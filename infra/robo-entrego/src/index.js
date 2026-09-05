// index.js (tasks.md FASE 5, 5.1) — fluxo principal do robô: login no hub →
// conferir entidade → sessão EntreGô (login completo se 401) → fetch dos 2
// relatórios → upload → polling → log de execução. Aplica a taxonomia de
// erro (research.md Decision 11) para decidir retry/parada e dispara as 3
// reações de FR-013 em falha definitiva.
//
// Todas as funções de orquestração (`executarRodada` para baixo) recebem
// suas dependências por injeção (`page`, `clienteHub`, `obterCodigo`,
// `transportador`, `dormir`, `agora`) — testáveis sem Playwright real, sem
// IMAP real, sem SMTP real, sem tempo real (mesmo padrão de hub-client.js/
// entrego-portal.js). Só `main()` (guardado por `require.main === module`)
// monta as dependências REAIS — não é exercitado por teste unitário
// (glue code fino; cobertura real fica pro roundtrip da FASE 6).
'use strict';

const fs = require('node:fs');

const { iniciarExecucao, finalizarExecucao, filtrarRelatorio } = require('./log-execucao');
const { CLASSIFICACAO, classificarSinal } = require('./taxonomia-erro');
const { criarTransportador, enviarAlerta } = require('./alerta-email');
const { criarClienteHub, ErroConfiguracaoHub } = require('./hub-client');
const {
  carregarStorageState,
  garantirSessaoValida,
  buscarUrlsRelatorio,
  baixarCsv,
  TRADUCAO_TIPO_HUB,
  STORAGE_STATE_PATH_DEFAULT,
  ErroAntibotSuspeito,
  ErroSemDados,
} = require('./entrego-portal');

// FR-012 — backoff crescente de 1, 5 e 15 minutos, até 3 tentativas.
const BACKOFF_MS_SEQUENCIA = [60_000, 5 * 60_000, 15 * 60_000];

const ACOES_EVENTO = Object.freeze({
  FALHA_DEFINITIVA: 'robo_entrego.falha_definitiva',
  SUSPEITA_ANTIBOT: 'robo_entrego.suspeita_antibot',
  FALHA_CONFIGURACAO: 'robo_entrego.falha_configuracao',
});

// ---------------------------------------------------------------------------
// Helpers puros
// ---------------------------------------------------------------------------

/** Data de execução − 1 dia, em `yyyy-MM-dd`, no fuso do portal (FR-003, ACHADOS-PORTAL.md §2 usa America/Sao_Paulo). */
function dataAnteriorISO(agoraMs = Date.now()) {
  const partes = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(agoraMs))
    .reduce((acc, p) => ((acc[p.type] = p.value), acc), {});
  // en-CA formata yyyy-MM-dd nativamente; subtrai 1 dia em UTC (a data já é só ano/mês/dia, sem componente de hora que importe aqui).
  const hoje = new Date(Date.UTC(Number(partes.year), Number(partes.month) - 1, Number(partes.day)));
  hoje.setUTCDate(hoje.getUTCDate() - 1);
  return hoje.toISOString().slice(0, 10);
}

/** Classificação segura: sinal ausente/desconhecido NUNCA vira retry silencioso (research.md Decision 11 — padrão conservador). */
function classificarSinalSeguro(sinal) {
  if (!sinal) return null;
  try {
    return classificarSinal(sinal);
  } catch (_e) {
    return null;
  }
}

function ehTransitorio(e) {
  return classificarSinalSeguro(e && e.sinal) === CLASSIFICACAO.TRANSITORIO;
}

/**
 * `acao` do endpoint de auditoria (contracts/hub-api.md §POST /robo-entrego/eventos)
 * para um erro de falha definitiva. Nunca reivindica "suspeita_antibot" sem
 * evidência (ErroAntibotSuspeito explícito, ou sinal `schema_inesperado`) —
 * o default seguro para o desconhecido é `falha_definitiva` (genérico), não
 * uma alegação de anti-bot que a implementação não tem como sustentar.
 */
function determinarAcao(e) {
  if (e instanceof ErroConfiguracaoHub) return ACOES_EVENTO.FALHA_CONFIGURACAO;
  if (e instanceof ErroAntibotSuspeito) return ACOES_EVENTO.SUSPEITA_ANTIBOT;
  if (classificarSinalSeguro(e && e.sinal) === CLASSIFICACAO.SUSPEITA_ANTIBOT) return ACOES_EVENTO.SUSPEITA_ANTIBOT;
  return ACOES_EVENTO.FALHA_DEFINITIVA;
}

// ---------------------------------------------------------------------------
// Retry transitório (FR-012)
// ---------------------------------------------------------------------------

async function dormirReal(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Executa `fn()`; em erro classificado TRANSITORIO (taxonomia-erro.js),
 * tenta de novo com o backoff de FR-012 (até 3 tentativas). Qualquer outra
 * classificação (ou sinal desconhecido) propaga IMEDIATAMENTE — nunca retry
 * (research.md Decision 11).
 * @returns {Promise<{valor: any, tentativas: number}>}
 */
async function comRetryTransitorio(fn, { dormir = dormirReal } = {}) {
  let tentativas = 0;
  for (;;) {
    tentativas += 1;
    try {
      const valor = await fn();
      return { valor, tentativas };
    } catch (e) {
      if (!ehTransitorio(e) || tentativas > BACKOFF_MS_SEQUENCIA.length) {
        e.tentativas = tentativas;
        throw e;
      }
      await dormir(BACKOFF_MS_SEQUENCIA[tentativas - 1]);
    }
  }
}

// ---------------------------------------------------------------------------
// Processamento de 1 relatório (1 tipo, 1 dia)
// ---------------------------------------------------------------------------

function comSinal(erro, sinal) {
  erro.sinal = sinal;
  return erro;
}

/**
 * Rastros que mudam um NÚMERO sem mudar o status da importação.
 *
 * Um `valor` de faturamento gravado como 0 (porque veio texto) subestima o total
 * do período, e a importação termina `completed` — nenhuma tela acusa. Aqui
 * transformamos esse silêncio em aviso.
 *
 * Best-effort: nunca lança. Uma falha ao consultar não pode derrubar uma
 * importação que deu certo.
 */
async function detectarValoresSilenciosos(clienteHub, importacaoId, tipo) {
  try {
    if (!clienteHub || typeof clienteHub.consultarErrosImportacao !== 'function') return [];
    const erros = await clienteHub.consultarErrosImportacao(importacaoId);
    const monetarios = erros.filter(
      (e) => e && e.campo === 'valor' && /texto em campo num/i.test(String(e.motivo || ''))
    );
    if (monetarios.length === 0) return [];
    return [{
      tipo,
      importacao_id: importacaoId,
      campo: 'valor',
      linhas_afetadas: monetarios.length,
      numeros_de_linha: monetarios.slice(0, 20).map((e) => e.numeroLinha ?? e.numero_linha).filter((n) => n != null),
      impacto: 'valor gravado como 0 — total do periodo subestimado',
    }];
  } catch (_) {
    return [];
  }
}

/** 1 tentativa completa: fetch da URL → download → upload → polling. */
async function tentativaUnica({ tipo, dataAnterior, page, clienteHub, axiosInstance }) {
  const [item] = await buscarUrlsRelatorio(page, { tipo, dataInicial: dataAnterior, dataFinal: dataAnterior });
  const { buffer, sha256 } = await baixarCsv(item.url, { axiosInstance });

  // CSV só com cabeçalho = movimento ainda não publicado. O hub NÃO pega este
  // caso: `arquivo_vazio` lá testa apenas 0 bytes (routes/hub-importacoes.js),
  // então um cabeçalho sozinho seria importado com 0 linhas e marcado
  // `completed` — falso sucesso, sem alerta, com o dia faltando.
  const linhasDeDados = buffer.toString('utf8').split('\n').filter((l) => l.trim()).length - 1;
  if (linhasDeDados < 1) {
    throw comSinal(
      new ErroSemDados(`entrego-portal: CSV de ${tipo} veio só com cabeçalho — relatório ainda não publicado para ${item.date}`),
      'relatorio_sem_dados'
    );
  }
  const nomeArquivo = `${TRADUCAO_TIPO_HUB[tipo]}_${item.date}.csv`;
  const upload = await clienteHub.enviarImportacao({ tipo: TRADUCAO_TIPO_HUB[tipo], nomeArquivo, bufferArquivo: buffer });

  // 409 = o arquivo já subiu antes. Duas situações MUITO diferentes vinham
  // caindo aqui como uma só (corrigido 2026-08-30):
  //  - a importação anterior terminou `completed`  -> nada a fazer, idempotente;
  //  - ela terminou TORTA (failed/cancelled/completed_with_errors) -> o dia
  //    está incompleto no hub e reenviar o arquivo nunca resolve, porque o
  //    UNIQUE do hash devolve 409 de novo. Foi o beco sem saída do dia 28/08.
  // O reprocessamento reusa o mesmo id e é idempotente nos fatos
  // (`on_conflict=id_empresa,hash_linha`), então só acrescenta o que faltava.
  if (upload.sinal === 'upload_409') {
    const idOriginal = upload.importacaoOriginalId;
    const anterior = await clienteHub.pollarImportacao(idOriginal);
    if (anterior.sinal === 'polling_completed') {
      return { statusHub: 'duplicado', importacaoId: idOriginal, item, sha256 };
    }
    const refeita = await clienteHub.reprocessarImportacao(idOriginal);
    if (refeita.sinal === 'http_5xx_hub') {
      throw comSinal(new Error(`hub: 5xx ao reprocessar a importação ${idOriginal} (status ${refeita.status})`), 'http_5xx_hub');
    }
    // 409/404 no reprocessar: não há o que refazer (ou a importação sumiu).
    // Reporta o estado real da anterior em vez de inventar sucesso.
    if (refeita.sinal !== 'reprocessar_202') {
      throw comSinal(
        new Error(`hub: importação ${idOriginal} terminou em '${anterior.dados && anterior.dados.status}' e não pôde ser reprocessada (${refeita.sinal})`),
        anterior.sinal
      );
    }
    return await aguardarDesfecho({ id: idOriginal, tipo, item, sha256, clienteHub, reprocessado: true });
  }
  if (upload.sinal === 'http_5xx_hub') {
    throw comSinal(new Error(`hub: 5xx no upload (status ${upload.status})`), 'http_5xx_hub');
  }
  if (upload.sinal === 'upload_422') {
    throw comSinal(new Error(`hub: upload rejeitado — ${upload.motivo}`), 'upload_422');
  }

  // upload_201 -> polling até status terminal (contracts/hub-api.md)
  return await aguardarDesfecho({ id: upload.id, tipo, item, sha256, clienteHub });
}

/** Polling até o status terminal e tradução do desfecho. Compartilhada pelo
 * upload novo (201) e pelo reprocessamento de uma importação torta (409), que
 * a partir daqui são o mesmo fluxo. */
async function aguardarDesfecho({ id, tipo, item, sha256, clienteHub, reprocessado = false }) {
  const poll = await clienteHub.pollarImportacao(id);
  if (poll.sinal === 'polling_completed') {
    // Importação `completed` NÃO significa "todos os valores corretos". Desde a
    // migration 0054, texto em campo numérico vira 0 e a linha entra. No campo
    // `valor` do FATURAMENTO isso é dinheiro: o total do período fica
    // subestimado e nada avisa. Este é o único ponto onde dá para perceber.
    const alertas = await detectarValoresSilenciosos(clienteHub, id, tipo);
    return { statusHub: poll.dados.status, importacaoId: id, item, sha256, alertas, reprocessado };
  }
  // polling_failed | polling_completed_with_errors — Falha do hub (research.md Decision 11)
  const erroResumo = poll.dados && poll.dados.erroResumo ? ` — ${poll.dados.erroResumo}` : '';
  const prefixo = reprocessado ? `hub: importação ${id} REPROCESSADA terminou` : 'hub: importação terminou';
  throw comSinal(new Error(`${prefixo} em '${poll.dados.status}'${erroResumo}`), poll.sinal);
}

/**
 * `sessao_expirada_401` (Decision 11) NÃO é falha — reloga (1x, sem contar
 * como tentativa/retry, FR-016) e repete a MESMA tentativa. Se falhar de
 * novo após o relogin, propaga (nunca reloga em loop).
 */
async function tentativaComRelogin({ tipo, dataAnterior, page, clienteHub, entregoCredenciais, obterCodigo, storageStatePath, axiosInstance }) {
  try {
    return await tentativaUnica({ tipo, dataAnterior, page, clienteHub, axiosInstance });
  } catch (e) {
    if (e.sinal !== 'sessao_expirada_401') throw e;
    // Mesmo caminho do início da rodada: refresh primeiro, login completo só
    // se o refresh falhar (antes chamava o login direto — um código por 401).
    const { relogou, renovada } = await garantirSessaoValida(page, {
      email: entregoCredenciais.email, senha: entregoCredenciais.senha, obterCodigo, storageStatePath,
    });
    // eslint-disable-next-line no-console
    console.log(`[robo] sessão expirou no meio de ${tipo} — ${relogou ? 'relogou' : renovada ? 'renovada' : 'reusada'}, retentando`);
    return tentativaUnica({ tipo, dataAnterior, page, clienteHub, axiosInstance });
  }
}

/**
 * Processa 1 tipo de relatório completo (retry transitório incluso).
 * @returns {Promise<object>} entrada de `relatorios[]` (data-model.md) em caso de sucesso
 * @throws {Error} com `.sinal`/`.tentativas` em caso de falha definitiva
 */
async function processarRelatorio({ tipo, dataAnterior, page, clienteHub, entregoCredenciais, obterCodigo, storageStatePath, dormir, axiosInstance }) {
  try {
    const { valor, tentativas } = await comRetryTransitorio(
      () => tentativaComRelogin({ tipo, dataAnterior, page, clienteHub, entregoCredenciais, obterCodigo, storageStatePath, axiosInstance }),
      { dormir }
    );
    return {
      tipo_portal: tipo,
      tipo_hub: TRADUCAO_TIPO_HUB[tipo],
      data_referencia: valor.item.date,
      url_s3: valor.item.url,
      sha256: valor.sha256,
      importacao_id: valor.importacaoId,
      status_hub: valor.statusHub,
      // Rastro de que este dia entrou numa SEGUNDA passada sobre o mesmo
      // arquivo — sem isso, um dia refeito fica indistinguível de um que
      // entrou certo de primeira.
      reprocessado: valor.reprocessado === true,
      tentativas,
    };
  } catch (e) {
    e.tipo_portal = tipo;
    e.tipo_hub = TRADUCAO_TIPO_HUB[tipo];
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Reações de falha (FR-013) — log é responsabilidade do chamador (1 registro por rodada, data-model.md); aqui só e-mail + auditoria.
// ---------------------------------------------------------------------------

/**
 * Dispara e-mail + auditoria para 1 falha (round-level ou de 1 relatório) —
 * "isoladamente", conforme data-model.md nota de falha parcial (dec-025):
 * cada falha tem seu próprio disparo, nunca soma com o item bem-sucedido.
 * Best-effort (`Promise.allSettled`): falha em uma reação não impede a
 * outra nem interrompe a rodada.
 */
async function dispararReacoesFalha({ acao, execucaoId, motivoFalha, relatorio, config, transportador, clienteHub }) {
  const relatorios = relatorio ? [relatorio] : [];
  const resultados = await Promise.allSettled([
    enviarAlerta({
      transportador,
      remetente: config.gmailEmail,
      destinatarios: config.alertaDestinatarios,
      execucaoId,
      resultado: acao,
      motivoFalha,
      relatorios,
    }),
    clienteHub.registrarEvento({
      acao,
      detalhes: { execucaoId, motivoFalha, relatorio: relatorio ? filtrarRelatorio(relatorio) : undefined },
    }),
  ]);
  // O allSettled existe para que uma reacao nao derrube a outra — mas
  // descartar o motivo torna a falha INVISIVEL. Foi assim que a porta 465
  // bloqueada silenciou todo alerta por dias sem deixar rastro em lugar
  // nenhum. O journal do systemd (`journalctl -u robo-entrego`) e onde o
  // operador olha quando o e-mail nao chega.
  const nomes = ['alerta por e-mail', 'evento de auditoria no hub'];
  resultados.forEach((r, i) => {
    if (r.status === 'rejected') {
      console.error(`[robo-entrego] ${nomes[i]} FALHOU (execucao ${execucaoId}):`, r.reason && r.reason.message);
    }
  });
  return resultados;
}

// ---------------------------------------------------------------------------
// Orquestração da rodada
// ---------------------------------------------------------------------------

/**
 * @param {object} opts
 * @param {object} opts.page - Playwright Page (ou mock) já com storageState carregado no context
 * @param {object} opts.config - ver `lerConfiguracao()`
 * @param {object} opts.clienteHub - já criado via `criarClienteHub`
 * @param {(timestamp: Date) => Promise<string>} opts.obterCodigo
 * @param {object} [opts.transportador] - nodemailer transporter (ou mock)
 * @param {Function} [opts.dormir] override para teste
 * @param {Function} [opts.agora] override para teste
 * @param {string} [opts.caminhoLog]
 * @returns {Promise<object>} a linha `fim` escrita em log-execucao.js
 */
async function executarRodada({ page, config, clienteHub, obterCodigo, transportador, dormir, agora, caminhoLog, axiosInstance, rede, diagnostico } = {}) {
  // Diagnóstico injetável (default: o módulo real). Anexa estado da página +
  // rede ao log QUANDO a rodada falha — sem isso, quem lê o alerta das 6h tem
  // só o `motivo_falha`, que em 3 de 11 casos de 2026-08-28 apontava para a
  // conclusão errada. Ver src/diagnostico-falha.js.
  const _diag = diagnostico || require('./diagnostico-falha');
  const { execucaoId } = iniciarExecucao({ caminhoLog });
  const dataAnterior = dataAnteriorISO(agora ? agora() : Date.now());
  const relatorios = [];
  let tentativasTotais = 0;
  const motivosFalha = [];

  const entregoCredenciais = { email: config.entregoEmail, senha: config.entregoSenha };

  try {
    // 1. hub: login + conferência de entidade (ErroConfiguracaoHub -> nunca retry)
    await clienteHub.login(config.hubServicoEmail, config.hubServicoSenha);

    // 2. sessão EntreGô (sonda + login completo se 401 — research.md Decision 3)
    // Ver a nota em enriquecimento.js: sem isto, um login completo (que gera
    // código de validação para o operador) é indistinguível de sessão reusada.
    const { relogou, renovada } = (await garantirSessaoValida(page, {
      email: config.entregoEmail,
      senha: config.entregoSenha,
      obterCodigo,
      storageStatePath: config.storageStatePath,
    })) || {};
    // eslint-disable-next-line no-console
    console.log(`[robo] sessão EntreGô: ${relogou ? 'relogou (login completo — gerou código de validação)' : renovada ? 'renovada' : 'reusada'}`);

    // 3. 1 relatório por tipo — antibot aborta a RODADA (FR-011); demais falhas seguem pro próximo tipo
    for (const tipo of ['PERFORMANCE', 'FINANCE']) {
      try {
        const r = await processarRelatorio({
          tipo,
          dataAnterior,
          page,
          clienteHub,
          entregoCredenciais,
          obterCodigo,
          storageStatePath: config.storageStatePath,
          dormir,
          axiosInstance,
        });
        relatorios.push(r);
        tentativasTotais += r.tentativas;
      } catch (e) {
        const tentativas = e.tentativas || 1;
        tentativasTotais += tentativas;
        const acao = determinarAcao(e);
        const relatorioFalho = {
          tipo_portal: e.tipo_portal || tipo,
          tipo_hub: e.tipo_hub || TRADUCAO_TIPO_HUB[tipo],
          data_referencia: dataAnterior,
          status_hub: null,
          tentativas,
        };
        relatorios.push(relatorioFalho);
        motivosFalha.push(`${tipo}: ${e.message}`);
        await dispararReacoesFalha({ acao, execucaoId, motivoFalha: e.message, relatorio: relatorioFalho, config, transportador, clienteHub });
        if (acao === ACOES_EVENTO.SUSPEITA_ANTIBOT) break; // FR-011: para a rodada, não tenta o próximo tipo
      }
    }
  } catch (e) {
    // falha ANTES do loop (login do hub ou sessão EntreGô) — nenhum relatório foi tentado
    const tentativas = e.tentativas || 1;
    tentativasTotais += tentativas;
    const acao = determinarAcao(e);
    motivosFalha.push(`sessão/login: ${e.message}`);
    await dispararReacoesFalha({ acao, execucaoId, motivoFalha: e.message, relatorio: null, config, transportador, clienteHub });
  }

  const sucessos = relatorios.filter((r) => r.status_hub != null).length;
  // Quando NADA subiu e todas as falhas foram "ainda não publicado", o
  // resultado é `sem_dados` — não `falha_total`. A diferença importa: o
  // operador não deve receber alerta de falha por um relatório que o portal
  // ainda não gerou; a próxima janela do dia tenta de novo.
  const soSemDados = relatorios.length > 0
    && relatorios.every((r) => r.status_hub == null)
    && motivosFalha.length > 0
    && motivosFalha.every((m) => /sem dados|só com cabeçalho|lista vazia|não publicado/i.test(m));
  const resultado = sucessos === 2 ? 'sucesso'
    : sucessos === 1 ? 'falha_parcial'
    : soSemDados ? 'sem_dados'
    : 'falha_total';

  // Avisos que NÃO mudam o resultado, mas mudam um NÚMERO. Hoje só o `valor`
  // monetário gravado como 0. Vão para o log SEMPRE, e por e-mail mesmo quando a
  // rodada foi 'sucesso' — é justamente no sucesso que passariam despercebidos.
  const avisosValor = relatorios.flatMap((r) => r.alertas || []);
  if (avisosValor.length > 0) {
    const linhas = avisosValor.reduce((acc, a) => acc + a.linhas_afetadas, 0);
    const detalhe = avisosValor
      .map((a) => `${a.tipo} (importacao ${a.importacao_id}): ${a.linhas_afetadas} linha(s), nº ${a.numeros_de_linha.join(', ')}`)
      .join(' | ');
    try {
      await enviarAlerta({
        transportador,
        remetente: config.gmailEmail,
        destinatarios: config.alertaDestinatarios,
        execucaoId,
        resultado: `AVISO: ${linhas} valor(es) monetário(s) gravado(s) como 0`,
        motivoFalha:
          `A importação concluiu com sucesso, mas ${linhas} lançamento(s) vieram com texto no campo `
          + `\`valor\` e foram gravados como 0 — o TOTAL DO PERÍODO está subestimado nesse montante. `
          + `Confira em ImportacaoLinhaErro (valorBruto tem o original). Detalhe: ${detalhe}`,
        relatorios: [],
      });
    } catch (e) {
      // o aviso é best-effort; nunca pode derrubar uma rodada bem-sucedida —
      // mas o motivo vai para o journal, senão some (mesma lição da porta 465).
      console.error(`[robo-entrego] aviso de valor por e-mail FALHOU (execucao ${execucaoId}):`, e && e.message);
    }
  }

  // Só coleta quando algo deu errado: numa rodada de sucesso o estado da página
  // não acrescenta nada e o screenshot é peso morto.
  let diagnosticoFalha;
  if (resultado !== 'sucesso' && page) {
    try {
      diagnosticoFalha = await _diag.coletar(page, rede, {
        screenshotPath: config && config.screenshotFalhaPath,
      });
    } catch (_) {
      // NUNCA deixar o diagnóstico mascarar a falha original.
    }
  }

  return finalizarExecucao({
    execucaoId,
    resultado,
    relatorios,
    tentativasTotais,
    motivoFalha: motivosFalha.length ? motivosFalha.join('; ') : null,
    caminhoLog,
    diagnostico: diagnosticoFalha,
    avisos: avisosValor.length ? avisosValor : null,
  });
}

/** 5.1.4 — invocado quando o lock (`flock -n`, scripts/docker-run.sh, Decision 8) já está ocupado por outra execução. Não toca portal/hub — só registra o resultado. */
function executarPuladoLock({ caminhoLog } = {}) {
  const { execucaoId } = iniciarExecucao({ caminhoLog });
  return finalizarExecucao({ execucaoId, resultado: 'pulado_lock', relatorios: [], tentativasTotais: 0, motivoFalha: null, caminhoLog });
}

// ---------------------------------------------------------------------------
// Configuração (data-model.md §Entity: Configuração da Rotina)
// ---------------------------------------------------------------------------

const ENV_PATH_DEFAULT = '/var/lib/hub_secrets/robo-entrego/.env';

/** Parser mínimo de `.env` (KEY=VALUE, `#` comentário, linha em branco ignorada) — sem dependência nova (ladder rung 6). Nunca sobrescreve env já setado (permite override manual/systemd). */
function carregarEnv(caminho = ENV_PATH_DEFAULT) {
  let conteudo;
  try {
    conteudo = fs.readFileSync(caminho, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return;
    throw e;
  }
  for (const linha of conteudo.split('\n')) {
    const l = linha.trim();
    if (!l || l.startsWith('#')) continue;
    const idx = l.indexOf('=');
    if (idx === -1) continue;
    const chave = l.slice(0, idx).trim();
    const valor = l.slice(idx + 1).trim();
    if (chave && !(chave in process.env)) process.env[chave] = valor;
  }
}

const CAMPOS_OBRIGATORIOS = ['ENTREGO_EMAIL', 'ENTREGO_SENHA', 'GMAIL_EMAIL', 'GMAIL_APP_PASSWORD', 'HUB_SERVICO_EMAIL', 'HUB_SERVICO_SENHA', 'HUB_ID_EMPRESA', 'HUB_BASE_URL', 'ALERTA_DESTINATARIOS'];

/** @throws {Error} campo obrigatório ausente — erro de CONFIGURAÇÃO, falha rápido antes de qualquer chamada de rede. */
function lerConfiguracao(env = process.env) {
  const faltando = CAMPOS_OBRIGATORIOS.filter((c) => !env[c]);
  if (faltando.length) {
    throw new Error(`index.js: configuração incompleta — faltando ${faltando.join(', ')} (ver .env.robo-entrego.example)`);
  }
  return {
    entregoEmail: env.ENTREGO_EMAIL,
    entregoSenha: env.ENTREGO_SENHA,
    gmailEmail: env.GMAIL_EMAIL,
    gmailAppPassword: env.GMAIL_APP_PASSWORD,
    hubServicoEmail: env.HUB_SERVICO_EMAIL,
    hubServicoSenha: env.HUB_SERVICO_SENHA,
    hubIdEmpresa: env.HUB_ID_EMPRESA,
    hubBaseURL: env.HUB_BASE_URL,
    alertaDestinatarios: env.ALERTA_DESTINATARIOS,
    storageStatePath: env.ENTREGO_STORAGE_STATE_PATH || STORAGE_STATE_PATH_DEFAULT,
  };
}

module.exports = {
  dataAnteriorISO,
  comRetryTransitorio,
  determinarAcao,
  tentativaUnica,
  tentativaComRelogin,
  processarRelatorio,
  dispararReacoesFalha,
  executarRodada,
  executarPuladoLock,
  carregarEnv,
  lerConfiguracao,
  BACKOFF_MS_SEQUENCIA,
  ACOES_EVENTO,
  ENV_PATH_DEFAULT,
};

// ---------------------------------------------------------------------------
// CLI real — nunca exercitado por teste unitário (glue code; browser/IMAP/SMTP reais)
// ---------------------------------------------------------------------------

if (require.main === module) {
  /* eslint-disable global-require */
  (async () => {
    if (process.argv.includes('--pulado-lock')) {
      executarPuladoLock();
      return;
    }

    carregarEnv();
    const config = lerConfiguracao();

    const { chromium } = require('playwright');
    const { ImapFlow } = require('imapflow');

    const storageState = carregarStorageState(config.storageStatePath);
    const browser = await chromium.launch();
    const context = await browser.newContext(storageState ? { storageState } : {});
    const page = await context.newPage();

    // Liga a captura de rede ANTES de qualquer navegação — em falha, é ela que
    // distingue "a requisição nem saiu" de "saiu e o portal recusou". Guarda só
    // método/status/path, nunca corpo nem querystring assinada.
    const rede = require('./diagnostico-falha').instrumentarRede(page);

    async function obterCodigo(timestampDisparo) {
      const client = new ImapFlow({
        host: 'imap.gmail.com',
        port: 993,
        secure: true,
        auth: { user: config.gmailEmail, pass: config.gmailAppPassword },
        logger: false,
      });
      await client.connect();
      try {
        const { lerCodigoAcesso } = require('./imap-codigo');
        return await lerCodigoAcesso(client, timestampDisparo);
      } finally {
        await client.logout();
      }
    }

    const clienteHub = criarClienteHub({ baseURL: config.hubBaseURL, idEmpresaEsperado: config.hubIdEmpresa });
    const transportador = criarTransportador({ gmailEmail: config.gmailEmail, gmailAppPassword: config.gmailAppPassword });

    try {
      await executarRodada({ page, config, clienteHub, obterCodigo, transportador, rede });
    } finally {
      await browser.close();
    }
  })().catch((e) => {
    // Falha ANTES/FORA de executarRodada (ex.: configuração ausente, browser não sobe) — nunca engolida em silêncio.
    // eslint-disable-next-line no-console
    console.error('[robo-entrego] falha fatal fora da rodada:', e && e.stack ? e.stack : e);
    process.exitCode = 1;
  });
}

// corrigir-movimento — logica pura da correcao de valor de movimento (EnvioMassa).
// Sem I/O proprio: o acesso ao banco entra por injecao (`deps`), para ser testavel de verdade.
// A guarda de nota/fechado/tenant mora no banco (migration 0116); aqui so se decide o que enviar
// e se traduz o desfecho REAL devolvido pela funcao em resposta HTTP — nunca sucesso presumido.
'use strict';

const { toNumberBR } = require('./numero-br');
const { linhaSemNada } = require('./disparo-alvo');
const { renderizarMensagem } = require('./adiantamento-mensagem');
const { hubPostgrestRequest } = require('./hub-postgrest');

const MOTIVO_MAX = 1000;

// ── Casamento (reimportacao) ─────────────────────────────────────────────────
// `existentes` ja vem filtrado por empresa+periodo+cnpj pela consulta do chamador.
// `uuid` e comparado AQUI, em memoria, e NUNCA entra em query (SEC-2).
// linha: { uuid, cnpj_prestador (somente digitos) }
function casarLinha(linha, existentes) {
  const uuid = String(linha.uuid ?? '').trim();
  if (uuid) {
    const porUuid = existentes.filter((e) => String(e.uuid ?? '').trim() === uuid);
    if (porUuid.length === 1) return { acao: 'atualizar', id: porUuid[0].id };
    if (porUuid.length > 1) return { acao: 'ambiguo', candidatos: porUuid.map((e) => e.id) };
    // uuid inexistente (ou instavel entre planilhas): cai no fallback, nao e erro.
  }
  const cnpj = String(linha.cnpj_prestador ?? '').replace(/\D/g, '');
  const porCnpj = existentes.filter((e) => String(e.cnpj_prestador ?? '').replace(/\D/g, '') === cnpj);
  if (porCnpj.length === 1) return { acao: 'atualizar', id: porCnpj[0].id };
  if (porCnpj.length > 1) return { acao: 'ambiguo', candidatos: porCnpj.map((e) => e.id) };
  return { acao: 'criar', semUuid: !uuid };
}

// ── Desfechos (INV-11: soma == total) ────────────────────────────────────────
const DESFECHOS = ['criados', 'atualizados', 'inalterados', 'pulados_nota_enviada',
  'pulados_mov_fechado', 'ambiguos', 'sem_identificador'];

const DESFECHO_RPC = {
  atualizado: 'atualizados', inalterado: 'inalterados',
  pulado_nota_enviada: 'pulados_nota_enviada', pulado_mov_fechado: 'pulados_mov_fechado',
};

// chaves: array de nomes de DESFECHOS, um por linha do arquivo. Lanca se algo nao for contabilizavel.
function resumir(chaves, totalLinhas, msgValorAntigo = 0, msgDivergente = 0) {
  const resumo = { total_linhas: totalLinhas };
  for (const d of DESFECHOS) resumo[d] = 0;
  for (const c of chaves) {
    if (!DESFECHOS.includes(c)) throw new Error(`desfecho nao contabilizavel: ${c}`);
    resumo[c] += 1;
  }
  const soma = DESFECHOS.reduce((a, d) => a + resumo[d], 0);
  if (soma !== totalLinhas) throw new Error(`resumo inconsistente: soma ${soma} != total ${totalLinhas}`);
  resumo.mensagem_valor_antigo = msgValorAntigo;
  resumo.mensagem_divergente = msgDivergente;
  return resumo;
}

// ── Ajuste ancorado do texto da mensagem (FR-014) ────────────────────────────
// Substitui SO o numero logo depois da frase-ancora, na mesma grafia de espaco encontrada.
// Ancora ausente ou duplicada => ajustada:false (o chamador avisa; nunca sucesso presumido).
// O lookahead final recusa numero PARCIAL ("242.24" sem virgula): sem ele o ".24" ficaria orfao colado ao novo valor.
const NUM = '(-|\\d+(?:\\.\\d{3})*(?:,\\d+)?)(?![\\d]|[.,]\\d)';
const ANCORA_VALOR = new RegExp(`(valor total para emiss(?:ã|a)o da NF (?:é|e) de R\\$ ?)${NUM}`, 'gi');
const ANCORA_GORJETA = new RegExp(`(valor de gorjetas (?:é|e) de R\\$ ?)${NUM}`, 'gi');

function fmtBR(n) {
  return n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function substituirAncorado(texto, re, numero) {
  const achados = [...texto.matchAll(re)];
  if (achados.length !== 1) return null;
  const novo = numero === null ? '-' : fmtBR(numero);
  return texto.replace(re, (_m, prefixo) => prefixo + novo);
}

// A mensagem cita, na frase-ancora, um valor diferente de `valor`? (qualquer ocorrencia; "-" nao conta)
function citaOutroValor(texto, valor) {
  return [...String(texto ?? '').matchAll(ANCORA_VALOR)]
    .some((m) => m[2] !== '-' && Math.abs(toNumberBR(m[2]) - valor) >= 0.005);
}

// novos: { valor?: number, gorjeta?: number|null } — so ajusta o que foi pedido.
function ajustarMensagem(texto, novos) {
  let atual = String(texto ?? '');
  if (novos.valor !== undefined) {
    const r = substituirAncorado(atual, ANCORA_VALOR, novos.valor);
    if (r === null) return { texto: String(texto ?? ''), ajustada: false };
    atual = r;
  }
  if (novos.gorjeta !== undefined) {
    const r = substituirAncorado(atual, ANCORA_GORJETA, novos.gorjeta);
    if (r === null) return { texto: String(texto ?? ''), ajustada: false };
    atual = r;
  }
  return { texto: atual, ajustada: true };
}

// ── Movimento gerado pelo hub (FR-014, CHK025): re-render do molde, sem procurar frase ──────────────
// O molde e editavel e os placeholders sao conjunto fechado (adiantamento-mensagem.js), entao a frase-ancora
// pode nem existir. Trava: renderizar o molde ATUAL com os valores ANTIGOS tem de reproduzir a mensagem1
// gravada; se nao reproduzir (molde editado depois, ou mensagem editada a mao) => ajustada:false, nunca
// sobrescrever com texto diferente do que o motorista recebeu.
// atual: { mensagem1, nome, valor, gorjeta } (a linha como esta);  origem: { modelo, periodoInicio, periodoFim }
function ajustarMensagemHub(atual, origem, novos) {
  const falha = { texto: String(atual.mensagem1 ?? ''), ajustada: false };
  if (!origem || typeof origem.modelo !== 'string') return falha;
  const num = (v) => (v === null || v === undefined || v === '' ? 0 : Number(v));
  const render = (valor, gorjeta) => renderizarMensagem(origem.modelo, {
    nome: atual.nome, valor, gorjeta, total: valor + gorjeta,
    periodoInicio: origem.periodoInicio, periodoFim: origem.periodoFim,
  });
  try {
    const v0 = num(atual.valor);
    const g0 = num(atual.gorjeta);
    if (render(v0, g0) !== String(atual.mensagem1 ?? '')) return falha;
    const v1 = novos.valor !== undefined ? novos.valor : v0;
    const g1 = novos.gorjeta !== undefined ? num(novos.gorjeta) : g0;
    return { texto: render(v1, g1), ajustada: true };
  } catch (_e) {
    return falha; // molde com placeholder fora da whitelist: nao reconhecivel
  }
}

// ── Correcao pela tela (PATCH /update-envio-massa/:id) ───────────────────────
// Allowlist LITERAL (SEC-1): do corpo so se le valor, gorjeta e motivo; nada mais chega ao banco.
// idEmp vem de resolveEmpresaAlvo (SEC-3) — o banco nao tem RLS nesta tabela, e a unica fronteira.
// deps: { lerMovimento(id, idEmp) -> {nome, valor, gorjeta, mensagem1}|null,
//         lerOrigemHub?(id, idEmp) -> {modelo, periodoInicio, periodoFim}|null  (null = movimento de planilha),
//         corrigir({idEmp, movimentos, motivo, origem, usuarioId}) -> [{desfecho, msg_valor_antigo, ...}] }
// Retorno: { status, body }. Lanca somente em falha de infraestrutura (o chamador responde 500).
const AVISO_MENSAGEM = 'O valor foi corrigido, mas a mensagem não pôde ser ajustada automaticamente — revise o texto antes de enviar.';

// toNumberBR('abc') devolve 0 (string sem digitos vira ''), comportamento herdado da importacao que
// nao se muda aqui; na tela, texto sem nenhum digito e valor invalido, nunca R$ 0,00.
// Tela: so caracteres de valor monetario BR, e "1.500" (ponto + 3 casas, sem virgula) e AMBIGUO (toNumberBR le 1,5):
// recusa em vez de gravar mil vezes menos. O operador digita "1500" ou "1.500,00".
const numeroBR = (v) => {
  if (typeof v === 'number') return toNumberBR(v);
  const t = String(v ?? '');
  if (!/\d/.test(t) || !/^[\sR$\d.,-]+$/i.test(t)) return NaN;
  if (!t.includes(',') && /\.\d{3}(\D|$)/.test(t)) return NaN;
  return toNumberBR(v);
};

const round2 = (n) => (Number.isFinite(n) ? Number(n.toFixed(2)) : n);

function validarEntrada(body) {
  const motivo = typeof body.motivo === 'string' ? body.motivo.trim() : '';
  if (!motivo) return { erro: 'Informe o motivo da correção.' };
  if (motivo.length > MOTIVO_MAX) return { erro: `O motivo deve ter no máximo ${MOTIVO_MAX} caracteres.` };
  // FR-012: mesma validacao da importacao, que arredonda a 2 casas (toFixed(2)); a coluna e double e nao arredonda.
  const valor = round2(numeroBR(body.valor));
  if (!Number.isFinite(valor) || valor < 0) return { erro: 'Valor inválido.' };
  let gorjeta;
  if (body.gorjeta !== undefined) {
    if (body.gorjeta === null || body.gorjeta === '') gorjeta = null;
    else {
      gorjeta = round2(numeroBR(body.gorjeta));
      if (!Number.isFinite(gorjeta) || gorjeta < 0) return { erro: 'Gorjeta inválida.' };
    }
  }
  // mesma regra da importação: recusa só quando não há nada a pagar nem a emitir (valor 0 + gorjeta é legítimo).
  if (linhaSemNada(valor, gorjeta)) return { erro: 'Valor inválido.' };
  return { motivo, valor, gorjeta };
}

async function corrigirPelaTela({ id, idEmp, body, usuarioId = null }, deps) {
  const ent = validarEntrada(body || {});
  if (ent.erro) return { status: 400, body: { error: ent.erro } };

  const atual = await deps.lerMovimento(id, idEmp);
  if (!atual) return { status: 404, body: { resultado: 'nao_encontrado' } };

  const mov = { id: Number(id), valor: ent.valor };
  if (ent.gorjeta !== undefined) mov.gorjeta = ent.gorjeta;
  const novos = { valor: ent.valor };
  if (ent.gorjeta !== undefined) novos.gorjeta = ent.gorjeta;
  // Origem hub (trilha ApuracaoRepasseMovimento) => re-render do molde; planilha => frase ancorada.
  const origemHub = deps.lerOrigemHub ? await deps.lerOrigemHub(id, idEmp) : null;
  const aj = origemHub ? ajustarMensagemHub(atual, origemHub, novos) : ajustarMensagem(atual.mensagem1, novos);
  if (aj.ajustada) mov.mensagem1 = aj.texto;

  const linhas = await deps.corrigir({ idEmp, movimentos: [mov], motivo: ent.motivo, origem: 'tela', usuarioId });
  const r = Array.isArray(linhas) ? linhas[0] : null;
  if (!r) throw new Error('A correção não devolveu resultado.');

  switch (r.desfecho) {
    case 'atualizado': {
      const out = { resultado: 'atualizado', mensagem_ajustada: aj.ajustada };
      if (!aj.ajustada) out.aviso = AVISO_MENSAGEM;
      if (r.msg_valor_antigo) out.mensagem_valor_antigo = true;
      return { status: 200, body: out };
    }
    case 'inalterado': return { status: 200, body: { resultado: 'inalterado' } };
    case 'pulado_nota_enviada': return { status: 409, body: { resultado: 'pulado_nota_enviada' } };
    case 'pulado_mov_fechado': return { status: 409, body: { resultado: 'pulado_mov_fechado' } };
    case 'nao_encontrado': return { status: 404, body: { resultado: 'nao_encontrado' } };
    default: throw new Error(`desfecho desconhecido: ${r.desfecho}`);
  }
}

// Fiacao real das deps da tela sobre `postgrestRequest(endpoint, method, body)` (injetado: testavel sem rede).
// Premissa (CHK019): EnvioMassa nao tem RLS — o filtro id_empresa em CADA consulta e a unica fronteira de tenant.
// A trilha ApuracaoRepasseMovimento existe => movimento gerado pelo hub; o molde e a versao vigente da config.
// A trilha/apuracao/config tem RLS por claim de escopo (0092): o GET de lerOrigemHub vai assinado com o escopo
// da empresa (mesmo padrao de lib/hub-envio-massa-import-log.js); o JWT legado sem claims le zero linhas.
function criarDepsCorrecao(postgrestRequest, hubRequest = hubPostgrestRequest) {
  const um = (rows) => (Array.isArray(rows) && rows.length ? rows[0] : null);
  return {
    lerMovimento: async (mid, emp) => um(await postgrestRequest(
      `EnvioMassa?id=eq.${encodeURIComponent(mid)}&id_empresa=eq.${emp}&select=mensagem1,nome,valor,gorjeta`)),
    lerOrigemHub: async (mid, emp) => {
      const claims = { empresaAtiva: emp, escopo: [emp] };
      const ler = (endpoint) => hubRequest(endpoint, 'GET', null, claims);
      const tr = um(await ler(
        `ApuracaoRepasseMovimento?envio_massa_id=eq.${encodeURIComponent(mid)}&id_empresa=eq.${emp}&select=apuracao_id&limit=1`));
      if (!tr) return null;
      const ap = um(await ler(
        `ApuracaoRepasse?id=eq.${encodeURIComponent(tr.apuracao_id)}&select=periodo_inicio,periodo_fim&limit=1`));
      const cf = um(await ler(
        `AdiantamentoConfiguracao?id_empresa=eq.${emp}&order=versao.desc&limit=1&select=mensagem1_modelo`));
      return {
        modelo: cf ? cf.mensagem1_modelo : null,
        periodoInicio: ap ? ap.periodo_inicio : null,
        periodoFim: ap ? ap.periodo_fim : null,
      };
    },
    corrigir: ({ idEmp, movimentos, motivo, origem, usuarioId }) => postgrestRequest(
      'rpc/hub_envio_massa_corrigir_valor', 'POST',
      { p_id_empresa: idEmp, p_movimentos: movimentos, p_motivo: motivo, p_origem: origem, p_usuario_id: usuarioId }),
  };
}

// ── Reimportacao (POST /upload) ──────────────────────────────────────────────
// Celula monetaria com texto mas SEM digito (#REF!, #VALOR!, N/A, abc): toNumberBR devolve 0 para isso
// (comportamento herdado, usado por 3 caminhos vivos — nao se muda). Na reimportacao esse 0 sobrescreveria
// valor correto de um motorista e o resumo diria "corrigido"; por isso e linha INVALIDA, validada na borda.
// Vazio e "R$ -"/"-" nao entram aqui (sao tratados pelo chamador como vazio/gorjeta nula).
function celulaSemNumero(raw) {
  if (typeof raw === 'number') return !Number.isFinite(raw);
  const s = String(raw ?? '').trim();
  if (!s || /^(R\$\s*)?-$/.test(s)) return false;
  return !/\d/.test(s);
}

// ts: 'YYYY-MM-DDT03:00:00-03:00' (toTimestamptzMidnightSP grava 03:00, nao meia-noite). Faixa do DIA no
// mesmo offset: [00:00 do dia, 00:00 do dia seguinte). Nunca ::date nem igualdade (indice + landmine do 03:00).
function faixaDia(ts) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T[\d:]+([+-]\d{2}:\d{2}|Z)$/.exec(String(ts ?? ''));
  if (!m) throw new Error('timestamp de periodo invalido');
  const [, y, mo, d, off] = m;
  const prox = new Date(Date.UTC(+y, +mo - 1, +d + 1)).toISOString().slice(0, 10);
  return { ini: `${y}-${mo}-${d}T00:00:00${off}`, fim: `${prox}T00:00:00${off}` };
}

const num = (v) => (v === null || v === undefined ? null : Number(v));
const mudaria = (linha, e, temGorjeta = true) => num(linha.valor) !== num(e.valor)
  || (temGorjeta && num(linha.gorjeta) !== num(e.gorjeta))
  || (typeof linha.mensagem1 === 'string' && linha.mensagem1 !== '' && linha.mensagem1 !== e.mensagem1);

const LOTE_RPC = 200;
// A RPC exige motivo ate para 'inalterado'. Sem motivo so chegamos aqui se NADA mudaria (checado acima);
// o texto so seria auditado numa corrida entre a leitura e a escrita.
const MOTIVO_SEM_ALTERACAO = 'reimportação idêntica (sem alteração prevista)';

// linhas: dataToInsert JA validadas (tudo-ou-nada feito pelo chamador); linha do arquivo = indice + 2.
// deps: { buscarExistentes({idEmp, cnpjs, ini, fim}) -> [{id,uuid,cnpj_prestador,valor,gorjeta,mensagem1}],
//         corrigir({idEmp, movimentos, motivo, origem:'reimportacao', usuarioId}) -> [...], inserir(rows) -> resposta }
// Retorno { status, body }. Falha no meio => 500 com `parcial` preciso (nunca sucesso total).
// temColunaGorjeta: a planilha TEM a coluna gorjeta (pelo cabecalho). Coluna ausente != gorjeta nula: sem coluna a
// gorjeta gravada nao e tocada.
async function reimportar({ linhas, idEmp, dtIni, dtFim, motivo, usuarioId = null, temColunaGorjeta = true }, deps) {
  const motivoT = typeof motivo === 'string' ? motivo.trim() : '';
  if (motivoT.length > MOTIVO_MAX) return { status: 400, body: { success: false, message: `O motivo deve ter no máximo ${MOTIVO_MAX} caracteres.` } };

  // SEC-2: so digitos de 14 posicoes entram na query.
  const cnpjs = [...new Set(linhas.map((l) => String(l.cnpj_prestador ?? '').replace(/\D/g, '')).filter((c) => /^\d{14}$/.test(c)))];
  const { ini: iniI, fim: iniF } = faixaDia(dtIni);
  const { ini: fimI, fim: fimF } = faixaDia(dtFim);
  const existentes = await deps.buscarExistentes({ idEmp, cnpjs, iniI, iniF, fimI, fimF });

  const plano = linhas.map((l, i) => {
    const cnpj = String(l.cnpj_prestador).replace(/\D/g, '');
    const c = casarLinha(l, existentes.filter((e) => String(e.cnpj_prestador ?? '').replace(/\D/g, '') === cnpj));
    return { ...c, linha: l, numero: i + 2 };
  });

  const alteraria = plano.some((p) => p.acao === 'atualizar' && mudaria(p.linha, existentes.find((e) => e.id === p.id), temColunaGorjeta));
  if (alteraria && !motivoT) {
    return { status: 400, body: { success: false, message: 'Informe o motivo: esta importação altera movimentos já existentes. Nada foi alterado.' } };
  }

  const chaves = new Array(linhas.length);
  const ambiguos = [];
  const pulados = [];
  let msgAntiga = 0;
  let msgDivergente = 0;
  const divergentes = new Set();
  let confirmadas = 0;

  const falha = (etapa, err) => {
    console.error('[UPLOAD][REIMPORT] falha em', etapa, err && err.status);
    return { status: 500, body: { success: false, message: 'Importação interrompida. Veja o que foi e o que não foi aplicado.',
      parcial: { atualizacoes_confirmadas: confirmadas, linhas_novas_criadas: false, etapa } } };
  };

  // 1) atualizar existentes (RPC em lote, so valor/gorjeta/mensagem1)
  const aAtualizar = plano.filter((p) => p.acao === 'atualizar');
  try {
    for (let i = 0; i < aAtualizar.length; i += LOTE_RPC) {
      const fatia = aAtualizar.slice(i, i + LOTE_RPC);
      const movimentos = fatia.map((p) => {
        const m = { id: p.id, valor: Number(p.linha.valor) };
        if (temColunaGorjeta) m.gorjeta = p.linha.gorjeta ?? null;
        if (typeof p.linha.mensagem1 === 'string' && p.linha.mensagem1 !== '') {
          m.mensagem1 = p.linha.mensagem1;
          // SC-007: o valor mudou na planilha mas o texto ainda cita o antigo => ajusta ou conta no resumo.
          if (citaOutroValor(p.linha.mensagem1, m.valor)) {
            const aj = ajustarMensagem(p.linha.mensagem1, { valor: m.valor });
            if (aj.ajustada) m.mensagem1 = aj.texto; else divergentes.add(p.id);
          }
        }
        return m;
      });
      const res = await deps.corrigir({ idEmp, movimentos, motivo: motivoT || MOTIVO_SEM_ALTERACAO, origem: 'reimportacao', usuarioId });
      const porId = new Map((Array.isArray(res) ? res : []).map((r) => [Number(r.movimento_id), r]));
      for (const p of fatia) {
        const r = porId.get(p.id);
        const d = r && DESFECHO_RPC[r.desfecho];
        if (!d) throw new Error(`sem desfecho contabilizavel para o movimento ${p.id}`);
        chaves[p.numero - 2] = d;
        if (d === 'pulados_nota_enviada') pulados.push({ linha: p.numero, id: p.id, motivo: 'nota_enviada' });
        if (d === 'pulados_mov_fechado') pulados.push({ linha: p.numero, id: p.id, motivo: 'mov_fechado' });
        if (r.msg_valor_antigo) msgAntiga += 1;
        if (d === 'atualizados' && divergentes.has(p.id)) msgDivergente += 1;
        confirmadas += 1;
      }
    }
  } catch (err) { return falha('atualizacao', err); }

  // 2) ambiguas: listadas, nunca escolhidas
  for (const p of plano.filter((x) => x.acao === 'ambiguo')) {
    chaves[p.numero - 2] = 'ambiguos';
    ambiguos.push({ linha: p.numero, cnpj_prestador: p.linha.cnpj_prestador, candidatos: p.candidatos });
  }

  // 3) criar as novas como hoje (FR-002)
  const aCriar = plano.filter((p) => p.acao === 'criar');
  if (aCriar.length) {
    try { await deps.inserir(aCriar.map((p) => p.linha)); } catch (err) { return falha('criacao', err); }
    for (const p of aCriar) chaves[p.numero - 2] = p.semUuid ? 'sem_identificador' : 'criados';
  }

  const resumo = resumir(chaves, linhas.length, msgAntiga, msgDivergente);
  return { status: 200, body: { success: true, resumo, ambiguos, pulados, inserted: aCriar.length } };
}

module.exports = {
  validarEntrada, celulaSemNumero, faixaDia, reimportar,
  casarLinha, resumir, DESFECHOS, DESFECHO_RPC, ajustarMensagem, corrigirPelaTela, AVISO_MENSAGEM,
  ajustarMensagemHub, criarDepsCorrecao,
};

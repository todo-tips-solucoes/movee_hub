#!/usr/bin/env node
/**
 * scripts/carga-contas-bancarias.js — carga inicial de contas bancárias
 * (tasks.md FASE 8, 8.1; Spec §FR-048, plan.md §Pontos para confirmação
 * item 3). Lê LOCALMENTE a planilha do operador
 * (`docs/documentos_apoio/conta_bancária_drivers.xlsx` — nome, CPF/CNPJ e
 * conta de gente real; NUNCA versionada, `.gitignore:13`) e cria contas
 * `PENDENTE`/`origem='CARGA_INICIAL'` para cada linha que casar com um
 * `Entregador` já cadastrado, sem aprovar nada automaticamente (FR-048).
 *
 * Execução MANUAL, pelo OPERADOR (rito de produção, CLAUDE.md — esta
 * pipeline NUNCA roda o script contra produção; a corrida real é do
 * operador, contra o ambiente que ele escolher).
 *
 *   node scripts/carga-contas-bancarias.js --arquivo <planilha.xlsx> [--simular|--gravar] [--saida <relatorio.json>] [--id-empresa 6]
 *
 * `--simular` (default) só gera o relatório — não grava nada. `--gravar`
 * grava de fato, via PostgREST (`hub_conta_bancaria_carga_inicial`,
 * migration 0072, claim `cargaInicialWorker` — lib/hub-postgrest-jwt.js) —
 * exige POSTGREST_URL + PGRST_JWT_SECRET no ambiente (mesmas variáveis de
 * lib/hub-postgrest-jwt.js).
 *
 * Idempotência (8.1.6): a RPC pré-checa conta PENDENTE/APROVADA existente
 * para o entregador e usa `ON CONFLICT ... DO NOTHING` como defesa
 * adicional — reexecutar sobre o mesmo arquivo não duplica.
 *
 * Colunas da planilha (research: docs/plans/adiantamento-motorista/PLANO.md
 * §5 — "só estrutura", nunca os dados reais): `Nome`, `ID` (uuid, hipótese
 * = Entregador.id_externo), `CPFEntregador`, `Nome titular`,
 * `CPF/CNPJ do titular da Conta`, `Banco`, `Agência`, `Conta`, `Dígito`,
 * `Tipo Conta`. Não há chave PIX, e-mail nem PF/PJ explícito (PLANO §5) —
 * gravados como NULL/derivados.
 *
 * Segurança/PII: o relatório de saída (--saida) grava só contadores e
 * `idExterno` (uuid pseudônimo da EntreGô, não documento/nome) — nunca
 * titular_nome/titular_documento/agência/conta. Permissão 0600, fora do
 * git (default: app_homologacao/backend/uploads/, já coberto por
 * `.gitignore:22`). O stdout imprime só os contadores agregados.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const {
  validarDocumento, validarBanco, normalizarAgencia, validarConta, validarDigitoConta,
} = require('../lib/adiantamento-conta');
const { hubPostgrestRequest } = require('../lib/hub-postgrest');

const COLUNAS = {
  id: 'ID',
  // 0085: CPF do próprio ENTREGADOR — não confundir com o documento do titular
  // da conta, que é a coluna seguinte e pode legitimamente ser outro (conta de
  // terceiro autorizada). É a comparação entre os dois que gera o alerta
  // DOCUMENTO_DIFERENTE para titular PF.
  cpfEntregador: 'CPFEntregador',
  titularNome: 'Nome titular',
  titularDocumento: 'CPF/CNPJ do titular da Conta',
  banco: 'Banco',
  agencia: 'Agência',
  conta: 'Conta',
  digito: 'Dígito',
  tipoConta: 'Tipo Conta',
};

const TIPO_CONTA_MAP = { 'Conta Corrente': 'CORRENTE', 'Conta Poupança': 'POUPANCA' };
const REGEX_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Zero-pad de código numérico curto (1-3 dígitos) para o formato COMPE de
 * 3 dígitos (edge: "Nubank aparece como 1 em 888 linhas e como 0001 em
 * 47" — PLANO §5). Formatos que não são "só dígitos" (nome por extenso,
 * ISPB de 8 dígitos) passam adiante SEM alteração, para `validarBanco`
 * recusar explicitamente (dec-027: nunca mapear por suposição). */
function normalizarCodigoBanco(valor) {
  const str = String(valor == null ? '' : valor).trim();
  return /^\d{1,3}$/.test(str) ? str.padStart(3, '0') : str;
}

/**
 * Valida e normaliza 1 linha da planilha (PURO — sem I/O). Reusa os MESMOS
 * validadores do envio pelo app (lib/adiantamento-conta.js) — nunca
 * duplica a lógica de DV/formato (ponytail: uma fonte só).
 * @returns {{aceito:true, idExterno:string, dados:object}|{aceito:false, idExterno:string|null, motivo:string}}
 */
function validarLinha(linha) {
  const idExterno = String(linha[COLUNAS.id] || '').trim().toLowerCase();
  if (!REGEX_UUID.test(idExterno)) return { aceito: false, idExterno: null, motivo: 'ID_INVALIDO' };

  const doc = validarDocumento(linha[COLUNAS.titularDocumento]);
  if (!doc.valido) return { aceito: false, idExterno, motivo: 'DOCUMENTO_INVALIDO' };

  const bancoCodigo = normalizarCodigoBanco(linha[COLUNAS.banco]);
  const banco = validarBanco(bancoCodigo);
  if (!banco.valido) return { aceito: false, idExterno, motivo: 'BANCO_NAO_IDENTIFICADO' };

  const agencia = normalizarAgencia(linha[COLUNAS.agencia]);
  if (!agencia) return { aceito: false, idExterno, motivo: 'AGENCIA_INVALIDA' };

  const conta = validarConta(linha[COLUNAS.conta]);
  if (!conta.valido) return { aceito: false, idExterno, motivo: 'CONTA_INVALIDA' };

  if (!validarDigitoConta(linha[COLUNAS.digito])) {
    return { aceito: false, idExterno, motivo: 'DIGITO_INVALIDO' };
  }

  const tipoConta = TIPO_CONTA_MAP[String(linha[COLUNAS.tipoConta] || '').trim()];
  if (!tipoConta) return { aceito: false, idExterno, motivo: 'TIPO_CONTA_INVALIDO' };

  const titularNome = String(linha[COLUNAS.titularNome] || '').trim();
  if (!titularNome || titularNome.length > 120) {
    return { aceito: false, idExterno, motivo: 'TITULAR_NOME_INVALIDO' };
  }

  // 0085: CPF do entregador é OPCIONAL na carga — linha sem ele (ou com valor
  // inválido) continua sendo aceita, só não alimenta a conferência de titular
  // PF. Recusar a linha por causa disto faria a carga de CONTA depender de um
  // campo que não é dela.
  const cpfEntregadorDigitos = String(linha[COLUNAS.cpfEntregador] || '').replace(/\D/g, '');
  const cpfEntregador = /^\d{11}$/.test(cpfEntregadorDigitos) ? cpfEntregadorDigitos : null;

  return {
    aceito: true,
    idExterno,
    cpfEntregador,
    dados: {
      titularNome,
      titularDocumento: doc.documento,
      titularTipo: doc.tipo,
      bancoCodigo,
      bancoNome: banco.nome,
      agencia,
      conta: conta.conta,
      contaDigito: String(linha[COLUNAS.digito]).trim(),
      tipoConta,
    },
  };
}

/**
 * Núcleo puro/injetável (padrão scripts/backfill-vinculo-motorista.js):
 * `buscarEntregadorFn(idExterno)` resolve `{id}` ou `null`;
 * `gravarContaFn(entregadorId, dados)` grava (ou simula) e devolve
 * `{criada:boolean}` — idempotente por natureza (RPC real: ON CONFLICT;
 * fake de teste: Set em memória).
 * @param {Array<object>} linhas - já lidas da planilha (sheet_to_json)
 * @param {{buscarEntregadorFn:Function, gravarContaFn:Function, gravarCpfFn?:Function, simular:boolean}} opts
 */
async function processarCarga(linhas, opts) {
  const { buscarEntregadorFn, gravarContaFn, gravarCpfFn, simular } = opts;
  const relatorio = {
    totalLinhas: linhas.length,
    aceitas: 0,
    recusadas: [],
    semEntregador: [],
    modo: simular ? 'simular' : 'gravar',
    criadas: 0,
    jaExistentes: 0,
    // 0085: quantos CPFs de entregador a planilha alimentou (contador, nunca o dado)
    cpfsGravados: 0,
  };

  for (const linha of linhas || []) {
    const v = validarLinha(linha);
    if (!v.aceito) {
      relatorio.recusadas.push({ idExterno: v.idExterno, motivo: v.motivo });
      continue;
    }
    relatorio.aceitas += 1;

    const entregador = await buscarEntregadorFn(v.idExterno);
    if (!entregador) {
      relatorio.semEntregador.push({ idExterno: v.idExterno });
      continue;
    }

    if (simular) {
      relatorio.criadas += 1; // "seria criada" — --simular nunca chama gravarContaFn
      continue;
    }

    const resultado = await gravarContaFn(entregador.id, v.dados);
    if (resultado && resultado.criada) relatorio.criadas += 1;
    else relatorio.jaExistentes += 1;

    // 0085: o CPF do entregador é gravado INDEPENDENTE de a conta ser nova ou
    // já existente — o que interessa é ter o dado para conferir contas futuras.
    if (gravarCpfFn && v.cpfEntregador) {
      const gravou = await gravarCpfFn(entregador.id, v.cpfEntregador);
      if (gravou) relatorio.cpfsGravados += 1;
    }
  }

  return relatorio;
}

/** Lê a planilha do operador (SheetJS). `raw:false` preserva zero à esquerda
 * quando a célula já está formatada como texto (PLANO §5) — a normalização
 * de agência/banco cobre o restante independente do tipo original da
 * célula. */
function lerPlanilha(caminho) {
  const wb = XLSX.readFile(caminho);
  const ws = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(ws, { defval: '', raw: false });
}

/** Busca real do Entregador por id_externo (uuid), escopado à empresa.
 * `Entregador` tem RLS por `escopo` desde a migration 0015
 * (`entregador_select_por_escopo`) — sem a claim `escopo` incluindo
 * `idEmpresa`, `hub_jwt_escopo_ids()` volta vazio e a policy nega tudo
 * (nega-por-padrão); confirmado rodando as 72 migrations num Postgres
 * efêmero nesta onda (achado real, não suposição). */
async function buscarEntregadorReal(idExterno, idEmpresa) {
  const qs = `id_empresa=eq.${idEmpresa}&id_externo=eq.${idExterno}&select=id&limit=1`;
  const linhas = await hubPostgrestRequest(`Entregador?${qs}`, 'GET', null, { escopo: [idEmpresa] });
  return Array.isArray(linhas) && linhas.length > 0 ? linhas[0] : null;
}

/** Grava real via RPC hub_conta_bancaria_carga_inicial (migration 0072) —
 * claim interna cargaInicialWorker, NUNCA a partir de dado de requisição. */
async function gravarContaReal(entregadorId, dados) {
  const linhas = await hubPostgrestRequest(
    'rpc/hub_conta_bancaria_carga_inicial',
    'POST',
    { p_entregador_id: entregadorId, p_dados: dados },
    { cargaInicialWorker: true },
  );
  const linha = Array.isArray(linhas) ? linhas[0] : linhas;
  return { criada: Boolean(linha && linha.criada) };
}

/** 0085: grava o CPF do ENTREGADOR (coluna `CPFEntregador` da planilha) em
 * `EntregadorDocumento`, que é o que permite conferir conta de titular PF.
 * Independente da gravação da conta: best-effort, porque a carga é de CONTA —
 * uma falha aqui não pode derrubar a linha inteira nem interromper o lote.
 * Devolve `true` se gravou, `false` se não havia CPF ou a RPC recusou. */
async function gravarCpfEntregadorReal(entregadorId, cpf) {
  if (!cpf) return false;
  try {
    const linhas = await hubPostgrestRequest(
      'rpc/hub_entregador_documento_gravar',
      'POST',
      { p_entregador_id: entregadorId, p_cpf: cpf, p_origem: 'CARGA_INICIAL' },
      { cargaInicialWorker: true },
    );
    const linha = Array.isArray(linhas) ? linhas[0] : linhas;
    return linha === true || Boolean(linha && linha.hub_entregador_documento_gravar);
  } catch {
    return false;
  }
}

function gravarRelatorio(relatorio, caminhoSaida) {
  const dir = path.dirname(caminhoSaida);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(caminhoSaida, JSON.stringify(relatorio, null, 2), { mode: 0o600 });
  fs.chmodSync(caminhoSaida, 0o600); // reforça o modo mesmo se o arquivo já existia
}

/** Resumo SEM PII para stdout — só contadores agregados (8.1.4). */
function resumoAgregado(relatorio) {
  return {
    modo: relatorio.modo,
    totalLinhas: relatorio.totalLinhas,
    aceitas: relatorio.aceitas,
    recusadas: relatorio.recusadas.length,
    semEntregador: relatorio.semEntregador.length,
    criadas: relatorio.criadas,
    jaExistentes: relatorio.jaExistentes,
    // 0085: contador agregado — quantos CPFs de entregador a planilha
    // alimentou. É número, nunca documento: o operador precisa saber a
    // cobertura da conferência de titular PF que acabou de habilitar.
    cpfsGravados: relatorio.cpfsGravados,
  };
}

function parseArgv(argv) {
  const opts = { simular: true, idEmpresa: 6 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--arquivo') opts.arquivo = argv[++i];
    else if (a === '--saida') opts.saida = argv[++i];
    else if (a === '--id-empresa') opts.idEmpresa = Number(argv[++i]);
    else if (a === '--simular') opts.simular = true;
    else if (a === '--gravar') opts.simular = false;
  }
  return opts;
}

async function main() {
  const opts = parseArgv(process.argv.slice(2));
  if (!opts.arquivo) {
    console.error('Uso: node scripts/carga-contas-bancarias.js --arquivo <planilha.xlsx> [--simular|--gravar] [--saida <relatorio.json>] [--id-empresa 6]');
    process.exitCode = 1;
    return;
  }
  if (!opts.simular && (!process.env.POSTGREST_URL || !process.env.PGRST_JWT_SECRET)) {
    console.error('--gravar exige POSTGREST_URL e PGRST_JWT_SECRET no ambiente (credenciais do PostgREST do hub).');
    process.exitCode = 1;
    return;
  }

  const linhas = lerPlanilha(opts.arquivo);
  const saida = opts.saida || path.join(__dirname, '..', 'uploads', 'carga-contas-bancarias', `relatorio-${Date.now()}.json`);

  const relatorio = await processarCarga(linhas, {
    simular: opts.simular,
    buscarEntregadorFn: (idExterno) => buscarEntregadorReal(idExterno, opts.idEmpresa),
    gravarContaFn: gravarContaReal,
    gravarCpfFn: gravarCpfEntregadorReal,
  });

  gravarRelatorio(relatorio, saida);
  console.log(JSON.stringify(resumoAgregado(relatorio), null, 2));
  console.log(`Relatório completo (sem PII de titular): ${saida}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[carga-contas-bancarias] erro fatal:', err.message);
    process.exitCode = 1;
  });
}

module.exports = {
  validarLinha,
  processarCarga,
  normalizarCodigoBanco,
  lerPlanilha,
  resumoAgregado,
  gravarRelatorio,
};

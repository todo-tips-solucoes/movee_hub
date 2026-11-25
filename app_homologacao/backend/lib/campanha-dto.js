'use strict';

/**
 * Campanhas do motorista — lógica PURA (sem I/O) das rotas hub e app.
 * Contrato: docs/plans/campanhas-motorista/CONTRATOS.md §4 (formulário), §5 (tokens), §7 (JSON).
 * Os mesmos limites moram em CHECK/RPC no banco; aqui é a primeira linha de defesa.
 */
const XLSX = require('xlsx');
const { CABECALHO_ESPERADO, TETO_CENTAVOS } = require('./lancamento-externo');

const IMAGEM_MAX_BYTES = 512000;
const SITUACOES_CAMPANHA = ['rascunho', 'agendada', 'em_andamento', 'apurando', 'encerrada', 'cancelada'];
const SITUACOES_RANKING = ['classificado', 'abaixo_corte', 'sem_minimo', 'sem_modal'];
const POR_PAGINA = 50;
const VALOR_OBJETO_MAX = 100000000; // estimativa de objeto (centavos): sem o teto do dinheiro, só cabe em int4

// ─── Tokens de erro da RPC → HTTP (CONTRATOS §5) ───────────────────────────
const TOKENS_HTTP = {
  CAMPANHA_NAO_ENCONTRADA: 404,
  CAMPANHA_IMUTAVEL: 409,
  CAMPANHA_SITUACAO_INVALIDA: 409,
  TETO_CAMPANHAS_ATIVAS: 409,
  PEDIDOS_SEM_COBERTURA: 422,
  INICIO_NO_PASSADO: 422,
  FAIXAS_SOBREPOSTAS: 422,
  PESOS_INVALIDOS: 422,
  CORTE_SEM_PESO: 422,
  OPCAO_DESCONHECIDA: 422,
  FECHAMENTO_ANTECIPADO: 409,
  FOTO_INVALIDA: 422,
  CONFIRMACAO_AUSENTE: 422,
  SEM_VINCULO: 404,
  VALIDACAO: 422,
  PERMISSAO_NEGADA: 403,
  FORA_DE_ESCOPO: 403,
};

/**
 * Erro do `hubPostgrestRequest` (`e.body` = texto do PostgREST) → `{status, erro}` ou `null` (não é token).
 * Prefere o `message` do JSON (igual ao token); cai para busca de substring.
 */
function mapearErroRpc(e) {
  const corpo = String((e && e.body) || '');
  let msg = '';
  let campo;
  try { const j = JSON.parse(corpo); msg = String(j.message || ''); campo = j.details || undefined; } catch (_) { /* corpo não-JSON */ }
  const token = Object.keys(TOKENS_HTTP).find((t) => msg === t)
    || Object.keys(TOKENS_HTTP).find((t) => corpo.includes(t));
  if (!token) return null;
  const out = { status: TOKENS_HTTP[token], erro: token };
  if (token === 'VALIDACAO' && campo) out.campo = String(campo); // DETAIL da RPC = campo
  return out;
}

// ─── Canonização ───────────────────────────────────────────────────────────
const canonizar = (s) => String(s).trim().toUpperCase();
const { lerCategorias: lerTokens } = require('./categorias-tokens');
const tam = (s) => Array.from(s).length;

// ─── Validação do formulário (§4) ──────────────────────────────────────────
const falha = (campo, token = 'VALIDACAO') => ({ ok: false, campo, token });
const ehInt = (n, min, max) => typeof n === 'number' && Number.isInteger(n) && n >= min && n <= max;

function dataReal(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(typeof s === 'string' ? s : '');
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d ? dt.getTime() : null;
}

/** null/undefined = todos; senão 1..50 itens de 1..120 caracteres, canonizados e sem repetição. */
function lerLista(v) {
  if (v === null || v === undefined) return { valor: null };
  if (!Array.isArray(v) || v.length < 1 || v.length > 50) return { erro: true };
  const out = [];
  for (const item of v) {
    if (typeof item !== 'string') return { erro: true };
    const c = canonizar(item);
    if (tam(c) < 1 || tam(c) > 120) return { erro: true };
    if (!out.includes(c)) out.push(c);
  }
  return { valor: out };
}

const INDICADORES = ['aceitacao', 'conclusao', 'tempo', 'pedidos'];

/** Categorias do extrato: 1..60 strings de 1..200 caracteres, SEM trim/upper (nome exato ou `familia:*`); repetição some. */
const lerCategorias = (v) => lerTokens(v, { min: 1, max: 60, maxNome: 200 }); // sem `modo:` (campanha não tem o modo)

/**
 * @param {object} corpo formulário camelCase (§7). Só os campos conhecidos são lidos
 *   (`idEmpresa` e afins no corpo são IGNORADOS).
 * @returns {{ok:true, dados:object}|{ok:false, campo:string, token:string}}
 *   `dados` = `p_dados` da RPC `hub_campanha_salvar` (snake_case, nomes das colunas).
 */
function validarFormulario(corpo) {
  const b = corpo && typeof corpo === 'object' && !Array.isArray(corpo) ? corpo : {};

  if (typeof b.nome !== 'string') return falha('nome');
  const nome = b.nome.trim();
  if (tam(nome) < 3 || tam(nome) > 120) return falha('nome');

  let descricao = '';
  if (b.descricao !== undefined && b.descricao !== null) {
    if (typeof b.descricao !== 'string') return falha('descricao');
    descricao = b.descricao.trim();
    if (tam(descricao) > 1000) return falha('descricao');
  }

  const ini = dataReal(b.dataInicio);
  if (ini === null) return falha('dataInicio');
  const fim = dataReal(b.dataFim);
  if (fim === null) return falha('dataFim');
  if (fim < ini) return falha('dataFim');
  if ((fim - ini) / 86400000 + 1 > 92) return falha('dataFim'); // duração inclusiva ≤ 92 dias

  // 0129: tipo / categorias / base do mínimo (mesmas regras do banco)
  let tipo = 'nota';
  if (b.tipo !== undefined && b.tipo !== null) {
    if (b.tipo !== 'nota' && b.tipo !== 'extrato') return falha('tipo');
    tipo = b.tipo;
  }
  const extrato = tipo === 'extrato';
  let minTurnosBase = 'trabalhados';
  if (b.minTurnosBase !== undefined && b.minTurnosBase !== null) {
    if (b.minTurnosBase !== 'trabalhados' && b.minTurnosBase !== 'validos') return falha('minTurnosBase');
    minTurnosBase = b.minTurnosBase;
  }
  if (!extrato && minTurnosBase !== 'trabalhados') return falha('minTurnosBase');
  let categorias = null;
  if (b.categorias !== undefined && b.categorias !== null) {
    categorias = lerCategorias(b.categorias);
    if (!categorias || !extrato) return falha('categorias');
  } else if (extrato) {
    return falha('categorias');
  }

  const listas = {};
  for (const campo of ['pracas', 'turnos', 'modais']) {
    const r = lerLista(b[campo]);
    if (r.erro) return falha(campo);
    listas[campo] = r.valor;
  }

  if (!ehInt(b.minTurnos, 1, 200)) return falha('minTurnos');

  // extrato não tem peso: ausente = todos 0; qualquer peso > 0 é PESOS_INVALIDOS (soma esperada 0, não 100)
  const pesosIn = b.pesos && typeof b.pesos === 'object' ? b.pesos : null;
  if (!pesosIn && !extrato) return falha('pesos');
  const pesos = {};
  for (const k of INDICADORES) {
    const x = pesosIn ? pesosIn[k] : undefined;
    if (extrato && (x === undefined || x === null)) { pesos[k] = 0; continue; }
    if (!ehInt(x, 0, 100)) return falha(`pesos.${k}`);
    pesos[k] = x;
  }
  const soma = INDICADORES.reduce((a, k) => a + pesos[k], 0);
  if (soma !== (extrato ? 0 : 100)) return falha('pesos', 'PESOS_INVALIDOS'); // nota: cobre "todos 0"

  const cortesIn = b.cortes && typeof b.cortes === 'object' ? b.cortes : {};
  const cortes = {};
  for (const k of INDICADORES) {
    const v = cortesIn[k];
    if (v === null || v === undefined) { cortes[k] = null; continue; }
    if (k === 'pedidos') {
      if (!ehInt(v, 1, 100000)) return falha('cortes.pedidos');
    } else if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1
      || Math.abs(v * 10000 - Math.round(v * 10000)) > 1e-6) {
      return falha(`cortes.${k}`);
    }
    if (!extrato && pesos[k] === 0) return falha(`cortes.${k}`, 'CORTE_SEM_PESO');
    cortes[k] = v;
  }
  // extrato: o corte é o critério do turno; sem nenhum, todo turno valeria
  if (extrato && INDICADORES.every((k) => cortes[k] === null)) return falha('cortes');

  if (!Array.isArray(b.premios) || b.premios.length < 1 || b.premios.length > 20) return falha('premios');
  const premios = [];
  for (let i = 0; i < b.premios.length; i += 1) {
    const p = b.premios[i];
    const c = (x) => `premios[${i}].${x}`;
    if (!p || typeof p !== 'object') return falha(`premios[${i}]`);
    if (!ehInt(p.posicaoDe, 1, 500)) return falha(c('posicaoDe'));
    if (!ehInt(p.posicaoAte, 1, 500) || p.posicaoAte < p.posicaoDe) return falha(c('posicaoAte'));
    if (p.tipo !== 'objeto' && p.tipo !== 'dinheiro') return falha(c('tipo'));
    if (typeof p.descricao !== 'string') return falha(c('descricao'));
    const desc = p.descricao.trim();
    if (tam(desc) < 1 || tam(desc) > 200) return falha(c('descricao'));
    let valor = null;
    if (p.valorCentavos !== null && p.valorCentavos !== undefined) {
      const max = p.tipo === 'dinheiro' ? TETO_CENTAVOS : VALOR_OBJETO_MAX;
      if (!ehInt(p.valorCentavos, 1, max)) return falha(c('valorCentavos'));
      valor = p.valorCentavos;
    } else if (p.tipo === 'dinheiro') {
      return falha(c('valorCentavos'));
    }
    const prem = { posicaoDe: p.posicaoDe, posicaoAte: p.posicaoAte, tipo: p.tipo, descricao: desc, valorCentavos: valor };
    // `id` (opcional) preserva a foto do prêmio já salvo ao editar o rascunho.
    if (p.id !== undefined && p.id !== null) {
      if (!ehInt(p.id, 1, 2147483647)) return falha(c('id'));
      prem.id = p.id;
    }
    premios.push(prem);
  }
  const ids = premios.filter((x) => x.id !== undefined).map((x) => x.id);
  if (new Set(ids).size !== ids.length) return falha('premios'); // B6: id repetido
  const ordenados = [...premios].sort((x, y) => x.posicaoDe - y.posicaoDe);
  for (let i = 1; i < ordenados.length; i += 1) {
    if (ordenados[i].posicaoDe <= ordenados[i - 1].posicaoAte) return falha('premios', 'FAIXAS_SOBREPOSTAS');
  }

  let avisar = true;
  if (b.avisar !== undefined && b.avisar !== null) {
    if (typeof b.avisar !== 'boolean') return falha('avisar');
    avisar = b.avisar;
  }

  // Ausente = chave fora de `p_dados`: o banco mantém o valor atual no UPDATE e usa false no INSERT.
  let visivelApp;
  if (b.visivelApp !== undefined && b.visivelApp !== null) {
    if (typeof b.visivelApp !== 'boolean') return falha('visivelApp');
    visivelApp = b.visivelApp;
  }

  // `dados` = `p_dados` de `hub_campanha_salvar` (0127 lê camelCase e revalida tudo).
  return {
    ok: true,
    dados: {
      nome, descricao, dataInicio: b.dataInicio, dataFim: b.dataFim,
      pracas: listas.pracas, turnos: listas.turnos, modais: listas.modais, minTurnos: b.minTurnos,
      pesos: { aceitacao: pesos.aceitacao, conclusao: pesos.conclusao, tempo: pesos.tempo, pedidos: pesos.pedidos },
      cortes, premios, avisar, tipo, categorias, minTurnosBase,
      ...(visivelApp === undefined ? {} : { visivelApp }),
    },
  };
}

// ─── App do motorista: whitelist do extrato ────────────────────────────────
/** Extrato: o app só vê posição + nome abreviado dos outros — nada de valor, turnos ou nota, mesmo que o banco mande. */
const soPosicaoNome = (l) => (Array.isArray(l) ? l.map((x) => ({ posicao: x && x.posicao, nomeAbreviado: x && x.nomeAbreviado })) : l);
function appCampanha(r) {
  const out = camelizar(r);
  if (out && typeof out === 'object') delete out.totalClassificados; // V4: o app só vê a posição, mesmo que o banco ainda mande o total
  if (out && out.campanha && out.campanha.tipo === 'extrato') {
    for (const k of ['top10', 'podio']) if (k in out) out[k] = soPosicaoNome(out[k]);
    if ('lider' in out) out.lider = null;
  }
  return out;
}

/** Lista do app: nenhum `total` por item (V4), mesmo que o banco ainda mande. */
const appLista = (itens) => camelizar(Array.isArray(itens) ? itens : []).map((i) => {
  if (!i || typeof i !== 'object') return i;
  const { total, ...resto } = i; // eslint-disable-line no-unused-vars
  return resto;
});

/** Lista CSV de query (`?pracas=A,B`) → array canonizado (≤50) ou `null`; `undefined` se malformada. */
function lerListaQuery(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const r = lerLista(raw.split(',').map((s) => s.trim()).filter(Boolean));
  return r.erro ? undefined : r.valor;
}

// ─── Foto (A9) ─────────────────────────────────────────────────────────────
/** Mime real pelos bytes iniciais; `null` se não for JPEG/PNG/WebP (SVG e demais recusados). */
function detectarImagem(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12 || buf.length > IMAGEM_MAX_BYTES) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

const MIMES_IMAGEM = ['image/jpeg', 'image/png', 'image/webp'];

// ─── snake → camel das respostas ───────────────────────────────────────────
const camel = (k) => k.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
/** Converte as CHAVES de jsonb (recursivo); valores intocados. */
function camelizar(v) {
  if (Array.isArray(v)) return v.map(camelizar);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [camel(k), camelizar(x)]));
  }
  return v;
}
const num = (x) => (x === null || x === undefined ? null : Number(x));

/** Linha de `hub_campanha_listar` = `{item: jsonb}` (já camelCase, §7); aceita o item solto. */
const itemLista = (r) => camelizar(r && r.item ? r.item : r);

/** Detalhe (jsonb da RPC): só camelização das chaves — o shape é o do banco (§7). */
const detalhe = camelizar;

function linhaRanking(r) {
  return {
    posicao: num(r.posicao),
    entregadorId: r.entregador_id,
    nome: r.nome,
    modal: r.modal ?? null,
    situacao: r.situacao,
    turnos: num(r.turnos),
    aceitacao: num(r.aceitacao),
    conclusao: num(r.conclusao),
    tempo: num(r.tempo),
    pedidos: num(r.pedidos),
    nota: num(r.nota),
    notaHipotetica: num(r.nota_hipotetica),
    posicaoHipotetica: num(r.posicao_hipotetica),
    motivoCorte: Array.isArray(r.motivo_corte) ? r.motivo_corte : [],
    posicaoAnterior: num(r.posicao_anterior),
    turnosValidos: num(r.turnos_validos),
    valorCentavos: num(r.valor_centavos),
  };
}

/** `valorSomado` (extrato): `{entregador_id → linha do ranking}`; a RPC de vencedores só devolve `nota` (NULL no extrato). */
const linhaCategoria = (r) => ({
  descricao: r.descricao,
  lancamentos: num(r.lancamentos),
  semMotoristaIdentificado: r.sem_motorista_identificado === true,
  familia: r.familia ?? null,
  primeira: r.primeira ?? null, // 0131: 1º lançamento na janela (YYYY-MM-DD)
});

function linhaVencedor(r, rankingPorEntregador) {
  const rk = rankingPorEntregador && rankingPorEntregador.get(r.entregador_id);
  return {
    posicao: num(r.posicao),
    nome: r.nome,
    nota: num(r.nota),
    turnosValidos: rk ? num(rk.turnos_validos) : null,
    valorSomadoCentavos: rk ? num(rk.valor_centavos) : null,
    premio: { tipo: r.premio_tipo, descricao: r.premio_descricao, valorCentavos: num(r.valor_centavos) },
    entregueEm: r.entregue_em ?? null,
    entreguePor: r.entregue_por_nome ?? null,
    observacao: r.observacao ?? null,
    exportadoEm: r.exportado_em ?? null,
    semCnpj: !r.cnpj,
  };
}

// ─── Planilha de prêmios em dinheiro (layout do Lançamento externo) ────────
/**
 * @param {Array<{cnpj:string|null,nome:string,valor_centavos:number,posicao:number,data_pagamento:string,adiado?:boolean}>} vencedores
 *   retorno de `hub_campanha_marcar_exportado` (A1/A2): a data de cada linha é a do carimbo da 1ª exportação.
 * @returns {Array<Array<string|number>>} AoA com cabeçalho; sem CNPJ válido, sem data ou `adiado` NÃO entram.
 */
function linhasPlanilhaPremios(vencedores, campanhaId) {
  const linhas = [];
  for (const v of vencedores || []) {
    const cnpj = String(v.cnpj || '').replace(/\D/g, '');
    if (v.adiado === true || cnpj.length !== 14 || !Number.isInteger(v.valor_centavos) || v.valor_centavos <= 0) continue;
    const data = String(v.data_pagamento || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) continue;
    linhas.push([cnpj, data, v.valor_centavos / 100, v.nome, `Prêmio campanha #${campanhaId} — ${v.posicao}º`]);
  }
  return [[...CABECALHO_ESPERADO], ...linhas];
}

/** Quantos vencedores ficaram para o dia seguinte (CNPJ já exportado hoje em outra campanha). */
const contarAdiados = (vencedores) => (vencedores || []).filter((v) => v && v.adiado === true).length;

function planilhaPremiosBuffer(aoa) {
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Prêmios');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

/** Responde a foto (linha `{mime, base64}` da RPC) com os headers fixos do plano (A9); mime fora da lista = 404. */
function enviarFoto(res, linha) {
  if (!linha || !linha.base64 || !MIMES_IMAGEM.includes(linha.mime)) {
    return res.status(404).json({ erro: 'CAMPANHA_NAO_ENCONTRADA' });
  }
  res.set({
    'Content-Type': linha.mime,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, max-age=300',
  });
  return res.status(200).send(Buffer.from(linha.base64, 'base64'));
}

module.exports = {
  enviarFoto,
  IMAGEM_MAX_BYTES, SITUACOES_CAMPANHA, SITUACOES_RANKING, POR_PAGINA, MIMES_IMAGEM, TOKENS_HTTP,
  TETO_CENTAVOS, CABECALHO_ESPERADO,
  mapearErroRpc, canonizar, validarFormulario, lerListaQuery, detectarImagem,
  camelizar, appCampanha, appLista, contarAdiados, itemLista, detalhe, linhaRanking, linhaVencedor, linhaCategoria, linhasPlanilhaPremios, planilhaPremiosBuffer,
};

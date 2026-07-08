/**
 * hub-motoristas-dto.js — helpers PUROS (sem I/O) de borda de API para
 * FASE 3 (tasks.md 3.1/3.2): paginação (mesmo padrão de
 * hub-importacoes-dto.js#parsePaginacao), normalização de nome
 * tolerante-a-acento (equivalente funcional de `hub_normaliza_nome()` do
 * banco, mas em JS — usada para filtrar/agrupar já resolvido no lado do
 * Node, ver cabeçalho de routes/hub-motoristas.js), mapeamento
 * snake_case -> camelCase (item de lista e detalhe) e máscara de CNPJ
 * (LGPD, contracts/motoristas-api.md §Mascaramento de CNPJ).
 *
 * Extraído para arquivo próprio (não inline em routes/hub-motoristas.js)
 * para ser testável isoladamente sem PostgREST/DB real (node --test), mesmo
 * padrão de lib/hub-importacoes-dto.js.
 *
 * Ref: contracts/motoristas-api.md, data-model.md.
 */

'use strict';

const PAGE_SIZE_DEFAULT = 20;
const PAGE_SIZE_MAX = 100;

/**
 * Parseia `page`/`pageSize` da query (mesma semântica de
 * hub-importacoes-dto.js#parsePaginacao — 0-indexed/inclusive `from`/`to`
 * para uso opcional com paginação Range do PostgREST). `page` < 1 ou não
 * numérico -> 1. `pageSize` fora de [1, PAGE_SIZE_MAX] -> clamp/default.
 * @param {object} query - `req.query`
 * @returns {{page:number, pageSize:number, from:number, to:number}}
 */
function parsePaginacao(query) {
  const pageParsed = parseInt(query && query.page, 10);
  const page = Number.isFinite(pageParsed) && pageParsed >= 1 ? pageParsed : 1;

  const pageSizeParsed = parseInt(query && query.pageSize, 10);
  const pageSize = Number.isFinite(pageSizeParsed) && pageSizeParsed >= 1
    ? Math.min(pageSizeParsed, PAGE_SIZE_MAX)
    : PAGE_SIZE_DEFAULT;

  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;
  return { page, pageSize, from, to };
}

/**
 * Normaliza um texto para comparação tolerante a acento/caixa: remove
 * diacríticos (NFD + strip de marcas combinantes) e lowercase. NÃO precisa
 * ser byte-a-byte idêntico a `hub_normaliza_nome()` (SQL, `lower(unaccent(...))`)
 * — só funcionalmente equivalente para o propósito de filtro em memória
 * (contracts/motoristas-api.md §GET /motoristas, "busca parcial, normalizada").
 * @param {string|null|undefined} texto
 * @returns {string}
 */
function normalizarNome(texto) {
  if (texto === null || texto === undefined) return '';
  return String(texto)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

/**
 * @param {string|null|undefined} termo - termo de busca (query `nome`)
 * @param {string|null|undefined} nomeArmazenado - `Entregador.nome`
 * @returns {boolean} `true` se `nomeArmazenado` contém `termo`, ambos
 *   normalizados (case/acento-insensitive).
 */
function nomeCasa(termo, nomeArmazenado) {
  const termoNorm = normalizarNome(termo);
  if (!termoNorm) return true;
  return normalizarNome(nomeArmazenado).includes(termoNorm);
}

/**
 * @param {string|null|undefined} area - termo de área (query `area`)
 * @param {Array<{subpraca:string}>} areasDoEntregador
 * @returns {boolean} `true` se QUALQUER área do entregador casa com `area`
 *   (comparação normalizada, igualdade — não substring, subpraça é um valor
 *   discreto, FR-002/Clarification Q2).
 */
function areaCasa(area, areasDoEntregador) {
  const areaNorm = normalizarNome(area);
  if (!areaNorm) return true;
  return (areasDoEntregador || []).some((a) => normalizarNome(a.subpraca) === areaNorm);
}

/**
 * Mapeia o mapa de áreas cru (linhas de `hub_areas_por_entregador`) para
 * `Map<entregadorId, Array<{subpraca, dataMaisRecente}>>`, já ordenado por
 * `dataMaisRecente` DESC dentro de cada entregador (contracts/motoristas-api.md
 * "areas ordenado por dataMaisRecente DESC").
 * @param {Array<{entregador_id:number, subpraca:string, data_mais_recente:string}>} linhas
 * @returns {Map<number, Array<{subpraca:string, dataMaisRecente:string}>>}
 */
function agruparAreasPorEntregador(linhas) {
  const mapa = new Map();
  for (const row of linhas || []) {
    const lista = mapa.get(row.entregador_id) || [];
    lista.push({ subpraca: row.subpraca, dataMaisRecente: row.data_mais_recente });
    mapa.set(row.entregador_id, lista);
  }
  for (const lista of mapa.values()) {
    lista.sort((a, b) => (a.dataMaisRecente < b.dataMaisRecente ? 1 : a.dataMaisRecente > b.dataMaisRecente ? -1 : 0));
  }
  return mapa;
}

/**
 * Mapeia 1 linha `Entregador` (snake_case/PostgREST) + suas áreas para o
 * shape de item de listagem do contrato (`GET /motoristas`).
 * @param {{id:number, nome:string, ativo:boolean, motorista_id:number|null}} row
 * @param {Array<{subpraca:string, dataMaisRecente:string}>} areas
 */
function mapMotoristaListItem(row, areas = []) {
  return {
    id: row.id,
    nome: row.nome,
    ativo: row.ativo,
    comVinculo: row.motorista_id !== null && row.motorista_id !== undefined,
    areas: areas.map((a) => a.subpraca),
  };
}

/**
 * Mapeia o detalhe completo (`GET /motoristas/:id`) — combina a linha do
 * `Entregador` (com embed opcional de `ContaMotorista`), a lista de áreas já
 * ordenada e o resumo de indicadores all-time.
 * @param {object} row - linha do Entregador (+ embed `ContaMotorista`)
 * @param {Array<{subpraca:string, dataMaisRecente:string}>} areas
 * @param {{totalFaturamento:number, totalPerformance:number, dataMaisRecente:string|null}} resumo
 */
function mapMotoristaDetalhe(row, areas, resumo) {
  const contaMotorista = row.ContaMotorista || null;
  return {
    id: row.id,
    nome: row.nome,
    ativo: row.ativo,
    nomeEditadoManualmente: !!row.nome_editado_manualmente,
    areas: areas || [],
    resumo: {
      totalFaturamento: (resumo && resumo.totalFaturamento) || 0,
      totalPerformance: (resumo && resumo.totalPerformance) || 0,
      dataMaisRecente: (resumo && resumo.dataMaisRecente) || null,
    },
    vinculo: contaMotorista
      ? {
        contaMotoristaId: contaMotorista.id,
        nome: contaMotorista.nome,
        cnpjPrestadorMascarado: mascararCnpj(contaMotorista.cnpj_prestador),
      }
      : null,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// FASE 4 — PATCH /motoristas/:id (task 4.1): allowlist estrita do corpo
// (contracts/motoristas-api.md §PATCH, research.md Decision 12 — guarda
// anti mass-assignment/BOPLA). Extraído para função pura testável sem
// PostgREST/Express real, mesmo padrão do resto deste arquivo.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Valida e extrai SOMENTE `nome`/`ativo` do corpo cru da requisição — qualquer
 * outra chave (`motoristaId`, `id`, `idEmpresa`, `nomeEditadoManualmente`,
 * etc.) é ignorada, nunca repassada ao PostgREST (allowlist estrita,
 * contracts/motoristas-api.md §PATCH).
 *
 * @param {object} corpoCru - `req.body`
 * @returns {{ok:true, patch:object, camposAlterados:string[]}|{ok:false, erro:'VAZIO'|'INVALIDO'}}
 *   `ok:false, erro:'VAZIO'` — nem `nome` nem `ativo` presentes no corpo (nada a alterar).
 *   `ok:false, erro:'INVALIDO'` — `nome` presente mas vazio/só espaços (422).
 *   `ok:true` — `patch` é o objeto pronto para o PATCH no PostgREST
 *   (snake_case; inclui `nome_editado_manualmente:true` quando `nome` muda) e
 *   `camposAlterados` é a lista (para o detalhe de auditoria).
 */
function validarPatchMotorista(corpoCru) {
  const corpo = corpoCru && typeof corpoCru === 'object' ? corpoCru : {};
  const temNome = Object.prototype.hasOwnProperty.call(corpo, 'nome');
  const temAtivo = Object.prototype.hasOwnProperty.call(corpo, 'ativo');

  if (!temNome && !temAtivo) {
    return { ok: false, erro: 'VAZIO' };
  }

  const patch = {};
  const camposAlterados = [];

  if (temNome) {
    const nome = typeof corpo.nome === 'string' ? corpo.nome.trim() : '';
    if (!nome) {
      return { ok: false, erro: 'INVALIDO' };
    }
    patch.nome = nome;
    patch.nome_editado_manualmente = true;
    camposAlterados.push('nome');
  }

  if (temAtivo) {
    if (typeof corpo.ativo !== 'boolean') {
      return { ok: false, erro: 'INVALIDO' };
    }
    patch.ativo = corpo.ativo;
    camposAlterados.push('ativo');
  }

  return { ok: true, patch, camposAlterados };
}

// ────────────────────────────────────────────────────────────────────────────
// Máscara de CNPJ (LGPD, contracts/motoristas-api.md §Mascaramento de CNPJ)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Formato `NN.xxx.xxx/NNNN-xx` (x = asterisco mascarado) — mantém os 2 primeiros dígitos e os 4
 * dígitos do bloco "ordem/filial" (posições 9-12 de um CNPJ de 14 dígitos),
 * mascara o resto. Normaliza a entrada para dígitos puros ANTES de fatiar
 * (a entrada pode vir formatada `12.345.678/0001-95` ou só dígitos
 * `12345678000195` — `ContaMotorista.cnpj_prestador` é gerado por
 * `Anon.fake_cnpj()`, que produz só dígitos, mas a função normaliza de
 * qualquer forma para ser robusta a mudança de formato de origem).
 * Entrada inválida/curta (menos de 14 dígitos) -> `null` (nunca lança, nunca
 * expõe o valor bruto).
 * @param {string|null|undefined} cnpjBruto
 * @returns {string|null}
 */
function mascararCnpj(cnpjBruto) {
  if (cnpjBruto === null || cnpjBruto === undefined) return null;
  const digitos = String(cnpjBruto).replace(/\D/g, '');
  if (digitos.length !== 14) return null;
  const prefixo = digitos.slice(0, 2);
  const ordemFilial = digitos.slice(8, 12);
  return `${prefixo}.***.***/${ordemFilial}-**`;
}

// ────────────────────────────────────────────────────────────────────────────
// FASE 6 — POST /motoristas/:id/vinculo (task 6.1.1): allowlist estrita do
// corpo (contracts/motoristas-api.md §POST vinculo, research.md Decision 12,
// mesmo padrão de `validarPatchMotorista`).
// ────────────────────────────────────────────────────────────────────────────

/**
 * Valida e extrai o corpo de `POST /motoristas/:id/vinculo`. `contaMotoristaId`
 * é o ÚNICO campo que influencia o `UPDATE` (allowlist estrita — qualquer
 * outro campo é ignorado no INSERT/UPDATE real). `origem` é um campo
 * ADITIVO, opcional, lido só para preencher `detalhes.origem` da auditoria
 * `motorista.vinculado` (research.md Decision 9) — NUNCA chega ao PostgREST,
 * nunca influencia a escrita em `Entregador`. Valor fora de
 * `{sugestao, busca_manual}` (ausente/mal-formado) -> `"nao_informado"`,
 * nunca rejeita a requisição por causa dele.
 *
 * @param {object} corpoCru - `req.body`
 * @returns {{ok:true, contaMotoristaId:number, origem:string}|{ok:false, erro:'INVALIDO'}}
 *   `ok:false` — `contaMotoristaId` ausente/não é inteiro positivo (422).
 */
function validarVinculoBody(corpoCru) {
  const corpo = corpoCru && typeof corpoCru === 'object' ? corpoCru : {};
  const bruto = corpo.contaMotoristaId;
  const strBruto = (typeof bruto === 'number' && Number.isFinite(bruto)) || typeof bruto === 'string'
    ? String(bruto)
    : '';
  if (!/^\d+$/.test(strBruto)) {
    return { ok: false, erro: 'INVALIDO' };
  }
  const contaMotoristaId = parseInt(strBruto, 10);
  const origem = corpo.origem === 'sugestao' || corpo.origem === 'busca_manual' ? corpo.origem : 'nao_informado';
  return { ok: true, contaMotoristaId, origem };
}

module.exports = {
  PAGE_SIZE_DEFAULT,
  PAGE_SIZE_MAX,
  parsePaginacao,
  normalizarNome,
  nomeCasa,
  areaCasa,
  agruparAreasPorEntregador,
  mapMotoristaListItem,
  mapMotoristaDetalhe,
  validarPatchMotorista,
  mascararCnpj,
  validarVinculoBody,
};

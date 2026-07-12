/**
 * hub-motoristas-similaridade.js — FASE 5 (tasks.md 5.1.1/5.2.1): sugestão
 * automática de candidatos por semelhança de nome e busca manual de conta
 * de acesso, para o fluxo de vínculo Entregador<->ContaMotorista.
 *
 * DECISÃO DE DESIGN (research.md Decision 10, gate `owasp-security` A05
 * Injection): TODA a lógica de similaridade/corte/limiar/elegibilidade de
 * grupo mora nas funções RPC do banco (`hub_motoristas_candidatos`/
 * `hub_motoristas_busca`, migration 0023) — este arquivo NUNCA monta SQL por
 * concatenação de string; só chama o RPC via `hubPostgrestRequest()` (bind
 * de parâmetros nativo do PostgREST, equivalente a prepared statement) e
 * mapeia a resposta snake_case -> camelCase do contrato
 * (contracts/motoristas-api.md §sugestoes/§contas-elegiveis).
 *
 * `termoBuscaValido()` é a ÚNICA checagem de "corte" que vive neste arquivo
 * (não no banco): o mínimo de 2 caracteres do termo de busca manual
 * (contracts/motoristas-api.md §contas-elegiveis, "q ... mínimo 2
 * caracteres") é uma validação de borda da API, não uma regra de
 * similaridade — evita golpear o RPC com um `LIKE '%%'`/`LIKE '%x%'`
 * demasiado amplo antes mesmo de a pessoa usuária terminar de digitar.
 * Extraída para função pura testável sem PostgREST/DB real (mesmo padrão de
 * lib/hub-motoristas-dto.js).
 *
 * Ref: docs/specs/hub-motoristas/contracts/motoristas-api.md,
 * research.md Decision 10/11, tasks.md FASE 5.
 */

'use strict';

const { hubPostgrestRequest } = require('./hub-postgrest');
const { mascararCnpj } = require('./hub-motoristas-dto');

const TERMO_BUSCA_MIN_CHARS = 2;

/**
 * hub-motorista-canonico FASE 2 / WS-B (tasks.md 2.1.1, contracts/
 * api-motorista-canonico.md §WS-B, research.md Decision 3): corte mínimo do
 * termo de busca de ENTREGADOR por nome em `GET /faturamento/entregadores` e
 * `GET /performance/entregadores` — 3 caracteres, DIFERENTE do corte de 2
 * caracteres da busca manual de CONTA em `GET /motoristas/contas-elegiveis`
 * (`TERMO_BUSCA_MIN_CHARS` acima). Os dois cortes NÃO podem compartilhar a
 * mesma constante — por isso `termoBuscaValido` abaixo aceita `minChars`
 * como segundo parâmetro opcional (default = `TERMO_BUSCA_MIN_CHARS`,
 * preserva 100% o comportamento/assinatura já coberto pelos testes
 * existentes de `hub-motoristas.js`).
 */
const TERMO_BUSCA_ENTREGADOR_MIN_CHARS = 3;

/** Limite de itens de `GET /faturamento|performance/entregadores` (FR-007,
 * contracts §WS-B — "até 20 itens"). */
const LIMITE_BUSCA_ENTREGADOR = 20;

/**
 * Mapeia o par `ja_vinculado_a`/`ja_vinculado_a_nome` (colunas RPC) para o
 * shape `jaVinculadoA` do contrato — `null` quando a conta não está
 * vinculada a NENHUMA outra pessoa entregadora hoje.
 * @param {number|null|undefined} idBruto
 * @param {string|null|undefined} nomeBruto
 * @returns {{entregadorId:number, nome:string}|null}
 */
function mapJaVinculadoA(idBruto, nomeBruto) {
  if (idBruto === null || idBruto === undefined) return null;
  return { entregadorId: idBruto, nome: nomeBruto };
}

/**
 * Mapeia 1 linha de `hub_motoristas_candidatos` (snake_case) para o shape de
 * item de `GET /motoristas/:id/sugestoes` (contracts/motoristas-api.md).
 * @param {{conta_motorista_id:number, nome:string, cnpj_prestador:string,
 *   similaridade:number, ja_vinculado_a:number|null,
 *   ja_vinculado_a_nome:string|null}} row
 */
function mapCandidato(row) {
  return {
    contaMotoristaId: row.conta_motorista_id,
    nome: row.nome,
    cnpjPrestadorMascarado: mascararCnpj(row.cnpj_prestador),
    similaridade: row.similaridade,
    jaVinculadoA: mapJaVinculadoA(row.ja_vinculado_a, row.ja_vinculado_a_nome),
  };
}

/**
 * Mapeia 1 linha de `hub_motoristas_busca` (snake_case) para o shape de item
 * de `GET /motoristas/contas-elegiveis` (contracts/motoristas-api.md) — mesmo
 * shape de `mapCandidato`, sem o campo `similaridade` (busca manual não tem
 * corte por semelhança).
 * @param {{conta_motorista_id:number, nome:string, cnpj_prestador:string,
 *   ja_vinculado_a:number|null, ja_vinculado_a_nome:string|null}} row
 */
function mapContaElegivel(row) {
  return {
    contaMotoristaId: row.conta_motorista_id,
    nome: row.nome,
    cnpjPrestadorMascarado: mascararCnpj(row.cnpj_prestador),
    jaVinculadoA: mapJaVinculadoA(row.ja_vinculado_a, row.ja_vinculado_a_nome),
  };
}

/**
 * `true` se `termo` (após trim) atinge o mínimo de
 * `TERMO_BUSCA_MIN_CHARS` caracteres exigido por `GET /motoristas/contas-elegiveis`
 * (contracts/motoristas-api.md — "q ... mínimo 2 caracteres"). `null`/
 * `undefined`/string vazia/só espaços -> `false`.
 *
 * `minChars` (opcional, default `TERMO_BUSCA_MIN_CHARS`=2) permite reusar a
 * MESMA função para o corte de 3 caracteres de `GET /faturamento|
 * performance/entregadores` (`TERMO_BUSCA_ENTREGADOR_MIN_CHARS`) sem
 * duplicar a lógica de trim/tipo — tasks.md 2.1.1 referencia esta função
 * nominalmente ("validar busca com termoBuscaValido... mínimo 3
 * caracteres").
 * @param {string|null|undefined} termo
 * @param {number} [minChars]
 * @returns {boolean}
 */
function termoBuscaValido(termo, minChars = TERMO_BUSCA_MIN_CHARS) {
  if (typeof termo !== 'string') return false;
  return termo.trim().length >= minChars;
}

/**
 * Mapeia 1 linha de `hub_entregadores_busca` (snake_case, migration 0042)
 * para o shape de item de `GET /faturamento|performance/entregadores`
 * (contracts/api-motorista-canonico.md §WS-B) — `{ id, nome }`, sem
 * transformação adicional (o RPC já entrega os campos prontos).
 * @param {{id:number, nome:string}} row
 * @returns {{id:number, nome:string}}
 */
function mapEntregadorBusca(row) {
  return { id: row.id, nome: row.nome };
}

/**
 * Chama `POST /rpc/hub_entregadores_busca {p_id_empresa, p_termo, p_limit}`
 * (migration 0042, research.md Decision 3) e mapeia a resposta. Termo
 * SEMPRE trafega como parâmetro de bind nativo do PostgREST — NUNCA
 * concatenado em querystring/SQL (mandato S1). `p_id_empresa` reforça o
 * escopo já garantido pela RLS de "Entregador" dentro da função
 * (SECURITY INVOKER, 0015) — defesa em profundidade, mesmo padrão de
 * `hub_faturamento_totais` (0027).
 * @param {number} idEmpresa - entidade ativa resolvida do token (nunca da query)
 * @param {string} termo - já validado via `termoBuscaValido(termo, TERMO_BUSCA_ENTREGADOR_MIN_CHARS)` pelo caller
 * @param {object} claims - repassado a hubPostgrestRequest (escopo do token)
 * @returns {Promise<Array<{id:number, nome:string}>>}
 */
async function buscarEntregadoresPorNome(idEmpresa, termo, claims) {
  const linhas = await hubPostgrestRequest(
    'rpc/hub_entregadores_busca',
    'POST',
    { p_id_empresa: idEmpresa, p_termo: termo, p_limit: LIMITE_BUSCA_ENTREGADOR },
    claims
  );
  return (linhas || []).map(mapEntregadorBusca);
}

/**
 * Chama `POST /rpc/hub_motoristas_candidatos {p_entregador_id}` (research.md
 * Decision 10) e mapeia a resposta. O RPC já resolve corte top-10 + limiar
 * 0.3 + elegibilidade de grupo (JOIN "EmpresaGrupoMovee") — este helper NUNCA
 * reimplementa essa lógica em JS, só chama e mapeia (contracts/motoristas-api.md
 * §sugestoes).
 * @param {number} entregadorId
 * @param {object} claims - repassado a hubPostgrestRequest (escopo do token)
 * @returns {Promise<Array<object>>} items já no shape do contrato
 */
async function buscarCandidatos(entregadorId, claims) {
  const linhas = await hubPostgrestRequest(
    'rpc/hub_motoristas_candidatos',
    'POST',
    { p_entregador_id: entregadorId },
    claims
  );
  return (linhas || []).map(mapCandidato);
}

/**
 * Chama `POST /rpc/hub_motoristas_busca {p_entregador_id, p_termo, p_limit,
 * p_offset}` (research.md Decision 10) e mapeia a resposta. `total` vem da
 * coluna `count(*) OVER()` da própria função RPC (não do header
 * `Content-Range` — este RPC não usa `opts.count` de `hubPostgrestRequest`,
 * porque `count(*) OVER()` já entrega o total junto de cada linha; `0` linhas
 * -> `total:0`, sem necessidade de uma 2ª chamada).
 * @param {number} entregadorId
 * @param {string} termo - já validado via `termoBuscaValido` pelo caller
 * @param {number} limit
 * @param {number} offset
 * @param {object} claims
 * @returns {Promise<{items:Array<object>, total:number}>}
 */
async function buscarContasElegiveis(entregadorId, termo, limit, offset, claims) {
  const linhas = await hubPostgrestRequest(
    'rpc/hub_motoristas_busca',
    'POST',
    { p_entregador_id: entregadorId, p_termo: termo, p_limit: limit, p_offset: offset },
    claims
  );
  const rows = linhas || [];
  const total = rows.length > 0 ? Number(rows[0].total) : 0;
  return { items: rows.map(mapContaElegivel), total };
}

module.exports = {
  TERMO_BUSCA_MIN_CHARS,
  TERMO_BUSCA_ENTREGADOR_MIN_CHARS,
  LIMITE_BUSCA_ENTREGADOR,
  termoBuscaValido,
  mapCandidato,
  mapContaElegivel,
  mapEntregadorBusca,
  buscarCandidatos,
  buscarContasElegiveis,
  buscarEntregadoresPorNome,
};

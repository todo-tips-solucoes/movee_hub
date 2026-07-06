// hub-fundacoes (FASE 4) — lib/hub-rbac-cache.js
//
// Cache in-memory das permissões efetivas por usuário (contracts/rbac-me.md
// §requirePermission, research.md Decision 7, FR-009/FR-013, SC-004).
//
// Modelo de permissões efetivas (Decision 5 — UNIÃO de grants, sem herança
// nem negação): todo `UsuarioEntidade` ATIVO da pessoa (qualquer empresa,
// inclusive papéis de escopo `global` — que nesta fundação também são
// modelados como uma linha de `UsuarioEntidade`, FR-006) contribui com TODAS
// as permissões do seu `Papel` via `PapelPermissao`. O resultado é um Set
// achatado (`modulo.acao`), sem diferenciação por entidade — GET /me expõe
// exatamente este conjunto (contracts/rbac-me.md).
//
// TTL 60s (SC-004) + invalidação ativa (`invalidarUsuario`) exportada para uso
// por qualquer operação administrativa futura (S3+) que altere papel/vínculo
// — nesta fundação nenhuma rota ainda chama `invalidarUsuario` (não há admin
// de papéis/vínculos exposta em FASE 4), mas o TTL natural já garante SC-004
// no pior caso.
//
// Fail-closed (Decision 13, remediação owasp-security): qualquer erro ao
// consultar o PostgREST resolve para um Set VAZIO (nega tudo) e o resultado
// de erro NUNCA é cacheado — assim uma falha transitória não fixa "sem
// permissão nenhuma" por 60s inteiros depois que a infra se recupera.
'use strict';

const { hubPostgrestRequest } = require('./hub-postgrest');

const TTL_MS = 60 * 1000;

// Map<string(usuarioId), { permissoes: Set<string>, expiraEm: number }>
const cache = new Map();

/**
 * Consulta o PostgREST e monta o conjunto de permissões efetivas de um
 * usuário. Pode lançar (erro de rede/infra) — o caller (`obterPermissoesEfetivas`)
 * é quem decide a política de fail-closed; esta função é só a leitura crua.
 * @param {number|string} usuarioId
 * @returns {Promise<Set<string>>}
 */
async function carregarPermissoesDoBanco(usuarioId) {
  // FASE 5 (0006_rls_policies.sql): a policy de UsuarioEntidade é escopada
  // por `usuario_id = claim.sub` (nega-por-padrão sem escopo/empresa_ativa
  // — cada pessoa só lê os PRÓPRIOS vínculos, research.md Decision 3/4).
  // Sem a claim `usuarioId` aqui, RLS devolveria zero linhas mesmo para o
  // dono legítimo do vínculo.
  const vinculos = await hubPostgrestRequest(
    `UsuarioEntidade?usuario_id=eq.${usuarioId}&ativo=eq.true&select=papel_id`,
    'GET',
    null,
    { usuarioId }
  );
  if (!vinculos || vinculos.length === 0) return new Set();

  const papelIds = [...new Set(vinculos.map((v) => v.papel_id))];
  if (papelIds.length === 0) return new Set();

  // PapelPermissao é tabela global (sem coluna de entidade) — fora da
  // cobertura FR-027, sem RLS; nenhuma claim de escopo é necessária aqui.
  const filtroIds = papelIds.join(',');
  const linhas = await hubPostgrestRequest(
    `PapelPermissao?papel_id=in.(${filtroIds})&select=permissao:Permissao(codigo)`
  );

  const codigos = new Set();
  for (const linha of linhas || []) {
    if (linha && linha.permissao && linha.permissao.codigo) {
      codigos.add(linha.permissao.codigo);
    }
  }
  return codigos;
}

/**
 * Retorna o conjunto de permissões efetivas do usuário, servindo do cache
 * quando válido (TTL 60s) ou recarregando do banco em cache-miss/expiração.
 * NUNCA lança — fail-closed resolve para Set vazio (ver cabeçalho do arquivo).
 * @param {number|string} usuarioId
 * @returns {Promise<Set<string>>}
 */
async function obterPermissoesEfetivas(usuarioId) {
  const chave = String(usuarioId);
  const agora = Date.now();
  const entrada = cache.get(chave);
  if (entrada && entrada.expiraEm > agora) {
    return entrada.permissoes;
  }

  let permissoes;
  try {
    permissoes = await carregarPermissoesDoBanco(usuarioId);
  } catch (e) {
    console.error(
      '[hub-rbac-cache] erro ao carregar permissoes do banco (fail-closed -> vazio, nao cacheado):',
      e.message
    );
    return new Set();
  }

  cache.set(chave, { permissoes, expiraEm: agora + TTL_MS });
  return permissoes;
}

/**
 * Invalidação ativa (Decision 7) — a ser chamada por qualquer operação
 * administrativa que altere `UsuarioEntidade`/`PapelPermissao` do usuário
 * afetado, garantindo que SC-004 (≤60s) seja cumprido com folga mesmo no
 * pior caso (mudança 1ms após o cache ter sido populado).
 * @param {number|string} usuarioId
 */
function invalidarUsuario(usuarioId) {
  cache.delete(String(usuarioId));
}

/** Limpa o cache inteiro — uso exclusivo de testes. */
function limparCache() {
  cache.clear();
}

module.exports = {
  obterPermissoesEfetivas,
  invalidarUsuario,
  limparCache,
  carregarPermissoesDoBanco,
  TTL_MS,
};

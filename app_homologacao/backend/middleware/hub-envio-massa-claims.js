// hub-envio-massa (S8, tasks.md FASE 2.1) — middleware/hub-envio-massa-claims.js
//
// Adaptador de claims: traduz uma sessão do HUB (payload `{sub, email,
// entidade_ativa}`, contracts/claims-adapter.md) para o formato que o código
// legado de `server.js` já espera (`req.user = {empresaId, id_grupo,
// is_grupo_pai}`), preservando 100% do comportamento para sessões legadas
// (payload `{empresaId, ...}`, research.md Decision 1/5, FR-018).
//
// Posição na cadeia (research.md Decision 2): `authenticateToken` (legado,
// intocado) -> ESTE middleware -> `hubEnvioMassaRequirePermission(codigo)` ->
// handler da rota.
//
// Ordem de checagem — `req.user.sub` SEMPRE primeiro (gate `owasp-security`,
// achado F1): uma eventual drift futura no payload do token hub (hoje nunca
// inclui `empresaId`) falha para o lado mais restrito (sujeito a RBAC), nunca
// para o lado de bypass total. Um payload de drift com `sub` E `empresaId`
// simultâneos cai SEMPRE no ramo 1 (hub) por causa desta ordem.
//
// `Empresa`/`Grupo` são tabelas legadas (mesma instância/URL compartilhada
// com as tabelas do hub — research.md "Technical Context"). A consulta
// abaixo duplica ~12 linhas de `server.js:278-291` (POST /login) de forma
// enxuta via `hubPostgrestRequest` — extrair uma função compartilhada
// tocaria `server.js` além do estritamente necessário (research.md Decision
// 2: diff do arquivo legado permanece ZERO fora da FASE 3).
'use strict';

const { hubPostgrestRequest } = require('../lib/hub-postgrest');

/**
 * Resolve `id_grupo`/`is_grupo_pai` para a empresa `entidadeAtiva`, espelhando
 * a MESMA lógica de `server.js:274-293` (POST /login):
 *   1. lê `Empresa.id_grupo` da entidade ativa;
 *   2. se houver `id_grupo`, confirma se esta empresa é a administradora
 *      (pai) do grupo (`Grupo.id_empresa_pai = entidadeAtiva`); se for, usa o
 *      `Grupo.id` como `id_grupo` efetivo (mesmo comportamento do legado —
 *      cobre o caso em que a FK direta e a resolução via `Grupo` divergem).
 * Pode lançar (erro de rede/infra) — o caller decide a política de resposta
 * (502 ADAPTADOR_INDISPONIVEL).
 *
 * @param {number|string} entidadeAtiva
 * @returns {Promise<{ idGrupo: number|null, isGrupoPai: boolean }>}
 */
async function resolverGrupoDaEntidade(entidadeAtiva) {
  const empresas = await hubPostgrestRequest(
    `Empresa?id=eq.${entidadeAtiva}&select=id,id_grupo`
  );
  if (!empresas || empresas.length === 0) {
    // Entidade ativa não resolve para nenhuma Empresa: trata como sem grupo
    // (mesma degradação fail-safe do legado quando a checagem de grupo falha).
    return { idGrupo: null, isGrupoPai: false };
  }

  let idGrupo = empresas[0].id_grupo || null;
  let isGrupoPai = false;

  if (idGrupo) {
    const grupoCheck = await hubPostgrestRequest(
      `Grupo?id_empresa_pai=eq.${entidadeAtiva}&select=id`
    );
    if (grupoCheck && grupoCheck.length > 0) {
      isGrupoPai = true;
      idGrupo = grupoCheck[0].id;
    }
  }

  return { idGrupo, isGrupoPai };
}

/**
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
async function hubEnvioMassaClaimsBridge(req, res, next) {
  const user = req.user || {};

  // Ramo 1 — sessão hub (`sub` testado SEMPRE primeiro, achado F1).
  if (user.sub !== undefined && user.sub !== null) {
    const entidadeAtiva = user.entidade_ativa;
    if (entidadeAtiva === undefined || entidadeAtiva === null) {
      return res.status(403).json({
        error: {
          code: 'SEM_ENTIDADE_ATIVA',
          message: 'Selecione uma entidade para continuar.',
        },
      });
    }

    try {
      const { idGrupo, isGrupoPai } = await resolverGrupoDaEntidade(entidadeAtiva);
      req.user = {
        empresaId: entidadeAtiva,
        id_grupo: idGrupo,
        is_grupo_pai: isGrupoPai,
      };
      req.hubContext = { viaHub: true, usuarioId: user.sub };
      return next();
    } catch (e) {
      console.error(
        '[hub-envio-massa-claims] falha ao resolver grupo da entidade ativa (502 ADAPTADOR_INDISPONIVEL):',
        e.message
      );
      return res.status(502).json({
        error: {
          code: 'ADAPTADOR_INDISPONIVEL',
          message: 'Serviço indisponível, tente novamente.',
        },
      });
    }
  }

  // Ramo 2 — sessão legada (`sub` ausente, `empresaId` presente): next()
  // imediato, ZERO leitura/mutação adicional de `req` (FR-018).
  if (user.empresaId !== undefined && user.empresaId !== null) {
    return next();
  }

  // Ramo 3 — nem legado nem hub.
  return res.status(401).json({ error: { code: 'TOKEN_INVALIDO' } });
}

module.exports = { hubEnvioMassaClaimsBridge, resolverGrupoDaEntidade };

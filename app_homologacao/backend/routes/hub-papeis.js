// hub-auditoria-admin (S9) — routes/hub-papeis.js
//
// GET /api/v1/papeis (matriz papel×permissão, leitura) + PUT
// /api/v1/papeis/:papelId/permissoes/:permissaoId (toggle de célula, escrita
// exclusiva admin_plataforma via RPC SECURITY DEFINER com guard anti-lockout).
// Ref: docs/specs/hub-auditoria-admin/contracts/papeis-api.md, spec.md
// FR-010/FR-016, tasks.md FASE 4.3.
//
// Arquivo 100% NOVO. Montado sob requireModuloAtivo('usuarios') (research
// Decision 10 — a matriz vive sob o módulo `usuarios`, não um módulo próprio).
// Catálogo de papéis é FIXO (dec-008): NENHUMA rota de criar/editar/excluir
// papel existe aqui nem em nenhum outro arquivo — RLS sem política de
// escrita em "Papel" garante isso na origem (FR-016).
'use strict';

const express = require('express');

const { decodificarAccessToken, lerAccessTokenDoRequest } = require('../lib/hub-access-token');
const { hubPostgrestRequest } = require('../lib/hub-postgrest');
const {
  obterPermissoesEfetivasPorEntidade,
  usuarioEhAdminPlataforma,
  limparCache,
} = require('../lib/hub-rbac-cache');
const { requirePermission } = require('../middleware/hub-require-permission');
const { requireModuloAtivo } = require('../middleware/hub-require-modulo');
const { registrarAuditoria } = require('../lib/hub-auditoria');

const router = express.Router();

// ────────────────────────────────────────────────────────────────────────────
// Helpers (mesmo padrão de routes/hub-usuarios.js)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Resolve payload+entidadeAtiva+isAdminPlataforma+permsEntidade e confirma
 * `usuarios.gerenciar` na entidade ativa (leitura da matriz — GET /papeis é
 * acessível a admin_entidade em modo somente leitura, contracts/papeis-api.md).
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {Promise<{payload:object, entidadeAtiva:number, isAdminPlataforma:boolean,
 *   permsEntidade:Set<string>}|null>}
 */
async function resolverContexto(req, res) {
  const accessToken = lerAccessTokenDoRequest(req);
  const payload = decodificarAccessToken(accessToken);
  if (!payload || !payload.sub) {
    res.status(401).json({ erro: 'NAO_AUTENTICADO' });
    return null;
  }
  const entidadeAtiva = payload.entidade_ativa ? Number(payload.entidade_ativa) : null;
  if (!entidadeAtiva) {
    res.status(403).json({ erro: 'PERMISSAO_NEGADA' });
    return null;
  }
  const permsEntidade = await obterPermissoesEfetivasPorEntidade(payload.sub, entidadeAtiva);
  if (!permsEntidade.has('usuarios.gerenciar')) {
    res.status(403).json({ erro: 'PERMISSAO_NEGADA' });
    return null;
  }
  const isAdminPlataforma = await usuarioEhAdminPlataforma(payload.sub);
  return { payload, entidadeAtiva, isAdminPlataforma, permsEntidade };
}

// ────────────────────────────────────────────────────────────────────────────
// GET /papeis (task 4.3.2)
// ────────────────────────────────────────────────────────────────────────────

router.get('/', requireModuloAtivo('usuarios'), requirePermission('usuarios.gerenciar'), async (req, res) => {
  try {
    const ctx = await resolverContexto(req, res);
    if (!ctx) return;

    // Papel/Permissao/PapelPermissao: catálogo global, sem RLS (data-model.md
    // "Entity: Papel/Permissao/PapelPermissao" — fora da cobertura FR-027),
    // GRANT SELECT já existe desde 0003 — nenhuma claim necessária aqui.
    const [papeis, permissoes, matriz] = await Promise.all([
      hubPostgrestRequest('Papel?select=id,nome,escopo,is_sistema&order=id.asc'),
      hubPostgrestRequest('Permissao?select=id,codigo,modulo:Modulo(codigo)&order=id.asc'),
      hubPostgrestRequest('PapelPermissao?select=papel_id,permissao_id'),
    ]);

    // contracts/papeis-api.md: "podeEditar = true somente quando o chamador
    // tem admin.gerenciar E vínculo ativo com papel admin_plataforma (mesma
    // condição do claim)".
    const podeEditar = ctx.isAdminPlataforma && ctx.permsEntidade.has('admin.gerenciar');

    return res.status(200).json({
      papeis: (papeis || []).map((p) => ({ id: p.id, nome: p.nome, escopo: p.escopo, isSistema: p.is_sistema })),
      permissoes: (permissoes || []).map((p) => ({ id: p.id, codigo: p.codigo, modulo: p.modulo ? p.modulo.codigo : null })),
      matriz: (matriz || []).map((m) => ({ papelId: m.papel_id, permissaoId: m.permissao_id })),
      podeEditar,
    });
  } catch (e) {
    console.error('[hub-papeis] erro em GET /papeis:', e.message);
    return res.status(500).json({ erro: 'ERRO_SERVIDOR' });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// PUT /papeis/:papelId/permissoes/:permissaoId (task 4.3.3) — toggle via RPC
// SECURITY DEFINER hub_papel_permissao_set (migration 0037)
// ────────────────────────────────────────────────────────────────────────────

router.put(
  '/:papelId/permissoes/:permissaoId',
  requireModuloAtivo('usuarios'),
  requirePermission('admin.gerenciar'),
  async (req, res) => {
    try {
      const accessToken = lerAccessTokenDoRequest(req);
      const payload = decodificarAccessToken(accessToken);
      if (!payload || !payload.sub) {
        return res.status(401).json({ erro: 'NAO_AUTENTICADO' });
      }
      const entidadeAtiva = payload.entidade_ativa ? Number(payload.entidade_ativa) : null;
      if (!entidadeAtiva) {
        return res.status(403).json({ erro: 'PERMISSAO_NEGADA' });
      }

      // Dupla barreira (middleware + banco): `admin.gerenciar` NÃO
      // pertence a admin_entidade (seed 0007) — quem chegar aqui sem ele
      // sempre cai em 403 (FR-010/FR-016). Verificação por-entidade (mesmo
      // padrão de routes/hub-me.js#GET /auditoria).
      const permsEntidade = await obterPermissoesEfetivasPorEntidade(payload.sub, entidadeAtiva);
      if (!permsEntidade.has('admin.gerenciar')) {
        return res.status(403).json({ erro: 'PERMISSAO_NEGADA' });
      }

      const papelId = Number(req.params.papelId);
      const permissaoId = Number(req.params.permissaoId);
      if (!Number.isInteger(papelId) || !Number.isInteger(permissaoId)) {
        return res.status(400).json({ erro: 'DADOS_INVALIDOS' });
      }
      const { ativo } = req.body || {};
      if (typeof ativo !== 'boolean') {
        return res.status(400).json({ erro: 'DADOS_INVALIDOS' });
      }

      const papeis = await hubPostgrestRequest(`Papel?id=eq.${papelId}&select=id,nome`);
      if (!papeis || papeis.length === 0) {
        return res.status(404).json({ erro: 'PAPEL_NAO_ENCONTRADO' });
      }
      const permissoes = await hubPostgrestRequest(`Permissao?id=eq.${permissaoId}&select=id,codigo`);
      if (!permissoes || permissoes.length === 0) {
        return res.status(404).json({ erro: 'PERMISSAO_NAO_ENCONTRADA' });
      }

      const isAdminPlataforma = await usuarioEhAdminPlataforma(payload.sub);
      const claims = { usuarioId: payload.sub, empresaAtiva: entidadeAtiva, escopo: [entidadeAtiva] };
      if (isAdminPlataforma) claims.adminPlataforma = true;

      try {
        await hubPostgrestRequest('rpc/hub_papel_permissao_set', 'POST', {
          p_papel_id: papelId, p_permissao_id: permissaoId, p_ativo: ativo,
        }, claims);
      } catch (e) {
        // A RPC (migration 0037) levanta ERRCODE 42501 em 2 cenários
        // distintos com a MESMA classe de erro (PostgREST mapeia ambos p/
        // 403) — distinguimos pelo texto da mensagem (única forma de
        // diferenciar guard anti-lockout de "não é admin_plataforma"):
        //   1. "exclusivo de admin_plataforma" -> 403 PERMISSAO_NEGADA
        //   2. "anti-lockout ..." -> 409 OPERACAO_BLOQUEADA (owasp finding M2)
        const corpo = String(e.body || e.message || '').toLowerCase();
        if (corpo.includes('anti-lockout')) {
          return res.status(409).json({ erro: 'OPERACAO_BLOQUEADA' });
        }
        if (e.status === 403 || corpo.includes('42501') || corpo.includes('exclusivo de admin_plataforma')) {
          return res.status(403).json({ erro: 'PERMISSAO_NEGADA' });
        }
        throw e;
      }

      // Efeitos colaterais obrigatórios (contracts/papeis-api.md):
      // (1) limparCache() global — mudança de matriz afeta conjunto
      //     não-enumerado de usuários (research Decision 6), diferente de
      //     invalidarUsuario (1 usuário só); (2) auditoria.
      limparCache();

      await registrarAuditoria({
        idEmpresa: entidadeAtiva,
        usuarioId: payload.sub,
        acao: 'papel_permissao_alterada',
        recurso: 'PapelPermissao',
        recursoId: `${papelId}:${permissaoId}`,
        detalhes: { papel: papeis[0].nome, permissao: permissoes[0].codigo, ativo },
        ip: req.ip,
        claims,
      });

      return res.status(200).json({ papelId, permissaoId, ativo });
    } catch (e) {
      console.error('[hub-papeis] erro em PUT /papeis/:papelId/permissoes/:permissaoId:', e.message);
      return res.status(500).json({ erro: 'ERRO_SERVIDOR' });
    }
  }
);

module.exports = { router };

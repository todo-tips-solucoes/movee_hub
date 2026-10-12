// hub — routes/hub-validacao-xml.js
//
// GET /api/v1/validacao-xml/regularizadas — notas que o motorista enviou
// DEPOIS do fechamento do movimento (EnvioMassa.regularizada_em, migration
// 0107, gravada por POST /motorista/notas-pendentes/...).
//
// Por que existe: o pagamento retido é liberado por UMA PESSOA — não há gate
// automático entre nota e pagamento. Sem esta lista o motorista regulariza e
// ninguém é avisado.
//
// Permissão: `validacao_xml.validar` (a única do módulo). Criar uma
// `.consultar` exigiria migration e espelho MANUAL na matriz papel×permissão;
// o papel `financeiro_aprovador` (0097) nasceu como CÓPIA do `financeiro`, sem
// vínculo vivo, então permissão nova dada a um não chega ao outro em silêncio.
// Quem valida XML é quem lida com notas.
'use strict';

const express = require('express');

const { decodificarAccessToken, lerAccessTokenDoRequest } = require('../lib/hub-access-token');
const { obterPermissoesEfetivasPorEntidade, usuarioEhAdminPlataforma } = require('../lib/hub-rbac-cache');
const { requirePermission } = require('../middleware/hub-require-permission');
const { requireModuloAtivo } = require('../middleware/hub-require-modulo');
const { hubPostgrestRequest } = require('../lib/hub-postgrest');
const { mesmoGrupoQue } = require('./grupo');

const router = express.Router();

const GRUPO_MOVEE_ID = 6;
const LIMITE_REGULARIZADAS = 100;

/**
 * "Aprovada" = `nota_ok` preenchido E `erro_validacao` vazio. O serviço de
 * validação grava `nota_ok` (URL do XML) mesmo quando a nota é REPROVADA,
 * então `nota_ok` sozinho não prova aprovação (ver routes/motorista.js).
 * @param {{nota_ok?:*, erro_validacao?:*}} row
 * @returns {boolean}
 */
function notaAprovada(row) {
  const temNotaOk = row.nota_ok != null && String(row.nota_ok).trim() !== '';
  const temErro = row.erro_validacao != null && String(row.erro_validacao).trim() !== '';
  return temNotaOk && !temErro;
}

/** Linha da EnvioMassa -> DTO. `nota_ok` (URL do XML) NÃO sai daqui. */
function mapRegularizada(row) {
  return {
    id: row.id,
    nome: row.nome,
    cnpjPrestador: row.cnpj_prestador,
    valor: row.valor,
    dtInicial: row.dt_inicial,
    dtFinal: row.dt_final,
    regularizadaEm: row.regularizada_em,
    notaAprovada: notaAprovada(row),
  };
}

/**
 * Resolve payload + entidade ativa + escopo de empresas. Responde o erro e
 * devolve `null` quando falha. `escopo === null` = admin da plataforma
 * (todas as empresas); senão, lista de ids (grupo Movee expande para as filiais).
 */
async function resolverContexto(req, res, permissao) {
  const payload = decodificarAccessToken(lerAccessTokenDoRequest(req));
  if (!payload || !payload.sub) {
    res.status(401).json({ erro: 'NAO_AUTENTICADO' });
    return null;
  }
  const entidadeAtiva = payload.entidade_ativa ? Number(payload.entidade_ativa) : null;
  if (!entidadeAtiva) {
    res.status(400).json({ erro: 'ENTIDADE_NAO_SELECIONADA' });
    return null;
  }
  const perms = await obterPermissoesEfetivasPorEntidade(payload.sub, entidadeAtiva);
  if (!perms.has(permissao)) {
    res.status(403).json({ erro: 'PERMISSAO_NEGADA' });
    return null;
  }
  const isAdminPlataforma = await usuarioEhAdminPlataforma(payload.sub);

  let escopo = null;
  if (!isAdminPlataforma) {
    if (entidadeAtiva === GRUPO_MOVEE_ID) {
      // `mesmoGrupoQue` é fail-safe: se a expansão falha por infra, `cache.ids`
      // fica vazio e degradamos para a empresa solo (nunca para "todas").
      const cache = {};
      await mesmoGrupoQue(entidadeAtiva, GRUPO_MOVEE_ID, cache);
      escopo = cache.ids ? [...cache.ids] : [entidadeAtiva];
    } else {
      escopo = [entidadeAtiva];
    }
  }

  const claims = { usuarioId: payload.sub, empresaAtiva: entidadeAtiva, escopo: escopo || [entidadeAtiva] };
  if (isAdminPlataforma) claims.adminPlataforma = true;
  return { claims, escopo };
}

router.get(
  '/regularizadas',
  requireModuloAtivo('validacao_xml'),
  requirePermission('validacao_xml.validar'),
  async (req, res) => {
    try {
      const ctx = await resolverContexto(req, res, 'validacao_xml.validar');
      if (!ctx) return;

      const partes = ['regularizada_em=not.is.null'];
      // 🔴 FILTRO DE ESCOPO EXPLÍCITO, DE PROPÓSITO. A `EnvioMassa` tem RLS
      // ligado, mas a policy é `policy_envioemmassa ... USING (true)`: ela NÃO
      // filtra nada, qualquer role autenticado vê todos os tenants. Confiar no
      // RLS faria o operador da Movee ver regularizações de outros clientes —
      // erro que não dá erro, a tela só mostra demais. Não "simplifique".
      if (ctx.escopo) partes.push(`id_empresa=in.(${ctx.escopo.join(',')})`);
      partes.push('select=id,nome,cnpj_prestador,valor,dt_inicial,dt_final,regularizada_em,nota_ok,erro_validacao');
      partes.push('order=regularizada_em.desc');

      const { data, total } = await hubPostgrestRequest(
        `EnvioMassa?${partes.join('&')}`, 'GET', null, ctx.claims,
        { count: true, range: { from: 0, to: LIMITE_REGULARIZADAS - 1 } }
      );
      const itens = (data || []).slice(0, LIMITE_REGULARIZADAS).map(mapRegularizada);
      return res.status(200).json({ itens, total: total ?? itens.length, limite: LIMITE_REGULARIZADAS });
    } catch (e) {
      console.error('[hub-validacao-xml] erro em GET /regularizadas:', e.message);
      return res.status(500).json({ erro: 'ERRO_SERVIDOR' });
    }
  }
);

module.exports = { router, notaAprovada, mapRegularizada, LIMITE_REGULARIZADAS };

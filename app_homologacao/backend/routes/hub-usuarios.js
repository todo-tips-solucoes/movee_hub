// hub-auditoria-admin (S9) — routes/hub-usuarios.js
//
// GET/POST/PUT /api/v1/usuarios, POST/PUT /api/v1/usuarios/:id/vinculos.
// Ref: docs/specs/hub-auditoria-admin/contracts/usuarios-api.md, spec.md
// FR-009/FR-011, tasks.md FASE 4.2.
//
// Arquivo 100% NOVO — nenhuma linha de server.js legado é editada (mesmo
// padrão de routes/hub-faturamento.js/hub-motoristas.js). Todas as rotas sob
// requireModuloAtivo('usuarios') + requirePermission('usuarios.gerenciar') +
// checagem por-entidade (obterPermissoesEfetivasPorEntidade). Escopo:
// admin_entidade opera SOMENTE a entidade_ativa; admin_plataforma (claim)
// opera qualquer entidade.
'use strict';

const express = require('express');
const bcrypt = require('bcrypt');
const rateLimit = require('express-rate-limit');

const { decodificarAccessToken, lerAccessTokenDoRequest } = require('../lib/hub-access-token');
const { hubPostgrestRequest } = require('../lib/hub-postgrest');
const {
  obterPermissoesEfetivasPorEntidade,
  usuarioEhAdminPlataforma,
  alvoTemPapelRestritoAtivo,
  invalidarUsuario,
} = require('../lib/hub-rbac-cache');
const { requirePermission } = require('../middleware/hub-require-permission');
const { requireModuloAtivo } = require('../middleware/hub-require-modulo');
const { registrarAuditoria } = require('../lib/hub-auditoria');
const { buscarNomesEntidades } = require('../lib/hub-entidade-nome');
const { papelEhRestrito } = require('../lib/hub-papeis-restritos');
const {
  TTL_CONVITE_MS,
  gerarTokenBruto,
  hashToken,
  enviarLinkSenha,
} = require('../lib/hub-convite-senha');

const router = express.Router();

const PAGE_SIZE_DEFAULT = 20;
const PAGE_SIZE_MAX = 100;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ────────────────────────────────────────────────────────────────────────────
// Helpers puros (testáveis sem PostgREST real)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Mesma regra de força de senha do painel (contracts/usuarios-api.md
 * "isStrongPassword, padrão do painel") —
 * app_homologacao/frontend_v2/app/register/page.tsx:60:
 * `v.length >= 6 && /[A-Z]/.test(v) && /\d/.test(v)`. Espelhada aqui
 * server-side (POST /usuarios e PUT /usuarios/:id nunca confiam só na
 * validação client-side).
 * @param {*} senha
 * @returns {boolean}
 */
function isStrongPassword(senha) {
  return typeof senha === 'string' && senha.length >= 6 && /[A-Z]/.test(senha) && /\d/.test(senha);
}

/**
 * Há link de senha (convite ou recuperação) emitido e ainda dentro da
 * validade? Só a DATA é lida — o hash nunca sai do banco.
 * @param {*} expira valor de `Usuario.token_recuperacao_expira`
 * @param {Date} [agora]
 * @returns {boolean}
 */
function linkSenhaPendente(expira, agora = new Date()) {
  if (!expira) return false;
  const d = new Date(expira);
  return !Number.isNaN(d.getTime()) && d > agora;
}

/**
 * Paginação de `GET /usuarios` (contracts/usuarios-api.md): `page` >= 1
 * default 1; `pageSize` 1..100 default 20. Mesmo padrão de
 * `parsePaginacaoAuditoria` em routes/hub-me.js. NUNCA lança.
 * @param {object} query
 * @returns {{page:number, pageSize:number}}
 */
function parsePaginacaoUsuarios(query) {
  const q = query || {};
  const pageParsed = parseInt(q.page, 10);
  const page = Number.isFinite(pageParsed) && pageParsed >= 1 ? pageParsed : 1;
  const pageSizeParsed = parseInt(q.pageSize, 10);
  const pageSize = Number.isFinite(pageSizeParsed) && pageSizeParsed >= 1
    ? Math.min(pageSizeParsed, PAGE_SIZE_MAX)
    : PAGE_SIZE_DEFAULT;
  return { page, pageSize };
}

/**
 * Resolve a entidade-ALVO da operação a partir de um parâmetro opcional
 * (`entidadeId` do query/body) — contracts/usuarios-api.md "SÓ
 * admin_plataforma pode divergir da ativa". `entidadeIdParam === null`
 * significa "não informado" -> usa a entidade ativa da sessão. Sem o claim
 * `admin_plataforma`, qualquer divergência responde 403 PERMISSAO_NEGADA e
 * retorna `undefined` (sentinela de erro já respondido — distinto de um
 * `entidadeId` válido, que é sempre um número).
 * @param {import('express').Response} res
 * @param {{entidadeAtiva:number, isAdminPlataforma:boolean}} ctx
 * @param {number|null} entidadeIdParam
 * @returns {number|undefined}
 */
function resolverEntidadeAlvo(res, ctx, entidadeIdParam) {
  if (entidadeIdParam === null) return ctx.entidadeAtiva;
  if (!ctx.isAdminPlataforma && entidadeIdParam !== ctx.entidadeAtiva) {
    res.status(403).json({ erro: 'PERMISSAO_NEGADA' });
    return undefined;
  }
  return entidadeIdParam;
}

/**
 * Resolve payload+entidadeAtiva+isAdminPlataforma do accessToken e confirma
 * que a ENTIDADE ATIVA concede `usuarios.gerenciar` (mesmo padrão de
 * routes/hub-faturamento.js#resolverContextoEntidade). Envia a resposta de
 * erro e retorna `null` em caso de falha (401/403); retorna o contexto em
 * caso de sucesso.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {Promise<{payload:object, entidadeAtiva:number,
 *   isAdminPlataforma:boolean}|null>}
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
  return { payload, entidadeAtiva, isAdminPlataforma };
}

/**
 * Claims padrão de `hubPostgrestRequest` para uma operação escopada à
 * entidade `entidadeAlvo` — inclui `adminPlataforma` só quando verificado
 * no request corrente (nunca de input do cliente, gate owasp).
 * @param {{payload:object, isAdminPlataforma:boolean}} ctx
 * @param {number} entidadeAlvo
 * @returns {object}
 */
function montarClaims(ctx, entidadeAlvo) {
  const claims = { usuarioId: ctx.payload.sub, empresaAtiva: entidadeAlvo, escopo: [entidadeAlvo] };
  if (ctx.isAdminPlataforma) claims.adminPlataforma = true;
  return claims;
}

/**
 * 403 padrão da trava de papel restrito (contracts/hub-usuarios-trava.md).
 * @param {import('express').Response} res
 */
function negarPapelRestrito(res) {
  return res.status(403).json({
    erro: 'PAPEL_RESTRITO',
    mensagem: 'Somente o administrador da plataforma pode conceder, alterar ou desativar este papel.',
  });
}

/**
 * Auditoria de recusa por papel restrito (FR-012, contracts/hub-usuarios-
 * trava.md) — SEM dado pessoal (nome/email/senha), só ids + motivo + rota.
 * Best-effort (mesmo padrão de registrarAuditoria no resto do arquivo —
 * nunca deve impedir a resposta 403 já decidida).
 * @param {{idEmpresa:number, usuarioId:number, rota:string,
 *   usuarioAlvoId:number|null, papelSolicitadoId?:number|null,
 *   papelAtualId?:number|null, claims:object, ip:*}} p
 */
async function auditarPapelRestrito(p) {
  await registrarAuditoria({
    idEmpresa: p.idEmpresa,
    usuarioId: p.usuarioId,
    acao: 'usuario_vinculo_negado',
    recurso: 'UsuarioEntidade',
    recursoId: null,
    detalhes: {
      motivo: 'PAPEL_RESTRITO',
      rota: p.rota,
      usuarioAlvoId: p.usuarioAlvoId ?? null,
      papelSolicitadoId: p.papelSolicitadoId ?? null,
      papelAtualId: p.papelAtualId ?? null,
    },
    ip: p.ip || null,
    claims: p.claims,
  });
}

// ────────────────────────────────────────────────────────────────────────────
// GET /usuarios (task 4.2.2)
// ────────────────────────────────────────────────────────────────────────────

router.get('/', requireModuloAtivo('usuarios'), requirePermission('usuarios.gerenciar'), async (req, res) => {
  try {
    const ctx = await resolverContexto(req, res);
    if (!ctx) return;

    const entidadeIdBruto = req.query.entidadeId;
    let entidadeIdParam = null;
    if (entidadeIdBruto !== undefined && entidadeIdBruto !== '') {
      const parsed = Number(entidadeIdBruto);
      if (!Number.isInteger(parsed)) return res.status(400).json({ erro: 'DADOS_INVALIDOS' });
      entidadeIdParam = parsed;
    }
    const entidadeAlvo = resolverEntidadeAlvo(res, ctx, entidadeIdParam);
    if (entidadeAlvo === undefined) return;

    const busca = typeof req.query.busca === 'string' ? req.query.busca.trim().toLowerCase() : '';
    const { page, pageSize } = parsePaginacaoUsuarios(req.query);

    const claims = montarClaims(ctx, entidadeAlvo);
    // UNIQUE(usuario_id, empresa_id) garante NO MÁXIMO 1 vínculo por pessoa
    // nesta entidade — a listagem abaixo é naturalmente 1 linha == 1 pessoa.
    const linhas = await hubPostgrestRequest(
      `UsuarioEntidade?empresa_id=eq.${entidadeAlvo}&select=id,ativo,papel:Papel(id,nome),usuario:Usuario(id,nome,email,ativo,token_recuperacao_expira,ultimo_login_em)`,
      'GET', null, claims
    );

    const nomesEntidades = await buscarNomesEntidades([entidadeAlvo], claims);
    const entidadeNome = nomesEntidades.get(entidadeAlvo) || null;

    let usuarios = (linhas || [])
      .filter((v) => v && v.usuario)
      .map((v) => ({
        id: v.usuario.id,
        nome: v.usuario.nome,
        email: v.usuario.email,
        ativo: v.usuario.ativo,
        // Dois fatos DIFERENTES, que o produto confundia:
        //  - linkSenhaPendente: há link de senha válido agora. Acende para
        //    quem foi convidado E para quem já usava o hub e pediu "esqueci
        //    minha senha" (as duas coisas gravam as mesmas colunas) — por
        //    isso o rótulo fala do LINK, não de "nunca acessou".
        //  - nuncaAcessou: nenhum login registrado em `ultimo_login_em`.
        //    ⚠️ A coluna (0105) é NULL para quem já existia antes dela, então
        //    nos primeiros dias o selo também acende para quem acessa o hub
        //    há tempos; ele se corrige no próximo login de cada pessoa.
        // Uma pessoa pode ter os dois, um ou nenhum; a ação (reenviar) é a
        // mesma, mas o selo conta a história certa.
        linkSenhaPendente: linkSenhaPendente(v.usuario.token_recuperacao_expira),
        nuncaAcessou: !v.usuario.ultimo_login_em,
        vinculo: {
          id: v.id,
          entidadeId: entidadeAlvo,
          entidadeNome,
          papelId: v.papel ? v.papel.id : null,
          papel: v.papel ? v.papel.nome : null,
          ativo: v.ativo,
        },
      }));

    if (busca) {
      usuarios = usuarios.filter(
        (u) => (u.nome || '').toLowerCase().includes(busca) || (u.email || '').toLowerCase().includes(busca)
      );
    }
    usuarios.sort((a, b) => (a.nome || '').localeCompare(b.nome || ''));

    const total = usuarios.length;
    const from = (page - 1) * pageSize;
    const pagina = usuarios.slice(from, from + pageSize).map((u) => ({
      id: u.id, nome: u.nome, email: u.email, ativo: u.ativo,
      linkSenhaPendente: u.linkSenhaPendente, nuncaAcessou: u.nuncaAcessou, vinculos: [u.vinculo],
    }));

    return res.status(200).json({ usuarios: pagina, total, page, pageSize });
  } catch (e) {
    console.error('[hub-usuarios] erro em GET /usuarios:', e.message);
    return res.status(500).json({ erro: 'ERRO_SERVIDOR' });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// POST /usuarios (task 4.2.3) — cria usuário + 1º vínculo em um passo (SC-008)
// ────────────────────────────────────────────────────────────────────────────

router.post('/', requireModuloAtivo('usuarios'), requirePermission('usuarios.gerenciar'), async (req, res) => {
  try {
    const ctx = await resolverContexto(req, res);
    if (!ctx) return;

    const { nome, email, senha, vinculo } = req.body || {};
    if (!nome || typeof nome !== 'string' || !nome.trim()) {
      return res.status(400).json({ erro: 'DADOS_INVALIDOS' });
    }
    if (!email || typeof email !== 'string' || !EMAIL_RE.test(email)) {
      return res.status(400).json({ erro: 'DADOS_INVALIDOS' });
    }
    // `senha` é OPCIONAL desde 2026-09-29: sem ela o usuário nasce sem acesso
    // e recebe por e-mail um link para criar a própria senha (convite). Quando
    // vem, o comportamento antigo é preservado — a validação de força continua
    // valendo, inclusive para string vazia, que é senha fraca e não convite.
    const comSenha = senha !== undefined && senha !== null;
    if (comSenha && !isStrongPassword(senha)) {
      return res.status(400).json({ erro: 'SENHA_FRACA' });
    }
    if (!vinculo || typeof vinculo !== 'object') {
      return res.status(400).json({ erro: 'DADOS_INVALIDOS' });
    }
    const entidadeIdParam = Number(vinculo.entidadeId);
    const papelIdParam = Number(vinculo.papelId);
    if (!Number.isInteger(entidadeIdParam) || !Number.isInteger(papelIdParam)) {
      return res.status(400).json({ erro: 'DADOS_INVALIDOS' });
    }
    const entidadeAlvo = resolverEntidadeAlvo(res, ctx, entidadeIdParam);
    if (entidadeAlvo === undefined) return;

    // papelId existe no catálogo fixo? (dec-008 — Papel sem RLS, sem claims)
    const papeis = await hubPostgrestRequest(`Papel?id=eq.${papelIdParam}&select=id,nome`);
    if (!papeis || papeis.length === 0) {
      return res.status(400).json({ erro: 'PAPEL_NAO_ENCONTRADO' });
    }
    // Trava F2 (FR-009/FR-010, contracts/hub-usuarios-trava.md): só admin
    // plataforma concede papel restrito no 1º vínculo de um usuário novo.
    if (papelEhRestrito(papeis[0].nome) && !ctx.isAdminPlataforma) {
      await auditarPapelRestrito({
        idEmpresa: entidadeAlvo, usuarioId: ctx.payload.sub, rota: 'POST /usuarios',
        usuarioAlvoId: null, papelSolicitadoId: papelIdParam,
        claims: montarClaims(ctx, entidadeAlvo), ip: req.ip,
      });
      return negarPapelRestrito(res);
    }

    const emailNormalizado = email.trim();
    const existentes = await hubPostgrestRequest(`Usuario?email=eq.${encodeURIComponent(emailNormalizado)}&select=id`);
    if (existentes && existentes.length > 0) {
      return res.status(409).json({ erro: 'EMAIL_JA_CADASTRADO' });
    }

    // Sem senha: hash de um segredo aleatório que ninguém conhece (a coluna é
    // NOT NULL — migration 0002). A conta só fica acessível quando o convite
    // for usado; nenhum login intermediário é possível.
    const tokenConvite = comSenha ? null : gerarTokenBruto();
    const senhaHash = await bcrypt.hash(comSenha ? senha : gerarTokenBruto(), 10);
    let criados;
    try {
      criados = await hubPostgrestRequest('Usuario', 'POST', {
        nome: nome.trim(), email: emailNormalizado, senha_hash: senhaHash, ativo: true,
        ...(tokenConvite
          ? {
              token_recuperacao_hash: hashToken(tokenConvite),
              token_recuperacao_expira: new Date(Date.now() + TTL_CONVITE_MS).toISOString(),
            }
          : {}),
      });
    } catch (e) {
      if (e.status === 409) return res.status(409).json({ erro: 'EMAIL_JA_CADASTRADO' });
      throw e;
    }
    const novoUsuario = criados && criados[0];
    if (!novoUsuario) {
      return res.status(500).json({ erro: 'ERRO_SERVIDOR' });
    }

    const claims = montarClaims(ctx, entidadeAlvo);
    let novoVinculo;
    try {
      const vinculosCriados = await hubPostgrestRequest('UsuarioEntidade', 'POST', {
        usuario_id: novoUsuario.id, empresa_id: entidadeAlvo, papel_id: papelIdParam, ativo: true,
      }, claims);
      novoVinculo = vinculosCriados && vinculosCriados[0];
    } catch (e) {
      if (e.status === 409) return res.status(409).json({ erro: 'VINCULO_JA_EXISTE' });
      throw e;
    }

    invalidarUsuario(novoUsuario.id);

    // Convite: só DEPOIS do vínculo, para não chamar alguém que ficaria sem
    // entidade. Falha de envio não desfaz a criação — a resposta diz que o
    // e-mail não saiu e quem criou reenvia pelo "esqueci minha senha".
    let conviteEnviado = null;
    if (tokenConvite) {
      const envio = await enviarLinkSenha({
        para: novoUsuario.email, nome: novoUsuario.nome, tokenBruto: tokenConvite, tipo: 'convite',
      });
      conviteEnviado = envio.ok;
      if (!envio.ok) {
        console.error('[hub-usuarios] convite nao enviado para usuario', novoUsuario.id, '-', envio.erro);
      }
    }

    // Auditoria: NUNCA senha/hash em `detalhes` (scrub por chave já cobre,
    // mas nem sequer incluímos aqui — defesa em profundidade). E-mail
    // também fica de fora de propósito (dec-029, scrubDetalhes por VALOR).
    await registrarAuditoria({
      idEmpresa: entidadeAlvo,
      usuarioId: ctx.payload.sub,
      acao: 'usuario_criado',
      recurso: 'Usuario',
      recursoId: novoUsuario.id,
      detalhes: {
        nome: nome.trim(), papelId: papelIdParam, papel: papeis[0].nome,
        ...(tokenConvite ? { conviteEnviado } : {}),
      },
      ip: req.ip,
      claims,
    });

    const nomesEntidades = await buscarNomesEntidades([entidadeAlvo], claims);

    return res.status(201).json({
      conviteEnviado,
      usuario: {
        id: novoUsuario.id,
        nome: novoUsuario.nome,
        email: novoUsuario.email,
        vinculos: novoVinculo
          ? [{
              id: novoVinculo.id,
              entidadeId: entidadeAlvo,
              entidadeNome: nomesEntidades.get(entidadeAlvo) || null,
              papelId: papelIdParam,
              papel: papeis[0].nome,
              ativo: true,
            }]
          : [],
      },
    });
  } catch (e) {
    console.error('[hub-usuarios] erro em POST /usuarios:', e.message);
    return res.status(500).json({ erro: 'ERRO_SERVIDOR' });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// PUT /usuarios/:id (task 4.2.4) — edita nome/ativo/senha (CHK033: desativar
// é `ativo:false`, JAMAIS DELETE de linha)
// ────────────────────────────────────────────────────────────────────────────

router.put('/:id', requireModuloAtivo('usuarios'), requirePermission('usuarios.gerenciar'), async (req, res) => {
  try {
    const ctx = await resolverContexto(req, res);
    if (!ctx) return;

    const usuarioId = Number(req.params.id);
    if (!Number.isInteger(usuarioId)) return res.status(400).json({ erro: 'DADOS_INVALIDOS' });

    // Confirma vínculo VISÍVEL no escopo do chamador — 404 se fora do
    // escopo (não vaza existência cross-tenant, contracts/usuarios-api.md).
    const filtroEscopo = ctx.isAdminPlataforma ? '' : `&empresa_id=eq.${ctx.entidadeAtiva}`;
    const claimsLeitura = montarClaims(ctx, ctx.entidadeAtiva);
    const vinculosVisiveis = await hubPostgrestRequest(
      `UsuarioEntidade?usuario_id=eq.${usuarioId}${filtroEscopo}&select=id,ativo,papel:Papel(nome)`,
      'GET', null, claimsLeitura
    );
    if (!vinculosVisiveis || vinculosVisiveis.length === 0) {
      return res.status(404).json({ erro: 'USUARIO_NAO_ENCONTRADO' });
    }

    const { nome, ativo, senha } = req.body || {};
    const patch = {};
    if (nome !== undefined) {
      if (typeof nome !== 'string' || !nome.trim()) return res.status(400).json({ erro: 'DADOS_INVALIDOS' });
      patch.nome = nome.trim();
    }
    if (ativo !== undefined) {
      if (typeof ativo !== 'boolean') return res.status(400).json({ erro: 'DADOS_INVALIDOS' });
      patch.ativo = ativo;
    }
    if (senha !== undefined) {
      if (!isStrongPassword(senha)) return res.status(400).json({ erro: 'SENHA_FRACA' });
      patch.senha_hash = await bcrypt.hash(senha, 10);
    }
    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ erro: 'DADOS_INVALIDOS' });
    }

    // Trava F2 (FR-012a): senha/nome/ativo de alvo com vínculo ATIVO em
    // papel restrito EM QUALQUER EMPRESA só pode ser alterado por admin
    // plataforma — vale mesmo quando o alvo é o próprio chamador (a
    // checagem não distingue). Leitura PRIVILEGIADA e SEPARADA da consulta
    // de visibilidade acima (`vinculosVisiveis` continua só para o 404
    // anti-vazamento) — correção pós-review (block-009/dec-075): a trava
    // antiga reusava `vinculosVisiveis`, que é filtrada por
    // `empresa_id=eq.entidadeAtiva` DO CHAMADOR e lida com claims escopadas
    // a essa mesma entidade, então um vínculo restrito do alvo em OUTRA
    // entidade nunca era enxergado (ver `alvoTemPapelRestritoAtivo`).
    const temVinculoRestritoAtivo = await alvoTemPapelRestritoAtivo(usuarioId);
    if (temVinculoRestritoAtivo && !ctx.isAdminPlataforma) {
      await auditarPapelRestrito({
        idEmpresa: ctx.entidadeAtiva, usuarioId: ctx.payload.sub, rota: 'PUT /usuarios/:id',
        usuarioAlvoId: usuarioId, claims: claimsLeitura, ip: req.ip,
      });
      return negarPapelRestrito(res);
    }

    const atualizados = await hubPostgrestRequest(`Usuario?id=eq.${usuarioId}`, 'PATCH', patch);
    const usuarioAtualizado = atualizados && atualizados[0];
    if (!usuarioAtualizado) {
      return res.status(404).json({ erro: 'USUARIO_NAO_ENCONTRADO' });
    }

    invalidarUsuario(usuarioId);

    await registrarAuditoria({
      idEmpresa: ctx.entidadeAtiva,
      usuarioId: ctx.payload.sub,
      acao: 'usuario_editado',
      recurso: 'Usuario',
      recursoId: usuarioId,
      detalhes: { camposAlterados: Object.keys(patch).filter((k) => k !== 'senha_hash') },
      ip: req.ip,
      claims: claimsLeitura,
    });

    return res.status(200).json({
      usuario: {
        id: usuarioAtualizado.id, nome: usuarioAtualizado.nome, email: usuarioAtualizado.email, ativo: usuarioAtualizado.ativo,
      },
    });
  } catch (e) {
    console.error('[hub-usuarios] erro em PUT /usuarios/:id:', e.message);
    return res.status(500).json({ erro: 'ERRO_SERVIDOR' });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// POST /usuarios/:id/convite (2026-09-29) — reenvia o link de criar senha
//
// Sem isto, o convite que se perde (spam, e-mail digitado errado, apagado sem
// ler) tinha duas saídas ruins: o admin definir uma senha pela edição — o
// hábito que o convite veio tirar — ou orientar a pessoa a usar o "esqueci
// minha senha", que ela não procura porque não sabe que tem conta.
//
// Gera token NOVO e sobrescreve o pendente: o link antigo morre na hora, que é
// o que se espera de um reenvio.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Gera token NOVO (o anterior morre), grava, envia o e-mail e audita. Recebe o
 * `alvo` já carregado e validado (escopo, papel restrito, ativo) por quem chama.
 * @param {{usuarioId:number, alvo:{email:string,nome:string}, ctx:object, claims:object, ip:*}} p
 * @returns {Promise<{ok:true}|{ok:false, motivo:'EMAIL_NAO_ENVIADO'}>}
 */
async function reenviarConviteDe({ usuarioId, alvo, ctx, claims, ip }) {
  const tokenBruto = gerarTokenBruto();
  await hubPostgrestRequest(`Usuario?id=eq.${usuarioId}`, 'PATCH', {
    token_recuperacao_hash: hashToken(tokenBruto),
    token_recuperacao_expira: new Date(Date.now() + TTL_CONVITE_MS).toISOString(),
  });

  const envio = await enviarLinkSenha({
    para: alvo.email, nome: alvo.nome, tokenBruto, tipo: 'convite',
  });

  await registrarAuditoria({
    idEmpresa: ctx.entidadeAtiva,
    usuarioId: ctx.payload.sub,
    acao: 'convite_reenviado',
    recurso: 'Usuario',
    recursoId: usuarioId,
    detalhes: { conviteEnviado: envio.ok },
    ip,
    claims,
  });

  if (!envio.ok) {
    // O token JÁ foi gravado: o link antigo morreu e o novo não chegou.
    // Dizer isso em voz alta é melhor que um 200 mentiroso — quem opera
    // tenta de novo, e cada tentativa emite um link novo.
    console.error('[hub-usuarios] reenvio de convite nao entregue ao usuario', usuarioId, '-', envio.erro);
    return { ok: false, motivo: 'EMAIL_NAO_ENVIADO' };
  }
  return { ok: true };
}

router.post('/:id/convite', requireModuloAtivo('usuarios'), requirePermission('usuarios.gerenciar'), async (req, res) => {
  try {
    const ctx = await resolverContexto(req, res);
    if (!ctx) return;

    const usuarioId = Number(req.params.id);
    if (!Number.isInteger(usuarioId)) return res.status(400).json({ erro: 'DADOS_INVALIDOS' });

    // 404 (não 403) fora do escopo — mesma regra do PUT: não vaza existência
    // cross-tenant.
    const filtroEscopo = ctx.isAdminPlataforma ? '' : `&empresa_id=eq.${ctx.entidadeAtiva}`;
    const claims = montarClaims(ctx, ctx.entidadeAtiva);
    const vinculosVisiveis = await hubPostgrestRequest(
      `UsuarioEntidade?usuario_id=eq.${usuarioId}${filtroEscopo}&select=id`,
      'GET', null, claims
    );
    if (!vinculosVisiveis || vinculosVisiveis.length === 0) {
      return res.status(404).json({ erro: 'USUARIO_NAO_ENCONTRADO' });
    }

    // Mesma trava do PUT (FR-012a): emitir link de senha para alvo com papel
    // restrito é poder equivalente a trocar a senha dele — só admin
    // plataforma. Leitura privilegiada, cobre vínculo restrito em QUALQUER
    // entidade.
    const alvoRestrito = await alvoTemPapelRestritoAtivo(usuarioId);
    if (alvoRestrito && !ctx.isAdminPlataforma) {
      await auditarPapelRestrito({
        idEmpresa: ctx.entidadeAtiva, usuarioId: ctx.payload.sub, rota: 'POST /usuarios/:id/convite',
        usuarioAlvoId: usuarioId, claims, ip: req.ip,
      });
      return negarPapelRestrito(res);
    }

    const alvos = await hubPostgrestRequest(`Usuario?id=eq.${usuarioId}&select=id,nome,email,ativo`);
    const alvo = alvos && alvos[0];
    if (!alvo) return res.status(404).json({ erro: 'USUARIO_NAO_ENCONTRADO' });
    // Conta desativada não entra nem com senha nova — reenviar mandaria a
    // pessoa para uma porta trancada.
    if (alvo.ativo === false) return res.status(409).json({ erro: 'USUARIO_INATIVO' });

    const r = await reenviarConviteDe({ usuarioId, alvo, ctx, claims, ip: req.ip });
    if (!r.ok) return res.status(502).json({ erro: r.motivo });

    return res.status(200).json({ ok: true, conviteEnviado: true });
  } catch (e) {
    console.error('[hub-usuarios] erro em POST /usuarios/:id/convite:', e.message);
    return res.status(500).json({ erro: 'ERRO_SERVIDOR' });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// POST /usuarios/convites — reenvio em lote
//
// Mesmo efeito da rota individual, por alvo: token novo (o link anterior morre)
// e um e-mail. Cada alvo que a individual recusaria é PULADO e relatado, nunca
// derruba o lote — e a trava de papel restrito vale por alvo, sem afrouxar.
// ────────────────────────────────────────────────────────────────────────────

const LOTE_MAX = 50;

// 10 req × 50 alvos = teto de 500 e-mails por janela; o caso real (~200
// pendentes, 4 lotes de 50) cabe com folga. O teto por requisição existe porque cada
// reenvio é um e-mail (o Resend tem limite de taxa e 200 e-mails numa
// requisição estourariam o timeout HTTP). A chave é o USUÁRIO autenticado:
// vários operadores atrás do mesmo IP não podem se bloquear entre si.
const conviteLoteRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => String(req.hubUsuarioId || req.ip),
  handler: (_req, res) => {
    res.status(429).json({ erro: 'LIMITE_EXCEDIDO' });
  },
});

router.post(
  '/convites',
  requireModuloAtivo('usuarios'),
  requirePermission('usuarios.gerenciar'),
  conviteLoteRateLimiter,
  async (req, res) => {
    try {
      const ctx = await resolverContexto(req, res);
      if (!ctx) return;

      // Só `usuarioIds`. A forma "todos os pendentes da entidade" foi
      // considerada e RECUSADA DE PROPÓSITO: cada reenvio manda e-mail e mata o
      // link anterior da pessoa, e um caminho sem chamador que faz isso em
      // massa estrearia em produção sem nunca ter rodado. A tela já cobre o caso
      // (seleção manual + pendentes da página, uma página por clique). Não é
      // esquecimento — não reintroduzir sem um chamador real.
      const bruto = (req.body || {}).usuarioIds;
      if (!Array.isArray(bruto) || bruto.length === 0 || !bruto.every((n) => Number.isInteger(n) && n > 0)) {
        return res.status(400).json({ erro: 'DADOS_INVALIDOS' });
      }
      if (bruto.length > LOTE_MAX) return res.status(400).json({ erro: 'LOTE_GRANDE', limite: LOTE_MAX });
      const ids = [...new Set(bruto)];
      const claims = montarClaims(ctx, ctx.entidadeAtiva);

      const resultado = [];
      // `in.()` com lista grande estoura o header do PostgREST (já houve
      // incidente): é o teto de LOTE_MAX que mantém estas duas consultas seguras.
      const lista = ids.join(',');
      const filtroEscopo = ctx.isAdminPlataforma ? '' : `&empresa_id=eq.${ctx.entidadeAtiva}`;
      const [vinculos, usuarios] = await Promise.all([
        hubPostgrestRequest(`UsuarioEntidade?usuario_id=in.(${lista})${filtroEscopo}&select=usuario_id`, 'GET', null, claims),
        hubPostgrestRequest(`Usuario?id=in.(${lista})&select=id,nome,email,ativo`),
      ]);
      const noEscopo = new Set((vinculos || []).map((v) => v.usuario_id));
      const porId = new Map((usuarios || []).map((u) => [u.id, u]));

      // E-mails em SEQUÊNCIA, nunca em paralelo: paralelo estoura o limite
      // de taxa do Resend.
      for (const usuarioId of ids) {
        const pular = (motivo) => resultado.push({ usuarioId, status: 'pulado', motivo });
        if (!noEscopo.has(usuarioId)) { pular('USUARIO_NAO_ENCONTRADO'); continue; }

        // ⚠️ A checagem de papel restrito é POR ALVO DE PROPÓSITO. A leitura
        // "em qualquer entidade" só é possível impersonando o alvo (RLS de
        // UsuarioEntidade: sub próprio, escopo do chamador ou admin
        // plataforma), então não há consulta única para N alvos sem emitir
        // privilégio de admin para quem não é — e esta é a trava que impede
        // escalada. O custo é limitado pelo teto de LOTE_MAX (50 leituras
        // locais, bem menos que os 50 e-mails seguintes: o SMTP é o gargalo).
        // Quem for "otimizar" com RPC SECURITY DEFINER ou claim nova: não.
        // (alvoTemPapelRestritoAtivo não tem cache, cada chamada vai ao banco.)
        if (!ctx.isAdminPlataforma && (await alvoTemPapelRestritoAtivo(usuarioId))) {
          await auditarPapelRestrito({
            idEmpresa: ctx.entidadeAtiva, usuarioId: ctx.payload.sub, rota: 'POST /usuarios/convites',
            usuarioAlvoId: usuarioId, claims, ip: req.ip,
          });
          pular('PAPEL_RESTRITO');
          continue;
        }

        const alvo = porId.get(usuarioId);
        if (!alvo) { pular('USUARIO_NAO_ENCONTRADO'); continue; }
        if (alvo.ativo === false) { pular('USUARIO_INATIVO'); continue; }

        try {
          const r = await reenviarConviteDe({ usuarioId, alvo, ctx, claims, ip: req.ip });
          if (r.ok) resultado.push({ usuarioId, status: 'enviado' });
          else pular(r.motivo);
        } catch (e) {
          // Um alvo com falha de infra não pode esconder o relatório dos demais.
          console.error('[hub-usuarios] erro no convite em lote, usuario', usuarioId, '-', e.message);
          pular('ERRO_SERVIDOR');
        }
      }

      const enviados = resultado.filter((r) => r.status === 'enviado').length;
      return res.status(200).json({ enviados, pulados: resultado.length - enviados, resultado });
    } catch (e) {
      console.error('[hub-usuarios] erro em POST /usuarios/convites:', e.message);
      return res.status(500).json({ erro: 'ERRO_SERVIDOR' });
    }
  }
);

// ────────────────────────────────────────────────────────────────────────────
// POST /usuarios/:id/vinculos (task 4.2.5) — novo vínculo a usuário existente
// ────────────────────────────────────────────────────────────────────────────

router.post('/:id/vinculos', requireModuloAtivo('usuarios'), requirePermission('usuarios.gerenciar'), async (req, res) => {
  try {
    const ctx = await resolverContexto(req, res);
    if (!ctx) return;

    const usuarioId = Number(req.params.id);
    if (!Number.isInteger(usuarioId)) return res.status(400).json({ erro: 'DADOS_INVALIDOS' });

    const { entidadeId, papelId } = req.body || {};
    const entidadeIdParam = Number(entidadeId);
    const papelIdParam = Number(papelId);
    if (!Number.isInteger(entidadeIdParam) || !Number.isInteger(papelIdParam)) {
      return res.status(400).json({ erro: 'DADOS_INVALIDOS' });
    }
    const entidadeAlvo = resolverEntidadeAlvo(res, ctx, entidadeIdParam);
    if (entidadeAlvo === undefined) return;

    const papeis = await hubPostgrestRequest(`Papel?id=eq.${papelIdParam}&select=id,nome`);
    if (!papeis || papeis.length === 0) return res.status(400).json({ erro: 'PAPEL_NAO_ENCONTRADO' });
    // Trava F2: só admin plataforma cria vínculo com papel restrito.
    if (papelEhRestrito(papeis[0].nome) && !ctx.isAdminPlataforma) {
      await auditarPapelRestrito({
        idEmpresa: entidadeAlvo, usuarioId: ctx.payload.sub, rota: 'POST /usuarios/:id/vinculos',
        usuarioAlvoId: usuarioId, papelSolicitadoId: papelIdParam,
        claims: montarClaims(ctx, entidadeAlvo), ip: req.ip,
      });
      return negarPapelRestrito(res);
    }

    const usuariosExistentes = await hubPostgrestRequest(`Usuario?id=eq.${usuarioId}&select=id`);
    if (!usuariosExistentes || usuariosExistentes.length === 0) {
      return res.status(404).json({ erro: 'USUARIO_NAO_ENCONTRADO' });
    }

    const claims = montarClaims(ctx, entidadeAlvo);
    const existentes = await hubPostgrestRequest(
      `UsuarioEntidade?usuario_id=eq.${usuarioId}&empresa_id=eq.${entidadeAlvo}&select=id`,
      'GET', null, claims
    );
    if (existentes && existentes.length > 0) {
      return res.status(409).json({ erro: 'VINCULO_JA_EXISTE' });
    }

    let novoVinculo;
    try {
      const criados = await hubPostgrestRequest('UsuarioEntidade', 'POST', {
        usuario_id: usuarioId, empresa_id: entidadeAlvo, papel_id: papelIdParam, ativo: true,
      }, claims);
      novoVinculo = criados && criados[0];
    } catch (e) {
      if (e.status === 409) return res.status(409).json({ erro: 'VINCULO_JA_EXISTE' });
      throw e;
    }

    invalidarUsuario(usuarioId);

    await registrarAuditoria({
      idEmpresa: entidadeAlvo,
      usuarioId: ctx.payload.sub,
      acao: 'usuario_vinculo_criado',
      recurso: 'UsuarioEntidade',
      recursoId: novoVinculo ? novoVinculo.id : null,
      detalhes: { usuarioAlvoId: usuarioId, papelId: papelIdParam, papel: papeis[0].nome },
      ip: req.ip,
      claims,
    });

    const nomesEntidades = await buscarNomesEntidades([entidadeAlvo], claims);

    return res.status(201).json({
      vinculo: {
        id: novoVinculo.id,
        entidadeId: entidadeAlvo,
        entidadeNome: nomesEntidades.get(entidadeAlvo) || null,
        papelId: papelIdParam,
        papel: papeis[0].nome,
        ativo: true,
      },
    });
  } catch (e) {
    console.error('[hub-usuarios] erro em POST /usuarios/:id/vinculos:', e.message);
    return res.status(500).json({ erro: 'ERRO_SERVIDOR' });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// PUT /usuarios/:id/vinculos/:vinculoId (task 4.2.6) — troca papelId e/ou
// ativo (nunca DELETE — CHK033)
// ────────────────────────────────────────────────────────────────────────────

router.put('/:id/vinculos/:vinculoId', requireModuloAtivo('usuarios'), requirePermission('usuarios.gerenciar'), async (req, res) => {
  try {
    const ctx = await resolverContexto(req, res);
    if (!ctx) return;

    const usuarioId = Number(req.params.id);
    const vinculoId = Number(req.params.vinculoId);
    if (!Number.isInteger(usuarioId) || !Number.isInteger(vinculoId)) {
      return res.status(400).json({ erro: 'DADOS_INVALIDOS' });
    }

    const { papelId, ativo } = req.body || {};
    const patch = {};
    let papelNome = null;
    if (papelId !== undefined) {
      const papelIdParam = Number(papelId);
      if (!Number.isInteger(papelIdParam)) return res.status(400).json({ erro: 'DADOS_INVALIDOS' });
      const papeis = await hubPostgrestRequest(`Papel?id=eq.${papelIdParam}&select=id,nome`);
      if (!papeis || papeis.length === 0) return res.status(400).json({ erro: 'PAPEL_NAO_ENCONTRADO' });
      patch.papel_id = papelIdParam;
      papelNome = papeis[0].nome;
    }
    if (ativo !== undefined) {
      if (typeof ativo !== 'boolean') return res.status(400).json({ erro: 'DADOS_INVALIDOS' });
      patch.ativo = ativo;
    }
    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ erro: 'DADOS_INVALIDOS' });
    }

    // Localiza o vínculo DENTRO do escopo do chamador (nunca cross-tenant).
    const filtroEscopo = ctx.isAdminPlataforma ? '' : `&empresa_id=eq.${ctx.entidadeAtiva}`;
    const claimsLeitura = montarClaims(ctx, ctx.entidadeAtiva);
    const vinculosVisiveis = await hubPostgrestRequest(
      `UsuarioEntidade?id=eq.${vinculoId}&usuario_id=eq.${usuarioId}${filtroEscopo}&select=id,empresa_id,ativo,papel_id,papel:Papel(nome)`,
      'GET', null, claimsLeitura
    );
    if (!vinculosVisiveis || vinculosVisiveis.length === 0) {
      return res.status(404).json({ erro: 'USUARIO_NAO_ENCONTRADO' });
    }
    const vinculoAtual = vinculosVisiveis[0];

    // Trava F2 (FR-009/FR-010): só admin plataforma altera/desativa um
    // vínculo cujo papel ATUAL é restrito, OU atribui um papel NOVO restrito.
    const papelAtualRestrito = papelEhRestrito(vinculoAtual.papel ? vinculoAtual.papel.nome : null);
    const papelNovoRestrito = papelNome !== null && papelEhRestrito(papelNome);
    if ((papelAtualRestrito || papelNovoRestrito) && !ctx.isAdminPlataforma) {
      await auditarPapelRestrito({
        idEmpresa: vinculoAtual.empresa_id, usuarioId: ctx.payload.sub, rota: 'PUT /usuarios/:id/vinculos/:vinculoId',
        usuarioAlvoId: usuarioId, papelSolicitadoId: patch.papel_id ?? null, papelAtualId: vinculoAtual.papel_id,
        claims: montarClaims(ctx, vinculoAtual.empresa_id), ip: req.ip,
      });
      return negarPapelRestrito(res);
    }

    const claims = montarClaims(ctx, vinculoAtual.empresa_id);
    const atualizados = await hubPostgrestRequest(`UsuarioEntidade?id=eq.${vinculoId}`, 'PATCH', patch, claims);
    const vinculoAtualizado = atualizados && atualizados[0];
    if (!vinculoAtualizado) {
      return res.status(404).json({ erro: 'USUARIO_NAO_ENCONTRADO' });
    }

    // FR-011/SC-004 — SÍNCRONO, antes da resposta (fecha o gap: invalidarUsuario
    // existe desde a S2 mas estava órfão até esta feature).
    invalidarUsuario(usuarioId);

    if (patch.papel_id !== undefined) {
      await registrarAuditoria({
        idEmpresa: vinculoAtual.empresa_id,
        usuarioId: ctx.payload.sub,
        acao: 'usuario_papel_alterado',
        recurso: 'UsuarioEntidade',
        recursoId: vinculoId,
        detalhes: {
          usuarioAlvoId: usuarioId, papelAnteriorId: vinculoAtual.papel_id, papelNovoId: patch.papel_id, papelNovo: papelNome,
        },
        ip: req.ip,
        claims,
      });
    }
    if (patch.ativo !== undefined) {
      await registrarAuditoria({
        idEmpresa: vinculoAtual.empresa_id,
        usuarioId: ctx.payload.sub,
        acao: 'usuario_vinculo_desativado',
        recurso: 'UsuarioEntidade',
        recursoId: vinculoId,
        detalhes: { usuarioAlvoId: usuarioId, ativo: patch.ativo },
        ip: req.ip,
        claims,
      });
    }

    return res.status(200).json({
      vinculo: {
        id: vinculoAtualizado.id, entidadeId: vinculoAtualizado.empresa_id, papelId: vinculoAtualizado.papel_id, ativo: vinculoAtualizado.ativo,
      },
    });
  } catch (e) {
    console.error('[hub-usuarios] erro em PUT /usuarios/:id/vinculos/:vinculoId:', e.message);
    return res.status(500).json({ erro: 'ERRO_SERVIDOR' });
  }
});

module.exports = {
  router,
  // exportados para testes unitários
  isStrongPassword,
  linkSenhaPendente,
  parsePaginacaoUsuarios,
  resolverEntidadeAlvo,
};

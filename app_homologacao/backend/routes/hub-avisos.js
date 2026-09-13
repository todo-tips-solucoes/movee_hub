/**
 * hub-avisos (push-motorista, FASE 4 — tasks.md 4.1/4.2/4.3) —
 * routes/hub-avisos.js
 *
 * Rotas do hub para o módulo Avisos (notificações push para o app
 * motorista): leitura (lista, detalhe, alcance, destinatários, cobertura) e
 * criação/disparo. Arquivo 100% NOVO — nenhuma linha de outro router é
 * editada (mesmo padrão de routes/hub-motoristas.js/hub-importacoes.js).
 *
 * Cadeia de guarda (contracts/hub-avisos.md §Convenções, research Decision
 * 7), nesta ordem em TODA rota:
 *   1. requireModuloAtivo('avisos') -> 401 sem sessão / 403 MODULO_DESABILITADO
 *   2. requirePermission('avisos.consultar'|'avisos.enviar') -> 403 PERMISSAO_NEGADA
 *      (união flat de permissões, checagem de nível de rota)
 *   3. reconferência da MESMA permissão NA ENTIDADE ATIVA do token
 *      (resolverContextoAvisos, mesmo padrão de hub-motoristas.js#resolverContextoEntidade)
 *   4. mesmoGrupoQue(entidadeAtiva, 6, cache) -> 403 FORA_DO_GRUPO_MOVEE
 *
 * mitigação S5 (task 4.1.5): o claim `escopo` do JWT do PostgREST é montado
 * com TODOS os ids do grupo Movee (não só [entidadeAtiva]) — SÓ dentro deste
 * arquivo. `mesmoGrupoQue` (routes/grupo.js) já resolve e cacheia esse
 * conjunto (Grupo/Empresa) ao checar o pertencimento; reusamos o MESMO
 * resultado como `idsDoGrupo(6)` em vez de duplicar a consulta — o cache
 * populado é exatamente o conjunto que a RPC do banco (`6 = ANY(escopo)`)
 * espera. Nenhuma outra rota do hub é alterada para produzir esse escopo
 * amplo (o claim `[entidadeAtiva]` das demais rotas continua intocado).
 *
 * Ref: contracts/hub-avisos.md, data-model.md §Funções/§RLS, tasks.md FASE 4.
 */

'use strict';

const crypto = require('crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');

const { decodificarAccessToken, lerAccessTokenDoRequest } = require('../lib/hub-access-token');
const { requireModuloAtivo } = require('../middleware/hub-require-modulo');
const { requirePermission } = require('../middleware/hub-require-permission');
const { obterPermissoesEfetivasPorEntidade } = require('../lib/hub-rbac-cache');
const { mesmoGrupoQue } = require('./grupo');
const { hubPostgrestRequest } = require('../lib/hub-postgrest');
const { registrarAuditoria } = require('../lib/hub-auditoria');
const { buscarNomesEntidades } = require('../lib/hub-entidade-nome');
const { hubMotoristaLoginHabilitado } = require('../lib/hub-motorista-app-login');
const { getKeyAtual } = require('../lib/hub-push-vapid');
const { validarAviso, MODOS_VALIDOS, IDS_MAX } = require('../lib/hub-avisos-dto');
// FASE 5 (tasks.md 5.1/5.2, research.md Decision 4) — dispara o
// processamento fire-and-forget logo após a criação/reutilização do aviso,
// mesmo padrão de `processarImportacao(...).catch(...)` em
// routes/hub-importacoes.js:380-387.
const { processarAviso } = require('../lib/hub-push-worker');

const router = express.Router();

const GRUPO_MOVEE_ID = 6;
const PAGE_SIZE_PADRAO = 20;
const PAGE_SIZE_MAX = 100;
const BUSCA_MOTORISTA_MIN = 3;
const BUSCA_MOTORISTA_LIMITE = 20;

// ────────────────────────────────────────────────────────────────────────────
// Helpers de domínio (DUPLICADOS deliberadamente — mesmo padrão documentado em
// routes/hub-motoristas.js: cada arquivo de rota do hub mantém sua própria
// cópia de helpers pequenos, sem import cross-domain).
// ────────────────────────────────────────────────────────────────────────────

function idValido(raw) {
  return typeof raw === 'string' && /^\d+$/.test(raw);
}

function parsePaginacao(query) {
  let page = parseInt(query && query.page, 10);
  if (!Number.isInteger(page) || page < 1) page = 1;
  let pageSize = parseInt(query && query.pageSize, 10);
  if (!Number.isInteger(pageSize) || pageSize < 1) pageSize = PAGE_SIZE_PADRAO;
  if (pageSize > PAGE_SIZE_MAX) pageSize = PAGE_SIZE_MAX;
  return { page, pageSize };
}

/** CSV de inteiros positivos, 1..max itens; `null` se ausente/malformado. */
function parseIdsCsv(raw, max) {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const partes = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (partes.length === 0 || partes.length > max) return null;
  const ids = partes.map((p) => Number(p));
  if (!ids.every((n) => Number.isInteger(n) && n > 0)) return null;
  return ids;
}

/**
 * Log de recusa (task 4.3.1, FR-031): nunca o path/query completo (poderia
 * carregar `destinatariosIds`/termo de busca) nem dado sensível — só o
 * código da recusa e um prefixo de correlação de 8 hex (sha256 do
 * `originalUrl`, sem reversibilidade prática).
 * @param {import('express').Request} req
 * @param {string} codigo - `FORA_DO_GRUPO_MOVEE` | `DESTINATARIOS_FORA_DO_ESCOPO`
 */
function logRecusa(req, codigo) {
  const prefixo = crypto.createHash('sha256').update(req.originalUrl || '').digest('hex').slice(0, 8);
  console.warn(`[hub-avisos] recusa ${codigo} (req_hash=${prefixo})`);
}

/**
 * dec-097 — disparo duplo concorrente com a MESMA chaveIdempotencia: o
 * check-then-act de `hub_aviso_criar` (SELECT de existência + INSERT, não
 * atômico) deixa uma janela onde as duas sessões passam pelo SELECT antes de
 * qualquer uma commitar o INSERT. A UNIQUE (criado_por, chave_idempotencia)
 * resolve a corrida no banco: o perdedor recebe `unique_violation` (23505)
 * do PostgREST em vez do 200/201 idempotente esperado.
 * @param {Error & {body?: string}} e
 */
function isCorridaChaveIdempotencia(e) {
  const corpo = String((e && e.body) || '');
  return corpo.includes('23505') || corpo.includes('aviso_criado_por_chave_uniq');
}

/**
 * Resolve payload+entidadeAtiva, reconfirma `permissao` NA ENTIDADE ATIVA
 * (passo 3 da cadeia de guarda) e confirma que a entidade pertence ao grupo
 * Movee (passo 4, `mesmoGrupoQue`) — 403 `FORA_DO_GRUPO_MOVEE` se não. Envia
 * a resposta de erro e retorna `null` em qualquer falha; retorna o contexto
 * em caso de sucesso.
 * @returns {Promise<{payload:object, entidadeAtiva:number, claims:object}|null>}
 */
async function resolverContextoAvisos(req, res, permissao) {
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

  const permsEntidade = await obterPermissoesEfetivasPorEntidade(payload.sub, entidadeAtiva);
  if (!permsEntidade.has(permissao)) {
    res.status(403).json({ erro: 'PERMISSAO_NEGADA' });
    return null;
  }

  const grupoCache = {};
  const dentroDoGrupo = await mesmoGrupoQue(entidadeAtiva, GRUPO_MOVEE_ID, grupoCache);
  if (!dentroDoGrupo) {
    logRecusa(req, 'FORA_DO_GRUPO_MOVEE');
    res.status(403).json({ erro: 'FORA_DO_GRUPO_MOVEE' });
    return null;
  }

  // idsDoGrupo(6): `mesmoGrupoQue` já populou `grupoCache.ids` com TODOS os
  // ids do grupo Movee (não só entidadeAtiva) para poder responder o
  // pertencimento — reaproveitado aqui como o escopo do claim (mitigação S5).
  const escopo = [...grupoCache.ids];
  const claims = { usuarioId: payload.sub, empresaAtiva: entidadeAtiva, escopo };
  return { payload, entidadeAtiva, claims };
}

/**
 * Contagens por aviso via `hub_aviso_resumo` (1 chamada em lote, nunca N+1).
 * @param {number[]} avisoIds
 * @param {object} claims
 * @returns {Promise<Map<number, {visados:number,pendentes:number,processando:number,aceitos:number,falhas:number,mortas:number}>>}
 */
async function buscarResumoPorAviso(avisoIds, claims) {
  if (!avisoIds || avisoIds.length === 0) return new Map();
  const linhas = await hubPostgrestRequest(
    'rpc/hub_aviso_resumo', 'POST', { p_aviso_ids: avisoIds }, claims
  );
  const mapa = new Map();
  for (const r of (linhas || [])) {
    mapa.set(r.aviso_id, {
      visados: Number(r.visados) || 0,
      pendentes: Number(r.pendentes) || 0,
      processando: Number(r.processando) || 0,
      aceitos: Number(r.aceitos) || 0,
      falhas: Number(r.falhas) || 0,
      mortas: Number(r.mortas) || 0,
    });
  }
  return mapa;
}

// FR-027/S8 — rate limit dedicado por usuário (10/15min): GET /alcance e GET
// /destinatarios/motoristas (task 4.1.4) compartilham o mesmo balde — as duas
// são consultas de preparo do MESMO fluxo de disparo.
const consultaEnvioRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const payload = decodificarAccessToken(lerAccessTokenDoRequest(req));
    return payload && payload.sub ? String(payload.sub) : req.ip;
  },
  handler: (_req, res) => {
    res.status(429).json({ erro: 'LIMITE_EXCEDIDO' });
  },
});

// FR-027 — POST /avisos: 10/15min por usuário (task 4.2.3), balde PRÓPRIO
// (disparo é ação distinta de consulta de alcance/busca).
const disparoRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const payload = decodificarAccessToken(lerAccessTokenDoRequest(req));
    return payload && payload.sub ? String(payload.sub) : req.ip;
  },
  handler: (_req, res) => {
    res.status(429).json({ erro: 'LIMITE_EXCEDIDO' });
  },
});

// ────────────────────────────────────────────────────────────────────────────
// GET /avisos — lista paginada (task 4.1.1/4.1.3)
// ────────────────────────────────────────────────────────────────────────────

router.get('/', requireModuloAtivo('avisos'), requirePermission('avisos.consultar'), async (req, res) => {
  try {
    const ctx = await resolverContextoAvisos(req, res, 'avisos.consultar');
    if (!ctx) return;
    const { claims } = ctx;

    const { page, pageSize } = parsePaginacao(req.query);
    const from = (page - 1) * pageSize;
    const to = from + pageSize - 1;

    const { data: linhas, total } = await hubPostgrestRequest(
      'Aviso?select=id,titulo,status,modo_destinatarios,criado_em&order=criado_em.desc',
      'GET', null, claims, { count: true, range: { from, to } }
    );
    const rows = linhas || [];
    const resumoMap = await buscarResumoPorAviso(rows.map((r) => r.id), claims);

    const itens = rows.map((r) => {
      const c = resumoMap.get(r.id) || { visados: 0, pendentes: 0, aceitos: 0, falhas: 0, mortas: 0 };
      return {
        id: r.id,
        titulo: r.titulo,
        status: r.status,
        modoDestinatarios: r.modo_destinatarios,
        criadoEm: r.criado_em,
        contagens: { visados: c.visados, pendentes: c.pendentes, aceitos: c.aceitos, falhas: c.falhas, mortas: c.mortas },
      };
    });

    return res.status(200).json({ itens, total, page, pageSize });
  } catch (e) {
    console.error('[hub-avisos] erro em GET /avisos:', e.message);
    return res.status(500).json({ erro: 'ERRO_SERVIDOR' });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// GET /avisos/alcance (task 4.1.1, mitigação S8) — DECLARADA ANTES de
// `GET /:id` (Express casa rotas literais só se vierem antes do parâmetro).
// ────────────────────────────────────────────────────────────────────────────

router.get(
  '/alcance',
  requireModuloAtivo('avisos'),
  requirePermission('avisos.enviar'),
  consultaEnvioRateLimiter,
  async (req, res) => {
    try {
      const ctx = await resolverContextoAvisos(req, res, 'avisos.enviar');
      if (!ctx) return;
      const { claims } = ctx;

      const modo = req.query.modo;
      if (!MODOS_VALIDOS.includes(modo)) return res.status(400).json({ erro: 'DADOS_INVALIDOS' });

      let ids = [];
      if (modo !== 'toda_base') {
        const parsed = parseIdsCsv(req.query.ids, IDS_MAX);
        if (!parsed) return res.status(400).json({ erro: 'DADOS_INVALIDOS' });
        ids = parsed;
      }

      let chaveAtual;
      try {
        chaveAtual = getKeyAtual();
      } catch (e) {
        return res.status(503).json({ erro: 'PUSH_INDISPONIVEL' });
      }
      const fonteConta = hubMotoristaLoginHabilitado() ? 'conta_motorista' : 'legado';

      let linhas;
      try {
        linhas = await hubPostgrestRequest(
          'rpc/hub_aviso_alcance', 'POST',
          { p_modo: modo, p_ids: ids, p_key_id: chaveAtual.keyId, p_fonte_conta: fonteConta },
          claims
        );
      } catch (e) {
        const msg = String((e && e.body) || (e && e.message) || '');
        if (msg.includes('DESTINATARIOS_FORA_DO_ESCOPO')) {
          logRecusa(req, 'DESTINATARIOS_FORA_DO_ESCOPO');
          return res.status(403).json({ erro: 'DESTINATARIOS_FORA_DO_ESCOPO' });
        }
        throw e;
      }

      const rows = linhas || [];
      const motoristas = new Set(rows.map((r) => r.cnpj_prestador)).size;
      return res.status(200).json({ motoristas, inscricoes: rows.length });
    } catch (e) {
      console.error('[hub-avisos] erro em GET /avisos/alcance:', e.message);
      return res.status(500).json({ erro: 'ERRO_SERVIDOR' });
    }
  }
);

// ────────────────────────────────────────────────────────────────────────────
// GET /avisos/destinatarios/empresas (task 4.1.1)
// ────────────────────────────────────────────────────────────────────────────

router.get(
  '/destinatarios/empresas',
  requireModuloAtivo('avisos'),
  requirePermission('avisos.enviar'),
  async (req, res) => {
    try {
      const ctx = await resolverContextoAvisos(req, res, 'avisos.enviar');
      if (!ctx) return;
      const { claims } = ctx;

      const nomesMap = await buscarNomesEntidades(claims.escopo, claims);
      const empresas = claims.escopo
        .map((id) => ({ id, nome: nomesMap.get(id) || null }))
        .sort((a, b) => (a.nome || '').localeCompare(b.nome || '', 'pt-BR'));

      return res.status(200).json({ empresas });
    } catch (e) {
      console.error('[hub-avisos] erro em GET /avisos/destinatarios/empresas:', e.message);
      return res.status(500).json({ erro: 'ERRO_SERVIDOR' });
    }
  }
);

// ────────────────────────────────────────────────────────────────────────────
// GET /avisos/destinatarios/motoristas (task 4.1.1, mitigação S8)
// ────────────────────────────────────────────────────────────────────────────

router.get(
  '/destinatarios/motoristas',
  requireModuloAtivo('avisos'),
  requirePermission('avisos.enviar'),
  consultaEnvioRateLimiter,
  async (req, res) => {
    try {
      const ctx = await resolverContextoAvisos(req, res, 'avisos.enviar');
      if (!ctx) return;
      const { claims } = ctx;

      const buscaCrua = typeof req.query.busca === 'string' ? req.query.busca.trim() : '';
      if (buscaCrua.length < BUSCA_MOTORISTA_MIN) return res.status(200).json({ motoristas: [] });
      // Remove caracteres de wildcard do PostgREST (`*`) — a busca é sempre
      // "contém", nunca deixamos o termo do usuário injetar outro padrão.
      const termo = buscaCrua.replace(/[*%]/g, '');

      const linhas = await hubPostgrestRequest(
        `Entregador?id_empresa=in.(${claims.escopo.join(',')})&motorista_id=not.is.null`
        + `&nome=ilike.*${encodeURIComponent(termo)}*&select=id,nome&order=nome.asc&limit=${BUSCA_MOTORISTA_LIMITE}`,
        'GET', null, claims
      );
      return res.status(200).json({ motoristas: (linhas || []).map((r) => ({ id: r.id, nome: r.nome })) });
    } catch (e) {
      console.error('[hub-avisos] erro em GET /avisos/destinatarios/motoristas:', e.message);
      return res.status(500).json({ erro: 'ERRO_SERVIDOR' });
    }
  }
);

// ────────────────────────────────────────────────────────────────────────────
// GET /avisos/cobertura (task 4.1.1)
// ────────────────────────────────────────────────────────────────────────────

router.get('/cobertura', requireModuloAtivo('avisos'), requirePermission('avisos.consultar'), async (req, res) => {
  try {
    const ctx = await resolverContextoAvisos(req, res, 'avisos.consultar');
    if (!ctx) return;
    const { claims } = ctx;

    const linhas = await hubPostgrestRequest('rpc/hub_push_cobertura', 'POST', {}, claims);
    const row = (linhas && linhas[0]) || {};

    return res.status(200).json({
      ativos: {
        android: Number(row.ativos_android) || 0,
        ios: Number(row.ativos_ios) || 0,
        desktopOutros: Number(row.ativos_desktop_outros) || 0,
      },
      impedidos: {
        iosSemInstalacao: Number(row.impedidos_ios_sem_instalacao) || 0,
        bloqueadas: Number(row.impedidos_bloqueadas) || 0,
        semSuporte: Number(row.impedidos_sem_suporte) || 0,
      },
      naoAtivadas: Number(row.nao_ativadas) || 0,
    });
  } catch (e) {
    console.error('[hub-avisos] erro em GET /avisos/cobertura:', e.message);
    return res.status(500).json({ erro: 'ERRO_SERVIDOR' });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// POST /avisos — criação e disparo (task 4.2)
// ────────────────────────────────────────────────────────────────────────────

router.post('/', requireModuloAtivo('avisos'), requirePermission('avisos.enviar'), disparoRateLimiter, async (req, res) => {
  try {
    const ctx = await resolverContextoAvisos(req, res, 'avisos.enviar');
    if (!ctx) return;
    const { entidadeAtiva, claims, payload } = ctx;

    const validado = validarAviso(req.body);
    if (!validado.ok) {
      const corpo = { erro: validado.erro };
      if (validado.motivo) corpo.motivo = validado.motivo;
      return res.status(400).json(corpo);
    }

    let chaveAtual;
    try {
      chaveAtual = getKeyAtual();
    } catch (e) {
      return res.status(503).json({ erro: 'PUSH_INDISPONIVEL' });
    }
    const fonteConta = hubMotoristaLoginHabilitado() ? 'conta_motorista' : 'legado';

    const paramsRpc = {
      p_titulo: validado.titulo,
      p_corpo: validado.corpo,
      p_modo: validado.modoDestinatarios,
      p_ids: validado.destinatariosIds,
      p_chave_idempotencia: validado.chaveIdempotencia,
      p_key_id: chaveAtual.keyId,
      p_fonte_conta: fonteConta,
    };

    let resultado;
    // dec-097: no máximo 2 tentativas — a 2ª só ocorre se a 1ª colidiu na
    // UNIQUE de idempotência (perdedor da corrida); por essa altura o
    // vencedor já commitou, então a 2ª chamada cai direto no ramo
    // "já existe" de hub_aviso_criar (sem 3ª tentativa possível).
    for (let tentativa = 1; tentativa <= 2; tentativa += 1) {
      try {
        const linhas = await hubPostgrestRequest('rpc/hub_aviso_criar', 'POST', paramsRpc, claims);
        resultado = (linhas && linhas[0]) || null;
        break;
      } catch (e) {
        const msg = String((e && e.body) || (e && e.message) || '');
        if (msg.includes('SEM_INSCRICOES_ATIVAS')) {
          return res.status(422).json({ erro: 'SEM_INSCRICOES_ATIVAS' });
        }
        if (msg.includes('DESTINATARIOS_FORA_DO_ESCOPO')) {
          logRecusa(req, 'DESTINATARIOS_FORA_DO_ESCOPO');
          return res.status(403).json({ erro: 'DESTINATARIOS_FORA_DO_ESCOPO' });
        }
        if (msg.includes('FORA_DO_GRUPO_MOVEE')) {
          logRecusa(req, 'FORA_DO_GRUPO_MOVEE');
          return res.status(403).json({ erro: 'FORA_DO_GRUPO_MOVEE' });
        }
        if (isCorridaChaveIdempotencia(e) && tentativa === 1) {
          continue;
        }
        throw e;
      }
    }

    if (!resultado) {
      return res.status(500).json({ erro: 'ERRO_SERVIDOR' });
    }

    // Auditoria (FR-029, task 4.2.5) só na criação de FATO — uma repetição
    // idempotente (`reutilizado`) não é um novo disparo, então não gera um
    // segundo evento (evitaria "momento"/"escopo" enganosos na trilha).
    if (!resultado.reutilizado) {
      await registrarAuditoria({
        idEmpresa: entidadeAtiva,
        usuarioId: payload.sub,
        acao: 'aviso_disparado',
        recurso: 'Aviso',
        recursoId: resultado.aviso_id,
        detalhes: { modoDestinatarios: validado.modoDestinatarios, visados: resultado.visados },
        claims,
      });
    }

    // FASE 5 (tasks.md 5.1/5.2) — dispara o worker (fire-and-forget,
    // research.md Decision 4: "promessa fire-and-forget após responder
    // 201"). Também no caso `reutilizado` (idempotência, task 4.2): uma
    // repetição da MESMA chave de idempotência pode ter visado o mesmo
    // aviso `na_fila`/`em_andamento` de uma tentativa anterior que ainda não
    // terminou de processar. `hub_push_reivindicar` é sempre seguro de
    // chamar (SKIP LOCKED); se não houver nada pendente, retorna vazio.
    processarAviso(resultado.aviso_id).catch((errWorker) => {
      console.error('[hub-avisos] falha inesperada no processamento assíncrono do worker:', errWorker && errWorker.message);
    });

    return res.status(resultado.reutilizado ? 200 : 201).json({
      id: resultado.aviso_id,
      status: 'na_fila',
      visados: resultado.visados,
    });
  } catch (e) {
    console.error('[hub-avisos] erro em POST /avisos:', e.message);
    return res.status(500).json({ erro: 'ERRO_SERVIDOR' });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// GET /avisos/:id — DECLARADA POR ÚLTIMO (Express casaria `/alcance`,
// `/cobertura` etc. como `req.params.id` se este handler viesse antes).
// ────────────────────────────────────────────────────────────────────────────

router.get('/:id', requireModuloAtivo('avisos'), requirePermission('avisos.consultar'), async (req, res) => {
  try {
    const ctx = await resolverContextoAvisos(req, res, 'avisos.consultar');
    if (!ctx) return;
    const { claims } = ctx;

    if (!idValido(req.params.id)) return res.status(404).json({ erro: 'AVISO_NAO_ENCONTRADO' });
    const id = Number(req.params.id);

    const linhas = await hubPostgrestRequest(
      `Aviso?id=eq.${id}&select=id,titulo,corpo,status,modo_destinatarios,destinatarios_ids,criado_em,iniciado_em,concluido_em`,
      'GET', null, claims
    );
    if (!linhas || linhas.length === 0) return res.status(404).json({ erro: 'AVISO_NAO_ENCONTRADO' });
    const row = linhas[0];

    const resumoMap = await buscarResumoPorAviso([id], claims);
    const contagens = resumoMap.get(id) || { visados: 0, pendentes: 0, processando: 0, aceitos: 0, falhas: 0, mortas: 0 };

    let destinatarios = {};
    const idsDestino = row.destinatarios_ids || [];
    if (row.modo_destinatarios === 'empresa') {
      const nomesMap = await buscarNomesEntidades(idsDestino, claims);
      destinatarios = { empresas: idsDestino.map((eid) => ({ id: eid, nome: nomesMap.get(eid) || null })) };
    } else if (row.modo_destinatarios === 'individual') {
      destinatarios = { qtdMotoristas: idsDestino.length };
    }

    return res.status(200).json({
      id: row.id,
      titulo: row.titulo,
      corpo: row.corpo,
      status: row.status,
      modoDestinatarios: row.modo_destinatarios,
      destinatarios,
      criadoEm: row.criado_em,
      iniciadoEm: row.iniciado_em,
      concluidoEm: row.concluido_em,
      contagens,
    });
  } catch (e) {
    console.error('[hub-avisos] erro em GET /avisos/:id:', e.message);
    return res.status(500).json({ erro: 'ERRO_SERVIDOR' });
  }
});

module.exports = { router };

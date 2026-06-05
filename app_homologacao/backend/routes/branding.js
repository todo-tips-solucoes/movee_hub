/**
 * Rotas de Branding (identidade visual por Grupo)
 * Prefixo: /empresa/branding e /motorista/branding-tomador
 *
 * Feature: config-ui-tenant (White-label por Tenant + Grupo de CNPJs)
 * Ref: docs/specs/config-ui-tenant/contracts/branding-api.md
 *      docs/specs/config-ui-tenant/spec.md (FR-005, FR-006, FR-007)
 *      docs/constitution.md §II v1.1.0
 *
 * Mandatos de segurança (F5 — dec-018, CHK015): campos extras no body são
 * ignorados silenciosamente (allowlist explícita: cor_primaria, cor_destaque,
 * nome_exibicao, remove_logo). Nenhum campo fora desta lista é persistido.
 *
 * Requer DDL aplicado: docs/sql/001-config-ui-tenant-schema.sql
 */

'use strict';

const express = require('express');
const multer = require('multer');

const router = express.Router();

// Logo é guardado como data-URI base64 na própria coluna Branding.logo_url
// (infra é PostgreSQL + PostgREST puro — sem Supabase Storage). Logos pequenos,
// usáveis direto em <img src>. Multer em memória, mimetype allowlist (dec-017, CHK006).
const uploadLogo = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 256 * 1024 }, // 256 KB (data-URI infla ~+33%)
  fileFilter: (_req, file, cb) => {
    const ALLOWED = ['image/png', 'image/jpeg', 'image/jpg', 'image/svg+xml'];
    if (ALLOWED.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Tipo de arquivo não permitido. Use PNG, JPEG ou SVG.'));
    }
  },
});

// ──────────────────────────────────────────────────────────────────────────────
// Dependências injetadas pelo server.js
// ──────────────────────────────────────────────────────────────────────────────
let _postgrestRequest;

function init({ postgrestRequest }) {
  _postgrestRequest = postgrestRequest;
}

// ──────────────────────────────────────────────────────────────────────────────
// Helpers internos
// ──────────────────────────────────────────────────────────────────────────────

/** Valida cor no formato #RRGGBB */
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
function isValidHex(c) {
  return typeof c === 'string' && HEX_COLOR_RE.test(c);
}

/**
 * Converte o arquivo de logo (buffer + mimetype) num data-URI base64,
 * guardado diretamente em Branding.logo_url (sem storage externo).
 * Ex.: "data:image/png;base64,iVBORw0KGgo...". Usável direto em <img src>.
 */
function fileToDataUri(fileBuffer, mimetype) {
  return `data:${mimetype};base64,${fileBuffer.toString('base64')}`;
}

// ──────────────────────────────────────────────────────────────────────────────
// GET /empresa/branding
//   Retorna a branding do grupo do token (escopo server-side).
//   Auth: authenticateToken (injeto pelo server.js no mount).
//   Empresa sem grupo → { id_grupo: null, fallback: "movee" }.
// ──────────────────────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { id_grupo } = req.user;

    if (!id_grupo) {
      return res.json({ id_grupo: null, fallback: 'movee' });
    }

    // F1: coerce id_grupo para inteiro
    const idGrupoInt = parseInt(id_grupo, 10);
    if (!Number.isInteger(idGrupoInt) || idGrupoInt <= 0) {
      return res.json({ id_grupo: null, fallback: 'movee' });
    }

    const rows = await _postgrestRequest(
      `Branding?id_grupo=eq.${idGrupoInt}&select=id_grupo,logo_url,cor_primaria,cor_destaque,nome_exibicao,updated_at`,
      'GET'
    );

    if (!rows || rows.length === 0) {
      return res.json({ id_grupo: idGrupoInt, fallback: 'movee' });
    }

    return res.json(rows[0]);
  } catch (err) {
    console.error('[GET /empresa/branding] Erro:', err.message);
    return res.status(500).json({ error: 'Erro no servidor.' });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// PUT /empresa/branding
//   Cria/atualiza (upsert) a branding do grupo. Somente o pai.
//   Suporta multipart/form-data (com logo) ou application/json (sem logo).
//   F5 (dec-018, CHK015): apenas campos da allowlist são persistidos.
//   dec-020 (CHK025): remove_logo: true → seta logo_url = null.
//   dec-023 (CHK034): sempre retorna 200 (upsert).
// ──────────────────────────────────────────────────────────────────────────────
router.put('/', uploadLogo.single('logo'), async (req, res) => {
  // requireGrupoPai inline (não importar de grupo.js para evitar dep circular)
  if (!req.user || req.user.is_grupo_pai !== true) {
    return res.status(403).json({
      error: 'Apenas o administrador do grupo pode editar a aparência.',
    });
  }

  try {
    const { id_grupo } = req.user;

    // F1: coerce id_grupo
    const idGrupoInt = parseInt(id_grupo, 10);
    if (!Number.isInteger(idGrupoInt) || idGrupoInt <= 0) {
      return res.status(403).json({ error: 'Token sem grupo válido.' });
    }

    // F5 — Allowlist explícita: apenas estes campos são lidos do body
    const ALLOWED_FIELDS = ['cor_primaria', 'cor_destaque', 'nome_exibicao', 'remove_logo'];
    const body = req.body || {};
    const update = {};

    // Validar e extrair cores (dec-022: hex obrigatório)
    if (body.cor_primaria !== undefined) {
      if (!isValidHex(body.cor_primaria)) {
        return res.status(400).json({ error: 'cor_primaria deve ser um hex válido (#RRGGBB).' });
      }
      update.cor_primaria = body.cor_primaria;
    }

    if (body.cor_destaque !== undefined) {
      if (!isValidHex(body.cor_destaque)) {
        return res.status(400).json({ error: 'cor_destaque deve ser um hex válido (#RRGGBB).' });
      }
      update.cor_destaque = body.cor_destaque;
    }

    // Validar nome_exibicao (dec-022, CHK033: máx 60 chars)
    if (body.nome_exibicao !== undefined) {
      const nome = String(body.nome_exibicao).trim();
      if (nome.length === 0) {
        return res.status(400).json({ error: 'nome_exibicao não pode ser vazio.' });
      }
      if (nome.length > 60) {
        return res.status(400).json({
          error: 'nome_exibicao deve ter no máximo 60 caracteres (dec-022).',
        });
      }
      update.nome_exibicao = nome;
    }

    // dec-020 (CHK025): remove_logo: true → logo_url = null
    const removeLogo = body.remove_logo === true || body.remove_logo === 'true';
    if (removeLogo) {
      update.logo_url = null;
    }

    // Logo enviado (e remove_logo não ativo): grava como data-URI em logo_url
    if (req.file && !removeLogo) {
      update.logo_url = fileToDataUri(req.file.buffer, req.file.mimetype);
    }

    // Sem campos para atualizar (exceto logo): ainda assim fazer upsert com updated_at
    update.updated_at = new Date().toISOString();

    // Upsert via PostgREST: tenta PATCH (atualizar); se não existir, faz POST (criar)
    const existing = await _postgrestRequest(
      `Branding?id_grupo=eq.${idGrupoInt}&select=id`,
      'GET'
    );

    let result;
    if (existing && existing.length > 0) {
      // Atualizar
      const patched = await _postgrestRequest(
        `Branding?id_grupo=eq.${idGrupoInt}`,
        'PATCH',
        update
      );
      // Buscar registro atualizado para retornar
      const rows = await _postgrestRequest(
        `Branding?id_grupo=eq.${idGrupoInt}&select=id_grupo,logo_url,cor_primaria,cor_destaque,nome_exibicao,updated_at`,
        'GET'
      );
      result = rows && rows.length > 0 ? rows[0] : { id_grupo: idGrupoInt, ...update };
    } else {
      // Criar (primeira vez)
      const inserted = await _postgrestRequest(
        'Branding',
        'POST',
        { id_grupo: idGrupoInt, ...update }
      );
      result = inserted && inserted.length > 0
        ? inserted[0]
        : { id_grupo: idGrupoInt, ...update };
    }

    // dec-023 (CHK034): sempre 200
    return res.status(200).json(result);
  } catch (err) {
    console.error('[PUT /empresa/branding] Erro:', err.message);
    return res.status(500).json({ error: 'Erro no servidor.' });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// GET /motorista/branding-tomador
//   Retorna a branding do grupo do TOMADOR do movimento.
//   Auth: authenticateMotorista (aud=motorista) — montado no router de motorista.
//   Timeout client-side: 3000ms (dec-024, CHK038) — documentado no contrato.
//   Cache no cliente: Map<cnpj_tomador, payload> TTL=sessão (dec-031, CHK066).
//   Query: ?movimento=<id> (preferencial) ou ?id_empresa=<id>.
//
//   NB: Esta rota é EXPORTADA e montada pelo motorista router no server.js,
//   não no router de /empresa. Ver module.exports.brandingTomadorRouter.
// ──────────────────────────────────────────────────────────────────────────────
const brandingTomadorRouter = express.Router();

brandingTomadorRouter.get('/branding-tomador', async (req, res) => {
  try {
    // req.motorista = { cnpjPrestador, nome, aud } (injetado por authenticateMotorista)
    if (!req.motorista) {
      return res.status(401).json({ error: 'Acesso negado.' });
    }

    let idEmpresaTomador;

    // Resolver id_empresa do tomador a partir do movimento (server-side)
    const movimentoId = req.query.movimento;
    const idEmpresaQuery = req.query.id_empresa;

    if (movimentoId) {
      // F1: coerce para inteiro
      const movId = parseInt(movimentoId, 10);
      if (!Number.isInteger(movId) || movId <= 0) {
        return res.status(400).json({
          error: 'Parâmetro inválido: movimento deve ser um número inteiro.',
        });
      }

      // Buscar o movimento para obter id_empresa do tomador
      // O campo cnpj_tomador é o identificador do tomador no EnvioMassa;
      // precisamos resolver o id_empresa via tabela Empresa por cnpj_tomador
      const movs = await _postgrestRequest(
        `EnvioMassa?id=eq.${movId}&select=id_empresa,cnpj_tomador`,
        'GET'
      );

      if (!movs || movs.length === 0) {
        // Movimento não encontrado: retornar fallback Movee (não 404 — PWA degrada)
        return res.json({ fallback: 'movee' });
      }

      const mov = movs[0];

      // O tomador é identificado pelo cnpj_tomador no movimento
      // Buscar a empresa pelo CNPJ do tomador para obter id_grupo
      if (mov.cnpj_tomador) {
        const cnpjNorm = String(mov.cnpj_tomador).replace(/\D/g, '');
        // Tentar por cnpj_prestador (coluna usada para identificar a empresa)
        const empresas = await _postgrestRequest(
          `Empresa?cnpj_prestador=eq.${cnpjNorm}&select=id,id_grupo`,
          'GET'
        );
        if (empresas && empresas.length > 0) {
          idEmpresaTomador = empresas[0].id;
        }
      }

      // Fallback: usar id_empresa diretamente do movimento
      if (!idEmpresaTomador && mov.id_empresa) {
        idEmpresaTomador = mov.id_empresa;
      }
    } else if (idEmpresaQuery) {
      // F1: coerce
      idEmpresaTomador = parseInt(idEmpresaQuery, 10);
      if (!Number.isInteger(idEmpresaTomador) || idEmpresaTomador <= 0) {
        return res.status(400).json({
          error: 'Parâmetro inválido: id_empresa deve ser um número inteiro.',
        });
      }
    } else {
      return res.status(400).json({
        error: 'Informe ?movimento=<id> ou ?id_empresa=<id>.',
      });
    }

    if (!idEmpresaTomador) {
      // Não foi possível resolver o tomador → fallback Movee (PWA degrada graciosamente)
      return res.json({ fallback: 'movee' });
    }

    // Buscar o grupo do tomador
    const empresas = await _postgrestRequest(
      `Empresa?id=eq.${idEmpresaTomador}&select=id_grupo`,
      'GET'
    );

    if (!empresas || empresas.length === 0 || !empresas[0].id_grupo) {
      return res.json({ fallback: 'movee' });
    }

    const idGrupoTomador = parseInt(empresas[0].id_grupo, 10);

    // Buscar branding do grupo do tomador
    const brandings = await _postgrestRequest(
      `Branding?id_grupo=eq.${idGrupoTomador}&select=logo_url,cor_primaria,cor_destaque,nome_exibicao`,
      'GET'
    );

    if (!brandings || brandings.length === 0) {
      return res.json({ fallback: 'movee' });
    }

    // Resposta completa (dec-024: timeout client-side 3000ms documentado no contrato)
    return res.json(brandings[0]);
  } catch (err) {
    console.error('[GET /motorista/branding-tomador] Erro:', err.message);
    // Falha de serviço → fallback Movee (não 500 — PWA degrada graciosamente)
    return res.json({ fallback: 'movee' });
  }
});

module.exports = { router, init, brandingTomadorRouter };

/**
 * Rotas de administração de Motoristas (painel da Empresa)
 * Prefixo: /admin/motoristas/*
 *
 * Feature: cadastro-motorista-base-validada (frente C — CRUD)
 *
 * Auth: montado sob `authenticateToken` de EMPRESA (NÃO authenticateMotorista).
 *       O motorista nunca acessa estas rotas.
 *
 * Multi-tenant (decisão §6.1): a tabela "Motorista" é GLOBAL (sem id_empresa) e
 *   um mesmo CNPJ de prestador pode movimentar para várias empresas. O escopo do
 *   admin é DERIVADO de EnvioMassa: ele só vê/edita motoristas cujo cnpj_prestador
 *   aparece no movimento das empresas do seu escopo (resolveScope, Princípio II).
 *   Isso preserva o multi-tenant e evita BOLA (A01/API1) sem mudar o schema.
 *
 * Segurança:
 *   - BOLA: PUT/DELETE/reset-senha checam que o motorista (:id) está no escopo →
 *     senão 404 genérico ("não encontrado").
 *   - :id sanitizado (parseInt + Number.isInteger + > 0) — padrão HIGH-002.
 *   - Hash de senha NUNCA é retornado nem editado diretamente; "resetar senha" =
 *     setar senha = NULL (motorista refaz o cadastro — decisão §6.6).
 *   - CNPJ não é editável (chave/identidade — decisão §6.5).
 */

'use strict';

const express = require('express');

const router = express.Router();

// ──────────────────────────────────────────────────────────────────────────────
// Dependências injetadas pelo server.js (ver module.exports.init)
// ──────────────────────────────────────────────────────────────────────────────
let _postgrestRequest;
let _resolveScope;

function init({ postgrestRequest, resolveScope }) {
  _postgrestRequest = postgrestRequest;
  _resolveScope = resolveScope;
}

const onlyDigits = (v) => String(v == null ? '' : v).replace(/\D/g, '');

// ──────────────────────────────────────────────────────────────────────────────
// Helper: cnpjsDoEscopo(user)
//   Conjunto de cnpj_prestador (14 dígitos) que o admin pode enxergar —
//   derivado do movimento (EnvioMassa) das empresas no escopo do token.
//   IDs de empresa saem EXCLUSIVAMENTE do token (resolveScope / Princípio II).
//   Retorna um Set<string> (pode ser vazio).
// ──────────────────────────────────────────────────────────────────────────────
async function cnpjsDoEscopo(user) {
  const empresaIds = await _resolveScope(user); // [empresaId, ...filhos]
  if (!Array.isArray(empresaIds) || empresaIds.length === 0) {
    return new Set();
  }
  // Coerção defensiva para inteiro (bloqueia injeção PostgREST via in.())
  const idsInt = empresaIds
    .map((id) => parseInt(id, 10))
    .filter((id) => Number.isInteger(id) && id > 0);
  if (idsInt.length === 0) {
    return new Set();
  }

  const movimentos = await _postgrestRequest(
    `EnvioMassa?id_empresa=in.(${idsInt.join(',')})&select=cnpj_prestador`
  );

  const set = new Set();
  for (const m of (movimentos || [])) {
    const cnpj = onlyDigits(m && m.cnpj_prestador);
    if (cnpj.length === 14) set.add(cnpj);
  }
  return set;
}

// DTO seguro: NUNCA expõe o hash de senha. `cadastrado` indica se o motorista já
// definiu acesso (senha != NULL) — pré-cadastro do upload ainda não cadastrou.
function toDTO(m) {
  return {
    id: m.id,
    cnpj_prestador: m.cnpj_prestador,
    nome: m.nome || '',
    ativo: m.ativo === true,
    cadastrado: !!m.senha,
    created_at: m.created_at,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Helper BOLA: busca o motorista por :id E garante que está no escopo do admin.
//   Retorna { motorista } se ok, ou { erro: {status, body} } caso contrário.
// ──────────────────────────────────────────────────────────────────────────────
const NAO_ENCONTRADO = { status: 404, body: { error: 'Motorista não encontrado.' } };

async function buscarMotoristaNoEscopo(user, idParam) {
  const id = parseInt(idParam, 10);
  if (!Number.isInteger(id) || id <= 0) {
    return { erro: { status: 400, body: { error: 'ID inválido.' } } };
  }

  const encontrados = await _postgrestRequest(
    `Motorista?id=eq.${id}&select=id,cnpj_prestador,nome,ativo,senha,created_at`
  );
  const motorista = encontrados && encontrados[0];
  if (!motorista) {
    return { erro: NAO_ENCONTRADO }; // genérico (não vaza existência)
  }

  const escopo = await cnpjsDoEscopo(user);
  if (!escopo.has(onlyDigits(motorista.cnpj_prestador))) {
    // BOLA: fora do escopo → mesma resposta genérica de "não encontrado".
    return { erro: NAO_ENCONTRADO };
  }

  return { motorista, id };
}

// ──────────────────────────────────────────────────────────────────────────────
// GET /admin/motoristas
//   Lista os motoristas no escopo do admin. Busca opcional (?q) por nome/CNPJ e
//   paginação (?limit, ?offset). Nunca retorna hash de senha.
//   Response 200: { motoristas: [...DTO], total: <int> }
// ──────────────────────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const escopo = await cnpjsDoEscopo(req.user);
    if (escopo.size === 0) {
      return res.json({ motoristas: [], total: 0 });
    }

    // Motorista é uma tabela curada (pequena): filtramos por pertença ao escopo
    // em JS — evita um in.() gigante na URL do PostgREST.
    const todos = await _postgrestRequest(
      'Motorista?select=id,cnpj_prestador,nome,ativo,senha,created_at&order=nome.asc'
    );

    let lista = (todos || [])
      .filter((m) => escopo.has(onlyDigits(m.cnpj_prestador)))
      .map(toDTO);

    // Busca textual opcional
    const q = String(req.query.q || '').trim().toLowerCase();
    if (q) {
      const qDigits = q.replace(/\D/g, '');
      lista = lista.filter((m) =>
        (m.nome && m.nome.toLowerCase().includes(q)) ||
        (qDigits && m.cnpj_prestador.includes(qDigits))
      );
    }

    const total = lista.length;

    // Paginação opcional
    const limit = parseInt(req.query.limit, 10);
    const offset = parseInt(req.query.offset, 10);
    if (Number.isInteger(limit) && limit > 0) {
      const off = Number.isInteger(offset) && offset > 0 ? offset : 0;
      lista = lista.slice(off, off + limit);
    }

    return res.json({ motoristas: lista, total });
  } catch (err) {
    console.error('[GET /admin/motoristas] Erro:', err.message);
    return res.status(500).json({ error: 'Erro no servidor.' });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// PUT /admin/motoristas/:id
//   Edita nome e/ou ativo. NÃO edita CNPJ (decisão §6.5) nem senha.
//   Body: { nome?: string, ativo?: boolean }
//   Response 200: DTO atualizado | 400 ID/payload inválido | 404 fora do escopo
// ──────────────────────────────────────────────────────────────────────────────
router.put('/:id', async (req, res) => {
  try {
    const { motorista, erro } = await buscarMotoristaNoEscopo(req.user, req.params.id);
    if (erro) return res.status(erro.status).json(erro.body);

    const { nome, ativo } = req.body || {};
    const payload = {};

    if (nome !== undefined) {
      if (typeof nome !== 'string' || !nome.trim()) {
        return res.status(400).json({ error: 'Nome inválido.' });
      }
      payload.nome = nome.trim();
    }
    if (ativo !== undefined) {
      if (typeof ativo !== 'boolean') {
        return res.status(400).json({ error: 'Campo "ativo" deve ser booleano.' });
      }
      payload.ativo = ativo;
    }

    if (Object.keys(payload).length === 0) {
      return res.status(400).json({ error: 'Nada para atualizar (informe nome e/ou ativo).' });
    }

    const atualizados = await _postgrestRequest(
      `Motorista?id=eq.${motorista.id}`,
      'PATCH',
      payload
    );
    if (!atualizados || atualizados.length === 0) {
      return res.status(500).json({ error: 'Erro ao atualizar motorista.' });
    }

    return res.status(200).json(toDTO(atualizados[0]));
  } catch (err) {
    console.error('[PUT /admin/motoristas/:id] Erro:', err.message);
    return res.status(500).json({ error: 'Erro no servidor.' });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// POST /admin/motoristas/:id/reset-senha
//   "Resetar senha" = setar senha = NULL (decisão §6.6). O motorista volta ao
//   estado de pré-cadastro e refaz o /register para definir nova senha.
//   Não gera nem expõe senha temporária.
//   Response 200: DTO atualizado (cadastrado:false) | 404 fora do escopo
// ──────────────────────────────────────────────────────────────────────────────
router.post('/:id/reset-senha', async (req, res) => {
  try {
    const { motorista, erro } = await buscarMotoristaNoEscopo(req.user, req.params.id);
    if (erro) return res.status(erro.status).json(erro.body);

    const atualizados = await _postgrestRequest(
      `Motorista?id=eq.${motorista.id}`,
      'PATCH',
      { senha: null }
    );
    if (!atualizados || atualizados.length === 0) {
      return res.status(500).json({ error: 'Erro ao resetar senha.' });
    }

    return res.status(200).json(toDTO(atualizados[0]));
  } catch (err) {
    console.error('[POST /admin/motoristas/:id/reset-senha] Erro:', err.message);
    return res.status(500).json({ error: 'Erro no servidor.' });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// DELETE /admin/motoristas/:id
//   Exclusão lógica (soft delete, decisão §6.7): seta ativo = false. Preserva
//   histórico e o vínculo com o movimento. Login do motorista passa a ser negado.
//   Response 200: { desativado: true, id } | 404 fora do escopo
// ──────────────────────────────────────────────────────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    const { motorista, erro } = await buscarMotoristaNoEscopo(req.user, req.params.id);
    if (erro) return res.status(erro.status).json(erro.body);

    const atualizados = await _postgrestRequest(
      `Motorista?id=eq.${motorista.id}`,
      'PATCH',
      { ativo: false }
    );
    if (!atualizados || atualizados.length === 0) {
      return res.status(500).json({ error: 'Erro ao desativar motorista.' });
    }

    return res.status(200).json({ desativado: true, id: motorista.id });
  } catch (err) {
    console.error('[DELETE /admin/motoristas/:id] Erro:', err.message);
    return res.status(500).json({ error: 'Erro no servidor.' });
  }
});

module.exports = { router, init };

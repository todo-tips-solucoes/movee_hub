/**
 * Rotas de Grupo de CNPJs + helper resolveScope
 * Prefixo: /grupo/*
 *
 * Feature: config-ui-tenant (White-label por Tenant + Grupo de CNPJs)
 * Feature: cadastro-filiais (Cadastro de Filiais)
 * Ref: docs/specs/config-ui-tenant/contracts/grupo-api.md
 *      docs/specs/config-ui-tenant/spec.md (FR-002, FR-004, FR-INFRA-LOCK)
 *      docs/specs/cadastro-filiais/contracts/grupo-empresas-api.md
 *      docs/constitution.md §II v1.1.0
 *
 * Princípio II (amendment v1.1.0): escopo resolvido exclusivamente a partir
 * do token JWT (req.user), nunca a partir do corpo/query do cliente.
 *
 * Requer DDL aplicado: docs/sql/001-config-ui-tenant-schema.sql
 *                      docs/sql/004-cadastro-filiais-cnpj.sql
 */

'use strict';

const express = require('express');
const router = express.Router();

// ──────────────────────────────────────────────────────────────────────────────
// Dependências injetadas pelo server.js (ver module.exports.init)
// ──────────────────────────────────────────────────────────────────────────────
let _postgrestRequest;
let _bcrypt;

function init({ postgrestRequest, bcrypt }) {
  _postgrestRequest = postgrestRequest;
  _bcrypt = bcrypt;
}

// ──────────────────────────────────────────────────────────────────────────────
// Helper: resolveScope(user)
//
// Contrato (contracts/grupo-api.md §Helper):
//   Input : req.user { empresaId, id_grupo, is_grupo_pai, ... }
//   Output: array de empresaIds que o token pode acessar.
//
//   | Situação                                  | Retorno                    |
//   |-------------------------------------------|----------------------------|
//   | id_grupo NULL (sem grupo)                 | [empresaId]                |
//   | is_grupo_pai === true                     | [empresaId, ...ids filhos] |
//   | tem id_grupo mas is_grupo_pai === false    | [empresaId] (não expande)  |
//
// Invariante (Princípio II v1.1.0): IDs saem exclusivamente do token.
// ──────────────────────────────────────────────────────────────────────────────
async function resolveScope(user) {
  const { empresaId, id_grupo, is_grupo_pai } = user;

  // Sem grupo ou é filho: escopo individual (comportamento original preservado)
  if (!id_grupo || !is_grupo_pai) {
    return [empresaId];
  }

  // Pai: escopo = próprio + filhos diretos (sem recursão — MVP 1:N plano)
  // F1: coerce id_grupo para inteiro antes de montar a query PostgREST,
  //     evitando injeção via claims maliciosas (ex: "1 OR 1=1").
  const idGrupoInt = parseInt(id_grupo, 10);
  if (!Number.isInteger(idGrupoInt) || idGrupoInt <= 0) {
    // Claim inválida: degradar para escopo individual (fail-safe)
    return [empresaId];
  }

  try {
    const filhos = await _postgrestRequest(
      `Empresa?id_grupo=eq.${idGrupoInt}&select=id`,
      'GET'
    );
    // Filhos = empresas com id_grupo = grupo do pai, excluindo o próprio pai
    const idFilhos = (filhos || [])
      .map(f => f.id)
      .filter(id => id !== empresaId);

    return [empresaId, ...idFilhos];
  } catch (err) {
    console.error('[resolveScope] Erro ao buscar filhos, degradando para escopo individual:', err.message);
    // Fail-safe: degradar para escopo individual em vez de expor dados cruzados
    return [empresaId];
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Helper: resolveOrCreateGrupo(user)
//
// Contrato (contracts/grupo-empresas-api.md §Helper):
//   Input : req.user { empresaId, id_grupo, nome_empresa, ... }
//   Output: idGrupo (inteiro) — o id do Grupo ao qual o pai pertence.
//           Cria o Grupo na primeira chamada se ainda não existir (idempotente).
//
//   Princípio II (SC-004): id_grupo vem SEMPRE do token, nunca do body.
//   Throws em caso de falha irrecuperável (quem chama deve capturar).
// ──────────────────────────────────────────────────────────────────────────────
async function resolveOrCreateGrupo(user) {
  const { empresaId, id_grupo, nome_empresa } = user;

  if (id_grupo) {
    // F1: coerce para inteiro — proteção contra claim maliciosa
    const idGrupoInt = parseInt(id_grupo, 10);
    if (!Number.isInteger(idGrupoInt) || idGrupoInt <= 0) {
      throw new Error('Dados de grupo inválidos no token.');
    }
    return idGrupoInt;
  }

  // Sem id_grupo no token: resolver via id_empresa_pai (idempotente)
  const grupoExistente = await _postgrestRequest(
    `Grupo?id_empresa_pai=eq.${empresaId}&select=id`,
    'GET'
  );

  if (grupoExistente && grupoExistente.length > 0) {
    return grupoExistente[0].id;
  }

  // Criar grupo novo (primeira vinculação)
  const novoGrupo = await _postgrestRequest(
    'Grupo',
    'POST',
    {
      nome: nome_empresa || `Grupo ${empresaId}`,
      id_empresa_pai: empresaId,
    }
  );
  // PostgREST com Prefer: return=representation retorna array
  if (!novoGrupo || novoGrupo.length === 0) {
    throw new Error('Erro ao criar grupo.');
  }
  return novoGrupo[0].id;
}

// ──────────────────────────────────────────────────────────────────────────────
// Middleware: requireGrupoPai
//   Garante que o token pertence ao administrador do grupo (is_grupo_pai === true).
//   Retorna 403 se não for pai ou não tiver grupo.
// ──────────────────────────────────────────────────────────────────────────────
function requireGrupoPai(req, res, next) {
  if (!req.user || req.user.is_grupo_pai !== true) {
    return res.status(403).json({
      error: 'Apenas o administrador do grupo pode executar esta operação.',
    });
  }
  next();
}

// ──────────────────────────────────────────────────────────────────────────────
// GET /grupo/filhos
//   Lista todas as empresas filhas do grupo do token.
//   Auth: authenticateToken + is_grupo_pai.
//   Limit implícito: 100 filhos (dec-025, CHK046) — retorna 422 se atingido.
// ──────────────────────────────────────────────────────────────────────────────
router.get('/filhos', requireGrupoPai, async (req, res) => {
  try {
    const { id_grupo } = req.user;

    // F1: coerce id_grupo para inteiro
    const idGrupoInt = parseInt(id_grupo, 10);
    if (!Number.isInteger(idGrupoInt) || idGrupoInt <= 0) {
      return res.status(403).json({ error: 'Apenas o administrador do grupo pode listar filhos.' });
    }

    const membros = await _postgrestRequest(
      `Empresa?id_grupo=eq.${idGrupoInt}&select=id,nome_empresa,email`,
      'GET'
    );

    // grupo-unificado-filiais: a empresa-pai também é tratada como membro EDITÁVEL do
    // grupo (decisão do operador). Mantemos a empresa-pai na lista marcada com
    // is_pai=true e a ordenamos primeiro; as filhas vêm com is_pai=false. O login único
    // permanece inalterado — a flag serve apenas para edição de cadastro na aba grupo.
    const lista = (membros || [])
      .map(f => ({ ...f, is_pai: f.id === req.user.empresaId }))
      .sort((a, b) => (b.is_pai ? 1 : 0) - (a.is_pai ? 1 : 0));

    // Limite implícito: 100 filhas — NÃO conta a empresa-pai (dec-025, CHK046)
    const totalFilhas = lista.filter(f => !f.is_pai).length;
    if (totalFilhas > 100) {
      return res.status(422).json({
        error: 'O grupo atingiu o limite de 100 empresas filhas. Contate o suporte.',
      });
    }

    return res.json({ id_grupo: idGrupoInt, filhos: lista });
  } catch (err) {
    console.error('[GET /grupo/filhos] Erro:', err.message);
    return res.status(500).json({ error: 'Erro no servidor.' });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// POST /grupo/filhos
//   Vincula uma empresa filha ao grupo do pai.
//   Cria o Grupo na primeira vinculação se necessário.
//   FR-INFRA-LOCK (dec-026, dec-033): verificação condicional antes do UPDATE.
//   Auth: authenticateToken + is_grupo_pai.
//
//   Body: { "empresa_id_filho": <int> }
//   Response 201: { "id_grupo": <int>, "empresa_id_filho": <int>, "vinculado": true }
// ──────────────────────────────────────────────────────────────────────────────
router.post('/filhos', requireGrupoPai, async (req, res) => {
  try {
    const { empresaId, id_grupo, nome_empresa } = req.user;

    // F1: validar empresa_id_filho (dec-016, CHK003: não-numérico → 400)
    const rawFilhoId = req.body && req.body.empresa_id_filho;
    const empresaIdFilho = parseInt(rawFilhoId, 10);
    if (!Number.isInteger(empresaIdFilho) || empresaIdFilho <= 0) {
      return res.status(400).json({
        error: 'Parâmetro inválido: empresa_id_filho deve ser um número inteiro.',
      });
    }

    // Não vincular o próprio pai como filho
    if (empresaIdFilho === empresaId) {
      return res.status(400).json({
        error: 'A empresa não pode ser filha de si mesma.',
      });
    }

    // Verificar se a empresa filha existe
    const candidatos = await _postgrestRequest(
      `Empresa?id=eq.${empresaIdFilho}&select=id,id_grupo,nome_empresa`,
      'GET'
    );
    if (!candidatos || candidatos.length === 0) {
      return res.status(400).json({ error: 'Empresa não encontrada.' });
    }

    const filho = candidatos[0];

    // FR-INFRA-LOCK: verificar se já pertence a outro grupo (dec-026, dec-033)
    if (filho.id_grupo !== null && filho.id_grupo !== undefined) {
      if (filho.id_grupo === id_grupo) {
        // Já é filho deste grupo — idempotente, retornar 201
        return res.status(201).json({
          id_grupo: id_grupo,
          empresa_id_filho: empresaIdFilho,
          vinculado: true,
        });
      }
      // Pertence a outro grupo → 409
      return res.status(409).json({
        error: 'Vínculo em conflito: empresa já pertence a outro grupo.',
      });
    }

    // Resolver ou criar o Grupo do pai (helper idempotente — T-2.1)
    const idGrupoFinal = await resolveOrCreateGrupo(req.user);

    // Verificar limite de 100 filhos antes de vincular (dec-025, CHK046)
    const filhosAtuais = await _postgrestRequest(
      `Empresa?id_grupo=eq.${idGrupoFinal}&select=id`,
      'GET'
    );
    const qtdFilhos = (filhosAtuais || []).filter(f => f.id !== empresaId).length;
    if (qtdFilhos >= 100) {
      return res.status(422).json({
        error: 'O grupo atingiu o limite de 100 empresas filhas.',
      });
    }

    // Vincular: UPDATE Empresa SET id_grupo = idGrupoFinal WHERE id = empresaIdFilho
    await _postgrestRequest(
      `Empresa?id=eq.${empresaIdFilho}`,
      'PATCH',
      { id_grupo: idGrupoFinal }
    );

    return res.status(201).json({
      id_grupo: idGrupoFinal,
      empresa_id_filho: empresaIdFilho,
      vinculado: true,
    });
  } catch (err) {
    console.error('[POST /grupo/filhos] Erro:', err.message);
    return res.status(500).json({ error: 'Erro no servidor.' });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// POST /grupo/empresas
//   Cria uma empresa filial e a vincula ao grupo do admin autenticado.
//   Feature: cadastro-filiais (FR-001..FR-007)
//   Ref: docs/specs/cadastro-filiais/contracts/grupo-empresas-api.md
//
//   Auth: authenticateToken (no mount /grupo) + requireGrupoPai (middleware aqui).
//   id_grupo: sempre do token via resolveOrCreateGrupo (SC-004).
//   Qualquer id_grupo no body é ignorado.
//
//   Body: { nome_empresa, email, senha, cnpj,
//           endereco?, numero?, cep?, email_nota?, observacao? }
//   Response 201: { id, nome_empresa, email, id_grupo }
//   Response 400: nome_empresa ausente / email inválido ou duplicado / senha fraca
//   Response 409: cnpj duplicado (UNIQUE constraint)
//   Response 422: limite de 100 filiais atingido
//   Response 403: não-admin (requireGrupoPai)
// ──────────────────────────────────────────────────────────────────────────────
router.post('/empresas', requireGrupoPai, async (req, res) => {
  try {
    const { nome_empresa, email, senha, cnpj,
            endereco, numero, cep, email_nota, observacao } = req.body || {};

    // ── Validações de entrada ──────────────────────────────────────────────

    // nome_empresa obrigatório (FR-001)
    if (!nome_empresa || typeof nome_empresa !== 'string' || !nome_empresa.trim()) {
      return res.status(400).json({ error: 'Campo obrigatório ausente: nome_empresa.' });
    }

    // email: formato + presença (FR-003)
    if (!email || typeof email !== 'string') {
      return res.status(400).json({ error: 'Campo obrigatório ausente: email.' });
    }
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email.trim())) {
      return res.status(400).json({ error: 'Formato de e-mail inválido.' });
    }

    // senha: regra mínima >= 6 chars + 1 maiúscula + 1 dígito (FR-005)
    if (!senha || typeof senha !== 'string') {
      return res.status(400).json({ error: 'Campo obrigatório ausente: senha.' });
    }
    if (senha.length < 6 || !/[A-Z]/.test(senha) || !/\d/.test(senha)) {
      return res.status(400).json({
        error: 'Senha fraca: mínimo 6 caracteres, 1 letra maiúscula e 1 dígito.',
      });
    }

    // cnpj: exatamente 14 dígitos numéricos (FR-006)
    if (!cnpj || typeof cnpj !== 'string') {
      return res.status(400).json({ error: 'Campo obrigatório ausente: cnpj.' });
    }
    const cnpjDigitos = cnpj.replace(/\D/g, '');
    if (cnpjDigitos.length !== 14) {
      return res.status(400).json({
        error: 'CNPJ inválido: deve conter exatamente 14 dígitos numéricos.',
      });
    }

    // ── Unicidade de email (FR-003) ───────────────────────────────────────
    const emailExistente = await _postgrestRequest(
      `Empresa?email=eq.${encodeURIComponent(email.trim())}&select=id`,
      'GET'
    );
    if (emailExistente && emailExistente.length > 0) {
      return res.status(400).json({ error: 'E-mail já cadastrado.' });
    }

    // ── Resolver/criar Grupo (SC-004: id_grupo do token, nunca do body) ───
    let idGrupo;
    try {
      idGrupo = await resolveOrCreateGrupo(req.user);
    } catch (grupoErr) {
      console.error('[POST /grupo/empresas] Erro ao resolver grupo:', grupoErr.message);
      return res.status(500).json({ error: 'Erro ao resolver grupo do administrador.' });
    }

    // ── Limite de 100 filiais por grupo (FR-007, dec-025) ─────────────────
    const filhosAtuais = await _postgrestRequest(
      `Empresa?id_grupo=eq.${idGrupo}&select=id`,
      'GET'
    );
    const qtdFilhos = (filhosAtuais || []).filter(f => f.id !== req.user.empresaId).length;
    if (qtdFilhos >= 100) {
      return res.status(422).json({
        error: 'O grupo atingiu o limite de 100 empresas filhas.',
      });
    }

    // ── Hashear senha (FR-005) ────────────────────────────────────────────
    if (!_bcrypt) {
      console.error('[POST /grupo/empresas] bcrypt não injetado — verifique server.js');
      return res.status(500).json({ error: 'Erro de configuração do servidor.' });
    }
    const hashedPass = await _bcrypt.hash(senha, 10);

    // ── Montar payload (campos fiscais opcionais — FR-004) ────────────────
    const payload = {
      nome_empresa: nome_empresa.trim(),
      email: email.trim(),
      pass: hashedPass,
      id_grupo: idGrupo,
    };
    // Incluir cnpj apenas se DDL 004 já foi aplicado; se a coluna não existir,
    // o PostgREST retorna 400/42703 — capturado abaixo com mensagem clara.
    payload.cnpj = cnpjDigitos;

    // Campos fiscais opcionais: incluir apenas quando fornecidos (não nulos)
    if (endereco !== undefined && endereco !== null) payload.endereco = endereco;
    if (numero   !== undefined && numero   !== null) payload.numero   = numero;
    if (cep      !== undefined && cep      !== null) payload.cep      = cep;
    if (email_nota !== undefined && email_nota !== null) payload.email_nota = email_nota;
    if (observacao !== undefined && observacao !== null) payload.observacao = observacao;

    // ── INSERT via PostgREST ──────────────────────────────────────────────
    let novaEmpresa;
    try {
      novaEmpresa = await _postgrestRequest('Empresa', 'POST', payload);
    } catch (pgErr) {
      const msg = pgErr && pgErr.message ? pgErr.message : '';
      // UNIQUE constraint em cnpj → 409
      if (/duplicate key.*cnpj/i.test(msg) || /unique.*cnpj/i.test(msg)) {
        return res.status(409).json({ error: 'CNPJ já cadastrado.' });
      }
      // UNIQUE constraint em email (failsafe para race condition) → 400
      if (/duplicate key.*email/i.test(msg) || /unique.*email/i.test(msg)) {
        return res.status(400).json({ error: 'E-mail já cadastrado.' });
      }
      // Coluna cnpj inexistente (DDL 004 não aplicado) — erro claro, não 500 genérico
      if (/column.*cnpj.*does not exist/i.test(msg) || /42703/i.test(msg)) {
        console.error('[POST /grupo/empresas] Coluna cnpj ausente — DDL 004 não aplicado:', msg);
        return res.status(503).json({
          error: 'Funcionalidade de CNPJ indisponível: DDL 004 ainda não foi aplicado. Contacte o operador.',
        });
      }
      throw pgErr; // outros erros: deixar cair no catch externo
    }

    if (!novaEmpresa || novaEmpresa.length === 0) {
      return res.status(500).json({ error: 'Erro ao criar empresa.' });
    }

    const criada = novaEmpresa[0];

    // Response 201 — pass ausente (SC-005, FR-005)
    return res.status(201).json({
      id:           criada.id,
      nome_empresa: criada.nome_empresa,
      email:        criada.email,
      id_grupo:     criada.id_grupo,
    });
  } catch (err) {
    console.error('[POST /grupo/empresas] Erro:', err.message);
    return res.status(500).json({ error: 'Erro no servidor.' });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// GET /grupo/empresas/:id
//   Retorna dados completos de uma empresa filial do grupo para pré-preencher form de edição.
//   Feature: grupo-unificado-filiais (FR-B, task 3.1)
//
//   Auth: authenticateToken (no mount /grupo) + requireGrupoPai (middleware aqui).
//   Segurança:
//     HIGH-002 (CWE-89): :id sanitizado para inteiro antes de qualquer query.
//     MEDIUM-003 (BOLA): empresa buscada e id_grupo comparado com token.
//
//   Response 200: { id, nome_empresa, email, cnpj, endereco, numero, cep, email_nota, observacao, id_grupo }
//   Response 400: ID inválido
//   Response 403: não-admin ou empresa de outro grupo
// ──────────────────────────────────────────────────────────────────────────────
router.get('/empresas/:id', requireGrupoPai, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'ID inválido' });
    }

    const { id_grupo } = req.user;
    const idGrupoInt = parseInt(id_grupo, 10);

    const empresaResult = await _postgrestRequest(
      `Empresa?id=eq.${id}&select=id,id_grupo,nome_empresa,email,cnpj,endereco,numero,cep,email_nota,observacao`,
      'GET'
    );
    if (!empresaResult || empresaResult.length === 0) {
      return res.status(403).json({ error: 'Empresa não encontrada' });
    }
    const empresa = empresaResult[0];
    if (empresa.id_grupo !== idGrupoInt) {
      return res.status(403).json({ error: 'Empresa não encontrada' });
    }

    // Não expõe pass/senha em hipótese alguma (SC-005, FR-B)
    return res.status(200).json({
      id:           empresa.id,
      nome_empresa: empresa.nome_empresa,
      email:        empresa.email,
      cnpj:         empresa.cnpj        || '',
      endereco:     empresa.endereco    || '',
      numero:       empresa.numero      || '',
      cep:          empresa.cep         || '',
      email_nota:   empresa.email_nota  || '',
      observacao:   empresa.observacao  || '',
      id_grupo:     empresa.id_grupo,
    });
  } catch (err) {
    console.error('[GET /grupo/empresas/:id] Erro:', err.message);
    return res.status(500).json({ error: 'Erro no servidor.' });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// PUT /grupo/empresas/:id
//   Atualiza dados cadastrais de uma empresa filial do grupo do admin autenticado.
//   Feature: grupo-unificado-filiais (FR-B)
//   Ref: docs/specs/grupo-unificado-filiais/spec.md
//
//   Auth: authenticateToken (no mount /grupo) + requireGrupoPai (middleware aqui).
//   Segurança:
//     HIGH-002 (CWE-89): :id sanitizado para inteiro antes de qualquer query.
//     MEDIUM-003 (BOLA): empresa buscada e id_grupo comparado com token.
//     LOW-002: mesmo emailRegex do POST.
//
//   Body: { nome_empresa, email, cnpj, endereco?, numero?, cep?, email_nota?, observacao? }
//   Campos ignorados: senha / pass (NUNCA atualizado por esta rota — FR-B).
//   Response 200: { id, nome_empresa, email, id_grupo }
//   Response 400: ID inválido / nome_empresa ausente / email inválido / CNPJ inválido /
//                 tentativa de editar a própria empresa-pai
//   Response 403: não-admin (requireGrupoPai) / empresa de outro grupo (MEDIUM-003)
//   Response 409: email duplicado / cnpj duplicado
// ──────────────────────────────────────────────────────────────────────────────
router.put('/empresas/:id', requireGrupoPai, async (req, res) => {
  try {
    // ── HIGH-002 (CWE-89): sanitizar :id antes de qualquer uso ────────────
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'ID inválido' });
    }

    // ── Dados do token (SC-004: id_grupo sempre do token, nunca do body) ──
    const { empresaId, id_grupo } = req.user;
    const idGrupoInt = parseInt(id_grupo, 10);

    // ── MEDIUM-003 (BOLA): buscar empresa e verificar pertença ao grupo ───
    const empresaResult = await _postgrestRequest(
      `Empresa?id=eq.${id}&select=id,id_grupo,nome_empresa,email,cnpj`,
      'GET'
    );
    if (!empresaResult || empresaResult.length === 0) {
      return res.status(403).json({ error: 'Empresa não encontrada' });
    }
    const empresa = empresaResult[0];
    if (empresa.id_grupo !== idGrupoInt) {
      return res.status(403).json({ error: 'Empresa não encontrada' });
    }

    // ── grupo-unificado-filiais (decisão do operador): a empresa-pai TAMBÉM é
    //    editável por esta rota (tratada como filial só para edição de cadastro).
    //    A proteção contra edição cross-grupo (acima) permanece; o login único
    //    permanece inalterado (esta rota nunca toca `pass`, FR-B).
    //    Antes havia um 400 bloqueando `id === empresaId`; removido a pedido do
    //    operador para permitir editar o cadastro da matriz na aba grupo.

    // ── Validações de entrada (FR-B) ──────────────────────────────────────
    const { nome_empresa, email, cnpj } = req.body || {};

    // nome_empresa obrigatório
    if (!nome_empresa || typeof nome_empresa !== 'string' || !nome_empresa.trim()) {
      return res.status(400).json({ error: 'Campo obrigatório ausente: nome_empresa.' });
    }

    // email: formato + presença — LOW-002: mesmo regex do POST
    if (!email || typeof email !== 'string') {
      return res.status(400).json({ error: 'Campo obrigatório ausente: email.' });
    }
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email.trim())) {
      return res.status(400).json({ error: 'Formato de e-mail inválido.' });
    }

    // cnpj: exatamente 14 dígitos numéricos
    if (!cnpj || typeof cnpj !== 'string') {
      return res.status(400).json({ error: 'Campo obrigatório ausente: cnpj.' });
    }
    const cnpjDigitos = cnpj.replace(/\D/g, '');
    if (cnpjDigitos.length !== 14) {
      return res.status(400).json({
        error: 'CNPJ inválido: deve conter exatamente 14 dígitos numéricos.',
      });
    }

    // ── Unicidade de email excluindo o próprio id (409) ───────────────────
    const emailDuplicado = await _postgrestRequest(
      `Empresa?email=eq.${encodeURIComponent(email.trim())}&id=neq.${id}&select=id`,
      'GET'
    );
    if (emailDuplicado && emailDuplicado.length > 0) {
      return res.status(409).json({ error: 'E-mail já cadastrado.' });
    }

    // ── Unicidade de cnpj excluindo o próprio id (409) ────────────────────
    const cnpjDuplicado = await _postgrestRequest(
      `Empresa?cnpj=eq.${encodeURIComponent(cnpjDigitos)}&id=neq.${id}&select=id`,
      'GET'
    );
    if (cnpjDuplicado && cnpjDuplicado.length > 0) {
      return res.status(409).json({ error: 'CNPJ já cadastrado.' });
    }

    // ── Montar payload — SEM pass/senha (FR-B) ────────────────────────────
    const payload = {
      nome_empresa: nome_empresa.trim(),
      email:        email.trim(),
      cnpj:         cnpjDigitos,
    };

    // Campos fiscais opcionais: incluir apenas quando fornecidos
    const { endereco, numero, cep, email_nota, observacao } = req.body || {};
    if (endereco   !== undefined && endereco   !== null) payload.endereco   = endereco;
    if (numero     !== undefined && numero     !== null) payload.numero     = numero;
    if (cep        !== undefined && cep        !== null) payload.cep        = cep;
    if (email_nota !== undefined && email_nota !== null) payload.email_nota = email_nota;
    if (observacao !== undefined && observacao !== null) payload.observacao = observacao;

    // ── PATCH via PostgREST (atualiza apenas os campos permitidos) ────────
    let empresaAtualizada;
    try {
      empresaAtualizada = await _postgrestRequest(
        `Empresa?id=eq.${id}`,
        'PATCH',
        payload
      );
    } catch (pgErr) {
      const msg = pgErr && pgErr.message ? pgErr.message : '';
      // UNIQUE constraint em email (race condition) → 409
      if (/duplicate key.*email/i.test(msg) || /unique.*email/i.test(msg)) {
        return res.status(409).json({ error: 'E-mail já cadastrado.' });
      }
      // UNIQUE constraint em cnpj (race condition) → 409
      if (/duplicate key.*cnpj/i.test(msg) || /unique.*cnpj/i.test(msg)) {
        return res.status(409).json({ error: 'CNPJ já cadastrado.' });
      }
      throw pgErr;
    }

    if (!empresaAtualizada || empresaAtualizada.length === 0) {
      return res.status(500).json({ error: 'Erro ao atualizar empresa.' });
    }

    const atualizada = empresaAtualizada[0];

    // Response 200 — pass ausente (SC-005, FR-B)
    return res.status(200).json({
      id:           atualizada.id,
      nome_empresa: atualizada.nome_empresa,
      email:        atualizada.email,
      id_grupo:     atualizada.id_grupo,
    });
  } catch (err) {
    console.error('[PUT /grupo/empresas/:id] Erro:', err.message);
    return res.status(500).json({ error: 'Erro no servidor.' });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// DELETE /grupo/filhos/:empresaIdFilho
//   Desvincula uma empresa filha (SET id_grupo = NULL). Só o pai.
//   Auth: authenticateToken + is_grupo_pai.
//   dec-016, CHK003: empresaIdFilho não-numérico → 400.
//   Response 200: { "desvinculado": true, "empresa_id_filho": <int> }
// ──────────────────────────────────────────────────────────────────────────────
router.delete('/filhos/:empresaIdFilho', requireGrupoPai, async (req, res) => {
  try {
    const { empresaId, id_grupo } = req.user;

    // F1 + dec-016: validar path param como inteiro
    const empresaIdFilho = parseInt(req.params.empresaIdFilho, 10);
    if (!Number.isInteger(empresaIdFilho) || empresaIdFilho <= 0) {
      return res.status(400).json({
        error: 'Parâmetro inválido: empresaIdFilho deve ser um número inteiro.',
      });
    }

    // Não deixar o pai se desvincular de si mesmo
    if (empresaIdFilho === empresaId) {
      return res.status(400).json({
        error: 'O administrador do grupo não pode ser desvinculado como filho.',
      });
    }

    // F1: coerce id_grupo do token
    const idGrupoInt = parseInt(id_grupo, 10);
    if (!Number.isInteger(idGrupoInt) || idGrupoInt <= 0) {
      return res.status(403).json({ error: 'Operação não permitida.' });
    }

    // Verificar se o filho pertence a este grupo
    const candidatos = await _postgrestRequest(
      `Empresa?id=eq.${empresaIdFilho}&select=id,id_grupo`,
      'GET'
    );

    if (!candidatos || candidatos.length === 0) {
      return res.status(404).json({ error: 'Empresa não está vinculada a este grupo.' });
    }

    const filho = candidatos[0];
    if (filho.id_grupo !== idGrupoInt) {
      return res.status(403).json({ error: 'Operação não permitida.' });
    }

    // Desvincular: UPDATE Empresa SET id_grupo = NULL
    await _postgrestRequest(
      `Empresa?id=eq.${empresaIdFilho}`,
      'PATCH',
      { id_grupo: null }
    );

    return res.json({ desvinculado: true, empresa_id_filho: empresaIdFilho });
  } catch (err) {
    console.error('[DELETE /grupo/filhos/:empresaIdFilho] Erro:', err.message);
    return res.status(500).json({ error: 'Erro no servidor.' });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// GET /grupo/escopo
//   Retorna as empresas que o token pode ver (escopo de seleção para o front).
//   Auth: authenticateToken (SEM requireGrupoPai — filhos também consultam).
//   Contrato: docs/specs/movimento-por-filial/contracts/grupo-escopo-api.md
//
//   Response 200:
//     { empresas: [{ id, nome_empresa, default?: true }], default: empresaId }
//
//   Regras de montagem:
//     - is_grupo_pai === true: busca Empresa?id=in.(ids)&select=id,nome_empresa
//       ordena por id asc; marca o item do pai com default:true.
//     - is_grupo_pai === false / sem grupo: retorna array de 1 item com default:true.
//     - Erro de banco: 503 { error: 'serviço indisponível' } — fail-closed.
//   CHK001-API: contrato documentado; CHK006-API: 401 sem token.
// ──────────────────────────────────────────────────────────────────────────────
router.get('/escopo', async (req, res) => {
  try {
    const { empresaId, id_grupo, is_grupo_pai, nome_empresa } = req.user;

    // Caso: single-empresa ou filho — escopo de 1 item, sem query ao banco.
    if (!id_grupo || !is_grupo_pai) {
      return res.json({
        empresas: [{ id: empresaId, nome_empresa, default: true }],
        default: empresaId,
      });
    }

    // Pai: coerce id_grupo para inteiro (proteção contra claim maliciosa).
    const idGrupoInt = parseInt(id_grupo, 10);
    if (!Number.isInteger(idGrupoInt) || idGrupoInt <= 0) {
      // Claim inválida: degradar para escopo individual (fail-safe)
      return res.json({
        empresas: [{ id: empresaId, nome_empresa, default: true }],
        default: empresaId,
      });
    }

    // Buscar todos os membros do grupo (pai + filhos) em uma única query.
    // Inclui o pai via id_grupo=eq.${idGrupoInt} (pai também tem id_grupo definido
    // quando o grupo existe). Alternativamente: busca pelo campo id_empresa_pai.
    // Usamos a abordagem mais simples: buscar filhos (id_grupo=eq.) e prepend do pai.
    const filhos = await _postgrestRequest(
      `Empresa?id_grupo=eq.${idGrupoInt}&select=id,nome_empresa&order=id.asc`,
      'GET'
    );

    // Montar lista: pai primeiro (com default:true), depois filhos em ordem.
    const listaFilhos = (filhos || []).filter(f => f.id !== empresaId);
    const empresas = [
      { id: empresaId, nome_empresa, default: true },
      ...listaFilhos.map(f => ({ id: f.id, nome_empresa: f.nome_empresa })),
    ];

    return res.json({ empresas, default: empresaId });
  } catch (err) {
    console.error('[GET /grupo/escopo] Erro:', err.message);
    return res.status(503).json({ error: 'serviço indisponível' });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// Helper interno: _resolveScopeStrict(user)
//
// Variante de resolveScope SEM degradação silenciosa:
//   - Propaga qualquer exceção de banco (em vez de engolir e retornar [empresaId]).
//   - Usada EXCLUSIVAMENTE por resolveEmpresaAlvo (CHK014-SEC: fail-closed).
//   - resolveScope público permanece com seu comportamento de degradação para
//     uso nos handlers existentes (contextos onde fail-open é preferível a falhar).
//
// Não exportada — artefato interno de resolveEmpresaAlvo.
// ──────────────────────────────────────────────────────────────────────────────
async function _resolveScopeStrict(user) {
  const { empresaId, id_grupo, is_grupo_pai } = user;

  // Sem grupo ou é filho: escopo individual — sem chamada ao banco, sem risco
  if (!id_grupo || !is_grupo_pai) {
    return [empresaId];
  }

  // Pai: coerce id_grupo para inteiro (mesma proteção de resolveScope)
  const idGrupoInt = parseInt(id_grupo, 10);
  if (!Number.isInteger(idGrupoInt) || idGrupoInt <= 0) {
    return [empresaId];
  }

  // CHK014-SEC: NÃO capturar exceção aqui — propagar para resolveEmpresaAlvo
  // que a traduz em 503 (escopo indisponível).
  const filhos = await _postgrestRequest(
    `Empresa?id_grupo=eq.${idGrupoInt}&select=id`,
    'GET'
  );
  const idFilhos = (filhos || [])
    .map(f => f.id)
    .filter(id => id !== empresaId);

  return [empresaId, ...idFilhos];
}

// ──────────────────────────────────────────────────────────────────────────────
// Helper: resolveEmpresaAlvo(user, requestedId, endpoint)
//
// Contrato (contracts/grupo-escopo-api.md §Helper):
//   Input : user       — req.user { empresaId, id_grupo, is_grupo_pai, id, ... }
//           requestedId — empresa_id solicitado pelo cliente (query/body);
//                         null/undefined/'' → usa user.empresaId (backward-compat)
//           endpoint   — string identificando o handler chamador (para log CHK019)
//   Output: empresaId (inteiro) que deve ser usado no filtro da query.
//
//   Comportamentos:
//     1. requestedId null/undefined/'' → retorna user.empresaId  (sem 403)
//     2. requestedId não-numérico (parseInt = NaN) → lança { status:403 }
//     3. requestedId ∉ _resolveScopeStrict(user) → lança { status:403 }
//     4. _resolveScopeStrict lança exceção (ex: erro de banco) → lança { status:503 }
//        CHK014-SEC FAIL-CLOSED: NUNCA defaultar para user.empresaId silenciosamente
//
//   CHK019-SEC: registra console.warn com user_id + empresa_id + endpoint em todo 403.
//   CHK016-SEC: valida que requestedId coerce para inteiro via parseInt+isInteger.
//
//   Invariante (Princípio II): IDs saem exclusivamente do token (via _resolveScopeStrict).
//   NUNCA aceitar empresaId de fora do escopo sem validação.
// ──────────────────────────────────────────────────────────────────────────────
async function resolveEmpresaAlvo(user, requestedId, endpoint) {
  // Caso 1: sem preferência de empresa → usar empresa do próprio token (backward-compat)
  if (requestedId == null || requestedId === '') {
    return user.empresaId;
  }

  // CHK016-SEC: validar que coerce para inteiro via parseInt+isInteger
  // (mesma defesa que resolveScope aplica ao id_grupo — bloqueia injeção PostgREST)
  const alvo = parseInt(requestedId, 10);
  if (!Number.isInteger(alvo)) {
    // CHK019-SEC: logar tentativa inválida
    console.warn(
      '[resolveEmpresaAlvo] 403 empresa_id inválido:',
      { user_id: user.id, empresa_id_solicitado: requestedId, endpoint: endpoint || 'desconhecido' }
    );
    const err = new Error('empresa_id inválido');
    err.status = 403;
    throw err;
  }

  // CHK014-SEC: FAIL-CLOSED — usa _resolveScopeStrict (sem degradação silenciosa).
  // Se o banco estiver indisponível, propagar como 503 — NUNCA retornar user.empresaId
  // por padrão, o que abriria brecha para acesso cross-empresa em caso de falha.
  let escopo;
  try {
    escopo = await _resolveScopeStrict(user);
  } catch (scopeErr) {
    console.error(
      '[resolveEmpresaAlvo] _resolveScopeStrict falhou — escopo indisponível:',
      { user_id: user.id, empresa_id_solicitado: alvo, endpoint: endpoint || 'desconhecido', erro: scopeErr.message }
    );
    const err = new Error('escopo indisponível');
    err.status = 503;
    throw err;
  }

  // Caso 3: empresa solicitada fora do escopo do token
  if (!escopo.includes(alvo)) {
    // CHK019-SEC: logar acesso negado com contexto completo
    console.warn(
      '[resolveEmpresaAlvo] 403 empresa fora do escopo:',
      { user_id: user.id, empresa_id_solicitado: alvo, escopo, endpoint: endpoint || 'desconhecido' }
    );
    const err = new Error('empresa fora do escopo');
    err.status = 403;
    throw err;
  }

  // Empresa válida e dentro do escopo
  return alvo;
}

// ──────────────────────────────────────────────────────────────────────────────
// Helper: mesmoGrupoQue(idEmpresa, idReferencia, cache)
//
// Verifica se idEmpresa pertence ao mesmo grupo que idReferencia.
//
// Algoritmo (máx. 2 queries PostgREST por ciclo — FR-005):
//   1. Se cache.ids já populado → usar direto (zero queries)
//   2. Buscar Grupo?id_empresa_pai=eq.<idReferencia>&select=id → idGrupoRef
//   3. Buscar Empresa?id_grupo=eq.<idGrupoRef>&select=id → membros
//   4. cache.ids = new Set([idReferencia, ...membros])
//   5. Retornar cache.ids.has(Number(idEmpresa))
//
// Assinatura SEM default cache={} — OWASP MEDIUM-002 (CWE-362):
//   default object em Node é compartilhado entre chamadas, causando
//   contaminação cross-request. O caller DEVE declarar const _grupoCache = {}
//   antes do loop e passar o objeto explicitamente.
//
// Fail-safe (FR-006): qualquer erro é capturado, logado e retorna false
//   (backward-compat — empresa não reconhecida não recebe privilégios).
// ──────────────────────────────────────────────────────────────────────────────
async function mesmoGrupoQue(idEmpresa, idReferencia, cache) {
  try {
    // Cache hit — sem queries adicionais
    if (cache.ids) {
      return cache.ids.has(Number(idEmpresa));
    }

    // Query 1: buscar o grupo cuja empresa-pai é idReferencia
    const grupos = await _postgrestRequest(
      `Grupo?id_empresa_pai=eq.${idReferencia}&select=id`,
      'GET'
    );
    if (!grupos || grupos.length === 0) {
      // idReferencia não é empresa-pai de nenhum grupo → só ela mesma
      cache.ids = new Set([Number(idReferencia)]);
      return cache.ids.has(Number(idEmpresa));
    }
    const idGrupoRef = grupos[0].id;

    // Query 2: buscar todos os membros do grupo
    const membros = await _postgrestRequest(
      `Empresa?id_grupo=eq.${idGrupoRef}&select=id`,
      'GET'
    );
    const idsMembros = Array.isArray(membros) ? membros.map(m => Number(m.id)) : [];

    // Popular cache — inclui a própria empresa de referência
    cache.ids = new Set([Number(idReferencia), ...idsMembros]);

    return cache.ids.has(Number(idEmpresa));
  } catch (err) {
    console.error('[mesmoGrupoQue] erro:', err && err.message ? err.message : err);
    return false; // fail-safe backward-compat
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Exportar router + init + resolveScope + resolveOrCreateGrupo + resolveEmpresaAlvo
// resolveScope é exportado para uso em branding.js e futuras rotas de escopo
// resolveOrCreateGrupo exportado para reutilização em futuras rotas
// resolveEmpresaAlvo exportado para uso nos 7 handlers de movimento-por-filial
// mesmoGrupoQue exportado para grupo-unificado-filiais: substituição de id===6
// ──────────────────────────────────────────────────────────────────────────────
module.exports = { router, init, resolveScope, resolveOrCreateGrupo, resolveEmpresaAlvo, mesmoGrupoQue };

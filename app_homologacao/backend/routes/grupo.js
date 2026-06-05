/**
 * Rotas de Grupo de CNPJs + helper resolveScope
 * Prefixo: /grupo/*
 *
 * Feature: config-ui-tenant (White-label por Tenant + Grupo de CNPJs)
 * Ref: docs/specs/config-ui-tenant/contracts/grupo-api.md
 *      docs/specs/config-ui-tenant/spec.md (FR-002, FR-004, FR-INFRA-LOCK)
 *      docs/constitution.md §II v1.1.0
 *
 * Princípio II (amendment v1.1.0): escopo resolvido exclusivamente a partir
 * do token JWT (req.user), nunca a partir do corpo/query do cliente.
 *
 * Requer DDL aplicado: docs/sql/001-config-ui-tenant-schema.sql
 */

'use strict';

const express = require('express');
const router = express.Router();

// ──────────────────────────────────────────────────────────────────────────────
// Dependências injetadas pelo server.js (ver module.exports.init)
// ──────────────────────────────────────────────────────────────────────────────
let _postgrestRequest;

function init({ postgrestRequest }) {
  _postgrestRequest = postgrestRequest;
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

    const filhos = await _postgrestRequest(
      `Empresa?id_grupo=eq.${idGrupoInt}&select=id,nome_empresa,email`,
      'GET'
    );

    const lista = (filhos || []).filter(f => f.id !== req.user.empresaId);

    // Limite implícito: 100 filhos (dec-025, CHK046)
    if (lista.length > 100) {
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

    // Resolver ou criar o Grupo do pai
    let idGrupoFinal;

    if (id_grupo) {
      // F1: coerce id_grupo para inteiro
      idGrupoFinal = parseInt(id_grupo, 10);
      if (!Number.isInteger(idGrupoFinal) || idGrupoFinal <= 0) {
        return res.status(500).json({ error: 'Dados de grupo inválidos no token.' });
      }
    } else {
      // Primeira vinculação: criar o Grupo para este pai
      // Verificar se já existe grupo com id_empresa_pai = empresaId (idempotência)
      const grupoExistente = await _postgrestRequest(
        `Grupo?id_empresa_pai=eq.${empresaId}&select=id`,
        'GET'
      );

      if (grupoExistente && grupoExistente.length > 0) {
        idGrupoFinal = grupoExistente[0].id;
      } else {
        // Criar grupo novo
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
          return res.status(500).json({ error: 'Erro ao criar grupo.' });
        }
        idGrupoFinal = novoGrupo[0].id;
      }
    }

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
// Exportar router + init + resolveScope
// resolveScope é exportado para uso em branding.js e futuras rotas de escopo
// ──────────────────────────────────────────────────────────────────────────────
module.exports = { router, init, resolveScope };

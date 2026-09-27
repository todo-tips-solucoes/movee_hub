// repasse-saldo-minimo F2 (tasks.md 2.2.2) — lib/hub-papeis-restritos.js
//
// Espelho Node do helper SQL `hub_papel_restrito` (migration 0097,
// infra/hub/migrations/0097_papel_financeiro_aprovador.sql): papéis que só
// o administrador da plataforma pode conceder, alterar ou desativar no
// vínculo de OUTRO usuário (spec.md FR-009/FR-010/FR-012a).
//
// Fonte única consumida por routes/hub-usuarios.js — qualquer papel
// restrito novo entra AQUI e no helper SQL da migration, nunca só num dos
// dois lados (a checagem em Node é defesa de UX/early-exit; a RLS de
// UsuarioEntidade é a defesa que vale de verdade — contracts/
// hub-usuarios-trava.md).
'use strict';

const PAPEIS_RESTRITOS = Object.freeze(['admin_plataforma', 'financeiro_aprovador']);

/**
 * @param {string|null|undefined} nomePapel
 * @returns {boolean}
 */
function papelEhRestrito(nomePapel) {
  return typeof nomePapel === 'string' && PAPEIS_RESTRITOS.includes(nomePapel);
}

module.exports = { PAPEIS_RESTRITOS, papelEhRestrito };

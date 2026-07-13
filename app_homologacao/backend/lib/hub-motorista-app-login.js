// hub-motorista-canonico (FASE 5, tasks.md 5.4) — lib/hub-motorista-app-login.js
//
// Gate de ambiente NOVO, análogo a `lib/envio-gate.js` (issue #62): decide se
// o login do app motorista (`routes/motorista.js POST /login`, produção real
// em app.motorista.moveelog.com.br) passa a autenticar contra a
// `ContaMotorista` canônica do hub (routes/hub-motoristas.js §credencial) em
// vez da tabela `Motorista` legada.
//
//   - HUB_MOTORISTA_LOGIN_CONTA_ATIVA=true → login via ContaMotorista
//     (routes/motorista.js#loginViaContaMotorista).
//   - Env var ausente/qualquer outro valor (produção hoje) → `false` sempre:
//     o bloco legado de `/login` roda EXATAMENTE como antes, byte-a-byte
//     (FR-023/SC-007 — inércia em produção).
//
// `env` é injetável só para teste unitário (default `process.env`) — nunca
// passar input de cliente aqui.
'use strict';

function hubMotoristaLoginHabilitado(env) {
  var e = env || process.env;
  return String(e.HUB_MOTORISTA_LOGIN_CONTA_ATIVA || '').toLowerCase() === 'true';
}

module.exports = { hubMotoristaLoginHabilitado };

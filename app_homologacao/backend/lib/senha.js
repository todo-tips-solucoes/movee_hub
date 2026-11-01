'use strict';

// Hash bcrypt FIXO (custo 10, ~60 ms medidos) que nunca confere com senha alguma. Os logins comparam contra ele
// quando não há conta/senha para comparar, para REDUZIR (não igualar: há hashes reais de custo 10 e de custo 12) a
// diferença de tempo em relação a uma senha errada de conta existente (anti-enumeração por tempo — OWASP HIGH-001 / CWE-208). Era duplicado em server.js e routes/hub-auth.js.
const DUMMY_HASH = '$2b$10$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ01234';

module.exports = { DUMMY_HASH };

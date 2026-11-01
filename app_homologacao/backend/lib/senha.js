'use strict';

// Hash bcrypt FIXO (custo 10, ~60 ms medidos) que nunca confere com senha alguma. Os logins comparam contra ele
// quando não há conta/senha para comparar, para a resposta demorar o mesmo que a de uma senha errada de conta
// existente (anti-enumeração por tempo — OWASP HIGH-001 / CWE-208). Era duplicado em server.js e routes/hub-auth.js.
const DUMMY_HASH = '$2b$10$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ01234';

module.exports = { DUMMY_HASH };

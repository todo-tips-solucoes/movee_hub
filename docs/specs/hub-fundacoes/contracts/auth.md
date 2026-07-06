# Contracts: Autenticação (`/api/v1/auth/*`)

Todas as respostas de erro seguem `{ "erro": "<mensagem em portugues>" }` (mesmo padrão
do backend legado). Datas em ISO 8601 UTC. Cookies `accessToken`/`refreshToken` são
`httpOnly`, `sameSite=Strict`, `secure` em ambientes com TLS (hub-homolog).

## POST /api/v1/auth/login

**Auth**: público (rate-limited por IP+e-mail — Decision 8).

### Request

| Field | Type | Required | Validation |
|-------|------|----------|------------|
| email | string | yes | formato de e-mail |
| senha | string | yes | non-empty |

### Response (200)

Cookies `accessToken` (15 min) e `refreshToken` (7 dias) setados. Corpo:

| Field | Type | Description |
|-------|------|--------------|
| usuario | object | `{ id, email, nome }` |

### Error Responses

| Status | Code | Description |
|--------|------|-------------|
| 401 | CREDENCIAIS_INVALIDAS | e-mail inexistente OU senha incorreta — resposta idêntica nos dois casos (FR-015, dummy-hash anti-enumeração, mesmo padrão de `server.js:79`) |
| 423 | CONTA_BLOQUEADA | 5 falhas consecutivas nos últimos 15 min (FR-017) |
| 429 | RATE_LIMIT | limite de tentativas por origem excedido (FR-016) |

**Efeito colateral**: todo login (sucesso ou falha) grava 1 linha em `Auditoria`
(`acao = login_sucesso | login_falha`), nunca com a senha em `detalhes` (FR-023, FR-025).

## POST /api/v1/auth/refresh

**Auth**: cookie `refreshToken` válido e não revogado.

### Response (200)

Novo `accessToken` (e novo `refreshToken` — rotação, Decision 9) setados como cookie.
Corpo vazio ou `{ ok: true }`.

### Error Responses

| Status | Code | Description |
|--------|------|--------------|
| 401 | SESSAO_INVALIDA | refresh token ausente, expirado ou já revogado (inclui replay de token rotacionado) |

## POST /api/v1/auth/logout

**Auth**: cookie `accessToken` ou `refreshToken` presente.

### Response (200)

`{ ok: true }`. `SessaoRefresh.revogado_em` setado para a sessão corrente; cookies
limpos. A partir deste momento essa sessão específica não renova mais acesso (FR-018).

## POST /api/v1/auth/recuperar-senha

**Auth**: público, rate-limited por IP+e-mail (mesmo limiter de `/auth/login` — research.md
Decision 14, remediação `owasp-security`).

### Request

| Field | Type | Required | Validation |
|-------|------|----------|------------|
| email | string | yes | formato de e-mail |

### Response (200)

**Sempre** `{ ok: true, mensagem: "Se o e-mail existir, um link de redefinição foi enviado." }`
— idêntica esteja o e-mail cadastrado, não cadastrado, ou o envio de e-mail tenha falhado
por qualquer motivo de infraestrutura (FR-020, SC-005). Nunca retorna 4xx/5xx distinto
por esse motivo.

**Efeito colateral** (quando o e-mail existe): gera `token_recuperacao_hash` +
`token_recuperacao_expira`, sobrescrevendo qualquer pedido anterior pendente (Edge Case
— apenas o pedido mais recente é válido); dispara envio via mock de e-mail
(`infra/hub/mocks/mailpit-like/` — Decision 11).

## POST /api/v1/auth/redefinir-senha

**Auth**: público (o token no corpo é a prova de identidade).

### Request

| Field | Type | Required | Validation |
|-------|------|----------|------------|
| token | string | yes | token bruto recebido por e-mail (comparado contra o hash armazenado) |
| nova_senha | string | yes | política mínima de senha (definida em `hub-auth.js`, ex.: 8+ caracteres) |

### Response (200)

`{ ok: true }`. `senha_hash` atualizado; `token_recuperacao_hash` invalidado (NULL);
**todas** as `SessaoRefresh` ativas dessa conta são revogadas (FR-022, SC-007).

### Error Responses

| Status | Code | Description |
|--------|------|--------------|
| 400 | TOKEN_INVALIDO | token não confere com nenhum hash armazenado |
| 410 | TOKEN_EXPIRADO | token existe mas passou de `token_recuperacao_expira`, ou já foi usado (hash já NULL) |

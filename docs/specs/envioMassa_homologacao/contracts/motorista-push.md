# Contracts: App do motorista — push e avisos

**[PROPOSTA — a validar na implementação]**: todos os endpoints abaixo são **novos**. O
que é afirmado como já existente cita `arquivo:linha`.

## Convenções

- **Caminho**: o app chama `/api/motorista/...`. O proxy `app_homologacao/frontend_motorista/app/api/[...path]/route.ts`
  remove `/api` e repassa para `BACKEND_URL` (`route.ts:9-15`), então o backend recebe
  `/motorista/...`.
- **Montagem no backend**: novo router `routes/motorista-push.js`, montado dentro do router
  `/motorista` com `authenticateMotorista` — mesmo padrão do `brandingTomadorRouter`
  (`app_homologacao/backend/server.js:2820`).
- **Autenticação**: cookie `accessToken` com `aud === 'motorista'` (`routes/motorista.js:155-176`).
  A identidade é `req.motorista.cnpjPrestador`. Qualquer `cnpj`, `cnpjPrestador`,
  `motoristaId` ou `empresa` no corpo ou na query é **ignorado** (FR-003).
- **Erro**: as rotas novas respondem `{ "erro": "CODIGO" }`, com `motivo` opcional (convenção
  do hub, `routes/hub-papeis.js:48-196`); o app traduz o código para mensagem em português.
  Exceção herdada: o `401` vem do `authenticateMotorista` reutilizado, com
  `{ "error": "<texto>" }` (`routes/motorista.js:158,163,168`) — o app decide pelo status
  HTTP, não pela chave.
- **Limite de taxa**: 30 requisições por 15 min por `cnpjPrestador`, somando inscrição,
  revogação e estado. Excedido → `429 { "erro": "LIMITE_EXCEDIDO" }`.
- **Logs**: nunca o `endpoint` completo, nem `p256dh`/`auth` ou a chave privada — só os 8
  primeiros hex do `endpoint_hash` (FR-031).

## GET /motorista/push/chave-publica

**Auth**: motorista.

### Response (200)

| Field | Type | Description |
|-------|------|-------------|
| chavePublica | string | chave pública VAPID (base64url, 65 bytes decodificados) — usada como `applicationServerKey` |
| keyId | string | 16 hex de sha256(chavePublica) |

### Error Responses

| Status | Code | Description |
|--------|------|-------------|
| 401 | — | sem sessão; o middleware existente responde |
| 503 | PUSH_INDISPONIVEL | arquivo de chave ausente ou inválido no servidor |

## PUT /motorista/push/inscricao

Registra ou atualiza a inscrição do aparelho. É idempotente e o app chama a cada abertura
autenticada com permissão concedida (FR-008).

### Request

| Field | Type | Required | Validation |
|-------|------|----------|------------|
| endpoint | string | yes | URL `https:`, sem userinfo e sem porta, até 2.000 caracteres, hostname na allowlist (research Decision 10) |
| keys.p256dh | string | yes | base64url, até 256 caracteres |
| keys.auth | string | yes | base64url, até 256 caracteres |
| keyId | string | yes | igual ao `keyId` ativo |
| plataforma | string | yes | `android` \| `ios` \| `desktop_outros` |
| dispositivoId | string | yes | UUID |

### Response (204)

Sem corpo. Efeitos:
- a inscrição fica vinculada ao `cnpjPrestador` do token, transferindo-a se for de outro
  motorista;
- o estado do aparelho passa a `ativas`.

### Error Responses

| Status | Code | Description |
|--------|------|-------------|
| 400 | DADOS_INVALIDOS | campo ausente ou fora de formato (`motivo` diz qual) |
| 400 | ENDPOINT_NAO_PERMITIDO | serviço de push não reconhecido |
| 409 | CHAVE_DESATUALIZADA | `keyId` diferente do ativo; o app re-assina com a chave nova |
| 429 | LIMITE_EXCEDIDO | limite de taxa |
| 503 | PUSH_INDISPONIVEL | chave do servidor indisponível |

## POST /motorista/push/inscricao/revogar

Chamado no logout, antes de `POST /motorista/logout`. É `POST` (e não `DELETE` com corpo)
para não depender de proxy repassar corpo em `DELETE`.

### Request

| Field | Type | Required | Validation |
|-------|------|----------|------------|
| endpoint | string | yes | mesma validação de formato; allowlist não exigida |
| dispositivoId | string | yes | UUID |

### Response (204)

Idempotente: responde 204 mesmo se a inscrição não existir ou não for do motorista.

## PUT /motorista/push/estado

### Request

| Field | Type | Required | Validation |
|-------|------|----------|------------|
| dispositivoId | string | yes | UUID |
| estado | string | yes | `ativas` \| `bloqueadas` \| `ios_sem_instalacao` \| `sem_suporte` \| `nao_ativadas` |
| plataforma | string | yes | `android` \| `ios` \| `desktop_outros` |

### Response (204)

Nenhum outro dado do aparelho é aceito (FR-007).

## GET /motorista/avisos/:id

**Auth**: motorista. `:id` inteiro positivo.

### Response (200)

Somente se o motorista do token foi destinatário do aviso (FR-013).

| Field | Type | Description |
|-------|------|-------------|
| id | number | id do aviso |
| titulo | string | |
| corpo | string | |
| enviadoEm | string | ISO 8601 (`Aviso.criado_em`) |

### Error Responses

| Status | Code | Description |
|--------|------|-------------|
| 404 | AVISO_NAO_DISPONIVEL | inexistente, expurgado **ou** o motorista não foi destinatário — resposta idêntica nos três casos, sem enumeração; o app mostra "Aviso não disponível" |

## Payload do push (backend → serviço de push → service worker)

Cifrado pelo `web-push`. O conteúdo em claro é JSON UTF-8 com no máximo 1.024 bytes:

```json
{ "avisoId": 123, "titulo": "Texto da equipe", "corpo": "Mensagem curta da equipe" }
```

Nenhum outro campo é permitido (FR-012, SC-007): sem nome, CNPJ, documento, valor ou dado
buscado da base.

Opções do envio (`web-push`): `TTL: 259200` (72 h), `urgency: 'normal'`, `timeout: 10000`.

## Service worker (`frontend_motorista/app/sw.ts`)

| Evento | Comportamento |
|---|---|
| `push` | `showNotification(titulo, { body: corpo, tag: 'aviso-<avisoId>', icon: '/icons/icon-192x192.png', data: { url: '/avisos/<avisoId>' } })`. O payload inválido é descartado sem notificação. |
| `notificationclick` | `notification.close()`; foca janela existente e navega para `data.url`; sem janela, `clients.openWindow(data.url)` |
| runtime caching | `NetworkOnly` para `/api/motorista/(avisos\|push)/` **antes** da regra `NetworkFirst` de `/api/motorista/.*` (`sw.ts:33-40`) |

## Estado local do app (`localStorage`, sem token e sem PII)

| Chave | Valor | Uso |
|---|---|---|
| `push.dispositivoId` | UUID aleatório | identifica o aparelho em inscrição e estado |
| `push.keyId` | `keyId` usado na última assinatura | se diferir do servido, o app re-assina (FR-008/FR-026) |
| `notificacoes.contexto.dispensado` | `"1"` | não reabrir o passo de contexto sozinho; o ponto de entrada continua visível (FR-007) |

## Rotas novas do app

| Rota | Descrição |
|---|---|
| `/avisos/[id]` | detalhe do aviso: busca `GET /api/motorista/avisos/:id`; 404 → "Aviso não disponível" |
| `/login?next=<caminho>` | `next` só é aceito se começar com `/` e não com `//` ou `/\`; o destino padrão continua `/movimento` |

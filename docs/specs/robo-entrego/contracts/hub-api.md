# Contract — API do hub (`app_homologacao/backend`, consumida pelo robô)

Fonte primária dos endpoints EXISTENTES: `docs/specs/hub-importacoes/contracts/importacoes-api.md`
(contrato já ratificado da feature `hub-importacoes`) + leitura direta do código-fonte
nesta sessão (`routes/hub-auth.js`, `routes/hub-importacoes.js`, `lib/hub-access-token.js`,
`lib/hub-auditoria.js`, `server.js`). Auth: cookie httpOnly `hub_accessToken`
(JWT HS256, TTL curto — ver `lib/hub-access-token.js`), **nunca** header
`Authorization`/`Bearer`. O robô precisa de um HTTP client com cookie jar (axios com
`jar` via `tough-cookie`, ou reconstruir manualmente o header `Cookie:` a partir do
`Set-Cookie` da resposta de login — decisão de implementação, fora do escopo deste
plano).

---

## POST /api/v1/auth/login — EXISTENTE

Fonte: `app_homologacao/backend/routes/hub-auth.js:217`, mount em `server.js:2823`
(`app.use('/api/v1/auth', hubAuthRoutes.router)`).

**Auth**: nenhuma (rota de login). Rate-limited (`authRateLimiter`).

### Request

`Content-Type: application/json`

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| email | string | yes | normalizado (lowercase/trim) no backend |
| senha | string | yes | nome do campo em português — **não** `password` |

### Response (200)

`Set-Cookie: hub_accessToken=<jwt>; httpOnly; ...` (`maxAge = ACCESS_TOKEN_TTL_MS`)
+ `Set-Cookie: hub_refreshToken=<jwt>; httpOnly; ...`. Corpo JSON não inspecionado
neste levantamento — não assumir shape; a implementação MUST inspecionar a resposta
real (o que importa para o robô são os cookies, não o corpo).

### Error Responses (verificadas no código)

| Status | Corpo | Motivo |
|--------|-------|--------|
| 401 | `{ erro: "E-mail ou senha inválidos." }` | credencial inválida, e-mail inexistente, ou senha errada — resposta uniforme (anti-enumeração) |
| 423 | `{ erro: "Conta temporariamente bloqueada por excesso de tentativas. Tente novamente mais tarde." }` | conta bloqueada por tentativas |

**Nota de design (CORRIGIDA — drift encontrado em tasks.md 6.2, roundtrip real
contra `hub-homolog`, 2026-08-28)**: a versão anterior desta nota afirmava que
o token JWT devolvido pelo login já carrega `entidade_ativa`. **Isso é falso**
— confirmado lendo `routes/hub-auth.js#gerarAccessToken` (assina só
`{sub, email}`) e decodificando o JWT de uma sessão de login real: a claim
está ausente. A claim `entidade_ativa` (snake_case — confirmado em
`routes/hub-importacoes.js:197`, `payload.entidade_ativa`) só passa a existir
no token **depois** de `POST /api/v1/me/entidade` (abaixo), mesmo quando o
usuário de serviço tem um único vínculo `UsuarioEntidade`. `hub-client.js`
(FASE 3.3) foi corrigido para encadear login → `/me/entidade` → conferência
contra `HUB_ID_EMPRESA` antes de considerar a sessão utilizável — se
`/me/entidade` falhar (ex.: `403 SEM_VINCULO`) ou a entidade devolvida
divergir de `HUB_ID_EMPRESA`, é erro de CONFIGURAÇÃO do usuário de serviço
(não uma falha transitória, não retry — bloqueio que exige o operador
corrigir o cadastro).

---

## POST /api/v1/me/entidade — EXISTENTE (passo obrigatório pós-login)

Fonte: `app_homologacao/backend/routes/hub-me.js:160`, mount em `server.js`
(`app.use('/api/v1/me', hubMeRoutes.router)`). Adicionado ao contrato do robô
após o achado acima — sem este passo o token nunca carrega `entidade_ativa` e
toda chamada subsequente (`/importacoes`, `/robo-entrego/eventos`) falha por
`ENTIDADE_NAO_SELECIONADA` (400).

**Auth**: cookie `hub_accessToken` (o da resposta de `/auth/login`).

### Request

`Content-Type: application/json`

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| empresa_id | integer | yes | `HUB_ID_EMPRESA` da configuração do robô — o backend recusa (`403 SEM_VINCULO`) se não houver `UsuarioEntidade` ativo para esse par usuário/empresa |

### Response (200)

`{ entidade_ativa: <empresa_id> }` + **novo** `Set-Cookie: hub_accessToken=<jwt>`
(substitui o cookie do login — o robô MUST reenviar este, não o anterior, nas
chamadas seguintes).

### Error Responses (verificadas no código)

| Status | Corpo | Motivo |
|--------|-------|--------|
| 400 | `{ erro: "EMPRESA_ID_INVALIDO" }` | `empresa_id` ausente ou não-inteiro |
| 401 | `{ erro: "NAO_AUTENTICADO" }` | sem cookie de sessão válido |
| 403 | `{ erro: "SEM_VINCULO" }` | usuário sem `UsuarioEntidade` ativo para essa empresa — erro de CONFIGURAÇÃO |

---

## POST /api/v1/importacoes — EXISTENTE

Fonte: `app_homologacao/backend/routes/hub-importacoes.js:215`, mount em
`server.js:2833` (`app.use('/api/v1/importacoes', hubImportacoesRoutes.router)`).
**Correção de fato**: este é o path real — não `/hub/importacoes` (path mencionado
na descrição inicial da feature, divergente do código-fonte verificado agora).

**Auth**: cookie `hub_accessToken` + permissão `importacoes.criar` na entidade
ativa do token.

### Request

`Content-Type: multipart/form-data`

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| tipo | string | yes | `faturamento` \| `performance` (`TIPOS_SUPORTADOS`, `lib/hub-import-parser.js:42`) — tradução do `FINANCE`/`PERFORMANCE` do portal (data-model.md) |
| file | binary | yes | nome do campo multipart é `file` (`upload.single('file')`, `routes/hub-importacoes.js:115`) — CSV ou ZIP de 1 entrada, ≤ 20 MB |

### Response (201) — aceito

```json
{ "id": <int>, "status": "pending" }
```

Processamento assíncrono inicia (ou aguarda `pg_try_advisory_lock(id_empresa,tipo)`
se já há outra importação do mesmo tipo em andamento). O robô MUST fazer polling em
`GET /api/v1/importacoes/:id` até status terminal — `201` sozinho NÃO significa
sucesso, só "aceito para processar" (FR-005 da spec, "obter arquivo assim que
pronto" já cumprido pelo robô antes desta chamada; a incerteza aqui é do lado do
hub, não do portal).

### Response (409) — duplicado (FR-008 da spec)

```json
{ "error": "CONFLITO", "importacaoOriginalId": <int> }
```

Tratar como SUCESSO idempotente — não é falha, não conta como tentativa, não
dispara retry nem alerta (data-model.md, `status_hub: duplicado`).

### Response (422) — inválido

```json
{ "error": "INVALIDO", "motivo": "<string>" }
```

Falha do hub ao aceitar o arquivo (extensão/MIME/tamanho/conteúdo inválido). O robô
MUST registrar `motivo` de forma legível no log/alerta — é o edge case explícito da
User Story 3 cenário 3 ("motivo da rejeição fica registrado... sem investigar logs
brutos do servidor").

---

## GET /api/v1/importacoes/:id — EXISTENTE (polling)

Fonte: `docs/specs/hub-importacoes/contracts/importacoes-api.md` §"GET
/importacoes/:id".

**Response (200)**:

```json
{
  "id": <int>, "tipo": "...", "status": "pending|validating|processing|completed|completed_with_errors|failed|cancelled",
  "contadores": { "total": <int>, "validas": <int>, "invalidas": <int> },
  "dataReferencia": "...", "iniciadoEm": "...", "concluidoEm": "...",
  "duracaoSegundos": <number>, "erroResumo": "..."
}
```

O robô faz polling (intervalo sugerido: alguns segundos, com timeout total — a
decidir em `create-tasks`) enquanto `status ∈ {pending, validating, processing}`.
Status terminal `completed`/`completed_with_errors` = sucesso da rodada para este
relatório (mesmo com algumas linhas inválidas — FR-008/US1 não exigem 100% de
linhas válidas para considerar a importação bem-sucedida, só que o ARQUIVO tenha
sido aceito e processado). Status terminal `failed` = falha (usar `erroResumo`).

---

## POST /api/v1/robo-entrego/eventos — **[PROPOSTA — NÃO EXISTE HOJE, a validar/implementar]**

Necessário para fechar o gap descoberto em research.md Decision 9: FR-013 exige
registrar TODA falha definitiva na auditoria do hub, mas não há hoje nenhum endpoint
público de escrita em `Auditoria` (só `GET /api/v1/auditoria`, leitura,
`routes/hub-me.js:72`). Sem isso, falhas de login no portal EntreGô (o caso mais
provável, dado o risco de PerimeterX/Akamai) nunca teriam trilha de auditoria no
hub.

**Auth**: cookie `hub_accessToken` + permissão `importacoes.criar` (REUSA a mesma
permissão já concedida ao usuário de serviço — nenhuma permissão nova).

### Request (proposto)

`Content-Type: application/json`

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| acao | string | yes | **allowlist fechada** (gate `owasp-security`, achado MEDIUM — research.md Decision 9): `robo_entrego.sucesso` \| `robo_entrego.falha_definitiva` \| `robo_entrego.suspeita_antibot` \| `robo_entrego.falha_configuracao`. Qualquer outro valor → `422 INVALIDO` |
| detalhes | object | não | passa por `scrubDetalhes` (já existente em `lib/hub-auditoria.js`) antes de gravar — nunca incluir segredo; tamanho já limitado pelo `express.json()` global (100kb default, `server.js:179`) |

**Hardening adicional recomendado**: aplicar o mesmo `authRateLimiter` já usado em
`POST /api/v1/auth/login` (defesa barata contra uso indevido da credencial para
flood de uma tabela imutável).

### Implementação proposta (server-side)

Resolve `id_empresa` da claim `entidade_ativa` do token (idêntico ao padrão de
`routes/hub-importacoes.js:224-227`), monta `{ idEmpresa, usuarioId: payload.sub,
acao, recurso: 'RoboEntrego', detalhes, ip: req.ip }` e delega para
`registrarAuditoria()` já existente (`lib/hub-auditoria.js:148`) — zero migration
nova (tabela `Auditoria` já tem as colunas necessárias, `infra/hub/migrations/0004_auditoria.sql`).

### Response (201) — proposto

```json
{ "ok": true }
```

(`registrarAuditoria` é best-effort/nunca lança — resposta simples o suficiente.)

**Nota de escopo**: esta é uma proposta de código NOVO no backend do hub —
`create-tasks`/`execute-task` desta pipeline PODEM implementá-la (não há restrição
contra tocar código do backend), mas a IMPLANTAÇÃO em produção segue o rito de
deploy padrão do projeto (fora do escopo de execução desta pipeline SDD).

---

## GET /api/v1/auditoria — EXISTENTE (leitura, usada só para verificação/6.2)

Fonte: `routes/hub-me.js:400` (`auditoriaRouter.get('/', requirePermission('auditoria.consultar'), ...)`).
Não é consumida pelo robô em produção (o robô só ESCREVE via `POST
/robo-entrego/eventos`) — usada aqui apenas para confirmar, no roundtrip real
de 6.2, que a linha gravada aparece.

**Drift encontrado (tasks.md 6.2.3, PRÉ-EXISTENTE — não introduzido por esta
feature, fora de escopo corrigir aqui)**: os filtros de query `acao` e
`recurso` validam contra `VOCABULARIO_FECHADO_RE = /^[a-z0-9_]+$/`
(`routes/hub-me.js:45`) — minúsculo, sem ponto. Isso rejeita com `400
PARAMETRO_INVALIDO` **qualquer** filtro pelos valores reais gravados por este
robô (`acao: "robo_entrego.sucesso"` tem `.`, fora do vocabulário) e por
`recurso: "RoboEntrego"` (CamelCase, fora do vocabulário) — o mesmo já valia
antes desta feature para `recurso: "Usuario"`/`"UsuarioEntidade"` gravados por
`routes/hub-auth.js`/`routes/hub-me.js`. Na prática, `GET /api/v1/auditoria`
só pode ser filtrada por `usuarioId`/`entidadeId`/`de`/`ate` para achar
eventos do robô — `acao`/`recurso` exigem listar sem filtro e buscar no
array `eventos` client-side (confirmado empiricamente em 6.2.2). Registrado
como sugestão para a skill/feature dona de `GET /auditoria`
(`hub-auditoria-admin`, S9) — fora do escopo de correção desta pipeline.

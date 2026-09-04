# Contract: Busca de dados na EntreGô (sob demanda + rotina semestral)

Cobre FR-001..FR-007, FR-016. Três superfícies: (1) endpoint novo no hub
para o gestor pedir a busca; (2) endpoint novo no hub para o worker de
`infra/robo-entrego/` consumir a fila e gravar o resultado; (3) a chamada do
worker ao portal EntreGô em si — **essa terceira é `[PROPOSTA — a validar na
implementação]`, sem endpoint documentado (research.md Decision 9)**.

## 1. POST /motoristas/:id/entrego-enriquecimento — `[PROPOSTA]`

Endpoint novo no hub (`app_homologacao/backend/routes/hub-motoristas.js`,
mesmo arquivo/convenção dos demais).

**Auth**: cookie `accessToken` + `requirePermission('motoristas.editar')`
(reusa a permissão já concedida a `operador`/admins — acionar a busca não é
mais sensível do que editar o cadastro; a leitura do RESULTADO é que é
RBAC-restrita, ver `contracts/hub-motoristas-detalhe.md`).

**Rate limiting (gate `owasp-security`, achado API4/A06)**: MUST aplicar um
`express-rate-limit` dedicado (mesmo padrão já usado no projeto —
`registerRateLimiter` em `routes/motorista.js`, `roboEntregoRateLimiter` em
`routes/hub-robo-entrego.js`), por usuário/IP. Razão específica desta
rota: a sessão EntreGô é **compartilhada por todas as empresas** (um único
`entrego-session.json`) — uma rajada de pedidos de UM gestor pode disparar
o antibot (`ErroAntibotSuspeito`) e travar a busca para TODOS os tenants,
não só o solicitante. Não é apenas um DoS comum; é um recurso compartilhado
com blast radius cross-tenant.

### Request

Sem corpo. `id` no path (mesmo padrão de `POST /:id/vinculo`).

### Response (202) — pedido aceito, processamento assíncrono

| Field | Type | Description |
|-------|------|-------------|
| status | string | `"pendente"` |

### Error Responses

| Status | Code | Description |
|--------|------|-------------|
| 404 | NAO_ENCONTRADO | fora do escopo da empresa ativa (mesmo padrão já usado no arquivo) |
| 409 | SEM_IDENTIFICADOR_ENTREGO | `Entregador.id_externo` ausente — User Story 2, cenário 3 ("sistema informa que falta associar o identificador") |
| 429 | JA_PENDENTE | já existe pedido pendente para este motorista (`dados_entrego_solicitado_em` não nulo) |

## 2. Fila consumida por `infra/robo-entrego/` — `[PROPOSTA]`

Extensão de `routes/hub-robo-entrego.js` (já existente, hoje só expõe
`POST /eventos`, verificado nesta sessão). Auth via o usuário de serviço
`robo_entrego_servico` já provisionado
(`infra/robo-entrego/sql/001-usuario-servico-robo-entrego.sql`), autenticado
pelo `hub-client.js` já existente do robô.

### GET /hub-robo-entrego/motoristas-para-enriquecer

**Auth**: `requirePermission('motoristas.enriquecimento.consultar')`
`[PROPOSTA]` — nova permissão concedida ao papel `robo_entrego_servico`
(research.md Decision 11).

**Escopo multi-tenant (gate `owasp-security`, achado A01/API1 BOLA —
OBRIGATÓRIO deixar explícito, Constitution II é NON-NEGOTIABLE)**: esta
query MUST passar por `hubPostgrestRequest()` com os `claims` do usuário de
serviço autenticado (nunca uma chamada direta ao Postgres/bypass de RLS).
A RLS de `Entregador` (já existente, migration 0015) confina o resultado a
`id_empresa` do token do `robo_entrego_servico` (hoje só `empresa_id=6`,
grupo Movee — `sql/001-usuario-servico-robo-entrego.sql`) automaticamente.
**Nunca** implementar esta rota com uma query que ignore `claims`/RLS "por
conveniência" (ex.: papel `service_role` do PostgREST) — isso reabriria
acesso cross-tenant que a RLS existente já fecha.

**Query params**: `modo=sob-demanda|semestral`.
- `sob-demanda`: `WHERE dados_entrego_solicitado_em IS NOT NULL ORDER BY dados_entrego_solicitado_em ASC LIMIT N`, com o MESMO throttle entre motoristas já exigido para o modo `semestral` (FR-016) — a sessão EntreGô é o recurso compartilhado, o throttle não pode valer só para um modo.
- `semestral`: `WHERE dados_entrego_enriquecidos_em < now() - interval '6 months' ORDER BY dados_entrego_enriquecidos_em ASC LIMIT N`

### Response (200)

| Field | Type | Description |
|-------|------|-------------|
| items[].id | int | `Entregador.id` |
| items[].idExterno | uuid | UUID EntreGô — usado para preencher o campo "UUID do motorista" do filtro (BRIEFING-INPUT.md passo 4) |

### PATCH /hub-robo-entrego/motoristas/:id/entrego-enriquecimento

**Auth**: `requirePermission('motoristas.enriquecimento.atualizar')` `[PROPOSTA]`.

**Request**: `{ sucesso: boolean, dados?: <shape de data-model.md>, motivoFalha?: string }`

- `sucesso=true`: grava `dados_entrego_json = dados`,
  `dados_entrego_enriquecidos_em = now()`, `dados_entrego_solicitado_em = NULL`.
- `sucesso=false`: só `dados_entrego_solicitado_em = NULL` (FR-007 — nunca
  descarta um enriquecimento anterior bem-sucedido).
- Em ambos os casos, chamar `registrarAuditoria()` (`lib/hub-auditoria.js`,
  já existente): `acao: 'motorista.entrego_enriquecido'` ou
  `'motorista.entrego_enriquecimento_falhou'`, `recurso: 'Entregador'`,
  `recursoId: id`, `detalhes: { modo }` — **nunca** incluir o payload de
  dados sensíveis em `detalhes` (evita duplicar CPF/RG/etc. na tabela de
  auditoria; `scrubDetalhes()` já existente em `hub-auditoria.js` é defesa
  adicional, não substitui a disciplina de não logar o payload).

**Verificação de linhas afetadas (gate `owasp-security`, achado A01 —
falha silenciosa)**: o `PATCH` MUST checar que a linha foi de fato
encontrada/afetada (RLS pode retornar 0 linhas para um `:id` fora do
escopo do `robo_entrego_servico` — mesmo mecanismo de isolamento do item
anterior) — 0 linhas afetadas MUST responder 404, nunca 200/204 silencioso
(que mascararia tanto um erro de escopo quanto um `id` inexistente).

### Error Responses

| Status | Code | Description |
|--------|------|--------------|
| 401/403 | NAO_AUTENTICADO / PERMISSAO_NEGADA | (mesmo middleware) |
| 404 | NAO_ENCONTRADO | inclui o caso de 0 linhas afetadas por RLS (fora do escopo do serviço) |

## 3. Worker → portal EntreGô — `[PROPOSTA — a validar na implementação]`

**Sem contrato afirmado.** `docs/plans/robo-entrego/ACHADOS-PORTAL.md` não
documenta nenhum endpoint de "dados da pessoa entregadora" (research.md
Decision 9). Duas vias, em ordem de preferência, ambas a validar
empiricamente na implementação:

1. **Preferencial**: chamada de API real ao BFF (`https://api.entregolog.com/logistics-web-bff/...`,
   rota exata desconhecida) feita dentro de `page.evaluate()` — mesmo padrão
   de `entrego-portal.js:7-13` para os relatórios. A implementação MUST
   inspecionar a aba Network durante os 6 passos de navegação (abaixo) e
   registrar o endpoint real em `ACHADOS-PORTAL.md` antes de codificar.
2. **Fallback declarado**: os 6 XPaths ditados pelo operador
   (`docs/plans/hub-motorista-360/BRIEFING-INPUT.md` linhas 41-48),
   navegação de UI completa até a página "Dados da pessoa entregadora",
   com scraping do DOM. Nenhum XPath foi verificado contra a plataforma
   real (mesmo aviso já presente no briefing).

| # | Ação | XPath (não verificado) |
|---|------|-------------------------|
| 1 | Abrir o menu | `/html/body/div[1]/div/div/div[2]/div/div/div/div/div[2]/div[1]/div[1]/div/div[2]/span` |
| 2 | Item "Busca de Pessoas" | `/html/body/div[1]/div/div/div[2]/div/div/div/div/div[2]/div[2]/div[8]/div[1]/div/div[2]/span` |
| 3 | Botão "Filtro" | `/html/body/div[1]/div/div/div[2]/main/div/div[1]/div[2]/button/span` |
| 4 | Campo UUID do motorista | `/html/body/div[2]/div/div[1]/form/div[1]/div[5]/div[1]/div/input` |
| 5 | Botão "Aplicar Filtros" | `//*[@id="pomodoro-modal-root"]/div/div[1]/form/div[2]/button[2]` |
| 6 | Botão "Ver detalhes" | `/html/body/div[1]/div/div/div[2]/main/div/div[3]/table/tbody/tr/td[5]/button` |

Ambas as vias reaproveitam a sessão persistida já existente
(`/var/lib/hub_secrets/robo-entrego/entrego-session.json`) e a taxonomia de
erro já existente (`ErroAntibotSuspeito` → `ehFalhaDefinitiva`,
`taxonomia-erro.js:78`) — nenhuma credencial nova, nenhum mecanismo de
retry novo.

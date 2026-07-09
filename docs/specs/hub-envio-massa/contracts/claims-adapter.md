# Contracts: Adaptador de Claims + Gate de Permissão (middlewares internos)

Este arquivo documenta contratos **internos** (middleware Express, não expostos
como API pública) — mas seguem o mesmo rigor de contrato de interface porque são
a fronteira exata entre "sessão do hub" e "código legado" (research.md
Decisions 2/3/5/6). Localização planejada:
`app_homologacao/backend/middleware/hub-envio-massa-claims.js` (adaptador) e
`app_homologacao/backend/middleware/hub-envio-massa-permission.js` (gate).

## Middleware: `hubEnvioMassaClaimsBridge`

**Posição na cadeia**: `authenticateToken` (legado, inalterado) → **este
middleware** → `hubEnvioMassaRequirePermission(codigo)` → handler da rota.

**Entrada**: `req.user` (já populado pelo `jwt.verify` de `authenticateToken`).

**Ordem de checagem — `sub` SEMPRE primeiro** (gate `owasp-security`, achado
F1, research.md Decision 2): o discriminador de ramo testa
`req.user.sub` ANTES de `req.user.empresaId`, para que uma eventual drift
futura no payload do token hub (que hoje nunca inclui `empresaId`) falhe para
o lado mais restrito (sujeito a RBAC) em vez do lado de bypass total.

### Ramo 1 — sessão hub (`req.user.sub` presente)

| Sub-caso | Resposta |
|----------|----------|
| `req.user.entidade_ativa` ausente/null | **403** `{"error":{"code":"SEM_ENTIDADE_ATIVA","message":"Selecione uma entidade para continuar."}}` — não chama `next()` |
| `entidade_ativa` presente, consulta a `Empresa`/`Grupo` OK | reescreve `req.user = {empresaId: entidade_ativa, id_grupo, is_grupo_pai}`; define `req.hubContext = {viaHub: true, usuarioId: sub}`; `next()` |
| `entidade_ativa` presente, consulta a `Empresa`/`Grupo` falha (infra) | **502** `{"error":{"code":"ADAPTADOR_INDISPONIVEL","message":"Serviço indisponível, tente novamente."}}` — não chama `next()` |

### Ramo 2 — sessão legada (`req.user.sub` ausente, `req.user.empresaId` presente)

| Efeito |
|--------|
| `next()` imediato, nenhuma leitura adicional, nenhuma mutação de `req` |

### Ramo 3 — nem legado nem hub (payload sem `empresaId` e sem `sub`)

| Resposta |
|----------|
| **401** `{"error":{"code":"TOKEN_INVALIDO"}}` |

## Middleware: `hubEnvioMassaRequirePermission(codigo)`

**Posição**: depois do adaptador acima, antes do handler.

**Entrada**: `req.user.empresaId` (já resolvido), `req.hubContext` (pode ser
`undefined` — sessão legada).

| Condição | Efeito |
|----------|--------|
| `req.hubContext` indefinido (sessão legada) | `next()` incondicional (research.md Decision 5) |
| `req.hubContext.viaHub === true` e `process.env.HUB_RBAC_ENVIO === 'off'` | `next()` incondicional (FR-006) |
| `req.hubContext.viaHub === true`, flag ligada, `obterPermissoesEfetivasPorEntidade(usuarioId, empresaId)` contém `codigo` | `next()` |
| `req.hubContext.viaHub === true`, flag ligada, permissão ausente | **403** `{"error":{"code":"PERMISSAO_INSUFICIENTE","message":"Você não tem permissão para executar esta ação."}}` |
| qualquer exceção na resolução de permissões | **403** `{"error":{"code":"PERMISSAO_INSUFICIENTE"}}` (fail-closed — mesmo padrão de `middleware/hub-require-permission.js`, nunca `next()` num catch) |

## Erros — vocabulário fechado introduzido por esta feature

| Código | HTTP | Quando |
|--------|------|--------|
| `SEM_ENTIDADE_ATIVA` | 403 | FR-004 — sessão hub sem entidade selecionada |
| `ADAPTADOR_INDISPONIVEL` | 502 | falha de infraestrutura ao resolver `id_grupo`/`is_grupo_pai` |
| `TOKEN_INVALIDO` | 401 | payload de token não reconhecido (defesa em profundidade) |
| `PERMISSAO_INSUFICIENTE` | 403 | FR-007 — RBAC negou (distinto de `SEM_ENTIDADE_ATIVA`, nunca confundir os dois) |

O frontend do módulo (`app/hub/dashboard/envio_massa/`) trata especificamente
`SEM_ENTIDADE_ATIVA` como um redirecionamento para `/selecionar-entidade`
(FR-004/Decision 7) — todos os demais códigos seguem o tratamento de erro
genérico já existente nos hooks reaproveitados
(`hooks/use-envio-massa.ts`/`use-process-status.ts`).

## Contrato de log de importação (FR-009/010/011) — `registrarImportacaoEnvioMassa`

**Não é uma rota HTTP** — é uma chamada interna feita de dentro do handler
`POST /upload`, depois do parse. Nunca bloqueia nem altera a resposta HTTP do
upload em si.

### Chamada

| Param | Tipo | Origem |
|-------|------|--------|
| `empresaId` | int | `req.user.empresaId` (pós-adaptador) |
| `usuarioId` | int | `req.hubContext.usuarioId` |
| `nomeArquivo` | string | `req.file.originalname` |
| `arquivo` | Buffer/stream | `req.file.path` (disco, `multer({dest:'uploads/'})`) |
| `totalLinhas`/`linhasValidas`/`linhasInvalidas` | int | contadores já produzidos pelo parser legado |
| `status` | enum | `'completed'` \| `'completed_with_errors'` \| `'failed'` — derivado de `linhasInvalidas` |

### Efeito

- `req.hubContext` ausente (sessão legada) → função **não é chamada** (guard no
  call site, não dentro do helper).
- `HUB_IMPORT_LOG_ENVIO === 'off'` → função retorna sem gravar.
- Falha de INSERT (qualquer motivo) → `catch` local, `console.error`, retorna —
  **nunca lança**, nunca afeta a resposta HTTP de `/upload` (FR-011).

### Erro Responses

N/A — esta função nunca produz uma resposta HTTP; é fire-and-forget do ponto de
vista do handler que a chama.

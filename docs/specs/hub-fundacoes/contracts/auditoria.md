# Contracts: Auditoria (`/api/v1/auditoria`)

FR-023 exige que todo evento de login fique "disponível para consulta posterior" — esta
fundação entrega a capacidade de consulta via API (sem tela; consumo por módulo futuro
S9 "Auditoria + Administração").

## GET /api/v1/auditoria

**Auth**: `requirePermission('auditoria.consultar')`. Escopado pela entidade ativa da
sessão (mesmo invariante do Princípio II — nunca por id vindo do corpo/query do
cliente); adicionalmente protegido por RLS (FR-026) como reforço independente.

### Request (query params)

| Field | Type | Required | Validation |
|-------|------|----------|------------|
| desde | ISO 8601 | no | filtro `criado_em >= desde` |
| ate | ISO 8601 | no | filtro `criado_em <= ate` |
| acao | string | no | filtro exato por `acao` |
| limit | int | no | default 50, max 200 |

### Response (200)

| Field | Type | Description |
|-------|------|--------------|
| eventos | array | `{ id, id_empresa, usuario_id, acao, recurso, recurso_id, detalhes, ip, criado_em }` — `detalhes` NUNCA contém dados sensíveis (FR-025) |

### Error Responses

| Status | Code | Description |
|--------|------|--------------|
| 401 | NAO_AUTENTICADO | sem `accessToken` válido |
| 403 | PERMISSAO_NEGADA | falta `auditoria.consultar` |

**Nota de escopo**: não existe `POST`/`PUT`/`PATCH`/`DELETE` para este recurso em nenhum
router do hub — a imutabilidade (FR-024) é garantida por ausência total de capacidade de
escrita/edição na API, reforçada por `REVOKE`+trigger no banco (data-model.md, Decision 6
de research.md).

# Contracts: Endpoints Legados do Envio em Massa (reaproveitados, sem alteração de request/response)

Os 11 endpoints abaixo já existem em `app_homologacao/backend/server.js` e **não
têm request/response alterados por esta feature** (FR-001, FR-012, FR-015) —
documentar de novo o schema de cada um duplicaria o código-fonte sem valor. Este
contrato documenta apenas a **camada nova**: quais middlewares passam a estar na
frente de cada rota, e o comportamento de autenticação/autorização observável
por fora (o que muda para quem chama).

**Auth**: cookie `accessToken` — aceita tanto o formato legado
(`{empresaId,...}`) quanto o formato hub (`{sub, email, entidade_ativa}`), via
`hubEnvioMassaClaimsBridge` (`contracts/claims-adapter.md`).

**Permissão**: `hubEnvioMassaRequirePermission(<codigo>)`, aplicada **apenas**
quando a sessão é do hub (`req.hubContext.viaHub === true`) — sessões legadas
passam sempre (research.md Decision 5).

| Rota | Middlewares na frente (ordem) | Permissão exigida (só sessão hub) | Request/Response |
|------|-------------------------------|-------------------------------------|-------------------|
| `GET /envio-massa` | `authenticateToken` → claims-bridge → permission | `envio_massa.consultar` | inalterado |
| `PATCH /update-envio-massa/:id` | idem | `envio_massa.criar` | inalterado |
| `DELETE /envio-massa/:id` | idem | `envio_massa.aprovar` | inalterado |
| `POST /start-process` | idem | `envio_massa.enviar` | inalterado |
| `GET /process-status` | idem | `envio_massa.consultar` | inalterado |
| `POST /stop-process` | idem | `envio_massa.enviar` | inalterado |
| `POST /upload` | idem (+ log de importação pós-parse, FR-009) | `envio_massa.criar` | inalterado |
| `GET /export-envio-massa` | idem | `envio_massa.consultar` | inalterado |
| `GET /download-xml-movimento` | idem | `envio_massa.consultar` | inalterado |
| `POST /validate-xml-batch` | idem | `envio_massa.enviar` | inalterado |
| `POST /close-movimento` | idem | `envio_massa.aprovar` | inalterado |

## Request

Nenhum campo novo em nenhum endpoint. Nenhum campo removido.

## Response (200/201/demais códigos de sucesso já existentes)

Nenhum campo novo, nenhum campo removido, nenhuma mudança de shape.

## Error Responses — camada nova (adicional às já existentes de cada rota)

| Status | Code | Quando | Só ocorre para |
|--------|------|--------|------------------|
| 403 | `SEM_ENTIDADE_ATIVA` | sessão hub sem `entidade_ativa` (FR-004) | sessões hub |
| 403 | `PERMISSAO_INSUFICIENTE` | RBAC negou (FR-007) | sessões hub, com `HUB_RBAC_ENVIO≠off` |
| 502 | `ADAPTADOR_INDISPONIVEL` | falha ao resolver grupo da entidade | sessões hub |
| 401 | `TOKEN_INVALIDO` | payload não reconhecido | qualquer |

Todos os demais códigos de erro (400/401/403/404/409/422/429/5xx) já
produzidos por cada endpoint hoje — incluindo a distinção negócio-vs-infra de
`POST /validate-xml-batch` (FR-013) — permanecem **exatamente como estão**,
verificados pelo relatório de diff (FR-015, evidência da feature).

## Matriz papel × ação

Ver [`matriz-papel-acao.md`](matriz-papel-acao.md) — matriz explícita
cruzando os 4 papéis-seed contra as 5 permissões do módulo (`consultar`/
`criar`/`enviar`/`aprovar`/`gerenciar`), derivada mecanicamente da tabela
acima + `PapelPermissao` seedada (fecha CHK006). Fonte única da verdade dos
asserts de RBAC do teste de cobertura de FASE 2.2.

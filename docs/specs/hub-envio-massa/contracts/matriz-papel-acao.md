# Matriz explícita papel × ação — módulo Envio em Massa

Fecha CHK006 (checklists/requirements.md). Derivada **mecanicamente** de duas
fontes de verdade já existentes — não é uma reconstrução manual da prosa da
US3 (spec.md §User Story 3, Acceptance Scenarios, linhas 133-146):

1. `legacy-endpoints.md` (tabela rota → permissão exigida, coluna "Permissão
   exigida (só sessão hub)").
2. `infra/hub/migrations/0007_seed_papeis_permissoes_modulos.sql` +
   `0032_seed_permissao_envio_massa_gerenciar.sql` (tabela `PapelPermissao`
   efetiva no `hub-homolog`, confirmada por consulta SQL em 2026-07-09 —
   ver "Evidência" no rodapé).

Aplicável **somente a sessões hub** (`req.hubContext.viaHub === true`) com
`HUB_RBAC_ENVIO` ligado (default). Sessão legada e `HUB_RBAC_ENVIO=off`
sempre passam, independente do papel (research.md Decision 5/6) — fora desta
matriz, ver `legacy-endpoints.md`.

## Ações operacionais (4 permissões que gateiam algum dos 11 endpoints)

| Papel | `consultar` | `criar` | `enviar` | `aprovar` | `gerenciar` |
|-------|:---:|:---:|:---:|:---:|:---:|
| `admin_plataforma` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `admin_entidade`   | ✅ | ✅ | ✅ | ✅ | ✅ |
| `operador`         | ✅ | ✅ | ✅ | ❌ | ❌ |
| `leitura`          | ✅ | ❌ | ❌ | ❌ | ❌ |

`gerenciar` (`envio_massa.gerenciar`) não gateia nenhum dos 11 endpoints
desta feature (research.md Decision 4 — "novo caso de uso que o fluxo atual
não tem hoje", fora de escopo do S8); presente na matriz só para refletir
FR-005/FR-008 corretamente no catálogo. Coluna incluída por completude, não
por uso corrente.

## Ação → endpoint (join com `legacy-endpoints.md`)

| Ação | Endpoints gateados |
|------|---------------------|
| `consultar` | `GET /envio-massa`, `GET /process-status`, `GET /export-envio-massa`, `GET /download-xml-movimento` |
| `criar` | `PATCH /update-envio-massa/:id`, `POST /upload` |
| `enviar` | `POST /start-process`, `POST /stop-process`, `POST /validate-xml-batch` |
| `aprovar` | `DELETE /envio-massa/:id`, `POST /close-movimento` |
| `gerenciar` | (nenhum endpoint desta feature) |

## Papel × endpoint (matriz completa, permitido/recusado)

| Endpoint | `admin_plataforma` | `admin_entidade` | `operador` | `leitura` |
|----------|:---:|:---:|:---:|:---:|
| `GET /envio-massa` | ✅ | ✅ | ✅ | ✅ |
| `PATCH /update-envio-massa/:id` | ✅ | ✅ | ✅ | ❌ |
| `DELETE /envio-massa/:id` | ✅ | ✅ | ❌ | ❌ |
| `POST /start-process` | ✅ | ✅ | ✅ | ❌ |
| `GET /process-status` | ✅ | ✅ | ✅ | ✅ |
| `POST /stop-process` | ✅ | ✅ | ✅ | ❌ |
| `POST /upload` | ✅ | ✅ | ✅ | ❌ |
| `GET /export-envio-massa` | ✅ | ✅ | ✅ | ✅ |
| `GET /download-xml-movimento` | ✅ | ✅ | ✅ | ✅ |
| `POST /validate-xml-batch` | ✅ | ✅ | ✅ | ❌ |
| `POST /close-movimento` | ✅ | ✅ | ❌ | ❌ |

## Conferência célula a célula contra os Acceptance Scenarios da US3 (spec.md linhas 133-146)

| Cenário | Papel | Ações testadas | Resultado esperado | Bate com a matriz? |
|---------|-------|------------------|----------------------|----------------------|
| 1 | `admin_entidade` | visualizar, criar, enviar, aprovar, gerenciar | todas permitidas | ✅ (linha `admin_entidade` = tudo ✅) |
| 2 | `operador` | visualizar/criar/enviar → permitido; aprovar/gerenciar → recusado com `PERMISSAO_INSUFICIENTE` | conforme | ✅ (linha `operador`: consultar/criar/enviar ✅, aprovar/gerenciar ❌) |
| 3 | `leitura` | visualizar → permitido; criar/enviar/aprovar/gerenciar → recusado | conforme | ✅ (linha `leitura`: só consultar ✅) |
| 4 | qualquer | `HUB_RBAC_ENVIO=off` → comportamento idêntico ao legado (sem gate) | fora desta matriz — ver `legacy-endpoints.md`/Decision 5-6 | ✅ (matriz só se aplica com a flag ligada, documentado na intro) |

Fonte única da verdade referenciada pelo teste de cobertura de RBAC da tarefa
2.2 (`tests/hub-envio-massa-permission-unit.test.js`) — os casos positivo/
negativo daquele teste usam exatamente as células acima, evitando drift entre
teste e documentação.

## Evidência

Consulta SQL em `hub_homolog_db` (2026-07-09, pós-migration `0032`):

```
papel             | codigo
------------------+-----------------------
admin_entidade    | envio_massa.gerenciar
admin_plataforma  | envio_massa.gerenciar
(2 rows)
```

Confirma que só `admin_plataforma`/`admin_entidade` têm `gerenciar`; as
demais 4 permissões (`consultar`/`criar`/`enviar`/`aprovar`) já vinham
seedadas por `0007` conforme reproduzido acima nas listas `operador`/
`leitura` do próprio arquivo de migration.

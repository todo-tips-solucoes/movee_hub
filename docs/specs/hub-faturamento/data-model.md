# Data Model — hub-faturamento (S6)

Nenhuma tabela nova. Esta fase é 100% leitura sobre `FaturamentoLancamento`
(fato já existente desde a migration `0013`, S4). As únicas mudanças de
schema são RBAC (permissão nova) e 2 funções SQL de agregação — ambas
tratadas como "entidades" abaixo por completude do artefato, embora não
sejam tabelas.

## Entity: FaturamentoLancamento (EXISTENTE — sem alteração de schema)

Fato append-only, granularidade = 1 linha do CSV de faturamento importado
pela S4. Consultada apenas por `SELECT` nesta fase (nenhum `INSERT`/`UPDATE`/
`DELETE` — FR-011).

| Campo | Tipo | Nota (uso nesta fase) |
|---|---|---|
| `id` | serial PK | — |
| `id_empresa` | int NOT NULL | escopo de todo filtro (FR-009); RLS já aplica |
| `importacao_id` | int NOT NULL FK | não exposto diretamente na API desta fase |
| `entregador_id` | int NULL FK `Entregador` | `NULL` = lançamento agregado/bônus (FR-005); usado no filtro `entregadorId` e no `group_by=entregador` |
| `recebedor_agregado` | text NULL | NÃO usado como chave de agrupamento (Decision 4) — só repassado como metadado informativo, se necessário, na linha detalhada |
| `data_lancamento` | date NOT NULL | não é filtro desta fase |
| `data_referencia` | date NOT NULL | **campo do filtro de datas padrão** (FR-002); default = últimos 30 dias |
| `data_repasse` | date NULL | não é filtro desta fase (edge case explícito da spec) |
| `periodo` | text NULL | exibido na linha detalhada, sem filtro dedicado nesta fase |
| `praca` | text NULL | exibido, sem filtro dedicado |
| `subpraca` | text NULL | filtro `subpraca` (FR-002), já indexado (`idx_faturamento_empresa_subpraca`, S5) |
| `origem` | text NULL | exibido, sem filtro |
| `tipo` | text NOT NULL | sempre `Credito` nos dados observados (§7.2 plano técnico); exibido sem filtro dedicado nesta fase |
| `valor` | numeric(12,2) NOT NULL | soma exclusivamente em SQL (Decision 2/7); trafega como `text` na API |
| `descricao` | text NOT NULL | **categoria** (FR-002/003/004); filtro `categoria`, agrupamento `group_by=categoria`, chave do desempate (Decision 3) |
| `atingido`, `pct_*`, `criterio_*` | numeric(8,2) NULL | fora de escopo desta fase (consumidos pela S7/Performance) |
| `margem_fee_*` | text/numeric NULL | fora de escopo desta fase |
| `hash_linha` | char(64) NOT NULL | não exposto na API |

Índices reutilizados (nenhum novo — spec FR-002 é explícita: "nenhuma
estrutura nova de índice é introduzida por esta fase"):
- `idx_faturamentolancamento_empresa_data (id_empresa, data_referencia)` — filtro de período.
- `idx_faturamentolancamento_empresa_entregador_data (id_empresa, entregador_id, data_referencia)` — filtro por entregador + período.
- `idx_faturamentolancamento_empresa_descricao (id_empresa, descricao)` — filtro por categoria.
- `idx_faturamento_empresa_subpraca (id_empresa, subpraca, entregador_id)` — filtro por área de atuação.

## Entity: Resumo Agregado do Período (computado, não persistido)

Não é uma tabela — é o shape de retorno das 2 funções RPC (`hub_faturamento_totais`,
`hub_faturamento_agrupado`), recalculado a cada chamada a partir dos
lançamentos correntes.

**Cards (FR-003)** — retorno de `hub_faturamento_totais`:

| Campo (API, camelCase) | Tipo | Origem |
|---|---|---|
| `totalGeral` | string (decimal) | `SUM(valor)::text` sobre o filtro aplicado |
| `categoriaMaiorValor` | string \| null | `descricao` da categoria vencedora (Decision 3); `null` quando não há nenhum lançamento no filtro (FR-012) |
| `entregadoresDistintos` | number (int) | `COUNT(DISTINCT entregador_id)` — ignora `NULL` nativamente |

**Agrupado (FR-004)** — retorno de `hub_faturamento_agrupado`, um array de:

| Campo (API, camelCase) | Tipo | Origem |
|---|---|---|
| `chave` | string | `data_referencia::text` (group_by=dia) \| `descricao` (group_by=categoria) \| `entregador_id::text` ou `'agregados_bonus'` (group_by=entregador, Decision 4) |
| `total` | string (decimal) | `SUM(valor)::text` do grupo |
| `quantidade` | number (int) | `COUNT(*)` do grupo |

## Entity: Permissao (EXISTENTE — 1 linha nova via migration `0026`)

`faturamento.listar` — mesmo shape de `Permissao` já usado por todo o hub
(`codigo text UNIQUE`, `modulo_id FK`). Sem alteração de schema, só de dado
(seed).

## Mapa permissão lógica → código real (consumido pelo `requirePermission`)

| Endpoint | Permissão de rota (`requirePermission`) | Checagem adicional inline |
|---|---|---|
| `GET /faturamento` (JSON, lista) | `faturamento.listar` | — |
| `GET /faturamento?format=csv` (export) | `faturamento.listar` | **+ `faturamento.exportar`** checado explicitamente antes de qualquer query (Decision 9) |
| `GET /faturamento/resumo` (cards, sem `group_by`) | `faturamento.consultar` | — |
| `GET /faturamento/resumo?group_by=...` (agrupado) | `faturamento.consultar` | — |

## Migrations desta fase (resumo)

| Nº | Arquivo | Conteúdo |
|----|---------|----------|
| 0026 | `seed_permissao_faturamento_listar.sql` | `INSERT INTO "Permissao"` (`faturamento.listar`) + concessão a `admin_plataforma`/`admin_entidade`/`operador`/`leitura` (research.md Decision 1) |
| 0027 | `hub_faturamento_rpc_resumo.sql` | funções `hub_faturamento_totais`/`hub_faturamento_agrupado` (`SECURITY INVOKER`, filtradas pela mesma RLS de `FaturamentoLancamento`) + `GRANT EXECUTE` ao role `authenticated` (research.md Decision 2) |

## State transitions

N/A — não há máquina de estados nesta fase (fato append-only, sem mutação;
"Resumo Agregado" é sempre recalculado, não tem ciclo de vida próprio).

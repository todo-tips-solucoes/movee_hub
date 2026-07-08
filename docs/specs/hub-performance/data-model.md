# Data Model — hub-performance (S7)

## Entity: PerformanceTurno (EXISTENTE — sem alteração de schema)

Fato append-only já criado pela migration `0014` (S4/hub-importacoes) e
indexado por `0020` (S5/hub-motoristas). Esta fase **não** altera o
schema — apenas consulta.

| Coluna | Tipo | Nulo | Semântica nesta fase |
|---|---|---|---|
| `id` | serial PK | não | — |
| `id_empresa` | int | não | escopo (RLS, Constitution II) |
| `importacao_id` | int FK | não | proveniência (não exposto na API) |
| `entregador_id` | int FK `Entregador` | **não** | sempre presente — sem bucket "sem entregador" (Decision 4) |
| `data_periodo` | date | não | campo padrão do filtro de data (FR-002) |
| `periodo` | text | não | turno do dia (16 valores documentados + qualquer texto livre — Edge Case) |
| `duracao` | interval | sim | peso da média ponderada de FR-003 (Decision 2) — `NULL` dispara fallback |
| `min_entregadores_escala` | int | sim | atributo do turno, não exposto por esta fase (fora do escopo) |
| `tag` | text | sim | não exposto por esta fase |
| `praca` | text | sim | não exposto/filtrado por esta fase (só `subpraca`) |
| `subpraca` | text | sim | filtro FR-002, índice já existente (`0020`) |
| `origem` | text | sim | não exposto por esta fase |
| `tempo_disponivel_pct` | numeric(6,2) | sim | insumo de FR-003; ausente → excluído do cálculo (Edge Case) |
| `tempo_disponivel` | interval | sim | não exposto por esta fase (o percentual já resume a informação) |
| `corridas_ofertadas` | int | não (default 0) | denominador da taxa de aceitação |
| `corridas_aceitas` | int | não (default 0) | numerador da taxa de aceitação; denominador da taxa de conclusão |
| `corridas_rejeitadas` | int | não (default 0) | exposto na lista (FR-001), não usado em taxa própria |
| `corridas_completadas` | int | não (default 0) | numerador da taxa de conclusão; métrica "corridas completadas" de FR-003 |
| `corridas_canceladas` | int | não (default 0) | exposto na lista |
| `pedidos_concluidos` | int | sim | exposto na lista (pode exceder corridas — multi-pedido) |
| `taxas_centavos` | int | sim | FR-005 — convertido para R$ na consulta; ausente → zero na soma |
| `hash_linha` | char(64) | não | não exposto (dedupe interno) |
| `criado_em` | timestamptz | não | não exposto por esta fase |

Nenhuma coluna nova. `UNIQUE (id_empresa, hash_linha)` já garante dedupe —
duplicatas legítimas de `(entregador_id, data_periodo, periodo, subpraca)`
existem por design (linhas distintas com hash distinto) e MUST somar, nunca
assumir unicidade (FR-004).

## Entity: Resumo Agregado do Período (computado, não persistido)

Shape de `GET /performance/resumo` sem `groupBy` (cards, FR-003):

| Campo | Tipo (JSON) | Regra |
|---|---|---|
| `corridasCompletadas` | `number` (int) | `SUM(corridas_completadas)` do filtro |
| `taxaAceitacao` | `string` (fração `"0.xxxx"`) ou `null` | `Σaceitas/Σofertadas`; `null` se `Σofertadas = 0` |
| `taxaConclusao` | `string` (fração `"0.xxxx"`) ou `null` | `Σcompletadas/Σaceitas`; `null` se `Σaceitas = 0` |
| `tempoDisponivelMedio` | `string` (`"0.00"`..`"150.00"`) ou `null` | Decision 2/3 — ponderado por `duracao`, fallback média simples; `null` se nenhum registro com `tempo_disponivel_pct` |
| `taxasReais` | `string` (`"0.00"`) | `Σtaxas_centavos/100`, `NULL`→0 antes de somar (FR-005) |

Shape com `groupBy` (agrupado, FR-004) — mesmos 5 campos + `chave`/`rotulo`/
`quantidade` por grupo, calculados via `FILTER` clause (Decision 3):

| Campo | Tipo | Regra |
|---|---|---|
| `chave` | `string` | `data_periodo::text` (dia) \| `periodo` (periodo, texto livre) \| `entregador_id::text` (entregador) |
| `rotulo` | `string` | idêntico a `chave` para `dia`/`periodo`; nome resolvido via `Entregador.nome` para `entregador` (nunca `agregados_bonus` — Decision 4) |
| `quantidade` | `number` (int) | `COUNT(*)` do grupo |
| ...+ os 5 campos acima, por grupo | | |

Nunca persistido — sempre recalculado a partir de `"PerformanceTurno"`
no momento da consulta (mesma semântica do Key Entity da spec.md).

## Entity: Permissao (EXISTENTE — 1 linha nova via migration `0029`)

`performance.listar` — código novo, `modulo_id` = `performance` (já
existe desde `0007`). Concedida a `admin_plataforma`, `admin_entidade`,
`operador`, `leitura` (Decision 1). Convive com `performance.consultar`
(resumos/agregados) e `performance.exportar` (export CSV), ambas já
seedadas desde `0007`.

## Mapa permissão lógica → código real (consumido pelo `requirePermission`)

| Endpoint | Permissão de rota (`requirePermission`) | Checagem adicional inline |
|---|---|---|
| `GET /performance` (JSON, lista) | `performance.listar` | — |
| `GET /performance?format=csv` (export) | `performance.listar` | **+ `performance.exportar`** checado explicitamente antes de qualquer query (Decision 9) |
| `GET /performance/resumo` (cards, sem `groupBy`) | `performance.consultar` | — |
| `GET /performance/resumo?groupBy=...` (agrupado) | `performance.consultar` | — |

## Migrations desta fase (resumo)

| Migration | Conteúdo | Idempotência |
|---|---|---|
| `0029_seed_permissao_performance_listar.sql` | `INSERT "Permissao"` (`performance.listar`) + `INSERT "PapelPermissao"` para os 4 papéis-seed | `ON CONFLICT DO NOTHING` em ambos |
| `0030_hub_performance_rpc_resumo.sql` | `CREATE OR REPLACE FUNCTION hub_performance_totais(...)` + `hub_performance_agrupado(...)` + `GRANT EXECUTE` | `CREATE OR REPLACE` — re-rodar é no-op |

## State transitions

Nenhuma — `"PerformanceTurno"` é append-only (FR-010, sem
criação/edição/remoção nesta fase); `Permissao`/`PapelPermissao` são
seeds estáticos sem transição de estado.

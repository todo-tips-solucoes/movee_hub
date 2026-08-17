# Contrato — `/api/v1/performance*` (hub-performance / S7)

Padrões herdados de `docs/plans/hub-frota/01-plano-tecnico.md §14` e do
contrato-irmão `docs/specs/hub-faturamento/contracts/faturamento-api.md`:
prefixo `/api/v1`; auth por cookie JWT (`accessToken`); entidade ativa
resolvida do token (nunca de query/body); erros JSON no formato curto
`{ "erro": "..." }` (mesmo já em uso por `hub-require-permission.js`/
`hub-importacoes.js`/`hub-faturamento.js`). Todos os campos de resposta em
**camelCase**.

## GET /performance — lista paginada de registros de turno

**Permissão**: `performance.listar`.

**Query params**:

| Param | Tipo | Default | Nota |
|---|---|---|---|
| `de` | `YYYY-MM-DD` | hoje − 30 dias | filtra por `data_periodo` (FR-002) |
| `ate` | `YYYY-MM-DD` | hoje | filtra por `data_periodo` |
| `periodo` | `string` | — | igualdade exata com a coluna `periodo` (texto livre) |
| `subpraca` | `string` | — | igualdade exata; usa índice `idx_performance_empresa_subpraca` (`0020`) |
| `entregadorId` | `int` | — | igualdade exata com `entregador_id` |
| `page` | `int` | `1` | 1-indexed |
| `pageSize` | `int` | `20` | máx. `100` |
| `format` | `csv` | — (JSON) | ver seção Export CSV abaixo |

**Resposta 200 (JSON, sem `format`)**:
```json
{
  "items": [
    {
      "id": 12345,
      "dataPeriodo": "2026-06-15",
      "periodo": "ALMOCO 11H30-15H29",
      "entregadorId": 42,
      "entregadorNome": "F*** S***",
      "subpraca": "PINHEIROS",
      "praca": "SAO PAULO",
      "corridasOfertadas": 18,
      "corridasAceitas": 15,
      "corridasRejeitadas": 3,
      "corridasCompletadas": 14,
      "corridasCanceladas": 1,
      "pedidosConcluidos": 20,
      "tempoDisponivelPct": 92.5,
      "taxas": "12.34"
    }
  ],
  "total": 431,
  "page": 1,
  "pageSize": 20
}
```
- `entregadorId`/`entregadorNome` sempre presentes (nunca `null`) —
  `"PerformanceTurno".entregador_id` é `NOT NULL` desde a origem (Decision
  4 de `research.md`); não existe o equivalente ao "Agregados/bônus" do
  faturamento.
- `taxas` é `string` (Decision 7) — `taxas_centavos` convertido para R$
  (`13254` → `"132.54"`); `NULL` na origem → `"0.00"`.
- `tempoDisponivelPct` é `number` (`null` se ausente) — % do PERÍODO em que
  a pessoa esteve online NAQUELA linha/praça, da coluna gerada
  `tempo_disponivel_periodo_pct` (migration 0050). Somável entre as praças do
  mesmo turno. Só o **agregado** (`/resumo`) usa `text` fixo.
- Ordenação: `order=data_periodo.desc,id.desc` (mais recente primeiro,
  desempate determinístico).

**Resposta 200 (`?format=csv`)**: `Content-Type: text/csv`, streaming
(Decision 5), cabeçalho:
```
dataPeriodo,periodo,entregadorNome,subpraca,praca,corridasOfertadas,corridasAceitas,corridasRejeitadas,corridasCompletadas,corridasCanceladas,pedidosConcluidos,tempoDisponivelPct,taxas,metaAceitacaoPct,metaConclusaoPct,metaTempoDisponivelPct,abaixoDaMeta
```
(as 4 últimas colunas entraram com as metas, PR #117 — o contrato tinha ficado
para trás; metas em percentual 0..100, vazio = não há meta para o cruzamento.)
Filtro sem correspondência → arquivo só com cabeçalho, `200` (nunca erro).
Toda célula cujo conteúdo comece com `= + - @` é neutralizada (FR-007,
`lib/hub-csv.js`, Decision 6).

**Erros**:
- `401 { "erro": "NAO_AUTENTICADO" }` — sem cookie válido.
- `400 { "erro": "ENTIDADE_NAO_SELECIONADA" }` — sem entidade ativa no token.
- `403 { "erro": "PERMISSAO_NEGADA" }` — sem `performance.listar` (rota) ou
  sem `performance.exportar` (quando `format=csv`, checagem inline —
  Decision 9).
- `400 { "erro": "DATA_INVALIDA" }` — `de`/`ate` fora do formato ISO ou
  `de > ate`.
- `400 { "erro": "ENTREGADOR_ID_INVALIDO" }` — `entregadorId` não numérico.

## GET /performance/resumo — agregados do período

**Permissão**: `performance.consultar`.

**Query params**: mesmos filtros de `GET /performance` (`de`, `ate`,
`periodo`, `subpraca`, `entregadorId`, exceto paginação) **+**:

| Param | Tipo | Default | Nota |
|---|---|---|---|
| `groupBy` | `dia` \| `periodo` \| `entregador` | — (ausente) | ausente → resposta "cards" (FR-003); presente → resposta agrupada (FR-004) |

**Resposta 200 — sem `groupBy` (cards, FR-003)**:
```json
{
  "corridasCompletadas": 1842,
  "taxaAceitacao": "0.8333",
  "taxaConclusao": "0.9333",
  "tempoDisponivelMedio": "87.42",
  "taxasReais": "9821.40"
}
```
Quando não há nenhum registro no filtro (FR-011): `{ "corridasCompletadas":
0, "taxaAceitacao": null, "taxaConclusao": null, "tempoDisponivelMedio":
null, "taxasReais": "0.00" }` — nunca erro, nunca corpo vazio.

Quando um denominador de razão é zero (`Σofertadas = 0` ou `Σaceitas = 0`,
SC-009): o campo correspondente é `null` — nunca `0`, nunca `1`, nunca uma
exceção.

**`tempoDisponivelMedio` (migration 0050, substitui a fórmula de dec-011)**:

```
tempoDisponivelMedio = 100 × Σ tempo_disponivel_absoluto / Σ duracao_do_periodo
```

com a duração contada **uma vez por turno** (entregador × dia × período) e o
tempo online **somado entre as praças** do mesmo turno — a origem repete a
`duracao_do_periodo` em cada linha de praça, e ponderar por ela contava o
mesmo turno duas ou três vezes. Teto de 100% por turno (a origem emite linhas
gêmeas que somariam mais que o próprio período). Turno sem
`tempo_disponivel` fica fora das duas somas: `null`, nunca `0`.

Era, até a 0050, a média de `tempo_disponivel_escalado` ponderada por
`duracao` — mas `escalado` mede sobre o tempo que a pessoa **se escalou**, não
sobre o período. Medido no CSV real: divergia em 11,5% das linhas (p95 36pp) e
mudava de lado numa meta de 60%/70% para 7-8% dos entregadores.

O mesmo vale para `tempoDisponivelPct` do item de lista (`GET /performance`) e
para a coluna homônima do CSV: passam a vir da coluna gerada
`tempo_disponivel_periodo_pct` (% do período **naquela linha/praça**, somável
entre as praças do turno). O nome do campo não mudou.

**Resposta 200 — com `groupBy` (FR-004)**:
```json
{
  "groupBy": "entregador",
  "grupos": [
    {
      "chave": "42",
      "rotulo": "F*** S***",
      "quantidade": 6,
      "corridasCompletadas": 84,
      "taxaAceitacao": "0.9000",
      "taxaConclusao": "0.9524",
      "tempoDisponivelMedio": "91.10",
      "taxasReais": "612.40"
    }
  ]
}
```
- `groupBy=dia`: `chave` no formato `YYYY-MM-DD`, `rotulo` idêntico.
- `groupBy=periodo`: `chave`/`rotulo` = texto literal de `periodo` (inclui
  valores fora dos 16 turnos documentados — Edge Case final da spec, o
  sistema nunca recusa/oculta).
- `groupBy=entregador`: `rotulo` resolvido via `Entregador.nome` (o
  backend nunca expõe a tabela inteira — só os ids presentes no
  resultado, mesmo padrão de `nomeMap` de `hub-faturamento-dto.js`).
- A soma de `corridasCompletadas` de todos os grupos retornados bate
  exatamente com `corridasCompletadas` do resumo sem `groupBy` do mesmo
  filtro (Acceptance Scenario 2 da User Story 2).

**Erros**: `401`/`400`/`403` (mesmo padrão); `400
{ "erro": "GROUP_BY_INVALIDO" }` — `groupBy` fora do enum.

**Frescor dos dados (follow-up SC-004, migration `0031`)**: os agregados
deste endpoint são servidos pela materialized view `mv_performance_dia`
(exceto quando o filtro `subpraca` é usado — dimensão fora da MV, cai na
tabela-base). O **contrato não muda** (mesmos shapes, taxas/valores como
`text`), mas o resumo pode estar **defasado até o fim do processamento da
importação em curso**: a MV é atualizada (`REFRESH ... CONCURRENTLY`)
automaticamente ao final de toda importação de performance bem-sucedida —
único caminho de escrita nos fatos — e manualmente via RPC
`hub_performance_refresh_mv`. Casos residuais (falha best-effort do refresh;
importação cancelada após inserir lotes) entram no resumo no próximo
refresh. `GET /performance` (lista) lê a tabela-base e é sempre fresco.

## Acesso negado (FR-008)

Uma pessoa sem `performance.listar` MUST não ver a lista (controle
ocultado no frontend) e recebe `403` ao chamar `GET /performance`
diretamente. Idêntico para `performance.consultar` (resumo) e
`performance.exportar` (export, checagem inline). As 3 permissões são
independentes — ter uma não implica as outras (SC-006).

## Mascaramento de dado pessoal (LGPD, mesmo padrão de `Entregador`/`Motorista`)

`entregadorNome` segue o mesmo mascaramento já aplicado em
`hub-motoristas`/`hub-faturamento` (nome completo do entregador é dado
pessoal — LGPD, briefing S7 herdado do plano técnico §7.6). Nenhuma
mudança de política nesta fase; reuso do mapeamento já existente de
`Entregador.nome`.

## Sem navegação para detalhe do entregador (Decision 11)

Ao contrário de `hub-faturamento`, esta fase não introduz link para
`/hub/dashboard/motoristas/:id` — fora do escopo da spec desta fase (ver
research.md Decision 11).

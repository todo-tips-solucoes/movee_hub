# Contrato — `/api/v1/performance*` (hub-performance / S7)

Padrões herdados de `docs/plans/hub-frota/01-plano-tecnico.md §14` e do
contrato-irmão `docs/specs/hub-faturamento/contracts/faturamento-api.md`:
prefixo `/api/v1`; auth por cookie JWT (`accessToken`); entidade ativa
resolvida do token (nunca de query/body); erros JSON no formato curto
`{ "erro": "..." }` (mesmo já em uso por `hub-require-permission.js`/
`hub-importacoes.js`/`hub-faturamento.js`). Todos os campos de resposta em
**camelCase**.

## GET /performance — lista paginada de TURNOS

**Permissão**: `performance.listar`.

> **A unidade mudou (migration 0051).** A linha do arquivo importado é a fatia
> de UMA praça dentro do turno, mas a meta é cadastrada por praça × TURNO
> (0048/0049). Listar por linha fazia a tela emitir dois vereditos para o mesmo
> turno de quem roda em duas praças — e o card, que sempre agregou por turno,
> mostrava um terceiro número. O grão padrão passou a ser o turno
> `(entregadorId, dataPeriodo, periodo)`; o grão da linha continua acessível em
> `?grao=linha`. Plano: `docs/plans/performance-linha-por-turno.md`.

**Query params**:

| Param | Tipo | Default | Nota |
|---|---|---|---|
| `de` | `YYYY-MM-DD` | hoje − 30 dias | filtra por `data_periodo` (FR-002) |
| `ate` | `YYYY-MM-DD` | hoje | filtra por `data_periodo` |
| `periodo` | `string` | — | igualdade exata com a coluna `periodo` (texto livre) |
| `subpraca` | `string` | — | **SELEÇÃO, não agregação** (0051/D1): entram os turnos que têm ao menos uma linha nessa sub-praça, medidos por inteiro |
| `entregadorId` | `int` | — | igualdade exata com `entregador_id` |
| `page` | `int` | `1` | 1-indexed |
| `pageSize` | `int` | `20` | máx. `100` |
| `grao` | `turno` \| `linha` | `turno` | `turno` = uma linha por `(entregador, dia, período)`; `linha` = o registro importado. Valor desconhecido → `400 GRAO_INVALIDO` |
| `format` | `csv` | — (JSON) | ver seção Export CSV abaixo |

**Resposta 200 (JSON, `grao=turno` — o padrão)**:
```json
{
  "items": [
    {
      "chave": "42|2026-06-15|ALMOCO 11H30-15H29",
      "dataPeriodo": "2026-06-15",
      "periodo": "ALMOCO 11H30-15H29",
      "entregadorId": 42,
      "entregadorNome": "F*** S***",
      "praca": "SAO PAULO",
      "corridasOfertadas": 18,
      "corridasAceitas": 15,
      "corridasRejeitadas": 3,
      "corridasCompletadas": 14,
      "corridasCanceladas": 1,
      "pedidosConcluidos": 20,
      "tempoDisponivelPct": 92.5,
      "taxas": "12.34",
      "pracas": [
        {
          "subpraca": "PINHEIROS",
          "praca": "SAO PAULO",
          "tempoDisponivelPct": 62.5,
          "corridasOfertadas": 12,
          "corridasAceitas": 10,
          "corridasCompletadas": 9,
          "taxas": "8.00"
        },
        {
          "subpraca": "BUTANTA",
          "praca": "SAO PAULO",
          "tempoDisponivelPct": 30.0,
          "corridasOfertadas": 6,
          "corridasAceitas": 5,
          "corridasCompletadas": 5,
          "taxas": "4.34"
        }
      ]
    }
  ],
  "total": 260,
  "page": 1,
  "pageSize": 20,
  "grao": "turno"
}
```
- **Não há `id`**: o turno é um agregado, não uma linha gravada. A identidade é
  `chave` = `entregadorId|dataPeriodo|periodo` — o mesmo grão da unique
  `uq_mv_performance_dia_grao`.
- `praca` é a praça **PREDOMINANTE** do turno (a de maior tempo online;
  desempate por ofertadas e depois pelo nome da sub-praça). É ela que resolve a
  meta, porque a meta é por praça × turno e o veredito é **um só**. Com uma
  praça só — a esmagadora maioria dos turnos — é a mesma praça de sempre.
- `pracas[]` traz as fatias do turno, ordenadas por tempo online desc. Os
  `tempoDisponivelPct` das fatias **somam** o do turno (teto de 100 por turno):
  é o que permite mostrar um número só sem esconder de onde ele veio.
- `total` é a contagem de TURNOS do filtro, vinda de `count(*) OVER ()` dentro
  da própria RPC. Consequência conhecida: uma página além do fim devolve zero
  itens e, com eles, `total: 0`.
- Ordenação: `dataPeriodo desc, periodo desc, entregadorId desc` — é a
  unique `uq_mv_performance_dia_grao` lida de trás para frente, então a
  página sai do índice sem ordenação nenhuma. É total (sem empate possível),
  o que a paginação exige: ordem parcial repete uma linha e omite outra.
  A D4 do plano propunha ordenar por `entregadorNome asc`; o nome vive noutra
  tabela e ordenar por ele obriga a juntar e ordenar o período INTEIRO antes
  do LIMIT — 1,6s medidos sobre 270k turnos, contra os 0,8ms desta. Fica
  registrado como decisão em aberto para o operador; achar uma pessoa já é
  trabalho do filtro de entregador.

Com `?grao=linha` a resposta volta ao formato anterior (uma linha por registro
importado, com `id`, `subpraca` e `praca` próprios, sem `pracas`), e `grao`
vem `"linha"` no corpo.
- `entregadorId`/`entregadorNome` sempre presentes (nunca `null`) —
  `"PerformanceTurno".entregador_id` é `NOT NULL` desde a origem (Decision
  4 de `research.md`); não existe o equivalente ao "Agregados/bônus" do
  faturamento.
- `taxas` é `string` (Decision 7) — `taxas_centavos` convertido para R$
  (`13254` → `"132.54"`); `NULL` na origem → `"0.00"`.
- `tempoDisponivelPct` é `number` (`null` se ausente) — % do PERÍODO em que a
  pessoa esteve online. No grão do turno, é o turno inteiro (praças somadas,
  teto 100); no grão da linha, é a coluna gerada
  `tempo_disponivel_periodo_pct` (migration 0050) daquela linha. `null` é
  ausência de leitura, **nunca** `0`.

**Resposta 200 (`?format=csv`)**: `Content-Type: text/csv`, streaming
(Decision 5), cabeçalho:
```
dataPeriodo,periodo,entregadorNome,subpracas,praca,corridasOfertadas,corridasAceitas,corridasRejeitadas,corridasCompletadas,corridasCanceladas,pedidosConcluidos,tempoDisponivelPct,taxas,metaAceitacaoPct,metaConclusaoPct,metaTempoDisponivelPct,abaixoDaMeta
```
(as 4 últimas colunas entraram com as metas, PR #117 — o contrato tinha ficado
para trás; metas em percentual 0..100, vazio = não há meta para o cruzamento.)

O CSV segue o `grao` do pedido, e o padrão é o TURNO (D2): o arquivo embasa a
cobrança e precisa dizer o mesmo que a tela. Por isso `subpraca` (uma) virou
`subpracas` — todas as do turno, separadas por `;`, porque a vírgula é o
separador do próprio arquivo — e `praca` é a predominante, a que resolve a
meta. Com `?grao=linha` o cabeçalho volta a trazer `subpraca`.
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
- `400 { "erro": "GRAO_INVALIDO" }` — `grao` fora de `turno`/`linha`. Não
  cai no padrão em silêncio: `?grao=praca` respondido como turno esconderia
  um erro de quem chama.

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

**Frescor dos dados (follow-up SC-004, migrations `0031`/`0051`)**: os
agregados deste endpoint são servidos pela materialized view
`mv_performance_dia` — desde a `0051`, **sempre**, inclusive com filtro de
sub-praça: a sub-praça deixou de ser dimensão de agregação e virou um
semi-join (`EXISTS`) sobre a tabela-base, então o caminho alternativo que
recalculava tudo fora da MV deixou de existir (e com ele a segunda cópia da
fórmula do tempo disponível). O **contrato não muda** (mesmos shapes,
taxas/valores como `text`), mas o resumo pode estar **defasado até o fim do
processamento da importação em curso**: a MV é atualizada
(`REFRESH ... CONCURRENTLY`) automaticamente ao final de toda importação de
performance bem-sucedida — único caminho de escrita nos fatos — e manualmente
via RPC `hub_performance_refresh_mv`. Casos residuais (falha best-effort do
refresh; importação cancelada após inserir lotes) entram no resumo no próximo
refresh.

⚠️ Desde a `0051` a LISTA também lê a MV (`grao=turno`, o padrão), então ela
passou a compartilhar essa defasagem — antes lia a tabela-base e era sempre
fresca. É o preço de a lista e os cards falarem do mesmo número; `?grao=linha`
continua lendo a tabela-base direto.

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

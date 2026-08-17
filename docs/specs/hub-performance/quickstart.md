# Quickstart — hub-performance (S7)

Cenários a executar no `hub-homolog` (exceção standing `hub-*`, G1) durante
`execute-task`/fechamento. Numeração e método espelham
`docs/specs/hub-faturamento/quickstart.md` (S6), adaptados às
particularidades desta fase (ponderação por duração, 3 permissões
introduzidas de uma vez, sem bucket "sem entregador").

## Cenário 1 — Resumo e filtros combinados batem com o banco (US1 / SC-001)

1. Autenticar como `qa.importacoes@moveelog.local` (papel `admin_entidade`,
   passa a ter `performance.consultar`/`performance.listar` após a
   migration `0029`).
2. Abrir `/hub/dashboard/performance` sem filtro.
3. **Expected**: cards mostram corridas completadas, taxa de aceitação,
   taxa de conclusão e tempo disponível médio dos últimos 30 dias
   (default, `data_periodo`); lista paginada abaixo.
4. Aplicar filtro `periodo=ALMOCO 11H30-15H29` + intervalo de datas
   específico.
5. **Expected**: cards E lista refletem só esse filtro; rodar
   `SELECT SUM(numero_de_corridas_completadas...)` (nomes reais de coluna:
   `corridas_completadas`, `corridas_aceitas`, `corridas_ofertadas`)
   direto no `hub_homolog_db` com o mesmo filtro e confirmar que bate
   exatamente com `corridasCompletadas`/`taxaAceitacao`.

## Cenário 2 — Taxa agregada nunca é média de percentuais (US1+US2 / SC-002)

1. Escolher um filtro com pelo menos 2 registros com taxas de
   aceitação individuais bem diferentes entre si (ex.: um turno com
   poucas corridas ofertadas e taxa 100%, outro com muitas corridas e
   taxa 60%).
2. Calcular manualmente: (a) média aritmética das taxas individuais; (b)
   razão entre as somas (Σaceitas/Σofertadas).
3. **Expected**: o valor exibido em `taxaAceitacao` bate com (b), nunca
   com (a) — confirma SC-002 (nenhuma taxa agregada é média de
   percentuais linha a linha).

## Cenário 3 — Tempo disponível médio: % do período, praças somadas (FR-003 / migration 0050)

> Substitui a fórmula de dec-011 (média de `tempo_disponivel_pct` ponderada
> por `duracao`). Motivo, medido no CSV real: `tempo_disponivel_pct` é o
> `escalado` da origem — mede sobre o tempo que a pessoa SE ESCALOU, não sobre
> o período — e a `duracao` vem repetida em cada linha de praça do mesmo turno,
> o que contava o turno duas ou três vezes no denominador.

1. Escolher um filtro com registros de pelo menos 2 turnos de duração
   diferente (ex.: `duracao` 2h29 e 3h59 — os 10 valores documentados no
   briefing).
2. Calcular manualmente: Σ`tempo_disponivel` / Σ`duracao`, com a `duracao`
   contada UMA VEZ por turno (entregador × dia × período) e o
   `tempo_disponivel` somado entre as praças daquele turno. Ignorar linhas sem
   `tempo_disponivel` ou sem `duracao`.
3. **Expected**: `tempoDisponivelMedio` bate exatamente com o cálculo manual —
   e NÃO com a média dos percentuais das mesmas linhas.
4. **Multi-praça** (o caso que a 0050 corrige): um entregador com 2 linhas no
   MESMO turno, mesma `duracao` repetida, online 1h e 30min num turno de 4h.
   **Expected**: 37,50% — não a média dos dois percentuais de linha.
5. **Linhas gêmeas da origem**: 2 linhas do mesmo turno de 2h com 2h de online
   cada (a origem emite isso; o dedupe por `hash_linha` não pega porque a
   sub-praça difere). **Expected**: 100,00% — teto por turno, nunca 200%.
6. **Ausência**: turno sem `tempo_disponivel`. **Expected**: `null`, nunca `0`.

## Cenário 4 — Agrupamentos por dia/período/entregador (US2 / FR-004)

1. Pedir o agregado `groupBy=entregador` para um filtro de período.
2. **Expected**: a soma de `corridasCompletadas` de todos os grupos
   retornados bate exatamente com `corridasCompletadas` do resumo sem
   `groupBy` do mesmo filtro (Acceptance Scenario 2, User Story 2).
3. Repetir com `groupBy=dia`: cada dia aparece com seus próprios totais,
   em ordem cronológica.
4. Repetir com `groupBy=periodo`: cada turno do dia aparece com seus
   próprios totais; incluir (se disponível na base de teste) um valor de
   `periodo` fora dos 16 turnos documentados e confirmar que aparece
   normalmente, sob o próprio texto (Edge Case final da spec).

## Cenário 5 — Data do turno é o único campo usado no filtro de data (US1)

1. Confirmar (leitura do contrato + teste) que o filtro `de`/`ate` usa
   exclusivamente `data_periodo` — nenhum outro campo de data de
   `"PerformanceTurno"` é usado como filtro padrão.

## Cenário 6 — Período sem dados (US1 cenário 5 / FR-011)

1. Filtrar um intervalo de datas sem nenhum registro (ex.: uma entidade
   recém-criada, sem importação).
2. **Expected**: tela mostra "período sem dados" (nunca erro/tela em
   branco); resposta JSON de `/resumo` retorna zeros/`null` (nunca 404 ou
   500); resposta de `/performance` retorna `items: []`, `total: 0`.

## Cenário 7 — Export CSV: conteúdo e contagem batem com a tela (US3 / SC-001)

1. Aplicar um filtro na lista; acionar exportação.
2. **Expected**: CSV resultante tem exatamente a mesma contagem de linhas
   que `total` da resposta paginada para aquele filtro; valores de
   `taxas`/`tempoDisponivelPct` batem com os exibidos na tela.

## Cenário 8 — CSV injection neutralizada (US3 / FR-007 / SC-005)

1. Localizar (ou inserir em ambiente de teste) um registro cujo
   `periodo`/`subpraca`/nome de entregador comece com `=`, `+`, `-` ou
   `@`.
2. Exportar o CSV contendo essa linha.
3. **Expected**: a célula aparece prefixada com `'` no arquivo — ao abrir
   em um programa de planilha comum, o conteúdo aparece como texto
   simples, nunca executado como fórmula.

## Cenário 9 — Export vazio gera só cabeçalho (edge case explícito)

1. Aplicar um filtro sem nenhum registro correspondente; acionar
   exportação.
2. **Expected**: arquivo gerado contém apenas a linha de cabeçalho,
   resposta `200` (nunca erro).

## Cenário 10 — Permissões independentes: listar/consultar/exportar (US1+US2+US3 / FR-008 / SC-006)

1. Criar/usar um usuário de teste com um papel que tenha só
   `performance.consultar` (sem `.listar` nem `.exportar`).
2. **Expected**: consegue ver os cards do resumo, mas a lista/tabela e o
   botão de export ficam ocultos na UI; chamada direta a `GET
   /performance` retorna `403`.
3. Repetir com um papel só com `performance.listar` (sem `.consultar` nem
   `.exportar`): vê a lista, cards ocultos/indisponíveis, export oculto;
   chamada direta a `GET /performance/resumo` retorna `403`.
4. Repetir com um papel com `performance.listar` + `.consultar` mas sem
   `.exportar`: vê lista e cards, botão de export oculto; chamada direta
   a `GET /performance?format=csv` retorna `403 PERMISSAO_NEGADA` mesmo
   tendo `.listar` (Decision 9 — checagem inline independente).

## Cenário 11 — Isolamento multi-tenant (Constitution II / FR-009 / SC-007)

1. Popular registros de teste em pelo menos 2 entidades diferentes.
2. Consultar lista/resumo/agregado/export autenticado em uma delas.
3. **Expected**: zero registros da outra entidade aparecem em qualquer
   resposta, mesmo sem filtro algum aplicado.

## Cenário 12 — Identidade visual preservada (SC-008)

1. Alternar tema claro/escuro e branding por tenant na tela
   `/hub/dashboard/performance`.
2. **Expected**: sem regressão perceptível em relação ao restante do
   painel (mesmo padrão de cards/tabela/filtros já usado em
   `.../faturamento`).

## Cenário 13 — Roundtrip End-to-End (contrato real, não mock)

1. Autenticar de verdade, abrir a tela, aplicar 2+ filtros combinados,
   conferir cards + lista + export com uma chamada HTTP real (não mock)
   contra o `hub-homolog`.
2. **Expected**: contrato de `contracts/performance-api.md` bate
   literalmente com a resposta observada.

## Cenário 14 — Divisão por zero nunca produz erro (SC-009)

1. Filtrar um período em que `Σcorridas_ofertadas = 0` (ex.: só registros
   com 0 corridas ofertadas) ou `Σcorridas_aceitas = 0`.
2. **Expected**: `taxaAceitacao`/`taxaConclusao` retornam `null`
   (indicador indisponível) — nunca erro HTTP, nunca `0` nem `1`
   calculados incorretamente.

## Cenário 15 — Performance de agregados sob volume ampliado (SC-004)

1. Gerar seed sintético equivalente a ~1 ano de operação de um tenant
   grande em `"PerformanceTurno"` (via `infra/hub/scripts/gen-seeds.py
   --perf ... --synthesize-days N` ou `generate_series` direto no
   `hub_homolog_db`, restrito a um `id_empresa` de teste — mesma técnica
   da medição original de `hub-faturamento`, research.md Decision 8).
2. Medir `GET /performance/resumo` (sem e com cada `groupBy`) end-to-end,
   1 aquecimento + 2 rodadas, e capturar `EXPLAIN (ANALYZE, BUFFERS)` das
   2 funções RPC.
3. **Expected/Decisão**: se todas as medições ficam abaixo de 1s, SC-004
   passa e nenhuma mitigação é necessária. Se alguma medição exceder 1s,
   registrar Decisão auditável com a evidência (mesmo padrão de dec-035
   em `hub-faturamento`) propondo a mitigação pré-aprovada do plano
   técnico §12.6 (`mv_performance_dia`, espelhando `mv_faturamento_dia`)
   como escopo de follow-up — nunca implementada preventivamente antes da
   medição.

# Requirements Checklist: Módulo Performance do Hub (hub-performance / S7)

**Purpose**: Quality gate de qualidade dos requisitos (spec + plan + research +
data-model + contrato + quickstart) antes de `create-tasks`. Valida
completude, clareza, consistência, mensurabilidade, cobertura de
cenários/edge cases, requisitos não-funcionais, dependências e
ambiguidades/conflitos — não testa implementação (não existe código ainda).
**Created**: 2026-07-08
**Feature**: [spec.md](../spec.md) · [plan.md](../plan.md) ·
[research.md](../research.md) · [data-model.md](../data-model.md) ·
[contracts/performance-api.md](../contracts/performance-api.md) ·
[quickstart.md](../quickstart.md)

## Completude de Requisitos

- [x] CHK001 - Está definido o comportamento de paginação (parâmetros, defaults, limites) da lista de registros? [Completude, Spec FR-001; Contract "GET /performance" params page/pageSize] {auto}
- [x] CHK002 - Estão definidos todos os campos retornados por item da lista? [Completude, Contract "Resposta 200 (JSON, sem format)"] {auto}
- [x] CHK003 - Está definido o formato exato do arquivo CSV exportado (cabeçalho, colunas, content-type)? [Completude, Contract "Resposta 200 (?format=csv)"] {auto}
- [x] CHK004 - Estão definidos os casos de erro (401/403/400) de cada endpoint, com o corpo de resposta esperado? [Completude, Contract "Erros" de ambos endpoints] {auto}
- [x] CHK005 - Está definido o schema de RBAC completo (as 3 permissões, quem as possui, a que endpoint/modo cada uma se aplica)? [Completude, data-model.md "Mapa permissão lógica → código real"; research.md Decision 1] {auto}
- [x] CHK006 - Estão definidas as migrations necessárias, seu conteúdo mínimo e a idempotência esperada? [Completude, plan.md "Plano por fases" passo 1; data-model.md "Migrations desta fase"] {auto}
- [x] CHK007 - Está definido o que é auditado e o que não é, com justificativa? [Completude, research.md "Constraints herdados — Auditoria"] {auto}
- [x] CHK008 - Está definido o volume de dados de referência (~1 ano) e o procedimento de geração de seed usados na medição de SC-004? [Completude, quickstart.md Cenário 15; research.md Decision 8] {auto}
- [x] CHK009 - A fórmula exata da média ponderada de tempo disponível (numerador, denominador, condição de fallback) está definida sem deixar espaço para interpretação de implementação? [Completude, Spec FR-003; research.md Decisions 2/3] {auto}

## Clareza de Requisitos

- [x] CHK010 - O termo "duração do turno" da fórmula ponderada está resolvido para uma coluna concreta do schema (`duracao`), não deixado como conceito abstrato a reimplementar? [Clareza, research.md Decision 2] {auto}
- [x] CHK011 - O nível em que o fallback de média simples se aplica (o conjunto/grupo inteiro, não apenas o registro sem duração derivável) está explícito, sem ambiguidade entre as duas leituras possíveis do Edge Case? [Clareza, Spec FR-003 Edge Case; research.md Decision 3] {auto}
- [x] CHK012 - A distinção entre `data_periodo` (campo padrão do filtro) e os demais atributos temporais do registro (`duracao`, `tempo_disponivel`) está explícita o suficiente para dispensar conhecimento do schema pela pessoa usuária? [Clareza, Spec FR-002; data-model.md] {auto}
- [x] CHK013 - Está claro, sem ambiguidade, qual caractere neutraliza a célula CSV, onde é inserido e que o conteúdo original é preservado como texto? [Clareza, Spec FR-007; SC-005] {auto}

## Consistência de Requisitos

- [x] CHK014 - O conjunto de permissões citado no corpo da spec (FR-008: listagem/consulta/exportação) é consistente com os códigos exatos usados no contrato e no data-model (`performance.listar`/`performance.consultar`/`performance.exportar`)? [Consistência, Spec FR-008; data-model.md "Mapa permissão lógica"; research.md Decision 1] {auto}
- [x] CHK015 - O tratamento de "período sem dados" (FR-011) é consistente entre card de resumo, agrupamento e lista (mesmo padrão nos três)? [Consistência, Spec FR-011; Contract "Resposta 200 — sem groupBy"; quickstart Cenário 6] {auto}
- [x] CHK016 - O filtro por subpraça é consistente entre a spec (nenhuma estrutura nova de índice) e o data-model (índice `0020` já existente citado, nenhum novo criado)? [Consistência, Spec FR-002; data-model.md] {auto}
- [x] CHK017 - A rota real da tela (`/hub/dashboard/performance`) é usada de forma consistente em plan.md, research.md (Decision 10) e quickstart.md, sem referência remanescente ao rascunho `/performance`? [Consistência, plan.md Technical Context; research.md Decision 10] {auto}
- [x] CHK018 - A ausência de bucket "sem entregador" (Decision 4) é consistente entre a introdução da spec, o schema no data-model (`entregador_id NOT NULL`) e o contrato (nenhuma chave `agregados_bonus`)? [Consistência, research.md Decision 4; data-model.md] {auto}
- [x] CHK019 - O vocabulário "turno (período)" usado na spec é mapeado de forma inequívoca para o valor de enum `periodo` (não `turno`) usado no contrato/RPC? [Consistência, research.md Decision 12] {auto}

## Qualidade de Critérios de Aceite (Mensurabilidade)

- [x] CHK020 - SC-001 (indicadores batem com o banco) é objetivamente verificável, com consulta SQL de referência definida? [Mensurabilidade, Spec SC-001; quickstart Cenário 1] {auto}
- [x] CHK021 - SC-002 (taxa agregada = razão entre somas) tem cenário que contrasta explicitamente com o cálculo incorreto (média de percentuais linha a linha)? [Mensurabilidade, Spec SC-002; quickstart Cenário 2] {auto}
- [ ] CHK022 - SC-003 ("localiza e confirma os indicadores... em menos de 15 segundos") tem procedimento de medição definido (cronômetro, instrumentação), ou depende de julgamento humano sobre o que conta como "localizar e confirmar"? [Mensurabilidade, Spec SC-003] {humano}
- [x] CHK023 - SC-004 (resposta em menos de 1s sob volume de ~1 ano) tem volume de dados e procedimento de medição definidos de forma reprodutível, incluindo o caso com e sem `groupBy`? [Mensurabilidade, Spec SC-004; quickstart Cenário 15; research.md Decision 8] {auto}
- [ ] CHK024 - SC-008 ("sem regressão perceptível" na identidade visual) tem critério objetivo definido (ex.: diff de screenshot, score de acessibilidade), ou depende de avaliação subjetiva humana? [Mensurabilidade, Spec SC-008; quickstart Cenário 12] {humano}

## Cobertura de Cenários

- [x] CHK025 - Existe teste independente definido para cada uma das 3 User Stories (P1/P2/P3)? [Cobertura, Spec "Independent Test" de cada US] {auto}
- [x] CHK026 - Existe cenário cobrindo a combinação de múltiplos filtros simultâneos (não apenas filtros isolados)? [Cobertura, Spec Acceptance Scenario US1.4; quickstart Cenário 1] {auto}
- [x] CHK027 - Existe cenário cobrindo o isolamento multi-tenant tanto na lista/resumo quanto no export CSV? [Cobertura, Spec FR-009/SC-007; quickstart Cenário 11] {auto}
- [x] CHK028 - Existe cenário dedicado ao caso de fallback da média ponderada (duração do turno não derivável para algum registro do conjunto)? [Cobertura, quickstart Cenário 3 item 4] {auto}
- [x] CHK029 - Existe cenário cobrindo as 3 permissões independentes em todas as combinações relevantes (só consultar, só listar, listar+consultar sem exportar)? [Cobertura, Spec FR-008/SC-006; quickstart Cenário 10] {auto}

## Cobertura de Edge Cases

- [x] CHK030 - O comportamento de exportação com filtro vazio (nenhum registro) está coberto por um cenário de teste explícito? [Cobertura Edge Case, Spec Edge Cases; quickstart Cenário 9] {auto}
- [ ] CHK031 - O edge case "célula já começa com apóstrofo ou outro caractere neutro — nenhuma neutralização adicional é aplicada" está coberto por um cenário de validação explícito (quickstart Cenário 8 só cobre `=`/`+`/`-`/`@`, não o caso de não-duplo-prefixo)? [Gap, Spec Edge Cases; quickstart Cenário 8] {auto}
- [x] CHK032 - O comportamento para um valor de `periodo` fora dos 16 turnos documentados está definido e coberto por cenário de teste? [Cobertura Edge Case, Spec Edge Cases; quickstart Cenário 4 item 4] {auto}
- [x] CHK033 - O comportamento para um registro com corridas aceitas+rejeitadas > ofertadas (dado inconsistente já importado) está definido e coberto por Acceptance Scenario? [Cobertura Edge Case, Spec Edge Cases; Acceptance Scenario US1.6] {auto}

## Requisitos Não-Funcionais

- [x] CHK034 - O requisito de export sem carregar todas as linhas em memória (streaming) especifica mecanismo e tamanho de lote, verificáveis por revisão de código? [NFR-Performance, research.md Decision 5] {auto}
- [x] CHK035 - O requisito de precisão decimal (sem ponto flutuante) especifica onde a soma/ponderação ocorre (SQL) e como o valor trafega na API (`text`)? [NFR-Precisão, Spec FR-003/FR-005; research.md Decision 7] {auto}
- [x] CHK036 - Estão definidos os requisitos de proteção contra SQL injection nas 2 novas funções de agregação (parametrização nativa, nenhuma concatenação)? [NFR-Segurança, plan.md "Gate owasp-security"; research.md Decision 3] {auto}
- [x] CHK037 - O requisito de isolamento multi-tenant está associado a um mecanismo de enforcement verificável (RLS) e não apenas à confiança no filtro aplicado pelo backend? [NFR-Segurança, plan.md Constitution Check II; research.md Decision 3] {auto}
- [x] CHK038 - O risco de consumo irrestrito de recursos pelo export (OWASP API4) foi avaliado, com decisão de não mitigar nesta fase explicitamente justificada? [NFR-Segurança, plan.md "Gate owasp-security — resultado", finding informativo API4] {auto}

## Dependências e Premissas

- [x] CHK039 - A dependência da S4 (fato `PerformanceTurno` já populado) e da S5 (RLS + índice de subpraça já entregues) está declarada explicitamente como premissa desta fase? [Dependência, Spec §intro; data-model.md] {auto}
- [x] CHK040 - A decisão de adiar a estrutura de pré-cálculo/agregação persistida está condicionada a um critério de gatilho mensurável (não "depois vemos")? [Dependência/Premissa, Spec §Decisões de infraestrutura; research.md Decision 8] {auto}

## Ambiguidades e Conflitos

- [x] CHK041 - O termo "resumo agregado" é usado de forma ambígua entre "cards" (FR-003) e "agrupado por dia/período/entregador" (FR-004), ou o contrato distingue claramente quando cada shape é retornado? [Ambiguity-check, Contract "GET /performance/resumo" — presença/ausência de `groupBy`] {auto}
- [x] CHK042 - Há conflito entre "nenhuma estrutura nova de índice é introduzida" (Spec FR-002) e a criação de 2 funções RPC pela migration `0030`? [Conflict-check, Spec FR-002; plan.md "Complexity Tracking"] {auto}

## Notes

- Items `{auto}` já vêm resolvidos pelo agente (`[x]` com citação, ou marcador
  `[Gap]` quando não satisfeito).
- Items `{humano}` ficam `[ ]` aguardando decisão do dono do produto: CHK022
  (procedimento de medição de SC-003 — cronômetro/instrumentação vs
  julgamento humano) e CHK024 (critério objetivo de SC-008 — diff de
  screenshot/score de acessibilidade vs avaliação subjetiva). Mesmos 2 gaps
  de natureza já aceitos como `{humano}` em `hub-faturamento` (CHK020/CHK023
  daquele checklist) — não são bloqueantes para `create-tasks`, ficam
  registrados para o dono do produto decidir a qualquer momento antes do
  fechamento (`review-task`).
- Gap aberto: **CHK031** — o cenário 8 do quickstart cobre a neutralização
  dos 4 caracteres perigosos (`= + - @`), mas não tem uma assertiva
  dedicada ao caso "célula já começa com `'`/outro caractere neutro → sem
  dupla neutralização". Ação: `/create-tasks` deve gerar uma subtarefa de
  teste unitário específica para esse ramo de `escaparCelulaCsvInjection`
  (mesmo gap já identificado e mantido aberto no CHK029 do checklist de
  `hub-faturamento` — o comportamento correto já está implementado em
  `lib/hub-csv.js`, falta só o teste explícito reaproveitado pelo consumidor
  novo).
- Marcar items concluídos com `[x]`.

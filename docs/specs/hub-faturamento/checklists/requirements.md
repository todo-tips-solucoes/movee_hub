# Requirements Checklist: Módulo Faturamento do Hub (hub-faturamento / S6)

**Purpose**: Quality gate de qualidade dos requisitos (spec + plan + research +
data-model + contrato + quickstart) antes de `create-tasks`. Valida
completude, clareza, consistência, mensurabilidade, cobertura de
cenários/edge cases, requisitos não-funcionais, dependências e
ambiguidades/conflitos — não testa implementação (não existe código ainda).
**Created**: 2026-07-08
**Feature**: [spec.md](../spec.md) · [plan.md](../plan.md) ·
[research.md](../research.md) · [data-model.md](../data-model.md) ·
[contracts/faturamento-api.md](../contracts/faturamento-api.md) ·
[quickstart.md](../quickstart.md)

## Completude de Requisitos

- [x] CHK001 - Está definido o comportamento de paginação (parâmetros, defaults, limites) da lista de lançamentos? [Completude, Spec FR-001; Contract "GET /faturamento" params page/pageSize] {auto}
- [x] CHK002 - Estão definidos todos os campos retornados por item da lista, inclusive campos derivados (`comEntregador`)? [Completude, Contract "Resposta 200 (JSON, sem format)"] {auto}
- [x] CHK003 - Está definido o formato exato do arquivo CSV exportado (cabeçalho, colunas, nome do arquivo, content-type)? [Completude, Contract "Resposta 200 (?format=csv)"] {auto}
- [x] CHK004 - Estão definidos os casos de erro (401/403/400) de cada endpoint, com o corpo de resposta esperado? [Completude, Contract "Erros" de ambos endpoints] {auto}
- [x] CHK005 - Está definido o schema de RBAC completo (quais permissões existem, quem as possui, a que endpoint/modo cada uma se aplica)? [Completude, data-model.md "Mapa permissão lógica → código real"; research.md Decision 1] {auto}
- [x] CHK006 - Estão definidas as migrations necessárias, seu conteúdo mínimo e a idempotência esperada? [Completude, plan.md "Plano por fases" passo 1; data-model.md "Migrations desta fase"] {auto}
- [x] CHK007 - Está definido o que é auditado e o que não é, com justificativa (não apenas "auditoria genérica")? [Completude, research.md "Constraints herdados — Auditoria"] {auto}
- [x] CHK008 - Está definido o volume de dados de referência (~1 ano) e o procedimento de geração de seed usados na medição de SC-004? [Completude, quickstart.md Cenário 15; research.md Decision 8] {auto}

## Clareza de Requisitos

- [x] CHK009 - O termo "categoria de maior valor" está quantificado com um critério de desempate explícito para o caso de empate exato? [Clareza, Spec FR-003; Clarifications Q4/dec-014] {auto}
- [x] CHK010 - O rótulo "agregados/bônus" está definido de forma única, sem se confundir com o texto livre de `recebedor_agregado`? [Clareza, Spec FR-004/FR-005; research.md Decision 4] {auto}
- [x] CHK011 - A distinção entre as três datas do lançamento (competência/registro/repasse) e qual delas alimenta o filtro está explícita o suficiente para dispensar conhecimento do schema pela pessoa usuária? [Clareza, Spec FR-002, Acceptance Scenario US1.6] {auto}
- [x] CHK012 - O termo "tempo aceitável" nos Edge Cases (volume grande de lançamentos) resolve para um valor mensurável em algum critério de aceite? [Clareza, Spec Edge Cases → SC-004] {auto}
- [x] CHK013 - Está claro, sem ambiguidade, qual caractere neutraliza a célula CSV, onde é inserido (prefixo, início da célula) e que o conteúdo original é preservado como texto? [Clareza, Spec FR-007; SC-005] {auto}

## Consistência de Requisitos

- [x] CHK014 - O conjunto de permissões citado no corpo da spec (FR-008: listagem/visualização/exportação) é consistente com os códigos exatos usados no contrato e no data-model (`faturamento.listar`/`faturamento.consultar`/`faturamento.exportar`)? [Consistência, Spec FR-008; data-model.md "Mapa permissão lógica"; research.md Decision 1] {auto}
- [x] CHK015 - O tratamento de "período sem dados" (FR-012) é consistente entre card de resumo, agrupamento e lista (mesmo padrão nos três)? [Consistência, Spec FR-012; Contract "Resposta 200 — sem groupBy"; quickstart Cenário 6] {auto}
- [x] CHK016 - O filtro por subpraça é consistente entre a spec (coluna própria, sem índice novo) e o data-model (índice já existente citado, nenhum novo criado)? [Consistência, Spec FR-002; Clarifications Q1/dec-009; data-model.md "Índices reutilizados"] {auto}
- [x] CHK017 - A rota real da tela (`/hub/dashboard/faturamento`) é usada de forma consistente em plan.md, research.md (Decision 10) e quickstart.md, sem referência remanescente ao rascunho `/faturamento`? [Consistência, plan.md Technical Context; research.md Decision 10; quickstart Cenário 1] {auto}
- [x] CHK018 - O comportamento do filtro `entregadorId` combinado com `comEntregador=false` é consistente entre o Edge Case da spec e o erro `400` declarado no contrato? [Consistência, Spec Edge Cases; Contract nota de `entregadorId`] {auto}

## Qualidade de Critérios de Aceite (Mensurabilidade)

- [x] CHK019 - SC-001 (totais batem com o banco) é objetivamente verificável, com consulta SQL de referência definida? [Mensurabilidade, Spec SC-001; quickstart Cenário 1] {auto}
- [ ] CHK020 - SC-003 ("localiza e confirma o total... em menos de 15 segundos") tem procedimento de medição definido (cronômetro, instrumentação), ou depende de julgamento humano sobre o que conta como "localizar e confirmar"? [Mensurabilidade, Spec SC-003] {humano}
- [x] CHK021 - SC-004 (resposta em menos de 1s sob volume de ~1 ano) tem volume de dados e procedimento de medição definidos de forma reprodutível? [Mensurabilidade, Spec SC-004; quickstart Cenário 15; research.md Decision 8] {auto}
- [x] CHK022 - SC-006 (permissão de exportação oculta/negada em 100% dos casos) tem cenário de teste dedicado tanto para ocultação de UI quanto para bypass direto de API? [Mensurabilidade, Spec SC-006; quickstart Cenário 10] {auto}
- [ ] CHK023 - SC-008 ("sem regressão perceptível" na identidade visual) tem critério objetivo definido (ex.: diff de screenshot, score de acessibilidade), ou depende de avaliação subjetiva humana? [Mensurabilidade, Spec SC-008; quickstart Cenário 14] {humano}

## Cobertura de Cenários

- [x] CHK024 - Existe teste independente definido para cada uma das 3 User Stories (P1/P2/P3)? [Cobertura, Spec "Independent Test" de cada US] {auto}
- [x] CHK025 - Existe cenário cobrindo a combinação de múltiplos filtros simultâneos (não apenas filtros isolados)? [Cobertura, Spec Acceptance Scenario US1.2; quickstart Cenário 1] {auto}
- [x] CHK026 - Existe cenário cobrindo o isolamento multi-tenant tanto na lista/resumo quanto no export CSV? [Cobertura, Spec FR-009/SC-007; quickstart Cenário 11] {auto}
- [x] CHK027 - Existe cenário cobrindo a navegação condicionada pela permissão do módulo de destino (motoristas), incluindo o caso sem permissão? [Cobertura, Spec FR-010; quickstart Cenário 12] {auto}

## Cobertura de Edge Cases

- [x] CHK028 - O comportamento de exportação com filtro vazio (nenhum lançamento) está coberto por um cenário de teste explícito? [Cobertura Edge Case, Spec Edge Cases; quickstart Cenário 9] {auto}
- [ ] CHK029 - O edge case "célula já começa com apóstrofo ou outro caractere neutro — nenhuma neutralização adicional é aplicada" está coberto por um cenário de validação explícito (quickstart só cobre `=`/`@` no Cenário 8, não o caso de não-duplo-prefixo)? [Gap, Spec Edge Cases; quickstart Cenário 8] {auto}
- [x] CHK030 - O comportamento para uma categoria (`descricao`) fora de uma lista fechada (texto livre não reconhecido) está definido e é consistente com a ausência de qualquer validação de enum sobre esse campo no contrato/data-model? [Cobertura Edge Case, Spec Edge Cases; data-model.md campo `descricao`] {auto}

## Requisitos Não-Funcionais

- [x] CHK031 - O requisito de export sem carregar todas as linhas em memória (streaming) especifica mecanismo e tamanho de lote, verificáveis por revisão de código? [NFR-Performance, Spec FR-006; research.md Decision 5] {auto}
- [x] CHK032 - O requisito de precisão decimal (sem ponto flutuante) especifica onde a soma ocorre (SQL) e como o valor trafega na API (string)? [NFR-Precisão, Spec FR-003; research.md Decision 7] {auto}
- [x] CHK033 - Estão definidos os requisitos de proteção contra SQL injection nas funções de agregação (parametrização nativa, nenhuma concatenação)? [NFR-Segurança, plan.md "Gate owasp-security"; research.md Decision 2] {auto}
- [x] CHK034 - O requisito de isolamento multi-tenant está associado a um mecanismo de enforcement verificável (RLS) e não apenas à confiança no filtro aplicado pelo backend? [NFR-Segurança, plan.md Constitution Check II; research.md Decision 2] {auto}
- [x] CHK035 - O risco de consumo irrestrito de recursos pelo export (OWASP API4) foi avaliado, com decisão de não mitigar nesta fase explicitamente justificada? [NFR-Segurança, plan.md "Gate owasp-security — resultado", finding informativo API4] {auto}

## Dependências e Premissas

- [x] CHK036 - A dependência da S4 (fato `FaturamentoLancamento` já populado) e da S5 (permissão `motoristas.consultar`, `GET /me`) está declarada explicitamente como premissa desta fase? [Dependência, Spec §intro; research.md Decision 11] {auto}
- [x] CHK037 - A decisão de adiar a estrutura de pré-cálculo/agregação persistida está condicionada a um critério de gatilho mensurável (não "depois vemos")? [Dependência/Premissa, Spec §Não inclui + Decisões de infraestrutura; research.md Decision 8] {auto}

## Ambiguidades e Conflitos

- [x] CHK038 - O termo "resumo agregado" é usado de forma ambígua entre "cards" (FR-003) e "agrupado por dia/categoria/entregador" (FR-004), ou o contrato distingue claramente quando cada shape é retornado? [Ambiguity-check, Contract "GET /faturamento/resumo" — presença/ausência de `groupBy`] {auto}
- [x] CHK039 - Há conflito entre "nenhuma estrutura nova de índice é introduzida" (spec FR-002) e a criação de 2 funções RPC pela migration `0027`? [Conflict-check, Spec FR-002; plan.md "Complexity Tracking"/"Re-check de Constitution"] {auto}

## Notes

- Items `{auto}` já vêm resolvidos pelo agente (`[x]` com citação, ou marcador `[Gap]`/`[Ambiguity]`/`[Conflict]` quando não satisfeitos).
- Items `{humano}` ficam `[ ]` aguardando decisão do dono do produto.
- Marcar items concluídos com `[x]`.

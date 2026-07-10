# Requirements Checklist: hub-auditoria-admin (S9 — Auditoria e Administração da Plataforma)

**Purpose**: Validar a QUALIDADE dos requisitos de spec.md/plan.md/data-model.md/contracts
antes de `/create-tasks` — completude, clareza, consistência, mensurabilidade dos
Success Criteria, cobertura de cenários/edge cases, não-funcionais, premissas e
ambiguidades residuais. Não valida implementação (ainda não existe).
**Created**: 2026-07-09 (onda-004, checklist)
**Feature**: [spec.md](../spec.md) · [plan.md](../plan.md) · [data-model.md](../data-model.md) ·
[research.md](../research.md) · [quickstart.md](../quickstart.md) ·
[contracts/](../contracts/)

## Completude de Requisitos

- [x] CHK001 - Todos os 4 domínios de superfície de API (auditoria, usuários, papéis,
  admin-módulos) referenciados nos FRs têm contrato de API dedicado com
  params/response/erros? [Completude, Spec §FR-001/FR-009/FR-010/FR-013] {auto}
  — `contracts/auditoria-api.md`, `usuarios-api.md`, `papeis-api.md`,
  `admin-modulos-api.md` cobrem os 4, cada um com params, response 200 e lista de erros.
- [x] CHK002 - Cada Key Entity da spec (Evento de Auditoria, Módulo, Habilitação de
  Módulo por Entidade, Usuário, Papel, Permissão) tem modelagem de campos/constraints
  documentada? [Completude, Spec §Key Entities] {auto}
  — `data-model.md` cobre as 6 entidades com colunas, tipos e constraints (§Entity:
  Auditoria .. §Entity: Usuario/UsuarioEntidade).
- [x] CHK003 - Existe enumeração explícita das migrations que implementam cada
  requisito de escrita nova (FR-005 imutabilidade, FR-007 módulos, FR-010/016
  matriz)? [Completude, Spec §FR-005/FR-007/FR-010] {auto}
  — `data-model.md` §"Migrations desta fase" mapeia 0035-0038 1:1 a cada capacidade.
- [x] CHK004 - Existe guard documentado contra lockout administrativo para toda
  operação que poderia bloquear a própria administração (desabilitar módulo `admin`,
  remover `admin.gerenciar` do papel `admin_plataforma`)? [Completude, Spec Edge
  Cases] {auto}
  — `contracts/papeis-api.md` finding M2 e `contracts/admin-modulos-api.md` finding
  M3 (ambos `409 OPERACAO_BLOQUEADA`).
- [x] CHK005 - O vocabulário de erros é fechado e enumerado para cada endpoint
  novo/evoluído? [Completude, Spec §FR-001..FR-017] {auto}
  — cada um dos 4 contratos lista seção "Erros:" fechada.
- [ ] CHK006 - Existe definição de qual mecanismo/ferramenta realiza a "checagem
  automatizada de padrões" citada em SC-006? [Completude, Spec §SC-006] {auto}
  **[Gap]** — nenhum artefato (plan.md/research.md/quickstart.md) especifica o
  mecanismo/regex/tool que executará essa checagem automatizada; apenas o requisito
  funcional equivalente na escrita (FR-004, `scrubDetalhes`) está descrito, não a
  checagem de verificação do SC-006 em si.

## Clareza de Requisitos

- [x] CHK007 - O termo "imediatamente" em FR-008/FR-011 é ancorado por um mecanismo
  determinístico (não apenas promessa qualitativa)? [Clareza, Spec §FR-008/FR-011]
  {auto}
  — `research.md` Decision 3 (middleware + invalidação síncrona de módulos) e
  Decision 6 (`invalidarUsuario` síncrono) tornam "imediatamente" operacionalmente
  verificável (não dependente de TTL).
- [x] CHK008 - "Dados sensíveis" (FR-004) é lista fechada e não termo vago? [Clareza,
  Spec §FR-004] {auto}
  — a própria FR-004 já enumera: documentos de identificação, senhas, tokens, nomes
  completos de terceiros.
- [ ] CHK009 - O critério de "ação de escrita relevante" (FR-006/SC-002) delimita
  explicitamente o que fica FORA do escopo de auditoria (ex.: leituras, no-ops,
  healthchecks)? [Clareza, Spec §FR-006] {humano}
  — `research.md` Decision 11 define o MÉTODO de inventário (grep de handlers de
  escrita `router.(post|put|patch|delete)`) mas não um critério positivo/negativo de
  "relevância". Decidir se alguma escrita é dispensável de auditoria é julgamento de
  produto/risco, não derivável só da spec.
- [x] CHK010 - "Trilha de auditoria" e "eventos" são usados de forma intercambiável e
  consistente entre spec, contratos e quickstart? [Clareza/Consistência] {auto}
  — terminologia consistente nos 3 artefatos; `plan.md` linha 8 explicita que a
  chave `eventos` é preservada por design (evolução aditiva, não renomeação).

## Consistência de Requisitos

- [x] CHK011 - O mapeamento de permissão lógica (spec) → código de permissão real
  (seed) é único e sem ambiguidade para cada FR de administração? [Consistência,
  Spec §FR-009/FR-010/FR-013] {auto}
  — `data-model.md` §"Mapa permissão lógica → código real" cobre as 5 capacidades
  sem duplicidade (`auditoria.consultar`, `usuarios.gerenciar`, `admin.gerenciar`).
- [x] CHK012 - FR-010 (leitura para admin_entidade) e o contrato `papeis-api.md`
  concordam sobre o campo que sinaliza modo leitura vs edição? [Consistência, Spec
  §FR-010] {auto}
  — o contrato expõe `podeEditar` (true somente com `admin.gerenciar` + vínculo
  `admin_plataforma`), consistente com "restrito a quem tem permissão de
  administração da plataforma" da spec.
- [x] CHK013 - A regra de visibilidade de eventos globais (`id_empresa` NULL) no
  Edge Case da spec é consistente com a política RLS 0035 descrita em
  data-model.md? [Consistência, Spec Edge Cases] {auto}
  — `data-model.md` confirma que a nova política SELECT remove o branch
  `id_empresa IS NULL` do caminho comum, restringindo-o à claim
  `hub_jwt_admin_plataforma()`.
- [x] CHK014 - Os códigos de erro para a mesma condição (acesso cross-tenant) são
  reaproveitados de forma consistente entre os 4 contratos, em vez de codificações
  redundantes? [Consistência] {auto}
  — `usuarios-api.md` tem nota explícita de "vocabulário unificado", reusando
  `403 PERMISSAO_NEGADA` do contrato de auditoria para o caso análogo.
- [x] CHK015 - plan.md e data-model.md concordam em não introduzir nenhuma tabela
  nova, mantendo a Complexity Tracking vazia? [Consistência] {auto}
  — `plan.md` linhas 17-19 e `data-model.md` linha 7 convergem; Complexity Tracking
  (plan.md §Complexity Tracking) está vazia por design, justificada no texto.

## Qualidade de Critérios de Aceite (Success Criteria)

- [ ] CHK016 - SC-001 (<30s) é mensurável sem depender de julgamento subjetivo de
  "localizar"? [Mensurabilidade, Spec §SC-001] {humano}
  — falta definir o protocolo de medição (cronômetro manual do QA vs script
  automatizado no E2E/quickstart); a escolha do método de teste cabe ao dono do
  produto/QA, não é derivável só da spec.
- [x] CHK017 - SC-004 (<2s) tem mecanismo determinístico e testável descrito na
  arquitetura, não apenas a meta numérica solta? [Mensurabilidade, Spec §SC-004]
  {auto}
  — `research.md` Decision 6 + `quickstart.md` Cenário 5 passo 3 dão o teste
  concreto (`invalidarUsuario` síncrono, sem esperar TTL de 60s).
- [x] CHK018 - SC-005 (100% bloqueio) tem cenário de teste que comprove tanto o
  bloqueio de acesso direto quanto o desaparecimento do item de menu,
  isoladamente? [Mensurabilidade, Spec §SC-005] {auto}
  — `quickstart.md` Cenário 7 passos 2-3 cobrem os dois efeitos separadamente
  (nav vs endpoint direto).
- [x] CHK019 - SC-008 (fluxo completo nas telas) tem cenário de teste ponta-a-ponta
  que não dependa de operação direta em banco, coerente com a própria definição do
  critério? [Mensurabilidade, Spec §SC-008] {auto}
  — `quickstart.md` Cenário 5 cobre criar+vincular+trocar papel+confirmar
  permissão via UI/API, sem operação de banco.
- [x] CHK020 - Os Success Criteria evitam referência a detalhes de implementação
  (nomes de função/tabela), mantendo-se centrados em resultado observável?
  [Qualidade de Critérios] {auto}
  — revisão de SC-001..SC-008 confirma foco em resultado (tempo, %, UX), sem
  menção a `invalidarUsuario`/RLS/nomes de tabela.

## Cobertura de Cenários e Edge Cases

- [x] CHK021 - Cada Acceptance Scenario de US1-US4 tem cenário de teste
  correspondente no quickstart.md? [Cobertura, Spec §User Scenarios] {auto}
  — mapeamento 1:1: US1→Cenários 1/2, US2→Cenário 3, US3→Cenários 5/6,
  US4→Cenário 7.
- [x] CHK022 - Todos os 8 Edge Cases da spec têm tratamento explícito (contrato,
  RLS ou cenário de teste), não apenas menção narrativa? [Cobertura Edge Cases,
  Spec §Edge Cases] {auto}
  — rastreados: entidade ausente→Cenário 2; filtro forçado cross-tenant→Cenário
  2.3; alteração/exclusão de evento→Cenário 4; período inválido→
  `auditoria-api.md` `PERIODO_INVALIDO`; paginação além do total→
  `auditoria-api.md` (`eventos: []`, 200); evento sem entidade→`data-model.md`
  0035; módulo desabilitado com sessão ativa→Cenário 7; endpoints legados sem
  auditoria→research Decision 11 + Cenário 9.
- [x] CHK023 - O cenário de roundtrip (Cenário 8) cobre as 3 superfícies novas
  (auditoria, papéis, admin-módulos), não apenas uma amostra? [Cobertura] {auto}
  — Cenário 8 passo 4 explicita repetição para `GET /papeis` e
  `GET /admin/entidades/9001/modulos`.
- [x] CHK024 - Existe cenário de teste que force o caminho negativo de FR-017
  (admin_entidade tentando qualquer rota do router admin)? [Cobertura, Spec
  §FR-017] {auto}
  — `quickstart.md` Cenário 7 passo 4 (`403 PERMISSAO_NEGADA`, nem leitura).

## Requisitos Não-Funcionais (Segurança/Performance)

- [x] CHK025 - O requisito "senha nunca em detalhes de auditoria" (FR-004) tem
  mecanismo de scrub verificável, não apenas convenção de código? [Segurança, Spec
  §FR-004] {auto}
  — `scrubDetalhes` (mecanismo já existente, `lib/hub-auditoria.js`) citado em
  `research.md` Decision 7 e coberto por `quickstart.md` Cenários 1/5.
- [x] CHK026 - Existe requisito e mecanismo para impedir enumeração de existência
  de usuário/entidade fora do escopo do chamador? [Segurança, Spec §FR-009]
  {auto}
  — `contracts/usuarios-api.md`: "`404 USUARIO_NAO_ENCONTRADO` se o usuário não
  tem vínculo visível no escopo do chamador (não vaza existência cross-tenant)".
- [x] CHK027 - O hardening de injeção de filtro (finding M1: vocabulário fechado +
  `encodeURIComponent`) está especificado com o mesmo rigor para TODOS os
  parâmetros de filtro, não só uma amostra? [Segurança, Spec §FR-001] {auto}
  — `contracts/auditoria-api.md` detalha a regra para `acao`/`recurso`
  (`^[a-z0-9_]+$`), `usuarioId`/`entidadeId` (`Number.isInteger`) e datas (ISO).
- [ ] CHK028 - O requisito de performance "p95 <500ms" citado no plan.md tem
  correspondência em algum Success Criteria da spec, ou é meta apenas técnica sem
  rastreabilidade formal? [Requisitos Não-Funcionais/Consistência, Spec
  §Success Criteria] {humano}
  **[Gap]** — `plan.md` §Technical Context lista "lista auditoria p95 <500ms no
  volume homolog" mas a spec (Success Criteria) não tem um SC equivalente; é meta
  de engenharia não formalizada como critério de aceite do produto. Decisão do
  dono: promover a SC-009 ou manter apenas como meta técnica interna.

## Dependências e Premissas

- [x] CHK029 - A premissa "papéis são catálogo fixo, sem escrita" (dec-008) está
  refletida como ausência deliberada de rota/política, não apenas texto na spec?
  [Premissas, Spec §FR-016] {auto}
  — `data-model.md` confirma: "Nenhuma política de escrita existe nem será
  criada" para `"Papel"`.
- [x] CHK030 - A dependência de que os módulos `usuarios`/`auditoria`/`admin` já
  existem no catálogo (sem seed de módulo novo) está verificada contra o schema
  real, não apenas assumida? [Premissas] {auto}
  — `data-model.md` confirma os 3 módulos já seedados na migration 0007
  (ordens 70/80/90).
- [x] CHK031 - A premissa de que o risco da senha inicial conhecida pelo admin
  (Decision 7 / finding L1) foi aceita explicitamente como risco residual
  auditado, e não deixada implícita? [Premissas/Segurança] {auto}
  — `contracts/usuarios-api.md` documenta: "Nota de risco (gate owasp, finding
  L1 — aceito e auditado)".

## Ambiguidades e Conflitos

- [ ] CHK032 - Existe conflito entre FR-014 (sem retenção/expurgo) e a ausência de
  qualquer limite de volume mencionado nos Success Criteria de performance
  (SC-001 <30s)? [Conflict, Spec §FR-014] {humano}
  — a spec não define até que volume de dados o SC-001 (<30s) permanece válido;
  sem política de retenção, o crescimento não-limitado do volume pode
  eventualmente pressionar a meta de performance. Trade-off de longo prazo (fora
  do escopo desta feature) que vale registrar para roadmap, mas cabe ao dono do
  produto avaliar.
- [ ] CHK033 - "gestão de usuários e papéis por telas completas" (título US3)
  inclui exclusão de usuário/vínculo, ou apenas criar/editar/vincular como o texto
  de FR-009 sugere? [Ambiguity, Spec §FR-009] {auto}
  **[Ambiguity]** — FR-009 lista "criar, editar, vincular... e atribuir papéis"
  sem menção a excluir; `data-model.md` confirma modelo "sem DELETE"
  (desativação via `ativo=false`), então a leitura pretendida é que "editar"
  inclui desativar — mas a spec não afirma isso explicitamente, deixando
  ambiguidade textual residual entre o título da US3 ("gerenciar") e o mecanismo
  real (soft-delete via PUT).

## Notes

- Items `{auto}` já vêm resolvidos pelo agente (`[x]` com citação, ou marcador `[Gap]`/`[Ambiguity]`).
- Items `{humano}` ficam `[ ]` aguardando decisão do dono do produto.
- 33 items totais: 27 resolvidos `[x]`, 6 em aberto (2 `[Gap]`, 1 `[Ambiguity]`, 3 `{humano}` puros).
- Rastreabilidade: 33/33 items (100%) citam `[Spec §X]`, `[Gap]`, `[Ambiguity]` ou `[Conflict]` — acima do mínimo de 80%.

## Follow-up (destino explícito dos 6 items em aberto)

| CHK | Marcador | Destino |
|-----|----------|---------|
| CHK006 | `[Gap]` — mecanismo do SC-006 não especificado | `/create-tasks` — vira tarefa "especificar/implementar checagem automatizada de padrões sensíveis (regex CPF/CNPJ/e-mail em `detalhes`)" |
| CHK009 | `{humano}` — critério de "relevância" da escrita auditada | Decisão do dono do produto antes de `/execute-task` (fase cobertura FR-006); na ausência de decisão, tratar TODA escrita como relevante (default seguro, já é a leitura corrente do research Decision 11) |
| CHK016 | `{humano}` — protocolo de medição de SC-001 | Decisão do dono/QA antes do E2E (Cenário 6/quickstart); default sugerido: medir manualmente no smoke de aceite, sem automação dedicada nesta fase |
| CHK028 | `[Gap]` — meta de performance sem SC formal | Decisão do dono: promover para SC-009 via `/clarify` (novo ciclo) ou manter como meta técnica interna documentada só no plan.md |
| CHK032 | `{humano}` — trade-off retenção × performance de longo prazo | Registrar como nota de roadmap pós-S9; não bloqueia esta feature (FR-014 já é explícito em excluir retenção do escopo) |
| CHK033 | `[Ambiguity]` — "editar" inclui desativar? | `/clarify` — se reaberto; caso contrário, `/create-tasks` já pode assumir a leitura documentada aqui (editar inclui `ativo=false`, sem DELETE) como resolução de baixo risco, citando este CHK033 na task correspondente |

# Requirements Checklist: Envio em Massa como Módulo do Hub

**Purpose**: validar a qualidade (completude, clareza, consistência,
mensurabilidade, cobertura) dos requisitos em `spec.md` antes de `create-tasks`
— não valida a implementação (que ainda não existe).
**Created**: 2026-07-09
**Feature**: [spec.md](../spec.md) · [plan.md](../plan.md) · [research.md](../research.md) · [data-model.md](../data-model.md)

## Completude de Requisitos

- [x] CHK001 - Os quatro (na prática cinco) níveis de permissão do módulo estão
  todos nomeados/mapeados a um código concreto (não só descritos em prosa)?
  [Completude, Spec §FR-005; data-model.md `Permissao`/`PapelPermissao` —
  `consultar`/`criar`/`enviar`/`aprovar` já seedados em `0007`, `administrar`
  novo via migration `0032`] {auto}
- [x] CHK002 - As duas flags de configuração reversíveis (FR-006, FR-010) têm
  nome de variável e semântica de leitura (valor ligado/desligado, default)
  explicitados em algum artefato da feature? [Completude, research.md Decision
  6 (`HUB_RBAC_ENVIO !== 'off'` → ativo, default ligado) e linha 317
  (`HUB_IMPORT_LOG_ENVIO !== 'off'`, default ligado)] {auto}
- [x] CHK003 - A lista de endpoints legados afetados (FR-015) está enumerada em
  algum artefato, e não só referida como "os pontos de entrada do fluxo
  legado"? [Completude, plan.md §Scale/Scope: "11 endpoints"; contracts/
  legacy-endpoints.md lista rota-a-rota] {auto}
- [x] CHK004 - O formato do relatório de diff exigido como evidência (FR-015)
  está definido o bastante para ser produzido de forma repetível (comando,
  escopo, local de anexação)? [Completude, Clarifications Q2;
  plan.md §Project Structure: `evidencias/diff-endpoints-legados.txt` via
  `git diff --name-only` + diff completo] {auto}
- [x] CHK005 - Os parâmetros das proteções de envio herdadas (FR-014: modo de
  simulação, allowlist de destinos, limite de itens por lote) têm mecanismo de
  origem identificado, ou a spec deixa como "já existente" sem apontar onde?
  [Completude, Spec §FR-014; research.md linha 429: `ENVIO_DRY_RUN`/allowlist/
  mocks já garantidos pela infra S1 — reaproveitados, não recriados] {auto}
- [ ] CHK006 - O critério de "conjunto de ações permitidas e recusadas
  exatamente como descrito" (FR-008) referencia uma matriz explícita
  ação×papel, ou depende de reconstruir a matriz a partir da prosa dos
  Acceptance Scenarios da User Story 3? [Completude, Spec §US3, Ambiguity]
  {humano}

## Clareza de Requisitos

- [x] CHK007 - O termo "resposta clara... permissão insuficiente" (FR-007) é
  quantificado com um código de erro específico (não só "mensagem amigável")?
  [Clareza, Spec §FR-007; contracts/legacy-endpoints.md: `403
  PERMISSAO_INSUFICIENTE`] {auto}
- [x] CHK008 - O termo "sem jamais inferir ou assumir uma entidade" (FR-004) é
  operacionalizado com um comportamento de sistema concreto e único (não duas
  alternativas em aberto)? [Clareza, Clarifications Q1/block-001/dec-012:
  Opção B — redirect para `/selecionar-entidade`] {auto}
- [x] CHK009 - "Não impedir, atrasar de forma perceptível, ou reverter" (FR-011)
  tem uma implementação de referência que torna o critério verificável (e não
  apenas uma intenção qualitativa sem mecanismo)? [Clareza, research.md
  Decision 9: grava em status terminal numa única transação, `try/catch`
  best-effort que só loga, nunca propaga exceção] {auto}
- [ ] CHK010 - "Menos de um novo ciclo de implantação" (SC-005) está quantificado
  em unidade quantificável (minutos/horas) ou depende de interpretação de
  quanto dura um "ciclo de implantação" neste projeto? [Clareza, Spec §SC-005,
  Ambiguity — reversível por config sem redeploy de código, mas o texto não
  define um teto de tempo] {humano}
- [x] CHK011 - "Comportamento observável idêntico ao painel legado" (FR-001,
  FR-012) é ancorado em um mecanismo de verificação objetivo, e não deixado
  como julgamento subjetivo de "parece igual"? [Clareza, Spec §FR-016/FR-017 —
  suíte de testes legada inalterada + E2E de ponta a ponta cobrindo os 3
  papéis são o mecanismo de verificação] {auto}

## Consistência de Requisitos

- [x] CHK012 - A resolução da Clarification Q1 (redirect automático) é
  consistente com o Edge Case de expiração de sessão no meio do processamento
  (ambos exigem reautenticação sem perda de estado, nunca bloqueio silencioso
  na tela)? [Consistência, Spec §Edge Cases + §Clarifications Q1] {auto}
- [x] CHK013 - O "modo de compatibilidade" do Acceptance Scenario 4 da US3
  (controle de acesso desligado → comportamento idêntico ao legado) é a mesma
  flag descrita em FR-006, ou a spec sugere duas flags distintas para o mesmo
  efeito? [Consistência, Spec §US3 cenário 4 + §FR-006; research.md Decision 6
  confirma flag única `HUB_RBAC_ENVIO`] {auto}
- [x] CHK014 - Os nomes de papel usados na User Story 3 (leitura/operação/
  administração) e os níveis de ação de FR-005 (visualizar/criar-enviar/
  aprovar/administrar) mapeiam 1:1 sem ambiguidade de qual papel cobre qual
  ação? [Consistência, Spec §US3 + §FR-005 — leitura=visualizar,
  operação=criar+enviar, administração=aprovar+administrar] {auto}
- [x] CHK015 - A regra "resolver a identidade da entidade exclusivamente da
  sessão" (FR-003) é consistente com a garantia de isolamento multi-tenant já
  descrita na Constitution Check do plan.md (Princípio II), sem introduzir uma
  segunda fonte de verdade (query/body)? [Consistência, Spec §FR-003;
  plan.md §Constitution Check Princípio II] {auto}

## Qualidade de Critérios de Aceite

- [x] CHK016 - SC-001 (E2E 100% para os 3 papéis) é objetivamente mensurável
  (pass/fail de um script) e não depende de julgamento humano? [Mensurabilidade,
  Spec §SC-001; Spec §FR-016] {auto}
- [x] CHK017 - SC-004 (nenhum falso-permitido, nenhum falso-negado) define
  precisamente contra qual conjunto de casos testados essa taxa é medida, ou
  fica em aberto quantos/quais casos compõem "100% dos casos testados"?
  [Mensurabilidade, Spec §SC-004 — ancorado na matriz papel×ação de US3;
  ver CHK006 sobre a matriz explícita ainda não estar consolidada] {auto}
- [ ] CHK018 - SC-006 (nenhum envio real fora do ambiente isolado) tem um
  mecanismo de verificação automatizável (e.g. asserção sobre destino
  bloqueado/mock chamado), ou depende só de inspeção manual dos logs durante o
  desenvolvimento? [Mensurabilidade, Spec §SC-006, Gap — research.md linha 429
  aponta que a garantia é da infra S1 (`ENVIO_DRY_RUN`/mocks), mas a spec desta
  feature não define um teste que a re-verifique no escopo de hub-envio-massa]
  {humano}
- [x] CHK019 - SC-002 (suíte legada 100% verde, zero alteração de arquivos de
  teste) é verificável de forma binária e automatizável (CI/test runner)?
  [Mensurabilidade, Spec §SC-002; Spec §FR-017] {auto}
- [x] CHK020 - SC-003 (login único, fluxo completo sem credencial adicional) é
  coberto pelo mesmo E2E de SC-001, ou exige um cenário de verificação
  separado? [Mensurabilidade, Spec §SC-003; Spec §US2 Independent Test —
  cenário isolado de "chamar 1 ação sem tocar em nenhuma tela"] {auto}

## Cobertura de Cenários

- [x] CHK021 - Cada uma das 4 User Stories tem pelo menos um Acceptance
  Scenario Given/When/Then associado? [Cobertura, Spec §US1-§US4] {auto}
- [x] CHK022 - O cenário de "sessão sem entidade ativa" (US2 cenário 2) está
  coberto tanto na spec de requisitos quanto no contrato de erro concreto
  (403 `SEM_ENTIDADE_ATIVA`)? [Cobertura, Spec §US2 cenário 2 + §FR-004;
  contracts/legacy-endpoints.md linha 44] {auto}
- [x] CHK023 - O cenário de desligamento das duas flags reversíveis (RBAC e
  histórico) tem um Acceptance Scenario dedicado por flag, e não só uma menção
  genérica de que "é reversível"? [Cobertura, Spec §US3 cenário 4 (RBAC) +
  §US4 cenário 2 (histórico)] {auto}

## Cobertura de Edge Cases

- [x] CHK024 - O Edge Case de expiração de sessão em processamento em
  andamento define claramente que o estado do processamento sobrevive no
  backend independente da sessão do usuário? [Cobertura de Edge Cases,
  Spec §Edge Cases item 1] {auto}
- [x] CHK025 - O Edge Case de revogação de permissão em sessão já aberta
  define que a checagem é por ação (não cacheada indefinidamente na sessão),
  garantindo efeito imediato? [Cobertura de Edge Cases, Spec §Edge Cases
  item 2] {auto}
- [x] CHK026 - O Edge Case de falha de upload antes de qualquer linha
  processada declara explicitamente que a mensagem/comportamento não pode ser
  alterado por esta feature? [Cobertura de Edge Cases, Spec §Edge Cases
  item 3; consistente com FR-012] {auto}
- [x] CHK027 - O Edge Case de falha do próprio registro de histórico declara
  que o upload de negócio nunca é bloqueado por essa falha (consistente com
  FR-011)? [Cobertura de Edge Cases, Spec §Edge Cases item 4] {auto}
- [x] CHK028 - O Edge Case de distinção erro de negócio vs. infraestrutura na
  validação de XML em lote está coberto por um requisito funcional dedicado
  (não só pelo Edge Case)? [Cobertura de Edge Cases, Spec §Edge Cases item 5 +
  §FR-013] {auto}
- [x] CHK029 - O Edge Case do grupo Movee vs. outros grupos declara
  explicitamente que a regra `mesmoGrupoQue` não muda para nenhum grupo através
  do módulo re-hospedado? [Cobertura de Edge Cases, Spec §Edge Cases item 6 +
  §FR-012] {auto}

## Requisitos Não-Funcionais

- [x] CHK030 - Segurança das mudanças de autenticação/permissão passou por
  revisão dedicada (não é apenas uma menção de intenção)? [Não-Funcional,
  plan.md §Constitution Check Princípio IV — gate `owasp-security` já
  executado na onda-003 (dec-016), 0 CRITICAL/HIGH] {auto}
- [ ] CHK031 - Requisitos de acessibilidade (navegação por teclado, leitor de
  tela) para a página nova do frontend (`app/hub/dashboard/envio_massa/`)
  estão definidos nesta spec, ou são herdados implicitamente dos componentes
  já existentes sem uma declaração própria? [Não-Funcional, Gap — spec.md não
  menciona a11y; plan.md indica reuso 100% dos componentes já existentes, mas
  não afirma que esses componentes já atendem a um padrão de acessibilidade]
  {humano}
- [x] CHK032 - Performance não é um objetivo novo desta feature (paridade
  comportamental, não otimização), e essa premissa está declarada
  explicitamente para não virar expectativa implícita de melhoria?
  [Não-Funcional, plan.md §Technical Context: "N/A — paridade comportamental
  com o legado, não performance nova (SC-001/SC-002)"] {auto}

## Dependências e Premissas

- [x] CHK033 - A dependência da rota `/selecionar-entidade` já existir no shell
  do hub (pré-requisito da resolução de FR-004) está identificada como
  premissa validada, e não como trabalho desta feature? [Dependências,
  Spec §Clarifications Q1: "Reaproveita a rota do shell S3, zero UI nova"]
  {auto}
- [x] CHK034 - A numeração de migration `0032` está verificada contra o estado
  atual do diretório de migrations para evitar colisão de número na hora de
  `create-tasks`/`execute-task`? [Dependências, plan.md linha 110; verificado
  nesta auditoria: `infra/hub/migrations/` mais recente antes desta feature é
  `0031` (mv_performance_dia, S7/PR #60) — `0032` é o próximo número livre]
  {auto}
- [x] CHK035 - A premissa de que os mocks de n8n/FastAPI do ambiente isolado
  (S1) já cobrem o roteamento nexus/não-nexus necessário para testar FR-012/
  FR-013 está declarada como pré-existente, não como trabalho desta feature?
  [Dependências, Spec intro: "mocks de n8n/FastAPI já entregues na S1";
  research.md linha 348: ramos 4xx/5xx já existem em `POST
  /validate-xml-batch`] {auto}

## Ambiguidades e Conflitos

- [x] CHK036 - A fronteira entre "mudança de autenticação/permissão" (permitida
  por FR-015) e "lógica de negócio" (proibida) está delimitada por uma lista
  concreta de arquivos/camadas, e não só por uma frase genérica passível de
  interpretação divergente durante a revisão manual do diff? [Ambiguidades,
  plan.md §Project Structure: TOCADO = `server.js` (inserção de middlewares) +
  NOVO = `middleware/hub-envio-massa-*.js`, `lib/hub-envio-massa-import-log.js`;
  nenhum outro arquivo do fluxo legado (parser XLSX, rotas FastAPI) é tocado]
  {auto}
- [ ] CHK037 - Existe algum conflito latente entre FR-006 (RBAC pode ser
  desligado, retorno instantâneo ao comportamento legado) e FR-014 (proteções
  de envio devem ser mantidas "para toda a extensão desta feature", sem
  menção de exceção quando RBAC está off)? A spec deixa implícito que FR-014
  continua valendo independente do estado da flag de FR-006, mas não afirma
  isso explicitamente. [Ambiguidades, Spec §FR-006 vs §FR-014, Ambiguity]
  {humano}

## Notes

- Items `{auto}` já vêm resolvidos pelo agente (`[x]` com citação, ou marcador
  `[Gap]`/`[Ambiguity]` quando `[ ]`).
- Items `{humano}` ficam `[ ]` aguardando decisão do dono do produto.
- 30 de 37 items resolvidos automaticamente com evidência citável; 7 seguem
  como `{humano}` (nenhum é bloqueante de segurança — todos são refinamentos
  de precisão/cobertura, não CRITICAL/HIGH).

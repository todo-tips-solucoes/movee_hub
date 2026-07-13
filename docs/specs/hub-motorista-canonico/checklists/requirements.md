# Requirements Checklist: Motorista canônico do hub + correções de navegação e filtros

**Purpose**: Validar a qualidade (completude, clareza, consistência, mensurabilidade
e cobertura) dos requisitos em `spec.md`, cruzados com `plan.md`, `research.md`,
`data-model.md`, `contracts/api-motorista-canonico.md` e `quickstart.md` — antes de
`create-tasks`.
**Created**: 2026-07-12
**Feature**: [spec.md](../spec.md)

## Completude de Requisitos

- [x] CHK001 - Todos os 3 workstreams (navegação, busca, motorista canônico) têm FRs
  correspondentes documentados? [Completude, Spec §Requirements FR-001..FR-024] {auto}
  — WS-A→FR-001..005, WS-B→FR-006..010, WS-C→FR-011..022A, confirmado 1:1 contra
  `plan.md` §Summary.
- [x] CHK002 - Existe requisito de auditoria (quem/quando) para toda escrita em
  motorista e credencial? [Completude, Spec §FR-021] {auto} — "para toda criação,
  edição, redefinição de senha ou mudança de situação... quem realizou a ação e
  quando".
- [x] CHK003 - O requisito de permissões (FR-020) cobre separadamente leitura e
  escrita, e as duas ações de escrita (cadastro vs. credencial)? [Completude,
  Spec §FR-020] {auto} — "DUAS permissões granulares separadas... Um usuário pode
  receber uma sem a outra. A leitura... NÃO exige essas permissões".
- [ ] CHK004 - O requisito de "copiável" do identificador único (FR-016) especifica
  o mecanismo esperado (botão de copiar, seleção de texto, ambos)? [Ambiguity,
  Spec §FR-016] {auto} — spec diz apenas "de forma visível e copiável"; nem
  `data-model.md` nem `contracts/api-motorista-canonico.md` detalham o mecanismo de
  cópia. **[Gap]** — deixar para `create-tasks` definir a UI mínima (ex.: ícone de
  copiar) ou tratar como comportamento nativo de seleção de texto (menor esforço).
- [x] CHK005 - Existe requisito de rollback/idempotência para as migrations novas?
  [Completude, Spec §Requirements > Decisões de infraestrutura] {auto} — spec marca
  N/A para infra específica, mas `data-model.md` §Migrations e `research.md`
  Decision 8 cobrem idempotência (`ADD COLUMN IF NOT EXISTS`, `ON CONFLICT DO
  NOTHING`) fora da spec — presente no nível de plano, consistente com
  Constitution V.
- [ ] CHK006 - Há requisito não-funcional de acessibilidade (teclado, leitor de
  tela) para o novo modal de perfil e o combobox de entregador? [Gap, Non-Functional]
  {humano} — nenhuma menção em spec.md/plan.md/research.md a requisitos de
  acessibilidade para `perfil-dialog.tsx`/`entregador-combobox.tsx`. Decisão do
  dono do produto: exigir paridade com os idiomas Base UI já usados (que
  presumivelmente já são acessíveis) ou tratar como fora de escopo desta feature.
- [x] CHK007 - O requisito de rate-limit/anti-abuso do endpoint de busca por nome
  (WS-B) está coberto? [Completude, Research §Decision 3 + S1] {auto} — mitigado
  via limite de 20 resultados + debounce 300ms no front (Decision 3) e
  parametrização (S1); não há requisito de rate-limit dedicado ao endpoint (distinto
  do rate-limit do login do app motorista, que é preservado por S3) — aceitável
  dado o escopo de leitura autenticada e mínimo de 3 caracteres.

## Clareza de Requisitos

- [x] CHK008 - "Página não encontrada" (FR-001) está definido em termos de rota
  concreta e comportamento esperado? [Clareza, Spec §FR-001, Research Decision 1]
  {auto} — research.md ancora a causa raiz (`/hub/dashboard/dashboard` inexistente)
  e a correção concreta (`moduloParaRota` retorna `/hub/dashboard`).
- [x] CHK009 - O termo "janela sobreposta" (FR-003) está quantificado com o
  componente técnico esperado? [Clareza, Spec §FR-003, Plan §Summary] {auto} — plan
  especifica `Dialog` Base UI, reuso do idioma de `motorista-detalhe-dialog.tsx`.
- [x] CHK010 - O mínimo de caracteres para busca por nome está quantificado de
  forma consistente entre spec, contrato e plano? [Clareza, Spec §FR-006, Contract
  §GET /entregadores, Plan §WS-B] {auto} — "mínimo de 3 caracteres" idêntico nos
  três artefatos.
- [x] CHK011 - O limite de resultados da busca por nome está quantificado?
  [Clareza, Spec §FR-007, Contract §Response 200] {auto} — "até 20" (spec) = "até
  **20** itens" (contract).
- [ ] CHK012 - "Formato inválido" do identificador único (FR-013) referencia uma
  definição verificável de formato? [Ambiguity, Spec §FR-013] {auto} — spec diz
  apenas "formato inválido"; `research.md` Decision 5 ancora em `uuidValido`
  (`lib/hub-import-normalizer.js:233`), que não é citado na spec. **[Gap]** — a
  spec por si só não é auto-suficiente para um leitor sem acesso ao research;
  aceitável porque `research.md` é parte do pacote entregue a `create-tasks`, mas
  vale registrar a dependência explícita.
- [x] CHK013 - O prazo de "menos de 3 segundos" (SC-003) está ancorado num
  mecanismo mensurável (debounce, latência de rede)? [Mensurabilidade, Spec §SC-003,
  Plan §Performance Goals] {auto} — plan.md quantifica debounce 300ms como parte do
  desenho que sustenta o SC.

## Consistência de Requisitos

- [x] CHK014 - A independência entre situação do motorista (FR-015) e status da
  credencial (FR-018) é consistente entre spec, research e data-model? [Consistência,
  Spec §FR-015/Clarifications Q3, Research §Decision 6, Data-Model §State
  Transitions] {auto} — os três artefatos afirmam a mesma independência sem
  contradição.
- [x] CHK015 - As DUAS permissões granulares (FR-020) mapeiam 1:1 para as permissões
  citadas em research/data-model (`motoristas.editar` / `motoristas.credencial`)?
  [Consistência, Spec §FR-020, Research §Decision 6, Data-Model §Permissões] {auto}
  — mapeamento idêntico e explícito nos três locais.
- [x] CHK016 - O comportamento de correlação por identificador único quando o
  motorista ainda não existe (edge case + Clarifications) é consistente com FR-014
  e com data-model? [Consistência, Spec §Edge Cases + Clarifications, Data-Model
  §Entity Atividade] {auto} — "fica sem correlação... nunca há criação automática"
  repetido de forma idêntica em Clarifications, Edge Cases e Data-Model.
- [x] CHK017 - A promessa de "produção inalterada" (FR-023/SC-007) é consistente
  entre spec, plan (Constitution Check), research (Decision 7/8) e quickstart
  (Scenario 9)? [Consistência, Spec §FR-023, Plan §Constitution Check, Research
  §Decision 7, Quickstart §Scenario 9] {auto} — os quatro artefatos convergem no
  mesmo mecanismo (condição de ambiente inerte, sem env nova).
- [ ] CHK018 - O contrato de paginação do histórico de atividades (FR-022) resolve
  definitivamente entre cursor e offset/limit, ou mantém as duas opções em aberto?
  [Ambiguity, Spec §FR-022, Contract §GET /motoristas/:id] {auto} — spec diz
  "paginação técnica decidida na fase de plano"; o contrato lista **"cursor/`?offset=&limit=`"**
  como alternativas, sem decidir uma. **[Gap]** — decisão de implementação ainda
  em aberto; deve virar tarefa explícita em `create-tasks` ("decidir mecanismo de
  paginação: offset/limit vs. cursor") antes de codificar o endpoint.

## Qualidade de Critérios de Aceite (mensurabilidade)

- [x] CHK019 - SC-001/SC-002 (navegação/perfil) são binários e objetivamente
  verificáveis? [Mensurabilidade, Spec §SC-001/SC-002] {auto} — "100% das
  tentativas... chegam... sem erro" e "100% dos acessos... exibem... sem sair da
  página" são critérios pass/fail claros, cobertos por Quickstart Scenarios 1-2.
- [x] CHK020 - SC-004 (uuid único e válido) é verificável por consulta direta ao
  banco/constraint? [Mensurabilidade, Spec §SC-004, Data-Model §Entity Entregador]
  {auto} — constraint `UNIQUE (id_empresa, id_externo)` já existente torna o
  critério mecanicamente verificável.
- [ ] CHK021 - SC-005 ("menos de 2 minutos" para cadastrar+conceder credencial) tem
  um método de medição definido (cronômetro manual, telemetria)? [Mensurabilidade,
  Spec §SC-005] {humano} — nenhum artefato define COMO medir os 2 minutos (teste
  manual do QA vs. instrumentação); decisão de processo de validação, não de
  código — fica para o dono do produto/QA decidir o método antes do smoke test.
- [x] CHK022 - SC-006 (100% das atividades correlacionadas) tem cenário E2E
  correspondente? [Cobertura, Spec §SC-006, Quickstart §Scenario 7] {auto} —
  Scenario 7 exercita exatamente esse fluxo (registrar atividade → detalhe →
  correlação por uuid).
- [x] CHK023 - SC-008 (tela legada inalterada) tem verificação explícita além da
  afirmação textual? [Mensurabilidade, Spec §SC-008, Quickstart §Scenario 9] {auto}
  — Scenario 9 item 2 lista explicitamente "tela legada `/dashboard/motoristas`
  inalterada" como expectativa verificável.

## Cobertura de Cenários (E2E quickstart ↔ FR)

- [x] CHK024 - Cada User Story (1-6) tem pelo menos um cenário correspondente em
  `quickstart.md`? [Cobertura, Spec §User Scenarios, Quickstart §Scenarios 1-7]
  {auto} — US1→Scenario1, US2→Scenario2, US3→Scenario3/4, US4→Scenario5,
  US5→Scenario6, US6→Scenario7; mapeamento completo, sem US órfã.
- [x] CHK025 - Existe cenário de roundtrip real backend↔frontend sem mocks (risco
  de contrato divergente)? [Cobertura, Quickstart §Scenario 8] {auto} — Scenario 8
  explicitamente "Sem mock — backend real do hub-homolog", validando os 3
  endpoints principais contra `contracts/api-motorista-canonico.md`.
- [x] CHK026 - Existe cenário dedicado a confirmar a não-regressão em produção?
  [Cobertura, Quickstart §Scenario 9] {auto} — Scenario 9 cobre especificamente
  FR-023/SC-007/FR-024/SC-008.
- [x] CHK027 - O cenário de erro/degradação da busca por nome (FR-010) está coberto
  por um teste dedicado, distinto do happy path? [Cobertura, Quickstart §Scenario
  4] {auto} — Scenario 4 simula 5xx e valida degradação para input numérico.

## Edge Cases

- [x] CHK028 - O edge case "duas planilhas com mesmo identificador em empresas
  diferentes" está resolvido sem ambiguidade quanto ao escopo da unicidade? [Spec
  §Edge Cases, Data-Model §Entity Entregador] {auto} — "identificador é único por
  empresa, não globalmente" == constraint `UNIQUE (id_empresa, id_externo)`.
- [x] CHK029 - O edge case de credencial desativada tentando registrar atividade
  está coberto por um requisito funcional explícito, não só pela narrativa do edge
  case? [Spec §Edge Cases, Contract §PATCH /credencial] {auto} — contrato afirma
  "Motorista com credencial desativada tem o acesso ao app negado antes de
  qualquer atividade".
- [x] CHK030 - O edge case de dados históricos pré-feature (sem uuid correlacionado)
  define claramente que NÃO há reconstrução retroativa? [Spec §Edge Cases] {auto}
  — "sem prometer reconstrução retroativa de dados antigos" é explícito e não
  contradito em nenhum outro artefato.

## Requisitos Não-Funcionais

- [x] CHK031 - Existe requisito de performance quantificado para a busca por nome?
  [Non-Functional, Spec §SC-003, Plan §Performance Goals] {auto} — "< 3s após parar
  de digitar" + debounce 300ms + limite 20 resultados.
- [x] CHK032 - Existe requisito de segurança para armazenamento de senha da
  credencial? [Non-Functional, Data-Model §ContaMotorista.senha, Research §S3]
  {auto} — bcrypt, nunca texto plano, cost >= 12 (mandato S3).
- [ ] CHK033 - Existe requisito de volumetria/escala para o histórico de atividades
  sem limite fixo de período? [Gap, Non-Functional, Spec §FR-022] {humano} — a
  spec explicitamente remove limite de período/quantidade por decisão do
  clarify Q5, mas nenhum artefato define um teto de performance para motoristas
  com histórico muito longo (ex.: milhares de registros) além de "paginação
  técnica" genérica — risco de degradação de UI/API não quantificado; decisão de
  aceitar o risco ou definir um teto fica com o dono do produto.

## Dependências e Premissas

- [x] CHK034 - A dependência entre User Stories (US5/US6 dependem de US4) está
  explícita e é consistente com a ordem de execução do plano? [Dependências, Spec
  §US5/US6 "Why this priority", Plan §Fases A→B→C] {auto} — spec descreve a
  dependência lógica; plan mapeia isso à ordem A(nav)→B(busca)→C(motorista+
  credencial+atividades), com C internamente sequenciado (cadastro antes de
  credencial antes de atividades).
- [x] CHK035 - As decisões já fechadas pelo operador (D-A0..D-C7) são referenciadas
  de forma rastreável, evitando reabertura na pipeline? [Dependências, Plan
  §Summary, Research (D-A0, D-A1, D-B1, D-C0, D-C1..D-C7)] {auto} — plan.md linha 6
  afirma explicitamente "a pipeline NÃO as reabre"; cada decisão do research.md
  cita o código `D-Xn` correspondente.
- [x] CHK036 - A premissa de que a infraestrutura de busca (unaccent/pg_trgm/
  hub_normaliza_nome) já existe está verificada, não presumida? [Assumption,
  Research §Decision 3] {auto} — research cita migration 0021 e índice trgm
  existentes como evidência, não presunção.

## Ambiguidades e Conflitos (open)

- [ ] CHK037 - [Ambiguity] Mecanismo de "copiável" do identificador único (FR-016)
  não especificado — ver CHK004. {humano}
- [ ] CHK038 - [Ambiguity] Mecanismo de paginação do histórico de atividades
  (cursor vs. offset/limit) não decidido — ver CHK018. {humano}
- [ ] CHK039 - [Gap] Requisito de acessibilidade para modal de perfil e combobox
  não especificado — ver CHK006. {humano}
- [ ] CHK040 - [Gap] Método de medição de SC-005 (2 minutos) não definido — ver
  CHK021. {humano}

## Notes

- Items `{auto}` já vêm resolvidos pelo agente (`[x]` com citação, ou marcador
  `[Gap]`/`[Ambiguity]`).
- Items `{humano}` ficam `[ ]` aguardando decisão do dono do produto.
- 4 gaps/ambiguidades reais identificados (CHK004/CHK006/CHK018/CHK021/CHK033,
  consolidados em CHK037-040): nenhum bloqueia P1-P2 (WS-A/WS-B); todos tocam
  WS-C (P3-P5) e podem ser resolvidos como tarefas de definição em
  `create-tasks` sem novo ciclo de `clarify` — são detalhes de UI/processo, não
  ambiguidades de requisito de negócio.

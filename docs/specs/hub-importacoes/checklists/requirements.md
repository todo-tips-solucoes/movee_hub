# Requirements Checklist: hub-importacoes (S4 — Pipeline de Importações)

**Purpose**: Quality gate sobre spec.md/plan.md/research.md/data-model.md/
contracts/quickstart.md antes de `/create-tasks`. Foco: completude, clareza,
consistência cross-artefato (spec ↔ plan ↔ data-model ↔ contracts ↔ estado real
do repo), cobertura de cenários/edge cases, requisitos não-funcionais
(segurança/LGPD/limites) e premissas.
**Created**: 2026-07-07
**Feature**: [spec.md](../spec.md) · [plan.md](../plan.md) · [research.md](../research.md) · [data-model.md](../data-model.md) · [contracts/importacoes-api.md](../contracts/importacoes-api.md) · [quickstart.md](../quickstart.md)

## Completude de Requisitos

- [x] CHK001 - Todos os FRs (001-026 + infra 027/028) têm cobertura explícita no
  plano por fases (migrations → parser → upload → processamento → endpoints →
  telas → E2E)? [Completude, Spec §FR-001-028, plan.md §Plano por fases] {auto}
- [x] CHK002 - Todas as 7 ações restritas por permissão do FR-021 (enviar,
  listar, detalhe, erros, baixar original, reprocessar, cancelar) têm um
  endpoint correspondente no contrato? [Completude, Spec §FR-021, contracts/importacoes-api.md] {auto}
- [x] CHK003 - As 5 Key Entities da spec têm mapeamento 1:1 para uma migration
  nomeada (Pessoa Entregadora→0010, Importação→0011, Erro de Linha→0012,
  Lançamento Faturamento→0013, Turno Performance→0014)? [Completude, Spec §Key Entities, data-model.md] {auto}
- [ ] CHK004 - Existe um teste unitário dedicado para a máquina de
  estados/lock/rollback de `hub-import-processor.js`, ou a cobertura fica só no
  teste de integração (`hub-importacoes.test.js`)? A árvore do plano lista
  `hub-import-parser.test.js` e `hub-import-normalizer.test.js` como unit, mas
  nenhum `hub-import-processor.test.js`. [Completude, plan.md §Project Structure] {humano}
- [x] CHK005 - O resumo de Auditoria (FR-022) é gerado para toda importação,
  incluindo as ações de reprocessar/cancelar, ou só para a criação? O contrato
  só menciona `Auditoria(acao='importacao.criada')` no POST de upload; não há
  menção equivalente em `POST .../reprocessar` nem `POST .../cancelar`.
  [Gap, Spec §FR-022, contracts/importacoes-api.md] {auto} → `/create-tasks`
  deve incluir tarefa explícita de auditar reprocessar/cancelar/download-original.
- [ ] CHK006 - SC-007 (preservação de identidade visual/branding/dark-light)
  tem um cenário de verificação dedicado no quickstart, ou fica implícito na
  fase 7 ("coletar evidências")? Nenhum dos 10 cenários de quickstart.md testa
  branding/tema explicitamente. [Gap, Spec §SC-007, quickstart.md] {auto} →
  `/create-tasks` deve incluir evidência de branding/dark-light na fase 7 (E2E).

## Clareza dos Requisitos

- [ ] CHK007 - FR-018 exige que o cancelamento "surta efeito em um intervalo
  curto" — esse intervalo está quantificado em algum artefato (spec, plan,
  research)? Não encontrado; plan.md define timeout de importação=120s
  (parâmetro diferente: falha por travamento, não responsividade de cancelamento)
  mas não define a latência máxima entre lotes para o cancelamento surtir
  efeito. [Ambiguity, Spec §FR-018] {humano} → decidir se lote=500 já é
  latência aceitável ou se precisa de um teto explícito (ex.: sub-lotes menores).
- [x] CHK008 - A faixa aceitável do campo `atingido` (FR-024, "faixa
  documentada pela origem") está quantificada concretamente? Sim — data-model.md
  define `numeric(8,2)`, faixa 0–1000, herdada da decisão já ratificada (D4).
  [Clareza, Spec §FR-024, data-model.md Entity FaturamentoLancamento] {auto}
- [x] CHK009 - Os dois dialetos numéricos (FR-007) estão descritos sem
  ambiguidade sobre qual tipo usa qual convenção? Sim — research.md Decision 3
  é explícito: faturamento=vírgula, performance=ponto, com exemplos e
  contraexemplo do risco de heurística de sniffing. [Clareza, Spec §FR-007, research.md Decision 3] {auto}

## Consistência (spec ↔ plan ↔ data-model ↔ contracts ↔ repositório)

- [x] CHK010 - A numeração de migrations proposta (0010–0016) é consistente com
  o estado real do repositório (última migration aplicada)? Verificado:
  `infra/hub/migrations/` vai até `0009_rls_hardening_indices.sql`; 0010 é o
  próximo número livre, sem gap. [Consistência, research.md Decision 1] {auto}
- [x] CHK011 - Os códigos de permissão usados em data-model.md/contracts
  (`importacoes.consultar`/`criar`) correspondem aos códigos reais já semeados
  em `0007_seed_papeis_permissoes_modulos.sql`? Verificado por grep linha a
  linha — batem exatamente. [Consistência, research.md Decision 2, infra/hub/migrations/0007] {auto}
- [x] CHK012 - O nome da nova permissão `importacoes.exportar` (seed 0016)
  segue o mesmo padrão de nomenclatura `<modulo>.exportar` já usado para outros
  módulos? Verificado: `motoristas.exportar`, `faturamento.exportar`,
  `performance.exportar` já existem em 0007 — `importacoes.exportar` é
  consistente com o padrão estabelecido. [Consistência, data-model.md §Migration 0016] {auto}
- [ ] CHK013 - FR-019 exige que a segunda submissão concorrente vire um "estado
  de espera visível" e que "o conjunto ordenado de estados de FR-006 MUST
  incluir esse estado de espera". research.md Decision 5 resolve isso
  **reaproveitando** o status `pending` (sem estado dedicado tipo
  `aguardando`/`queued`) — o mesmo valor que uma importação recém-criada tem
  antes de começar a validar. Isso distingue visualmente, no histórico, uma
  importação "prestes a começar" de uma "esperando lock de outra em
  andamento"? [Ambiguity, Spec §FR-019, research.md Decision 5, data-model.md
  Entity ImportacaoArquivo] {humano} → decidir se a UI precisa de um sinal
  adicional (ex.: mensagem/tooltip) para diferenciar os dois casos de `pending`.
- [x] CHK014 - A diferença de nome de coluna entre os dois tipos de arquivo
  (`subpraca` sem underscore em faturamento vs `sub_praca` com underscore em
  performance) está documentada de forma que não seja confundida como erro de
  digitação? Sim — repetida consistentemente em data-model.md (ambas colunas)
  e research.md Decision 3. [Consistência, data-model.md] {auto}
- [x] CHK015 - Os mecanismos de deduplicação citados em FR-004 (arquivo) e
  FR-012 (linha) têm constraint física 1:1 no data-model? Sim —
  `UNIQUE(id_empresa,tipo,hash_sha256)` em ImportacaoArquivo e
  `UNIQUE(id_empresa,hash_linha)` em ambas as tabelas de fato.
  [Consistência, Spec §FR-004/FR-012, data-model.md] {auto}
- [x] CHK016 - FR-005 proíbe usar o nome do arquivo como identificador
  endereçável — o esquema de armazenamento (Decision 8: `uploads/importacoes/<id>`)
  usa o id numérico, não o nome enviado? Sim, consistente.
  [Consistência, Spec §FR-005, research.md Decision 8] {auto}
- [x] CHK017 - A proteção contra CSV injection exigida em FR-016 ("protegido
  contra execução de comandos ocultos") está detalhada com a regra exata
  (prefixo `'` em células iniciadas por `= + - @`) no contrato? Sim.
  [Consistência, Spec §FR-016, contracts/importacoes-api.md GET .../erros] {auto}
- [x] CHK018 - FR-015/FR-023 proíbem expor valor bruto com dado pessoal — a
  coluna `valor_mascarado` em ImportacaoLinhaErro é o único campo de valor
  exposto (sem coluna paralela de valor bruto na mesma tabela)? Sim, confirmado
  no data-model.md. [Consistência, Spec §FR-015/FR-023, data-model.md Entity ImportacaoLinhaErro] {auto}
- [x] CHK019 - US4 cenário 5 (consultar sem exportar deve recusar o download do
  original) tem uma permissão distinta de fato modelada, e não uma reutilização
  de `consultar`? Sim — `importacoes.exportar` é uma permissão nova e
  distinta, testada no quickstart Cenário 7. [Consistência, Spec §US4 cenário 5, contracts, quickstart.md Cenário 7] {auto}
- [x] CHK020 - FR-026 exige que o fluxo de envio em massa existente não mude de
  comportamento — o valor `envio_massa` incluído desde já no CHECK de `tipo`
  em ImportacaoArquivo é apenas reserva de valor (sem rota/lógica tocando-o
  nesta fase)? Confirmado — data-model.md anota "usado na S8" e nenhuma fase
  do plano cria rota para esse tipo. [Consistência, Spec §FR-026, data-model.md Entity ImportacaoArquivo] {auto}
- [ ] CHK021 - GET /importacoes/:id/original não documenta o comportamento
  quando o arquivo físico originalmente retido não está mais disponível (edge
  case explícito da spec: "a pessoa deve receber uma mensagem de erro clara").
  O contrato só define `200`/`403`; nenhum código para arquivo ausente.
  [Gap, Spec §Edge Cases, contracts/importacoes-api.md GET .../original] {auto}
  → `/create-tasks` deve adicionar um código de erro explícito (ex.: `410`/`500`
  com mensagem clara) a essa rota.

## Cobertura de Cenários e Edge Cases

- [x] CHK022 - O edge case "sessão expira durante acompanhamento" está coberto
  pela arquitetura (polling stateless via `GET /importacoes/:id` com JWT
  renovado, sem afinidade de sessão ao processamento em background)? Sim — o
  desenho é inerentemente stateless (auth por cookie recarregado a cada poll,
  processamento no backend independente de quem o disparou), então não exige
  cenário de teste dedicado. [Cobertura, Spec §Edge Cases, plan.md Technical Context Auth] {auto}
- [x] CHK023 - O edge case "cancelar importação que já terminou entre clique e
  processamento do pedido" tem resposta definida sem estado inconsistente?
  Sim — contrato define `409 CONFLITO` se já terminal.
  [Cobertura, Spec §Edge Cases, contracts/importacoes-api.md POST .../cancelar] {auto}
- [x] CHK024 - O edge case "isolamento entre entidades no histórico/detalhes"
  tem cenário de teste dedicado? Sim — quickstart Cenário 8 (multi-tenant, RLS
  + filtro backend). [Cobertura, Spec §Edge Cases, quickstart.md Cenário 8] {auto}
- [x] CHK025 - O edge case "linha sem identificador de pessoa quando o tipo
  permite" (ex.: bônus agregado de faturamento) é modelado com um campo
  próprio, não apenas "ignorado"? Sim — `entregador_id NULL` +
  `recebedor_agregado` em FaturamentoLancamento.
  [Cobertura, Spec §Edge Cases, data-model.md Entity FaturamentoLancamento] {auto}
- [x] CHK026 - O edge case "valor novo em campo de classificação conhecido"
  (categoria/tipo inédito) resulta em aviso (linha válida), não rejeição? Sim
  — research.md Decision 7 confirma explicitamente (warning, não erro, sem
  superfície própria nesta fase, conforme Clarify Q5). [Cobertura, Spec §Edge Cases + FR-009, research.md Decision 7] {auto}
- [x] CHK027 - O edge case de ZIP malicioso (múltiplos arquivos, path
  traversal, zip bomb) tem validação explícita antes de qualquer extração
  completa? Sim — FR-003 + fluxo de validações imediatas do contrato POST
  /importacoes. [Cobertura, Spec §FR-003, contracts/importacoes-api.md POST /importacoes] {auto}
- [x] CHK028 - O cenário de concorrência (duas submissões simultâneas do mesmo
  tipo+entidade) tem teste dedicado que confirma "sem rejeição, com espera
  automática"? Sim — quickstart Cenário 9. [Cobertura, Spec §Edge Cases + FR-019, quickstart.md Cenário 9] {auto}
- [x] CHK029 - O critério ">50% inválidas → falha total, rollback" tem cenário
  de teste que confirma zero linhas persistidas mesmo para os fatos já
  inseridos antes do limiar ser atingido? Sim — quickstart Cenário 5 +
  research.md Decision 7 (rollback do que já foi inserido, filtro por
  `importacao_id`). [Cobertura, Spec §FR-014, quickstart.md Cenário 5, research.md Decision 7] {auto}

## Requisitos Não-Funcionais (Segurança, LGPD, Limites)

- [x] CHK030 - RLS está habilitado e com policy consistente nas 5 tabelas
  novas, incluindo a denormalização de `id_empresa` na tabela de erro (que só
  tinha `importacao_id` no catálogo original)? Sim — Migration 0015 cobre as 5
  tabelas; Decision 4 justifica a denormalização como reforço, não enfraquecimento,
  do Princípio II. [NFR-Segurança, data-model.md Migration 0015, research.md Decision 4] {auto}
- [x] CHK031 - O plano documenta explicitamente o passo de GRANT +
  `SIGUSR1`/reload do PostgREST por tabela nova (gotcha conhecido do hub)? Sim
  — plan.md "Plano por fases" item 1 e Technical Context (linha Migrations).
  [NFR-Operação, plan.md §Plano por fases] {auto}
- [x] CHK032 - As regras de LGPD (seeds anonimizados em homolog, CSV real só em
  sandbox context-mode, valor mascarado nunca bruto) estão documentadas de
  forma acionável para quem for implementar/testar? Sim — research.md
  Decision 8 e o cabeçalho do quickstart.md repetem a regra.
  [NFR-LGPD, Spec §FR-023, research.md Decision 8, quickstart.md] {auto}
- [x] CHK033 - Os limites numéricos (20 MB upload, 100 MB ZIP descomprimido,
  lote 500, 50% de threshold de falha, timeout 120s) estão todos centralizados
  numa única fonte de referência para evitar drift entre migrations/backend/
  frontend? Sim — plan.md Technical Context "Limites (§12)" é citado como
  fonte única, referenciando §12 do plano técnico mestre.
  [NFR-Limites, plan.md Technical Context] {auto}
- [x] CHK034 - O contrato define uma taxonomia de erro única e reutilizada
  entre endpoints (401/403/404/409/422), evitando que cada rota invente seu
  próprio formato? Sim — "Códigos de erro padrão do hub" declarado no topo do
  contrato e reusado em cada endpoint. [NFR-Consistência, contracts/importacoes-api.md] {auto}

## Dependências e Premissas

- [x] CHK035 - As dependências de infraestrutura que o plano assume como
  "reusar sem modificação" (`hub-postgrest.js`, `hub-postgrest-jwt.js`,
  `hub-require-permission.js`, `hub-rbac-cache.js`, `hub-auditoria.js`,
  `use-process-status`, `data-table`, `filters`) existem de fato no
  repositório, sem exigir extensão de claims/assinatura? Verificado — todos os
  9 módulos citados existem hoje em `app_homologacao/backend/lib|middleware/`
  e `app_homologacao/frontend_v2/hooks|components/`.
  [Premissa, plan.md §Project Structure] {auto}
- [x] CHK036 - O uso de `pg_try_advisory_lock` (Decision 5) é um padrão novo
  neste código-base (nenhuma ocorrência anterior encontrada em
  `app_homologacao/backend/` ou `infra/hub/`) — a equipe validou que o pool de
  conexões do backend/PostgREST sustenta uma sessão dedicada durante o
  processamento síncrono (o lock advisory libera ao fim da sessão Postgres, não
  da transação)? **Resolvido em execute-task (dec-030..033, commit
  `c37a9ba`)**: `hub-postgrest.js` é HTTP stateless (sem pool `pg` direto no
  backend) — `pg_try_advisory_lock` não sustentaria sessão entre chamadas.
  Substituído por índice único parcial em `ImportacaoArquivo(id_empresa,
  tipo) WHERE status IN ('validating','processing')`, mesmo contrato
  funcional, documentado como ADENDO em `research.md` Decision 5 e
  `data-model.md`. Confirmado funcionalmente pelo Cenário 9 (concorrência),
  ver `docs/plans/hub-frota/evidencias/S4/cenarios-1-10-resultado.md`.
  [Assumption, research.md Decision 5] {humano→resolvido}
- [x] CHK037 - A decisão de não introduzir fila (Decision 10) declara o
  gatilho objetivo para reconsiderar (>50k linhas ou timeout de request), que é
  mensurável e não subjetivo? Sim.
  [Premissa, research.md Decision 10] {auto}

## Ambiguidades e Conflitos

- [x] CHK038 - Existem marcações `NEEDS CLARIFICATION` pendentes em algum
  artefato? Não — plan.md Technical Context confirma "0" e research.md resolve
  as 10 decisions sem deixar unknowns em aberto.
  [Ambiguity, plan.md Technical Context] {auto}
- [x] CHK039 - A decisão de negócio intencionalmente indefinida (D4:
  `atingido`/`margem_fee`) está claramente marcada como "não reabrir" em todos
  os artefatos que a tocam (spec, research, data-model), evitando que uma fase
  futura de `/clarify` tente reabri-la por engano? Sim — spec.md tem bloco
  dedicado no topo, research.md Decision 3 cita "D4 ratificado", data-model.md
  cita "(D4, sem interpretar)" na coluna `atingido`.
  [Consistência, Spec §Decisão já ratificada, research.md Decision 3, data-model.md] {auto}

## Notes

- Items `{auto}` já vêm resolvidos pelo agente (`[x]` com citação, ou marcador
  `[Gap]`/`[Ambiguity]`/`[Assumption]`). Items `{humano}` ficam `[ ]`
  aguardando decisão do dono do produto.
- **Gaps que viram tarefa em `/create-tasks`**: CHK005 (auditoria de
  reprocessar/cancelar), CHK006 (evidência de branding/dark-light no E2E),
  CHK021 (código de erro explícito para arquivo original ausente).
- **Ambiguidades que ficam para decisão humana antes de `/execute-task`**:
  CHK004 (cobertura de teste unitário do processor), CHK007 (SLA de
  responsividade do cancelamento), CHK013 (sinalização visual de "espera por
  lock" vs "pending inicial"), CHK036 (validação de sustentação do advisory
  lock pelo pool de conexões).
- Marcar items concluídos com `[x]`. Numerados sequencialmente para referência
  (CHK001–CHK039).

# Relatório de Status das Tarefas — hub-motorista-360

**Data:** 2026-09-04
**Projeto:** hub-motorista-360 (dentro do monorepo movee_hub / envioMassa_homologacao)
**Tipo:** Misto (SQL/migrations + backend Express + frontend Next.js + infra systemd)
**Arquivo de Tarefas:** `docs/specs/hub-motorista-360/tasks.md`
**Onda de fechamento:** onda-018 (execute-task) → onda-019 (review-task, esta)
**Diretório de trabalho:** `/root/work/hub-motorista-360` (worktree, branch `feature/hub-motorista-360`) —
`/var/lib/envioMassa_homologacao` (diretório vivo) confirmado em `main`, intocado.

---

## Resumo Executivo

| Métrica | Valor |
|---------|-------|
| Total de Tarefas (nível N.M) | 22 |
| Total de Subtarefas (checkboxes) | 97 |
| Concluídas | 97 (100%) |
| Finalizadas Nesta Sessão (onda-018) | 2 (2.2.4, 2.4.3) |
| Em Progresso | 0 |
| Pendentes | 0 |
| Bloqueadas | 0 |
| Criticidade | 7 `[C]` / 12 `[A]` / 3 `[M]` (nível tarefa) |
| Gate `convergence` (execute-task→review-task) | **0 achados** — feature convergida (dec-092) |

Backlog **100% fechado (97/97)**. Nenhuma tarefa pendente, bloqueada ou em progresso.

---

## Tarefas Finalizadas Nesta Sessão (onda-018)

### 2.2.4 — Teste automatizado da RPC `hub_motoristas_candidatos_por_conta` (migration 0058)

Deferida na FASE 2 (onda-010) por falta de caller real. Retomada porque o hook automático
da FASE 3 (`vincularAutomaticamente`, task 3.1.2) agora é caller de fato.

- **Padrão adotado**: chamada DIRETA ao PostgREST (bypass do Express, JWT sintético via
  `lib/hub-postgrest-jwt.js`) — mesma técnica de `hub-rls-integration.sh` — porque esta RPC,
  ao contrário da 0023 (`hub_motoristas_candidatos`, exposta via `GET /motoristas/:id/sugestoes`),
  não tem endpoint HTTP passthrough.
- **Onde**: acrescentado a `infra/hub/testes/hub-motorista-360-integration-homolog.sh`
  (já roda no `hub-homolog` persistente; sem stack Docker nova).
- **Evidência (output literal, hub-homolog real)**:
  ```
  PASS: RPC 0058: POST direto no PostgREST -> 200
  PASS: RPC 0058: candidato A (nome idêntico, sim=1.0) presente
  PASS: RPC 0058: candidato B (sim~0.46, acima do piso) presente
  PASS: RPC 0058: candidato C (sim~0.017, abaixo do piso 0.3) EXCLUÍDO
  PASS: RPC 0058: candidato D (fora de EmpresaGrupoMovee, mesmo com a empresa no escopo do JWT) EXCLUÍDO — prova o JOIN da própria RPC
  PASS: RPC 0058: resultado ordenado por similaridade DESC (A antes de B)
  ```
  Similaridades medidas via `similarity(hub_normaliza_nome(...))` real antes de fixar os
  fixtures: 1.0 / 0.459 / 0.017.
- **Ação**: `tasks.md` marcado `[x]`.

### 2.4.3 — Teste do perímetro RBAC do papel `robo_entrego_servico`

Deferida na FASE 2 (onda-010) por falta de rotas reais. Retomada porque as rotas de fila
(FASE 5) existem desde a FASE 8.

- **Onde**: mesmo script acima, reusando o login `robo_entrego_servico` que o Scenario 5/6
  já fazia.
- **Evidência (output literal)**:
  ```
  PASS: GET /robo-entrego/motoristas-para-enriquecer (robo, tem enriquecimento.consultar) -> 200 (alcança)
  PASS: GET /motoristas/:id (robo, SEM motoristas.consultar) -> 403 (não alcança)
  PASS: GET /motoristas/:id/sugestoes (robo, SEM motoristas.editar) -> 403 (não alcança)
  PASS: POST /motoristas (robo, SEM motoristas.editar) -> 403 (não alcança)
  ```
  (`PATCH .../entrego-enriquecimento` → 200, permissão `.atualizar`, já estava coberto pelo
  Scenario 5/6 pré-existente — não duplicado.)
- **Ação**: `tasks.md` marcado `[x]`.

### Achado colateral corrigido no mesmo run

1 assertion **pré-existente** e desatualizada no mesmo script (`hub-motorista-360-integration-homolog.sh`,
FASE 8): `leitura: has(entregoEnriquecimento.documentos.cnh)=true (nunca sensível)` — escrita
antes da task 8.3 (dec-087, 2026-09-04) mover CNH para o grupo de campos sensíveis. O primeiro
run desta onda a pegou como FAIL real (comportamento correto, assertion errada). Corrigida
para `=false (sensível desde dec-087)`. Rerun completo: **0 falhas** (46 asserts).

**Verificação após as correções**:
- `node --test tests/hub-motorista-360-integration.test.js` → **1/1 PASS**
- Driver `.sh` direto → **`HUB-MOTORISTA-360-INTEGRATION-HOMOLOG: OK (0 falhas)`**
- Sem resíduo sintético pós-cleanup (`SELECT count(*) ... WHERE nome LIKE 'E2E360%'` → 0/0)
- `package-lock.json` (backend/frontend_v2) **intacto** (`git status --porcelain` vazio para os dois)

---

## Gate `convergence` (execute-task → review-task) — incondicional

Executado nesta onda (18 pares path/origin extraídos de `tasks.md`+`plan.md`, FASES 1-8 + FR-009,
todos resolvidos e lidos). **0 achados acionáveis** (missing: 0, partial: 0, contradicts: 0,
unrequested: 0). `dec-038` (retenção) foi verificado como **explicitamente fora de escopo de
código** pela própria `spec.md` (FR-017/FR-020: "nenhuma tarefa desta feature MUST implementar
expurgo, TTL, job de limpeza ou anonimização") — não é um gap, é dívida deliberada (ver seção
"Dívidas e itens em aberto" abaixo). Nenhuma fase nova apendada a `tasks.md`.

Decisão registrada: `dec-092` (score 3). `record-skill` confirmado no roster da onda-018.

---

## Progresso por Fase

| Fase | Total | Concluídas | % |
|------|-------|------------|---|
| 1 — Fundação de Requisitos (checklist de segurança) | 19 | 19 | 100% |
| 2 — Migrations e RBAC (banco) | 13 | 13 | 100% |
| 3 — Backend: Vínculo automático de credencial | 15 | 15 | 100% |
| 4 — Backend: CNPJ do legado na tela | 4 | 4 | 100% |
| 5 — Backend: Enriquecimento EntreGô sob demanda | 22 | 22 | 100% |
| 6 — Robô EntreGô: rotina semestral | 4 | 4 | 100% |
| 7 — Frontend: tela de detalhe do motorista | 8 | 8 | 100% |
| 8 — Testes de integração e E2E | 12 | 12 | 100% |

---

## Selecao de modelo por subagente (model-routing)

| subagent_type | etapa | onda | modelo | score | fallback |
|---------------|-------|------|--------|-------|----------|
| feature-00c-clarify-asker | clarify | onda-002 | manter-atual | 0 | no |
| feature-00c-clarify-answerer | clarify | onda-002 | manter-atual | 0 | no |

**Sumario**:
- Total: 2
- haiku: 0
- sonnet: 0
- opus: 0
- manter-atual: 2
- fallback-default: 0 (0%)

## Selecao de modelo por onda (sugerido vs aplicado)

| onda | etapa | sugerido | aplicado | origem | divergente |
|------|-------|----------|----------|--------|------------|
|  | specify | sonnet | sonnet | mapa | no |
| onda-001 | clarify | sonnet | sonnet | mapa | no |
| onda-002 | clarify | sonnet | sonnet | mapa | no |
| onda-004 | plan | opus | opus | mapa | no |
| onda-006 | checklist | sonnet | sonnet | mapa | no |
| onda-008 | execute-task | sonnet | sonnet | mapa | no |
| onda-009 | execute-task | sonnet | sonnet | mapa | no |
| onda-010 | execute-task | sonnet | sonnet | mapa | no |
| onda-011 | execute-task | sonnet | sonnet | mapa | no |
| onda-012 | execute-task | sonnet | sonnet | mapa | no |
| onda-013 | execute-task | sonnet | sonnet | mapa | no |
| onda-014 | execute-task | sonnet | sonnet | mapa | no |
| onda-016 | execute-task | sonnet | sonnet | mapa | no |

**Sumario por onda**:
- Total de ondas roteadas: 13
- aplicado haiku/sonnet/opus/manter-atual: 0/12/1/0
- origem mapa/refino/override-operador/fallback: 13/0/0/0
- fallback (manter-atual): 0 (0%)
- override do operador: 0 (0%)
- divergencias sugerido!=aplicado: 0 (rotuladas: 0, sem rotulo: 0)

*("sem rótulo" = 0 → nenhuma divergência não-auditada, SC-006 saudável. Seção "Consumo x
roteamento por onda" omitida: `wave-usage-report.sh` retorna `coverage_pct=0%`/tokens `null`
em todas as ondas — métrica de consumo nunca foi coletada nesta execução, não é uma falha
desta onda.)*

---

## Auditoria `.tasks[]` ↔ `tasks.md` (reconcile-tasks, §4.6)

- **Divergência detectada** (antes do back-fill): 4 tarefas concluídas ausentes de `.tasks[]`
  — `7.1`, `7.2`, `8.1`, `8.2`. Finding `task-outcome-nao-gravado`: o orquestrador pulou o
  `record-task` ao vivo nessas ondas (FASE 7/8, execuções anteriores a esta sessão).
- **Sanado**: back-fill determinístico rodado (`--if-absent`, não sobrescreve entradas reais).
  `.tasks[]` foi de 41 → 45 entradas.
- **Origem das entradas**: 41 `execute-task` (gravadas ao vivo) + 4 `reconcile` (back-filled
  agora) = 45.
- **Nota de granularidade** (informativa, não é gap): `.tasks[]` desta execução mistura
  granularidade nível-tarefa (`N.M`, ex. `7.1`) e nível-subtarefa (`N.M.K`, ex. `2.2.1`) —
  histórico de ondas diferentes gravaram em níveis diferentes. Os 45 registros cobrem mais
  do que as 22 tarefas de nível `N.M`; nenhuma tarefa concluída ficou de fora do conjunto
  união. Não bloqueia a ingestão (`recall.sh` lê `.tasks[]` tal-e-qual).
- Half-records de `model-routing` (`state-decisions-reconcile.sh check`): **0** — saudável.

---

## Dívidas e itens em aberto (honestidade > celebração)

Esta feature fecha 97/97 tasks, mas **não está "terminada" no sentido de nada restar** —
os itens abaixo são deliberados, documentados, e não escondidos:

### 1. Retenção de dados pessoais — dec-038 / CHK019 — **NÃO RESOLVIDO**
`dados_entrego_json` (payload enriquecido da EntreGô: nome, CNH/RG, contato de emergência)
**não tem prazo de retenção nem base legal definidos**. `CHK019` (`checklists/security.md`)
permanece **`[ ]` intencionalmente** — decisão adiada para o jurídico/DPO, não é auto-marcável
pelo agente (item `{humano}`). `FR-017`/`FR-020` proíbem qualquer expurgo/TTL/anonimização
automáticos até essa decisão existir — **nenhum foi implementado**, e nenhum deve ser até lá.
O gate `convergence` confirmou isso como escopo explicitamente excluído, não um gap.

### 2. Timers systemd de enriquecimento — entregues, **NÃO instalados**
`infra/robo-entrego/entrego-enriquecimento-sob-demanda.{timer,service}` e
`infra/robo-entrego/entrego-enriquecimento-semestral.{timer,service}` existem como artefato
gerado (`scripts/gerar-timer.sh`) + runbook (`README.md`). A instalação em
`/etc/systemd/system` + `systemctl enable --now` é **ato manual do operador** (rito de
produção) — esta pipeline nunca executa isso.

### 3. Migrations 0057/0058/0059 + script SQL do robô (003) — **só em hub-homolog isolado**
Aplicadas e testadas em `hub-homolog` (confirmado via `SchemaMigration` nesta sessão).
**Produção (`chatmasterveloz`) não foi tocada** — aplicar lá é rito de produção
(migration → operador roda os passos de banco; agente nunca tem acesso de escrita a
`pgadmin_db`), fora do escopo desta pipeline.

### 4. `ACHADOS-PORTAL.md` §9.5 item 3 (payload de forma variável)
`docs/plans/robo-entrego/ACHADOS-PORTAL.md` §9.5.3 registra, medido com 2 motoristas reais
em 2026-09-04: o payload da API da EntreGô tem **forma variável** — `personalData.fatherName`
("Nome do pai"), `documentDriver.rg`/`.cnh` e as fotos de documento aparecem ou somem conforme
o modal (`BICYCLE` vs `MOTORCYCLE`) e o tipo de documento da pessoa. Nenhuma chave de
`documentDriver` pode ser tratada como garantida. O parsing do hub (`lib/hub-motoristas-dto.js`,
handler de enriquecimento) já foi construído com acesso opcional a esses campos — consistente
com o achado, mas vale registrar que o achado em si vem de uma amostra de 2 casos reais, não
de um levantamento exaustivo de todos os modais possíveis.
Itens que seguem **⚠️ NÃO VERIFICADO** no mesmo documento (pré-existentes, fora do escopo desta
feature, mas relevantes por serem a mesma cadeia de dependência do robô EntreGô): duração real
da sessão do portal (§7), comportamento sob volume alto (§6), e 2 itens do filtro de relatório
("Pedidos pagos em Dinheiro"/"Pedidos extraviados", §2). Nenhum bloqueia hub-motorista-360.

### 5. Endpoint da EntreGô (§9.3) — mudança de status: de proposta para fato medido
Diferente de outros endpoints do research.md ainda marcados `[PROPOSTA]`, o endpoint
`GET .../drivers/{uuid}` (e a busca `POST .../drivers/search`) está **medido e confirmado**:
status 200/201 reais, testado no portal ao vivo em 2026-09-04. Registrando aqui a transição
de status para não ficar só implícito no doc de pesquisa.

### 6. Nada foi pushed, mergeado ou deployado
Branch `feature/hub-motorista-360` é **local**, sem upstream configurado
(`git rev-parse @{u}` → `fatal: no upstream configured`). Todo o trabalho desta feature
(15 commits, o último `f6a45e2`) vive só no worktree `/root/work/hub-motorista-360`. O
diretório vivo `/var/lib/envioMassa_homologacao` permanece em `main`, sem nenhuma alteração.

### 7. Worktree pendente de remoção
`/root/work/hub-motorista-360` deve ser removido (`git worktree remove`) quando a feature
for encerrada de fato (após push/PR/merge, que são decisão e ação do operador) — não removido
nesta sessão porque o trabalho ainda está sendo revisado/pode precisar de mais um ciclo.

---

## Recomendações

### Ações imediatas (do operador, fora desta pipeline)
1. Decidir prazo de retenção/base legal (dec-038/CHK019) com o jurídico/DPO.
2. Revisar o diff local (`git -C /root/work/hub-motorista-360 log main..feature/hub-motorista-360 --oneline`),
   abrir PR quando aprovado.
3. Instalar os 2 timers systemd em produção (rito de produção) quando o deploy for autorizado.
4. Aplicar migrations 0057/0058/0059 + script 003 em produção (rito de produção) antes ou junto
   do deploy — nunca antes de mergear.
5. Após merge/deploy: `git worktree remove /root/work/hub-motorista-360`.

### Não há tarefas pendentes do backlog SDD a recomendar — 97/97 fechado.

# Relatorio de Status das Tarefas — review-task (onda-009)

**Data:** 2026-07-08
**Projeto:** hub-frota / hub-faturamento (S6 — Modulo Faturamento)
**Tipo:** Misto (codigo + docs SDD)
**Arquivo de Tarefas:** `docs/specs/hub-faturamento/tasks.md`
**Branch:** `feat/hub-faturamento` (7 commits, HEAD `d28bc41`, working tree limpo)
**Pipeline:** `/feature-00c` — onda-009 (re-tentativa; onda-009 anterior spawnada
com `model=haiku` nao persistiu nada — dec-038/dec-039 — reaberta do zero)

---

## Resumo Executivo

| Metrica | Valor |
|---------|-------|
| Fases | 7 |
| Total de Tarefas | 13 |
| Subtarefas | 73 |
| Concluidas | 73 (100%) |
| Em Progresso | 0 (0%) |
| Pendentes | 0 (0%) |
| Bloqueadas | 0 (0%) |
| Criticidade | [C] 4 · [A] 7 · [M] 2 |

Fonte: `~/.claude/skills/review-task/scripts/metrics.sh docs/specs/hub-faturamento/tasks.md`
(saida JSON: `{"phases":7,"tasks":13,"subtasks":73,"done":73,"pct_done":100,"critical":4,"high":7,"medium":2}`).

---

## Reconciliacao `.tasks[]` ↔ `tasks.md` (§4.6)

- `state-ondas.sh reconcile-tasks --dry-run` (antes de qualquer gravacao nesta
  onda): stdout **vazio** → 0 divergencias detectadas.
- `.tasks[]` no `state.json`: **13/13** entradas, todas `outcome=pass`,
  cobrindo 1.1, 1.2, 2.1, 2.2, 3.1, 3.2, 4.1, 5.1, 6.1, 6.2, 7.1, 7.2, 7.3 —
  bate 1-para-1 com as 13 tarefas `[x]` de `tasks.md`.
- **Divergencia pre-reconcile: 0** — nao houve finding `task-outcome-nao-gravado`
  (todas as tasks ja tinham sido gravadas ao vivo pelo `execute-task` nas
  ondas 005-007; nenhum back-fill foi necessario nesta onda).

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
| init | specify | sonnet | sonnet | mapa | no |
| onda-001 | clarify | sonnet | sonnet | mapa | no |
| onda-002 | clarify | sonnet | sonnet | mapa | no |
| onda-003 | checklist | sonnet | sonnet | mapa | no |
| onda-004 | create-tasks | sonnet | sonnet | mapa | no |
| onda-005 | execute-task | sonnet | sonnet | mapa | no |
| onda-006 | execute-task | sonnet | sonnet | mapa | no |
| onda-007 | execute-task | sonnet | sonnet | mapa | no |
| onda-008 | review-task | haiku | haiku | mapa | no |

**Sumario por onda**:
- Total de ondas roteadas: 9
- aplicado haiku/sonnet/opus/manter-atual: 1/8/0/0
- origem mapa/refino/override-operador/fallback: 9/0/0/0
- fallback (manter-atual): 0 (0%)
- override do operador: 0 (0%)
- divergencias sugerido!=aplicado: 0 (rotuladas: 0, sem rotulo: 0)

**Nota sobre onda-009 (esta onda)**: o wave-select do mapa roteou onda-008
(review-task) para `haiku`, que nao executou a fase (spawn retornou apos
~64s com 3 tool-uses e nenhuma escrita de estado — dec-038). O comando PAI
registrou `dec-038` como **override para sonnet** na re-tentativa da
onda-009 (contexto/rationale/evidencia auditados, score 3). Esse override
nao aparece na tabela acima porque `dec-038` foi gravada com
`wave_id=onda-008` (momento da decisao, antes da onda-009 ser reaberta) e
contexto de texto livre distinto do padrao `"Selecao de modelo para onda N"`
que o agregador reconhece — registrado aqui para transparencia, sem
reformatar a secao canonica (Gotcha "Agregado model-routing nao deve ser
reformatado").

**Half-records (FR-013)**: `state-decisions-reconcile.sh check` → **exit 0,
0 orfas**. Paridade N_DEC==N_REC confirmada no escopo do two-step
subagente (`"Selecao de modelo para subagente"`): 2 Decisoes / 2
record-skill.

---

## Validacao Deterministica (re-executada nesta onda, nao so evidencia gravada)

| Suite | Comando | Resultado | Onde |
|---|---|---|---|
| Backend `npm test` completo (inclui `hub-faturamento-integration.sh` embutida via `hub-faturamento.test.js`, projeto `hub-test-*` efemero) | `node --test tests/hub-faturamento-dto.test.js tests/hub-faturamento.test.js` | **32/32 PASS, 0 FAIL** (duration 49046ms) | re-executado ao vivo, containers `hub-test-1783531062-*` auto-limpos (confirmado via `docker ps -a` pos-run) |
| `hub-csv.test.js` (CHK029) | `node --test tests/hub-csv.test.js` | **9/9 PASS** | re-executado ao vivo |
| Frontend DTO | `npx vitest run lib/hub/faturamento-dto.test.ts` | **11/11 PASS** | re-executado ao vivo |
| `tsc --noEmit` | frontend_v2 | **limpo (exit 0)** | re-executado ao vivo |
| `eslint` (4 arquivos novos: `page.tsx`, `faturamento-api.ts`, `faturamento-dto.ts`, `faturamento-dto.test.ts`) | `npx eslint ...` | **limpo (exit 0)** | re-executado ao vivo |
| `infra/hub/testes/hub-faturamento-integration.sh` isolado (62/62 asserts) | onda-006/007 | **62/62 PASS** (evidencia gravada; cobertura equivalente reconfirmada pela suite `npm test` acima na mesma onda) | `docs/plans/hub-frota/evidencias/S6/fase7-e2e-perf-resultado.md` §0 |

Decisao registrada (`dec-040`, score 3) documentando a re-execucao ao vivo
em vez de confiar apenas em evidencia gravada por onda anterior.

---

## E2E ao vivo contra `hub-homolog` (evidencia gravada, nao re-executada — instrucao explicita de nao repetir o E2E completo ja evidenciado)

- **42/42 PASS, 0 FAIL** nos 14 cenarios do `quickstart.md`
  (`docs/plans/hub-frota/evidencias/S6/fase7-e2e-onda008-output.txt`,
  contagem confirmada via `grep -c "^PASS:"` = 42).
- Cobertura: totais batendo com `SUM` SQL direto; empate alfabetico
  deterministico (dec-014); filtro por `data_referencia` (nunca
  `data_repasse`); periodo vazio sem erro; export CSV com contagem/soma
  batendo com a tela; CSV injection neutralizada (`=`/`@` + os 2 casos
  CHK029 — apostrofo pre-existente sem dupla neutralizacao, caractere
  neutro sem prefixo espurio); bypass de permissao via `curl` direto
  (`403 PERMISSAO_NEGADA`); isolamento multi-tenant real (empresa 9002
  sintetica, zero vazamento nos dois sentidos); roundtrip DTO real (sem
  mock, sem drift snake_case↔camelCase); identidade visual clara/escura
  (Playwright, 2/2, screenshots `cenario14-faturamento-{light,dark}.png`).
- Usuarios QA reais: `qa.importacoes@moveelog.local` (9001, admin_entidade),
  `qa.motoristas.leitura@moveelog.local` (9001, leitura, sem exportar),
  `qa.motoristas.outraempresa@moveelog.local` (9002, tenant isolado).

---

## ACHADO FORMAL — Cenario 15 / SC-004 (performance) — VIOLADO

**Nao mascarado, nao aprovado silenciosamente.** Sob volume ampliado
(~900.219 linhas, `id_empresa=9001`, cobrindo `2025-07-01..2026-06-30`,
~1 ano completo — pior caso realista de 1 tenant grande):

| Medicao | 1a rodada | 2a rodada | Limite SC-004 |
|---|---|---|---|
| `GET /faturamento/resumo` sem `groupBy` | 2600.5ms | 2230.6ms | 1000ms |
| `GET /faturamento/resumo` com `groupBy=categoria` | 1678.0ms | 1625.2ms | 1000ms |

**Ambas as medicoes excedem o limite de 1s — SC-004 formalmente violado.**

`EXPLAIN (ANALYZE, BUFFERS)`:
- `hub_faturamento_totais` (cards): Execution Time **1737.799 ms**, Seq
  Scan sobre 900207 linhas, 3 `InitPlan`s percorrendo a CTE materializada
  inteira, `temp read=39172 written=20186` blocos (ordenacao top-N em
  disco) — gargalo dominante.
- `hub_faturamento_agrupado` (`groupBy=categoria`): Execution Time
  **377.350 ms** (SQL puro rapido) — o tempo end-to-end observado
  (1.6-1.7s) inclui overhead de rede/TLS/serializacao/PostgREST nao
  capturado pelo `EXPLAIN ANALYZE` isolado, mas a metrica real de SC-004
  (percepcao do usuario) e o tempo end-to-end, que excede o limite.
- Indice `idx_faturamentolancamento_empresa_data` **nao usado** em nenhum
  dos dois planos — esperado: o filtro cobre ~100% das linhas da empresa
  no pior caso (ano inteiro populado), cenario em que Seq Scan e de fato
  mais barato. Confirma que o gargalo e volume bruto varrido, nao ausencia
  de indice.

**Decisao auditavel `dec-035`** (score 3, evidencia empirica acima):
`mv_faturamento_dia` (§12.6 do plano tecnico / Decision 8 de
`research.md`) e a mitigacao pre-aprovada, condicionada a evidencia real de
violacao — que agora existe. Implementa-la exige nova migration +
estrategia de refresh + mudanca nas 2 RPCs + testes: **escopo novo alem do
backlog de 13 tarefas ja revisado** (create-tasks onda-005, gates verdes).
Escolha registrada: **`registrar-e-escalar-para-operador`** — mesmo padrao
de governanca ja usado para D3/D4 do plano hub-frota (ratificadas via
DIARIO). **Nao implementada nesta onda.**

Fonte completa: `docs/plans/hub-frota/evidencias/S6/fase7-e2e-perf-resultado.md` §4.

---

## Pendencias registradas para o operador

1. **`mv_faturamento_dia`** (dec-035): decidir se implementa a view
   materializada agora (nova FASE/S6.1 ou S7 cedo) ou aceita o risco por
   enquanto — SC-004 esta formalmente violado sob volume anual de 1
   tenant grande.
2. **Seed de performance (~900k linhas)** em `hub_homolog_db`
   (`id_empresa=9001`, ids 300-900299): tentativa de `DELETE` foi
   **bloqueada pelo classificador de auto mode** ("mass delete... run
   outside auto mode so the user can review the scope"). Respeitando a
   politica de nao contornar gates de seguranca, **nao foi tentado
   novamente nesta onda**. Requer acao humana direta (dentro do escopo
   `hub-*` ja autorizado por G1) — apagar ou manter como fixture de
   regressao de performance.
3. Pendencia recorrente (desde S1): trailer de commit do CLAUDE.md
   ("Claude Opus 4.8") desatualizado vs modelo vigente — sem decisao do
   operador.

---

## Progresso por Fase

| Fase | Total | Concluidas | % |
|------|-------|------------|---|
| 1 — Migrations (RBAC + RPCs) | 2 | 2 | 100% |
| 2 — `lib/hub-csv.js` compartilhada | 2 | 2 | 100% |
| 3 — `GET /faturamento` (lista paginada) | 2 | 2 | 100% |
| 4 — `GET /faturamento/resumo` (cards/agregados) | 1 | 1 | 100% |
| 5 — Export CSV streaming | 1 | 1 | 100% |
| 6 — Tela `/hub/dashboard/faturamento` | 2 | 2 | 100% |
| 7 — E2E, performance e evidencias | 3 | 3 | 100% |

---

## Veredito

**APROVAR — com ressalva formal de SC-004 (dec-035), pendente de decisao do
operador sobre `mv_faturamento_dia`.**

Justificativa (`dec-041`, score 3): toda a superficie funcional (US1/US2/US3,
FR-001..FR-012) esta implementada, testada e evidenciada — 13/13 tarefas,
73/73 subtarefas, 42/42 E2E ao vivo, suites deterministicas verdes
(re-executadas nesta onda), isolamento multi-tenant e permissoes
independentes confirmados, CSV injection neutralizada (incl. gap CHK029),
identidade visual preservada. O unico achado e um requisito NAO-funcional
de performance sob volume anual completo de 1 tenant grande (pior caso),
que a propria spec ja havia antecipado como candidato a mitigacao SE
evidencia empirica confirmasse violacao (research.md Decision 8) — o que
ocorreu agora. Implementar `mv_faturamento_dia` unilateralmente expandiria
o escopo alem do backlog ja revisado (create-tasks onda-005, gates verdes)
sem ratificacao do operador, replicando o padrao ja usado para D3/D4.
Bloquear a S6 inteira por um NFR de escala grande (nao bug funcional, nao
falha de seguranca/isolamento) atrasaria valor de negocio pronto e testado;
aprovar sem ressalva mascararia o achado. PR aberto em **DRAFT** — nao
mergeavel sem decisao do operador.

---

## Entrega

- **PR draft**: `feat/hub-faturamento` → `main` (ver link no sumario do
  orquestrador).
- **DIARIO**: `docs/plans/hub-frota/DIARIO.md` atualizado com o fechamento
  da S6.
- **Ambiente**: apenas recursos `hub-*`/`hub_*` tocados (exceção G1);
  `envio-massa-homologacao_*` (producao real) nao tocado nesta onda.

---

## Recomendacoes

### Acoes Imediatas
1. **Decidir `mv_faturamento_dia`** (dec-035) — operador avalia se abre
   S6.1/S7 antecipada ou aceita o risco documentado.
2. **Decidir limpeza do seed de 900k linhas** em `hub_homolog_db` —
   operador executa o `DELETE` fora do auto mode ou mantem como fixture.
3. **Revisar e mergear PR draft** `feat/hub-faturamento` → `main` quando
   a ressalva SC-004 estiver resolvida/aceita.
4. Proxima fase da ordem S3→S10: **S7**.

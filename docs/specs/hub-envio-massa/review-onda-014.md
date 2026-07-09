# Relatório de Status das Tarefas — hub-envio-massa (S8)

**Data:** 2026-07-09
**Projeto:** envioMassa_homologacao / Hub de Frota
**Tipo:** Misto (código backend/frontend + docs SDD)
**Arquivo de Tarefas:** `docs/specs/hub-envio-massa/tasks.md`
**Onda:** onda-014 (review-task, modelo sonnet — override auditado dec-055)

---

## Resumo Executivo

| Métrica | Valor |
|---------|-------|
| Total de Subtarefas | 78 |
| Concluídas | 75 (96%) |
| Finalizadas Nesta Sessão | 0 (auditoria, não execução) |
| Pendentes (deferidas deliberadamente) | 3 (6.2.1–6.2.3) |
| Bloqueadas | 0 |
| Branch | `feat/hub-envio-massa`, HEAD `98ff9e3`, 18 commits à frente de `main`, working tree limpo, **sem push** |
| Suíte E2E (efêmero `hub-test-*`) | 62/62 PASS (`evidencias/e2e-run-20260709T082218Z.log`) |
| Suíte legada | 458 pass / 8 fail pré-existentes (zero regressão, zero arquivo de teste pré-existente alterado) |
| Gates de qualidade | `owasp-security` (dec-016, 0 CRITICAL/HIGH, 2 MEDIUM corrigidos no design), `validate-documentation` x2, `validate-docs-rendered`, `validate-tasks-template` — todos limpos |

---

## Auditoria de evidência (anti-confabulação)

Todas as afirmações abaixo foram verificadas em disco nesta onda, não aceitas por resumo de sessões anteriores:

- `git status`/`git log` confirmam HEAD `98ff9e3`, tree limpo, 18 commits ahead de `main`.
- `tasks.md`: 75/78 `[x]` confirmado por grep direto (não pelo relato do state.json).
- `evidencias/e2e-run-20260709T082218Z.log`: 62 linhas `^PASS:`, 0 `FAIL` — contagem literal do arquivo, bate com o alegado "62/62".
- `evidencias/diff-endpoints-legados.txt` + `git diff main..feat/hub-envio-massa -- server.js`: confirma wiring aditivo de middlewares nas 11 rotas + histórico de importação (FASE 4); nenhuma linha de lógica de negócio pré-existente alterada.
- Achado de segurança pré-existente (`ENVIO_DRY_RUN` não lido via `process.env`) confirmado literalmente em `e2e-hub-envio-massa.sh` linhas 21 e 609 — citação de dec-050 corresponde ao texto real do arquivo (não fabricada).
- **Contexto "sessão concorrente" (dec-048–053)**: re-auditado via `git log`/`git diff` nesta onda — confirmado que os commits `10f0bd4..73f3127` são trabalho legítimo do próprio subagente da onda-011 retomado após falha transitória de API, não uma sessão hostil/desconhecida. Sem tampering, sem lost-update.

---

## Achados desta onda (review-task)

### 1. `.tasks[]` incompleto — 3 tasks concluídas sem outcome gravado (CORRIGIDO)

`state-ondas.sh reconcile-tasks --dry-run` detectou que as tasks **5.2, 6.1, 6.3** (concluídas no `tasks.md`) não tinham entrada em `.tasks[]` — o `execute-task` pulou o `record-task` ao vivo nessas 3 (provavelmente durante a reconciliação da sessão concorrente, dec-053). Ação: back-fill determinístico via `reconcile-tasks` (idempotente, `--if-absent`, não sobrescreve entradas reais). `.tasks[]` passou de 10 → 13 entradas. `state-decisions-reconcile.sh check` confirma **0 half-records** de model-routing. Registrado como dec-056.

### 2. `checklists/requirements.md` desatualizado (NÃO BLOQUEANTE — follow-up leve)

O arquivo tem um único commit (`2d7c76e`, fase `checklist`) e nunca foi re-sincronizado. `CHK006`, `CHK010` e `CHK031` permanecem marcados `[ ]` mesmo com evidência real de fechamento documentada em `dec-040`/`dec-052`/`dec-053` (matriz papel×ação, medição empírica SC-005, smoke de a11y via Playwright). `CHK018`/`CHK037` permanecem `[ ]` **deliberadamente** (gap pré-existente fora de escopo, ver achado 3). Registrado como dec-057 — recomenda-se sincronizar o checklist numa próxima onda de doc-hygiene ou como parte do fechamento de PR; não é um problema de substância, é de rastreabilidade documental.

### 3. Achado de segurança pré-existente — `ENVIO_DRY_RUN`/allowlist não lidos (FORA DE ESCOPO, deferido)

Confirmado (dec-050, re-verificado nesta onda): `sendMessage()` e `POST /validate-xml-batch` em `server.js` usam URLs hardcoded de produção; nenhuma leitura de `process.env.ENVIO_DRY_RUN`/allowlist existe no código, apesar de documentado desde a S1 em `RUNBOOK`/`.env.hub.*.example`. **Confirmado fora do diff desta feature** — `diff-endpoints-legados.txt` mostra zero linhas tocadas nessas duas funções. Corrigir seria mudança de lógica de negócio do fluxo legado, fora do escopo "diff mínimo, zero lógica de negócio" da S8 (FR-015). Tasks 6.2.1–6.2.3 (CHK018/CHK037) permanecem deliberadamente abertas — mesmo padrão de ressalva formal já aceito pelo operador em `hub-faturamento` (PR #59) e `hub-performance` (PR #60). Registrado como dec-058, recomenda-se follow-up formal (feature própria) para o dono do produto decidir.

### 4. Cosmético: entrada duplicada em `.tasks[]` (`2.2` + `2.2.9`)

`.tasks[]` tem tanto `2.2` quanto `2.2.9` como task_ids distintos — resquício de uma gravação ao vivo que usou id de subtask em vez do id de task pai. Não afeta contagem de `tasks.md` (que usa headers `### N.M`), efeito é só um registro extra na `knowledge.db`. Não bloqueante, não corrigido nesta onda (retroativo, baixo valor).

### 5. Model-routing por onda — override de dec-055 não refletido na tabela formal (informativo)

`model-routing-report.sh aggregate` mostra `onda-013 | review-task | sugerido=haiku | aplicado=haiku | origem=mapa` — o override para sonnet (dec-055, registrado pelo `/feature-00c-resume` PAI como Decisão avulsa) não foi capturado pelo mecanismo formal `DecisaoDeRoteamentoPorOnda`. Não há "divergência sem rótulo" (a tabela nem chegou a registrar a onda-014 corrente), mas é um gap de instrumentação a considerar em refino futuro do `model-routing-por-onda` — não afeta o veredito desta feature.

---

## Progresso por Fase

| Fase | Total | Concluídas | % |
|------|-------|------------|---|
| 1 — Fundação (permissão, middlewares, schema legado) | ~15 | 15 | 100% |
| 2 — Middlewares + flags | ~10 | 10 | 100% |
| 3 — Integração nas 11 rotas legadas | ~5 | 5 | 100% |
| 4 — Histórico leve de importação | ~8 | 8 | 100% |
| 5 — Tela `/hub/dashboard/envio_massa` + a11y | ~10 | 10 | 100% |
| 6 — E2E + proteções de envio + fechamento | ~30 | 27 | 90% (6.2.1–6.2.3 deferidos) |

---

## Selecao de modelo por subagente (model-routing)

| subagent_type | etapa | onda | modelo | score | fallback |
|---------------|-------|------|--------|-------|----------|
| feature-00c-clarify-asker | clarify | onda-002 | manter-atual | 0 | no |
| feature-00c-clarify-answerer | clarify | onda-002 | manter-atual | 0 | no |

**Sumário**: Total: 2 · haiku: 0 · sonnet: 0 · opus: 0 · manter-atual: 2 · fallback-default: 0 (0%)

## Selecao de modelo por onda (sugerido vs aplicado)

| onda | etapa | sugerido | aplicado | origem | divergente |
|------|-------|----------|----------|--------|------------|
| init | specify | sonnet | sonnet | mapa | no |
| onda-001 | clarify | sonnet | sonnet | mapa | no |
| onda-002 | clarify | sonnet | sonnet | mapa | no |
| onda-003 | checklist | sonnet | sonnet | mapa | no |
| onda-004 | create-tasks | sonnet | sonnet | mapa | no |
| onda-005..011 | execute-task | sonnet | sonnet | mapa | no |
| onda-013 | review-task | haiku | haiku | mapa | no |

**Sumário por onda**: 13 ondas roteadas · aplicado haiku/sonnet/opus/manter-atual: 1/12/0/0 · origem mapa 13/13 · fallback 0% · override-operador 0% (formal) · divergências 0. *(onda-014, esta onda, corre em sonnet por override dec-055, fora do mecanismo formal — ver achado 5.)*

---

## Veredito

**APROVAR COM RESSALVA** — mesmo padrão formal já aceito pelo operador em `hub-faturamento` (PR #59) e `hub-performance` (PR #60).

Fundamentação:
- Critério 1 (E2E verde): **atendido** — 62/62 PASS em ambiente efêmero, evidência literal verificada.
- Critério 2 (testes legados intocados/verdes): **atendido** — 458/466 pass, 8 falhas pré-existentes, zero regressão, zero arquivo de teste pré-existente alterado.
- Critério 3 (diff mínimo): **atendido** — wiring aditivo de middlewares + histórico fire-and-forget, nenhuma linha de lógica de negócio pré-existente tocada, confirmado por diff literal.
- Critério 4 (flags reversíveis com aposentadoria agendada): **atendido** — `HUB_RBAC_ENVIO`/`HUB_IMPORT_LOG_ENVIO` reversíveis por env (medição empírica CHK010), retirada/consolidação prevista na fase S10 (regressão geral + ensaio de cutover, `01-plano-tecnico.md` linha 1204/1265).
- Critério 5 (proteções auditadas): **parcial** — gate `owasp-security` limpo (0 CRITICAL/HIGH) sobre o código NOVO desta feature; achado de segurança pré-existente no fluxo LEGADO (`ENVIO_DRY_RUN`) está fora de escopo e formalmente deferido (CHK018/CHK037, tasks 6.2.1–6.2.3 abertas por decisão, não por omissão).
- Critério 6 (PR + DIARIO): **PR NÃO aberto nesta onda** (autorização de push/PR é do operador — ver "Pendências do operador" abaixo); DIARIO.md atualizado na onda-013 (seção "S8 CONCLUÍDA").

## Pendências do operador

1. **Push + abertura de PR** — branch `feat/hub-envio-massa` (HEAD `98ff9e3`) pronta, working tree limpo, 18 commits ahead de `main`. Requer autorização explícita (Rito de Produção / Governança do CLAUDE.md).
2. **Follow-up `ENVIO_DRY_RUN`** (achado 3 acima) — decidir se vira feature própria para introduzir a leitura real da flag em `sendMessage`/`validate-xml-batch` (fora do escopo "diff mínimo" da S8).
3. **`POSTGREST_API_KEY` em `.env.hub.homolog`** — valor placeholder `__GERAR__` em `infra/hub/.env.hub.homolog.example`; alinhar geração/rotação real com o operador antes de qualquer uso além do ambiente `hub-test-*` efêmero (não é regressão desta feature, é item operacional pendente desde S1).
4. **Gaps `{humano}` remanescentes do checklist**: CHK018, CHK037 (achado 3) — decisão formal do dono do produto. CHK006/CHK010/CHK031 têm evidência real de fechamento mas o arquivo `checklists/requirements.md` não foi re-sincronizado (achado 2) — recomenda-se marcar `[x]` numa próxima passada de doc-hygiene.
5. **Sincronizar `checklists/requirements.md`** (achado 2) — cosmético, não bloqueia PR.

---

## Recomendações

### Ações Imediatas
1. **Operador decide push + PR** — branch pronta, sem ação de código pendente.
2. **Follow-up `ENVIO_DRY_RUN`** — abrir feature própria se o dono do produto priorizar.
3. **Doc-hygiene leve** — sincronizar `checklists/requirements.md` (achado 2) na próxima janela de manutenção.

# Review-task — hub-shell (S3, Shell Modular do Hub)

Onda: onda-012 · Fase: review-task (terminal) · Data: 2026-07-07

> **Nota de método**: este relatório NÃO reexecuta build/E2E/browser (custo de
> host e risco de starvation — ver CLAUDE.md/rito anti-starvation). Toda
> métrica abaixo é citada de uma evidência gravada nesta execução (arquivo +
> linha, quando aplicável) ou marcada explicitamente como "não reexecutado
> nesta onda". Números sem fonte não aparecem neste relatório.

## 1. Veredito final

**APROVAR** — S3 (hub-shell) está pronta para revisão do operador no PR #56
(draft, branch `feat/hub-shell` → `main`, `MERGEABLE`). Nenhum bloqueio aberto,
nenhum finding crítico/alto sem tratamento, escopo da spec 100% coberto.

## 2. Cobertura de tasks.md

Fonte: `docs/specs/hub-shell/tasks.md` (leitura direta, `grep -c`).

- Subtarefas: **84/85 marcadas `[x]`**. A única pendente é
  `7.1.2 [teste] Confirmar CI verde` (linha 396) — **intencionalmente
  não-bloqueante**: o próprio tasks.md documenta que essa subtask é do
  orquestrador PAI, pós-push/PR (CI só roda após o push, que ocorreu depois
  desta fase gerar o artefato). Não é uma lacuna de trabalho da S3.
- As 7 fases (1–7) e as 21 tasks de nível grupo estão `[x]`.
- Reconciliação `.tasks[]` ↔ `tasks.md` (`state-ondas.sh reconcile-tasks`,
  best-effort desta onda): passou de 33 → **38 entradas**, back-fillando 5
  IDs de grupo da Fase 6 (6.1–6.5) que só existiam em granularidade de
  subtask. Todas as 38 entradas têm `outcome: pass`; nenhum `fail` registrado
  em `.tasks[]`.

## 3. Testes — métricas com fonte citada

**Não reexecutados nesta onda.** Citações da evidência gravada nas fases
anteriores:

| Métrica | Valor citado | Fonte |
|---|---|---|
| Testes unitários (vitest) | **73 verdes** (total agregado) | `docs/plans/hub-frota/DIARIO.md` linha 390 |
| Testes unitários por arquivo (amostra verificável) | `me-dto.test.ts` 8/8; `hub-auth-context.test.tsx` 4/4; `env-badge.test.tsx` 7/7; `module-nav.test.ts` 5/5 + `module-nav.test.tsx` 4/4; `entity-switcher.test.tsx` 9/9; `selecionar-entidade/page.test.tsx` 7/7; login 5/5; recuperar-senha 3/3; redefinir-senha 5/5; perfil 4/4; `session-guard.test.tsx` 7/7 | `docs/specs/hub-shell/tasks.md` linhas 95,114,140,165,193,218,241,255,269,284,302 |
| E2E via API/proxy | **11/11 asserts PASS** | `docs/plans/hub-frota/evidencias/S3/fase6-e2e-evidencias.md` linha 38 |
| E2E browser (Playwright real) | **10/10 testes PASS** | idem, linhas 59-61; log bruto `fase6-browser-run-20260707T112631Z.log` |
| axe (acessibilidade) | **6/6 telas em 100/100** após correção de 4 achados moderados (`landmark-one-main`/`page-has-heading-one`/`region`) | idem, tabela linhas 79-97 |
| tsc/eslint | "limpos" (pass/fail, sem contagem — este projeto não tem gate de lint com contagem numérica) | `tasks.md` linha 97 (`npx tsc --noEmit` e `npx eslint` limpos) |

A soma "8+5+3+5+4 + suítes anteriores" citada no próprio DIARIO.md (linha 390)
é uma nota de composição parcial do autor daquela fase, não uma fórmula
auditável ponta-a-ponta a partir deste relatório — reporto o total que o
DIARIO declara (73) sem tentar recompor uma soma própria a partir dos
arquivos individuais acima, porque a task 5.1.4 (dashboard) não registra
contagem explícita em `tasks.md`. **Divergência não encontrada** entre as
fontes citadas — apenas uma lacuna de granularidade (uma suíte sem número
publicado), sinalizada aqui em vez de omitida.

## 4. Gates de qualidade (skills_invoked, `.waves[].skills_invoked`)

| Gate | Invocações | Achados críticos/high | Decisão |
|---|---|---|---|
| `validate-documentation` (doc-quality) | 2x (specify, plan) | nenhum crítico registrado | — |
| `owasp-security` | 1x (pós-implementação, Fase 6) | **0 findings critical/high** | dec-019: A01 mitigado por design (backend reautoriza por-entidade); A07/CSRF via TTL curto + `sameSite=strict` |
| `validate-tasks-template` (template-fidelity) | 1x (create-tasks) | conformidade ao template | — |
| `validate-docs-rendered` (docs-render) | 1x (create-tasks) | sem link 404 / Mermaid inválido registrado | — |
| `ui-ux-pro-max` | 1x agregada (Fases 2-5 reusam o mesmo padrão de design) | — | — |
| `model-selector` (model-routing) | 2x nesta amostra de skills_invoked; 14 Decisões de "Selecao de modelo" em `.decisions[]` (10 sonnet, 2 manter-atual, 1 opus, 1 haiku) | n/a | routing aplicado por spawn, sem decisão órfã aparente |

Nenhum "gate skip" com severidade problemática: os 2 registros de contexto
contendo "gate" em `.decisions[]` são decisões de **escopo dentro da Fase 6**
(cobrir E2E via API primeiro, browser em onda seguinte; fórmula de score do
axe) — não são pulos de gate, são decisões de sequenciamento já executadas
(a onda browser rodou e fechou o axe em 100/100, conforme §3).

## 5. Sugestões para skills globais (FR-020)

Nenhuma sugestão nova registrada nesta onda de review. `accumulated_metrics.
global_skill_suggestions_total = 0` (state.json). Nenhum bug/aspereza de
skill global observado empiricamente durante o review desta feature.

## 6. Blast radius e segurança

- Toda escrita de ambiente confinada a recursos `hub-*` (compose
  `hub-homolog`, containers `hub_homolog_*`) — confirmado em
  `docs/plans/hub-frota/DIARIO.md` (seção "Blast radius" da entrada S3).
  Zero escrita no ambiente vivo do cliente (`chatmasterveloz`,
  `envio-massa-homologacao_*`, `pgadmin_db`).
- Sem DDL nesta fase (S3 reusa 100% os dados de `/me` da S2 — dec-016).
- `contexts/auth-context.tsx` (legado envio-massa) confirmado intocado por
  leitura (`git diff --stat` vazio, task 1.4.2).
- Sem dado pessoal real em evidências: contas sintéticas
  `e2e-teste-shell-*@example.test`, criadas/removidas por script a cada
  execução (`fase6-e2e-evidencias.md` cabeçalho).

## 7. Estado do PR

`gh pr view 56`: `state=OPEN`, `isDraft=true`, `mergeable=MERGEABLE`,
título "S3 — Shell Modular do Hub (nav, auth, EntitySwitcher, dashboard)".
`statusCheckRollup` vazio — este repositório não tem pipeline de CI
configurado neste momento (nenhum check associado ao PR); a subtask 7.1.2
("confirmar CI verde") portanto não tem um CI a aguardar — fica marcada como
pendência do PAI apenas por convenção do template de tasks, não por haver
um check real bloqueado.

## 8. Follow-ups não-bloqueantes para S4+

1. **Trailer de commit desatualizado** (pendência recorrente desde S1):
   `CLAUDE.md` pede `Claude Opus 4.8`; os commits desta feature usam o
   modelo vigente. Requer decisão do operador (item já registrado no
   DIARIO).
2. **Path de evidências diverge do documentado em tasks.md**: a task 6.5.4
   referencia `docs/specs/hub-shell/evidencias/`, mas as evidências reais
   vivem em `docs/plans/hub-frota/evidencias/S3/` (convenção adotada desde a
   onda anterior). Nenhuma evidência foi criada no caminho antigo — não é
   uma lacuna de conteúdo, só uma inconsistência textual no tasks.md que
   pode ser corrigida num passe de limpeza futuro.
3. **`NEXT_PUBLIC_APP_ENV` "não reconhecido"** (fail-safe CHK029): o
   comportamento fail-safe está testado (`env-badge.test.tsx`), mas vale o
   operador confirmar o valor real que será setado em produção antes do
   cutover S10, para não exibir o banner de "não-produção" por engano.
4. **Formalização de "PermissionGate é decorativo"** como requisito
   numerado — decisão de produto pendente do dono do produto (já sinalizada
   em `tasks.md` "Escopo Excluído", não bloqueia a execução).
5. **Endpoint de troca de senha autenticada** (com senha atual) — hoje
   reusa o fluxo de recuperação por e-mail; se o produto quiser UX mais
   direta no futuro, precisará de endpoint novo no backend (fora da
   fronteira desta feature, dec-010).

## 9. Métricas de execução (proxy de custo)

Fonte: `.accumulated_metrics` do `state.json` (tool_calls como proxy
documentado — custo em tokens não é exposto pela harness, decisão dec-005
herdada, sem valor inventado):

- `waves_total`: 14 (11 antes desta onda + esta onda de review + as 2 que a
  fecharão)
- `decisions_total`: 59 (auditadas via `state-decisions.sh`)
- `human_blocks_total`: 1 (block-001, respondido — autorização da abordagem
  de E2E da Fase 6)
- `max_depth_reached`: 2 (dentro do limite de 3 — FR-021)
- `subagents_spawned`: 2

## 10. Conclusão

Pipeline SDD completo (specify → clarify → plan → checklist → create-tasks
→ execute-task ×7 fases → review-task), sem drift de escopo, sem
Decisão órfã de model-routing aparente, sem finding crítico/alto pendente,
sem escrita em produção. **Recomendação: aprovar para revisão humana do
PR #56** — merge/deploy permanecem sob autorização explícita do operador
(rito de produção do CLAUDE.md); cutover para produção (gate G3) só ocorre
no fechamento da S10 do plano mestre, não nesta fase.

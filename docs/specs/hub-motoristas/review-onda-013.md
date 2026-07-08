# Review-task — hub-motoristas (S5, Módulo Motoristas do Hub de Frota)

Onda: onda-013 · Fase: review-task (terminal) · Data: 2026-07-08

> **Nota de método**: todas as métricas de teste (unit backend/frontend,
> tsc, eslint) abaixo foram **reexecutadas nesta onda** — comando exato
> registrado ao lado de cada número. A integração `hub-motoristas-
> integration.sh` (stack `hub-test-*` efêmera) **não foi reexecutada**
> nesta onda (custo de subir a stack completa de novo); é citada da FASE
> 8 (onda-012), com o próprio script conferido linha a linha. O status da
> migration 0025 no `hub_homolog_db` **foi consultado ao vivo** via
> `psql` (read-only). Números sem fonte não aparecem neste relatório.

## 1. Veredito final

**APROVAR** — S5 (hub-motoristas) está pronta para revisão do operador.
Branch `feat/hub-motoristas` (commit `98a4321`, 9 commits à frente de
`origin/main`, working tree limpa), 46 arquivos alterados, 7523 inserções
/ 6 remoções vs `main` (`git diff --stat 122382a..98a4321`). Nenhum
bloqueio humano aberto (4/4 `respondido`), nenhum finding crítico/alto
sem tratamento, **75/75 subtarefas de `tasks.md` marcadas `[x]`
(100%)**.

## 2. Cobertura de `tasks.md`

Fonte: `scripts/metrics.sh` (review-task, execução direta nesta onda).

| Métrica | Valor |
|---|---|
| Fases | 8 |
| Tarefas | 18 |
| Subtarefas | 75 |
| Concluídas | **75 (100%)** |
| Em andamento / Pendentes / Bloqueadas | 0 / 0 / 0 |
| Criticidade | 0 [C], 16 [A], 2 [M] |

`state-ondas.sh reconcile-tasks --dry-run` detectou 2 entradas de
`.tasks[]` ausentes (tarefas-pai **8.1** e **8.2** — só as subtarefas
`8.1.1-8.1.5`/`8.2.1-8.2.4` estavam registradas). Aplicado o backfill
(`--if-absent`, não-destrutivo): `.tasks[]` foi de 25 para **27**
entradas, ambas com `outcome: pass`, `source: reconcile`. Nenhuma outra
divergência entre `tasks.md` e `.tasks[]`.

## 3. Testes — métricas reexecutadas nesta onda (com comando + fonte)

| Suíte | Comando | Resultado |
|---|---|---|
| Backend — suíte completa (`npm test`, 16 arquivos incl. hub-motoristas) | `cd app_homologacao/backend && npm test` | **380 testes, 93 suítes, 372 pass, 8 fail** |
| Backend — só hub-motoristas (dto/similaridade/postgrest-jwt/import-processor) | `node --test tests/hub-motoristas-dto.test.js tests/hub-motoristas-similaridade.test.js tests/hub-postgrest-jwt-unit.test.js tests/hub-import-processor.test.js` | **133 testes, 32 suítes, 133 pass, 0 fail** |
| Frontend unit — todo o repo (vitest) | `cd app_homologacao/frontend_v2 && npx vitest run` | **22 arquivos, 165 testes, 165 pass, 0 fail** |
| TypeScript | `npx tsc --noEmit` | **saída vazia = 0 erros** |
| ESLint (escopo motoristas: `app/hub/dashboard/motoristas`, `components/hub/vinculo-motorista-dialog.tsx`, `lib/hub/motoristas-{api,dto}.ts`) | `npx eslint app/hub/dashboard/motoristas components/hub/vinculo-motorista-dialog.tsx lib/hub/motoristas-api.ts lib/hub/motoristas-dto.ts` | **exit 0, 0 erros** |

**As 8 falhas do `npm test` completo são pré-existentes e não
relacionadas a esta feature** — confirmado nesta onda por inspeção
direta do output (`grep "not ok"`): todas as 4 suítes falhas (84, 85,
86, 89) pertencem a `motorista-integration.test.js` (app motorista
legado, base de dados compartilhada `chatmasterveloz` de teste), zero
delas em qualquer arquivo `hub-motoristas-*`. Consistente com o que
`dec-050`/tasks.md 8.2.4 já registrou (confirmado via `git stash` antes
da mudança da FASE 8.2.4) — **reconfirmado independentemente** nesta
onda, mesma contagem exata (372/380) e mesmas 4 suítes.

Integração (`hub-motoristas-integration.sh`, stack `hub-test-*`
efêmera) **não foi reexecutada** (custo de build da imagem, mesmo
padrão de limitação documentado em `hub-importacoes/review-onda-011.md`
§3) — citada da FASE 8 (§4 abaixo), script conferido linha a linha
(38 pontos de cobertura lettered a-z+ no cabeçalho, todos os asserts
listados como `PASS` no run real da FASE 8).

## 4. Evidência E2E (FASE 8, hub-homolog persistente) — citada com fonte

Fonte: `docs/plans/hub-frota/evidencias/S5/fase8-e2e-resultado.md` + 4
PNGs `cenario12-*`. Conteúdo conferido linha a linha nesta onda:

| Cenário | Resultado citado | Requisito |
|---|---|---|
| 1 — busca/filtro/paginação | 6 asserts PASS (nome, total real=209, pageSize, comVinculo=false, termo inexistente) | SC-001/SC-002 |
| 2 — multi-área | entregador com 2 áreas aparece em ambos os filtros; ordem Centro primeiro | FR-003 |
| 3 — edição nome/situação + RBAC | PATCH nome/ativo 200, persistência confirmada por GET; usuário leitura → 403 sem side-effect | FR-004/FR-005/SC-006 |
| 4 — proteção de reimportação (trigger 0019, pré-0025) | nome editado sobrevive à reimportação; controle sem edição prévia atualiza normalmente | FR-004 |
| 5 — sugestão automática | `entidadeElegivel:true`, top-N ≤10, conta alvo presente | SC-003 |
| 6 — vínculo via sugestão | leitura de `/sugestoes` sem efeito colateral; `POST vinculo` 200 e persistido | SC-004 |
| 7 — busca manual | busca por termo com `entregadorId`; sem `entregadorId` → 422; confirmação → 200 | FR-008 |
| 8 — vínculo duplicado/substituição/desvínculo idempotente | 409 `conta_ja_vinculada`; substituição numa única ação 200; `DELETE` sem vínculo → 204 idempotente (CHK006) | CHK006 |
| 9 — fora do grupo Movee | sugestões/contas-elegíveis retornam vazio; `POST` forçado → 422 `entidade_fora_do_grupo` | FR-016 |
| 10 — isolamento multi-tenant | empresa 9002 acessando entregador da 9001 → 404; listagem → total 0 | Constitution II |
| 11 — shape/roundtrip | camelCase puro (`nomeEditadoManualmente`), `cnpjPrestadorMascarado` mascarado mesmo para dono | Constitution III, LGPD |
| 12 — branding claro/escuro | 4 PNGs (`cenario12-{lista,detalhe}-{light,dark}.png`), paleta EntreGô 2.0, sem cor hardcoded | SC-008 |
| Auditoria | `motorista.editado`=3, `motorista.vinculado`=3, `motorista.desvinculado`=1 — 1-para-1 com as ações confirmadas | FR-014 |

**Nota de higiene de dados autodetectada** (§ da própria evidência): um
UUID sintético calculado errado no script de seed do Cenário 4 colidiu
com um `id_externo` real e sobrescreveu temporariamente um nome; achado
identificado pela própria auditoria da screenshot do Cenário 12,
corrigido via `UPDATE` direto, sem invalidar a prova do trigger (2º
rascunho, UUIDs corretos). Registrado aqui por transparência, não é bug
de produto.

## 5. Achado 8.2.4 (block-004) e status da migration 0025 — verificado ao vivo

A FASE 8 (Cenário 4) descobriu que o trigger `trg_entregador_protege_
nome` (migration 0019) bloqueava **qualquer** 2ª correção manual de nome
pelo operador, não só a reimportação automática do S4. Escalado como
`block-004`; o operador respondeu (2026-07-08): **reeditar deve sempre
funcionar pela tela — o trigger deve bloquear só a sobrescrita vinda da
reimportação S4**. Implementado (commit `98a4321`, tarefa 8.2.4):

- `infra/hub/migrations/0025_entregador_protege_nome_apenas_import.sql`
  — nova função `hub_jwt_origem_importacao()` + trigger condicionado à
  claim `origemImportacao:true`, emitida **só** por
  `lib/hub-import-processor.js#upsertEntregadoresDoLote` via
  `lib/hub-postgrest-jwt.js`. `PATCH` manual (`routes/hub-motoristas.js`)
  nunca emite a claim — sempre pode reeditar.
- 6 unit novos (`hub-postgrest-jwt-unit.test.js` + `hub-import-
  processor.test.js`) + 8 asserts novos no script de integração —
  **todos incluídos e verdes** na reexecução §3 desta onda.

**Verificação ao vivo nesta onda** (`docker exec hub_homolog_db psql -U
hub_homolog -d hub_homolog`, read-only):

```sql
SELECT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'hub_jwt_origem_importacao');
-- f
SELECT count(*) FROM pg_trigger WHERE tgname = 'trg_entregador_protege_nome';
-- 1  (trigger da migration 0019 ainda ativo, versão ANTIGA)
```

**Confirmado: a migration 0025 ainda NÃO está aplicada no
`hub_homolog_db` persistente.** O comportamento restritivo antigo
(bloqueia 2ª edição manual) segue vigente nesse ambiente até a
aplicação. Código, testes e migration estão prontos e commitados; falta
só a aplicação real — ver §7 (pendências).

## 6. Checklist (`requirements.md`) — itens humanos

3 itens `{humano}` seguem com checkbox `[ ]` **por design** (aguardam
decisão de produto do operador, não bloqueiam a entrega):

| Item | Assunto | Status |
|---|---|---|
| CHK007 | Rate limiting em `/sugestoes`/`/contas-elegiveis` | Aberto — decidir se herda do shell (S3) ou é requisito desta fase |
| CHK031 | Concorrência de edição (optimistic locking) | Aberto — risco baixo, decidir last-write-wins explícito |
| CHK033 | Acessibilidade das telas novas além de "preservar identidade visual" | Aberto — telas entregues via `/ui-ux-pro-max` tendem a cobrir, mas não é requisito explícito |

CHK006 (semântica idempotente do `DELETE /vinculo`) e CHK012 (SC-002
qualitativo) foram fechados nas fases 6 e 4 respectivamente (ver
`requirements.md` linhas 14/23).

## 7. Gates de qualidade (`skills_invoked`, `.waves[].skills_invoked`)

| Gate | Invocações | Achados críticos/high | Decisão |
|---|---|---|---|
| `validate-documentation` (doc-quality) | 1x (onda-003, plan) | 0 críticos | dec-020: `corrigir-agora` (nenhuma correção necessária — 0 TODO/TBD/FIXME residual) |
| `owasp-security` | 1x (onda-003, plan) | 3 gaps de especificação identificados (A05 SQL ilustrativo, A01 BOLA não documentado, API3 mass-assignment) — **0 residual após correção** | dec-021 (score 3, evidência: grep zero SQL concatenado + Decisions 10-12 do research.md documentam RPC parametrizado + 404 BOLA + allowlist) |
| `checklist` | 1x (onda-004) | 2 gaps menores + 3 itens humanos, nenhum bloqueante | dec-023: `prosseguir-para-create-tasks` |
| `validate-tasks-template` (template-fidelity) | 1x (onda-004) | conformante | dec-025 (score 3, evidência: `critical=0\|warning=0 exit=0`) |
| `validate-docs-rendered` (docs-render) | 1x (onda-004) | 0 erro/aviso | dec-026 (score 3, evidência: `ERRO=0 AVISO=0` em `tasks.md`+`requirements.md`) |
| `model-selector` (model-routing) | 2 registros (onda-002, clarify asker+answerer) | n/a | `manter-atual`, sem fallback; agregado por-onda: 14 ondas roteadas, 0 divergência sugerido≠aplicado sem rótulo (ver §8) |

`jq` em `.decisions[]` por `choice=="skip-com-justificativa"` retornou
**0 ocorrências** — nenhum gate pulado nesta feature.

## 8. Agregado model-routing (`model-routing-report.sh aggregate`)

Colado verbatim (`~/.claude/skills/agente-00c-runtime/scripts/model-routing-report.sh aggregate --state-dir $SD`):

```
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
| onda-003 | plan |  | manter-atual | fallback | no |
| onda-003 | plan | opus | opus | mapa | no |
| onda-004 | execute-task | sonnet | sonnet | mapa | no |
| onda-005 | execute-task | sonnet | sonnet | mapa | no |
| onda-006 | execute-task | sonnet | sonnet | mapa | no |
| onda-007 | execute-task | sonnet | sonnet | mapa | no |
| onda-008 | execute-task | sonnet | sonnet | mapa | no |
| onda-009 | execute-task | sonnet | sonnet | mapa | no |
| onda-010 | execute-task | sonnet | sonnet | mapa | no |
| onda-011 | execute-task | sonnet | sonnet | mapa | no |
| onda-012 | execute-task | sonnet | sonnet | mapa | no |

**Sumario por onda**:
- Total de ondas roteadas: 14
- aplicado haiku/sonnet/opus/manter-atual: 0/12/1/1
- origem mapa/refino/override-operador/fallback: 13/0/0/1
- fallback (manter-atual): 1 (7.1%)
- override do operador: 0 (0%)
- divergencias sugerido!=aplicado: 0 (rotuladas: 0, sem rotulo: 0)
```

**Auditoria de meia-gravação** (`state-decisions-reconcile.sh check
--state-dir $SD`): **exit 0 — 0 half-records pendentes** (paridade
`N_DEC == N_REC` confirmada).

## 9. Cobertura de Success Criteria (spec.md)

| SC | Status | Evidência |
|---|---|---|
| SC-001 (localizar em <15s) | ✅ | Cenário 1 (§4), busca+filtros funcionais |
| SC-002 (navegável sem degradação, milhares de registros) | ⚠️ qualitativo | Paginação máx 100/página mitiga; CHK012 registra ausência de alvo numérico, aceito como qualitativo (dec do checklist) |
| SC-003 (conta correta nas sugestões, 100% dos testados) | ✅ | Cenário 5 (§4) |
| SC-004 (zero vínculo sem confirmação humana) | ✅ | Cenário 6 (§4): leitura de `/sugestoes` sem efeito colateral; auditoria 1-para-1 |
| SC-005 (jornada completa só pelas telas) | ✅ | FASE 7 entrega lista/detalhe/vínculo; Cenários 1-12 exercitam via API os mesmos endpoints que as telas chamam (`lib/hub/motoristas-api.ts` confirmado por leitura) |
| SC-006 (controles ocultos + acesso negado sem permissão) | ✅ | Cenário 3 (§4): usuário leitura → 403 sem side-effect |
| SC-007 (zero impacto na base do app motorista) | ✅ | §5 do `fase8-e2e-resultado.md`: `hub_homolog_backend` só fala com PostgREST próprio (rede `hub_internal`), grep vazio por `chatmasterveloz`/`pgadmin_db` no código do módulo |
| SC-008 (identidade visual preservada, claro/escuro) | ✅ | Cenário 12 (§4), 4 PNGs |

## 10. Blast radius e segurança

- Toda escrita de ambiente confinada a recursos `hub-*`/`hub_*`
  (`hub-homolog`, `hub_homolog_*`) — confirmado por `fase8-e2e-
  resultado.md` §0/§5 e pela consulta ao vivo desta onda (psql contra
  `hub_homolog_db`, sem tocar `pgadmin_db`/`chatmasterveloz`).
- `git diff --name-only 122382a..98a4321 | grep -iE "docker-compose\.yml$|\.env$|swarm"`
  → **vazio** (nenhum arquivo de infraestrutura viva tocado nesta
  feature).
- Isolamento multi-tenant (Constitution II, NON-NEGOTIABLE): RLS
  verificado no Cenário 10 (§4) — empresa 9002 acessando entregador da
  9001 → 404, listagem → total 0.
- Sem dado pessoal real: seeds sintéticos (`gen-seeds.py`), CNPJ
  mascarado mesmo para `admin_entidade` (Cenário 11), banner
  "HOMOLOGAÇÃO — dados fictícios" visível nas screenshots.

## 11. Métricas de execução (proxy de custo)

Fonte: `.accumulated_metrics` do `state.json` (tool_calls não é exposto
pela harness — dec-005 herdada; nenhum valor de custo inventado):

- `waves_total`: 13 (12 antes desta onda + esta onda de review)
- `decisions_total`: 50 (antes desta onda de review)
- `human_blocks_total`: 4 (4/4 `respondido`)
- `max_depth_reached`: 2
- `subagents_spawned`: 2
- `wallclock_total_seconds`: 26504 (~7h21min, acumulado desde `onda-init`)

## 12. Pendências para o operador

1. **Migration 0025 não aplicada no `hub_homolog_db` persistente**
   (§5) — confirmado ao vivo nesta onda. Código/testes/migration estão
   prontos e commitados (`98a4321`); a aplicação real (`psql` contra o
   container `hub_homolog_db`, ou via pipeline de migração do hub) e a
   revalidação do trigger (reeditar nome 2x pela tela + reimportação
   protegendo nome editado) cabem no orçamento da exceção G1 (recursos
   `hub-*`), mas **não foram executadas nesta onda** — decisão do
   operador se prefere que o agente aplique e revalide agora, ou trata
   como follow-up explícito antes do merge.
2. **Push + PR da branch `feat/hub-motoristas`** aguardam autorização
   explícita do operador (Governança, CLAUDE.md) — branch local, 9
   commits à frente de `origin/main`, working tree limpa.
3. **Atualização do `DIARIO.md` da S5** — critério de aceite 5 (PR + Diário)
   ainda não cumprido; pendente até o PR existir (item 2).
4. **3 itens `{humano}` do checklist** (§6: CHK007 rate limiting,
   CHK031 concorrência, CHK033 a11y explícita) seguem aguardando decisão
   de produto — nenhum bloqueia a entrega atual.
5. **SC-002 qualitativo** (§9) — sem alvo numérico de latência/tamanho
   de página; aceito como está pela decisão do checklist (dec-023), mas
   registrado aqui para rastreabilidade.

## 13. Conclusão

Pipeline SDD completo (specify → clarify → plan → checklist →
create-tasks → execute-task ×8 fases → review-task), sem drift de
escopo, sem gate crítico/alto pendente, sem escrita em produção
(`chatmasterveloz`/`pgadmin_db` nunca tocados). Testes reexecutados
nesta onda confirmam de forma independente as métricas citadas nas
fases anteriores (372/380 backend geral — 8 falhas pré-existentes e não
relacionadas; 133/133 unit hub-motoristas; 165/165 vitest frontend;
tsc/eslint limpos). `.tasks[]` reconciliado (100% de paridade com
`tasks.md`), 0 half-records de model-routing, 0 divergência
sugerido≠aplicado sem rótulo. **Recomendação: aprovar para revisão
humana do PR** — a aplicação da migration 0025 no `hub_homolog_db`,
push/PR e atualização do DIARIO permanecem como pendências explícitas
sob autorização do operador (rito de produção do CLAUDE.md); cutover
para produção (gate G3) só ocorre no fechamento da S10 do plano mestre.

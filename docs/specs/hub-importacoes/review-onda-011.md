# Review-task — hub-importacoes (S4, Pipeline de Importações)

Onda: onda-011 · Fase: review-task (terminal) · Data: 2026-07-07

> **Nota de método**: as métricas de teste unitário/lint/tsc abaixo foram
> **reexecutadas nesta onda** (não apenas citadas das fases anteriores) —
> comando exato registrado ao lado de cada número. Métricas de E2E contra o
> `hub-homolog` (cenários 1-11) **não foram reexecutadas** (custo de subir o
> ambiente completo de novo); são citadas dos arquivos de evidência gravados
> na FASE 7, com path+conteúdo conferido linha a linha nesta onda. Números
> sem fonte não aparecem neste relatório.

## 1. Veredito final

**APROVAR** — S4 (hub-importacoes) está pronta para revisão do operador.
Branch `feat/hub-importacoes` (commit `24e5d28`), 70 arquivos alterados,
11574 inserções / 11 remoções vs `main`. Nenhum bloqueio humano aberto,
nenhum finding crítico/alto sem tratamento, 146/149 subtarefas de
`tasks.md` marcadas `[x]` (as 3 restantes são exatamente 7.5.1-7.5.3,
fechadas por esta própria onda).

## 2. Cobertura de `tasks.md`

Fonte: `docs/specs/hub-importacoes/tasks.md` (`grep -c '^\- \[x\]'` /
`grep -c '^\- \[ \]'`, execução direta nesta onda).

- Subtarefas: **146/149 marcadas `[x]`** antes desta onda. As 3 pendentes
  eram `7.5.1` (DIARIO), `7.5.2` (PR draft), `7.5.3` (sem merge/deploy) —
  todas de responsabilidade do próprio `review-task`, fechadas por esta
  execução (ver §7).
- As 7 fases (0-7) e a subtask de fechamento 7.5 estão cobertas.

## 3. Testes — métricas reexecutadas nesta onda (com comando + fonte)

| Suíte | Comando | Resultado |
|---|---|---|
| Backend unit — hub-importacoes (6 arquivos: parser/normalizer/hash/unit/processor/dto) | `cd app_homologacao/backend && node --test tests/hub-import-parser.test.js tests/hub-import-normalizer.test.js tests/hub-import-hash.test.js tests/hub-importacoes-unit.test.js tests/hub-import-processor.test.js tests/hub-importacoes-dto.test.js` | **143 testes, 39 suítes, 143 pass, 0 fail** (`/tmp/hub-importacoes-unit-tap.txt`) |
| Backend unit — todo o hub (`npm run test:hub:unit`, inclui auth/rbac/auditoria/postgrest-jwt + os 6 acima) | `npm run test:hub:unit` | **210 testes, 59 suítes, 210 pass, 0 fail** |
| Frontend unit — todo o repo (vitest) | `cd app_homologacao/frontend_v2 && npx vitest run` | **18 arquivos, 121 testes, 121 pass, 0 fail** |
| Frontend unit — só importações (isolado) | `npx vitest run lib/hub/importacoes-dto.test.ts hooks/use-importacao-polling.test.ts` | **2 arquivos, 24 testes, 24 pass** (subconjunto do total acima) |
| TypeScript | `npx tsc --noEmit` | **saída vazia = 0 erros** |
| ESLint (escopo importações: `app/hub/dashboard/importacoes`, `lib/hub`, `hooks/use-importacao-polling.ts`) | `npx eslint app/hub/dashboard/importacoes lib/hub hooks/use-importacao-polling.ts` | **exit 0, 0 erros** |

Os 121/121 do vitest e o "0 erros" de tsc/eslint batem com o que
`dec-049` (execute-task, FASE 6) já havia registrado — **confirmado
independentemente** nesta onda, não apenas citado.

Integração/E2E contra Postgres real **não foi reexecutada** (o suite
`hub-importacoes-integration.test.js` / `hub-import-processor-integration
.test.js` sobe um projeto docker-compose efêmero `hub-test-*` com build de
imagem — tentativa nesta onda expirou em 90s sem concluir o build; custo
não justificado quando a FASE 7 já produziu evidência fresca de
2026-07-07 contra o `hub-homolog` persistente, citada abaixo). Isso é
citado como limitação explícita, não omitido.

## 4. Evidência E2E (FASE 7, hub-homolog persistente) — citada com fonte

Fonte: `docs/plans/hub-frota/evidencias/S4/cenarios-1-10-resultado.md` +
`lgpd-zero-vazamentos.md` + `roundtrip-payload-exemplo.json` + 4 PNGs
`cenario11-*`. Conteúdo conferido linha a linha nesta onda (não apenas
listado):

| Cenário | Resultado citado | Requisito |
|---|---|---|
| 1 — happy path faturamento | status `completed`, 20 total/20 válidas/0 inválidas | SC-001 |
| 2/2b — reimportação + dedupe de linha | reenvio → `409`, `importacaoOriginalId=10`; arquivo com 5 repetidas+5 novas → `{"total":10,"validas":10,"invalidas":0}`, 0 fatos novos confirmados por contagem direta | SC-002 |
| 3 — dialeto performance | `completed_with_errors`, 6 total/5 válidas/1 inválida | FR (parser por tipo) |
| 4 — erros + LGPD | `completed_with_errors`, 10/8/2; CSV-injection escapado; 0 UUID bruto exposto; shape JSON só expõe `valorMascarado` | SC-004 |
| 5 — falha estrutural | 60% inválidas → `failed`, `erro_resumo` explícito, 0 linhas persistidas | SC-003 |
| 6 — reprocessar/cancelar | `failed`→reprocessar `202`; `completed`→reprocessar `409`; sem permissão→`403`; cancelar `completed`→`409` | SC-005 (parcial — jornada de tela, ver §8) |
| 7 — gate de export | papel leitura (sem `importacoes.exportar`) → `403`; papel `admin_entidade` → `200` | SC-006 |
| 8 — isolamento RLS | empresa B lendo importação de A → `404`; listagem de B não contém a de A | Constitution II (NON-NEGOTIABLE) |
| 9 — concorrência (lock) | 2 uploads simultâneos (mesma empresa+tipo) → ambos `201`, ambos terminam `completed` (índice único parcial supre a mudança de design do CHK036, ver §6) | Decision 5 (research.md, ADENDO) |
| 10 — roundtrip contrato | payload real capturado (`roundtrip-payload-exemplo.json`): camelCase `linhasValidas`→na verdade campo é `contadores.validas`/`dataReferencia` presentes, sem drift snake_case | Constitution III |
| 11 — branding dark/light | 4 PNGs capturados (`cenario11-{lista,detalhe}-{dark,light}.png`, 55-57KB cada) | SC-007 |
| LGPD (log) | grep por CPF/CNPJ formatado nos logs de `hub_homolog_backend`/`hub_homolog_db`: **0 ocorrências** | SC-004 |

Nota de auditoria: no roundtrip-payload-exemplo.json real o campo é
`contadores: {total, validas, invalidas}` (não `linhasValidas` solto como
a task 7.3.2 descreve) — **é uma reformulação, não um drift**: o objeto
aninhado `contadores` é o formato efetivamente documentado em
`contracts/importacoes-api.md` para `GET /:id`. Sinalizado aqui para não
mascarar a diferença de nomenclatura entre o texto da task e o payload
real.

## 5. Endpoints e migrations — contagem verificada nesta onda

- **7 endpoints** (não 6): `grep -nE "router\.(get|post|patch|delete|put)"
  app_homologacao/backend/routes/hub-importacoes.js` retorna `POST /`,
  `GET /`, `GET /:id`, `GET /:id/erros`, `GET /:id/original`, `POST
  /:id/reprocessar`, `POST /:id/cancelar`. Divergência do número "6"
  citado em contexto anterior — reportado aqui com a contagem real.
- **8 migrations** (0010-0017): `ls infra/hub/migrations/ | grep -E
  '^00(1[0-7])'` confirma as 8 presentes, incluindo `0017_grant_delete_
  importacao_linha_erro.sql` (grant adicional pós-FASE7, fora do range
  0010-0016 original do plano — expand-only, sem breaking change).
- Aplicação real confirmada em `01-migrate-fase1-run1.txt` /
  `02-migrate-fase1-run2-idempotencia.txt` (rodagem dupla idempotente,
  17 migrations totais incluindo as 9 herdadas de S1-S3).

## 6. Checklist (`requirements.md`) — item humano CHK036

CHK036 (`pg_try_advisory_lock` sustentado por sessão dedicada) segue com
`[ ]` **no arquivo do checklist** (marcado `{humano}`), mas foi
**resolvido por decisão registrada** em `dec-030..033` (commit `c37a9ba`,
FASE 0 de execute-task): verificação em código mostrou que
`hub-postgrest.js` é HTTP stateless (sem pool `pg` direto no backend) —
`pg_try_advisory_lock` não sustentaria sessão entre chamadas. Mecanismo
substituto com o **mesmo contrato funcional**: índice único parcial em
`ImportacaoArquivo(id_empresa, tipo) WHERE status IN ('validating',
'processing')`, documentado como ADENDO em `research.md` Decision 5 e
`data-model.md`. O Cenário 9 (§4) confirma o comportamento funcional
esperado (concorrência tratada sem duplicar processamento). **Achado não
bloqueante**: o checkbox `[ ]` de CHK036 no arquivo de checklist não foi
atualizado para `[x]` apesar da decisão registrada — inconsistência
textual, não lacuna de trabalho. Corrigido nesta onda (ver diff do
checklist).

## 7. Gates de qualidade (`skills_invoked`, `.waves[].skills_invoked`)

| Gate | Invocações | Achados críticos/high | Decisão |
|---|---|---|---|
| `validate-documentation` (doc-quality) | 2x (specify, plan) | nenhum crítico | dec-005, dec-018: `aceitar-risco-com-justificativa` (0 placeholders TODO/TBD/FIXME, 26 FRs + 8 SCs presentes) |
| `owasp-security` | 1x (pós-plan, arquitetural) | **0 findings critical/high** | dec-019: A01 mitigado (RLS por token nas 5 tabelas + `requirePermission` fail-closed + gate export distinto de consultar); A03 (CSV-injection anti-prefix + PostgREST parametrizado); A04 (limites 20MB/ZIP 1-entrada/100MB/path-traversal); LGPD (`valorMascarado`, CSV bruto fora de log/git) |
| `validate-tasks-template` (template-fidelity) | 1x (create-tasks) | conformante | dec-026/027: `conformante-prosseguir` |
| `validate-docs-rendered` (docs-render) | 2x | sem link 404/Mermaid inválido registrado | — |
| `ui-ux-pro-max` | 2x (FASE 6 telas + auditoria pós-implementação) | correções de touch-target aplicadas (não achado crítico) | dec-048/049 |
| `model-selector` (model-routing) | 2 registros amostrados em `skills_invoked`; 56 Decisões totais em `.decisions[]` (a maioria model-routing por onda) | n/a | routing aplicado por spawn, sem decisão órfã aparente nesta amostra |

Nenhum "gate skip" com severidade problemática encontrado — `grep` em
`.decisions[]` por `skip-com-justificativa` não retornou nenhuma
ocorrência nesta feature.

## 8. Cobertura de Success Criteria (spec.md)

| SC | Status | Evidência |
|---|---|---|
| SC-001 (100% válidas em happy path) | ✅ | Cenário 1 (§4) |
| SC-002 (reimportação = 0 duplicatas) | ✅ | Cenário 2/2b (§4) |
| SC-003 (falha estrutural sem intervenção manual) | ✅ | Cenário 5 (§4) |
| SC-004 (0 dado pessoal em log/erro) | ✅ | Cenário 4 + `lgpd-zero-vazamentos.md` (§4) |
| SC-005 (jornada completa só pelas telas) | ⚠️ parcial | FASE 6 entrega as 4 telas (histórico/detalhe/wizard/reprocessar); Cenário 6 confirma os endpoints subjacentes (reprocessar/cancelar) via API, não via clique na tela — **não há evidência de screenshot/gravação da jornada fim-a-fim pela UI**, só via API + Cenário 11 (screenshots estáticos de lista/detalhe). Não bloqueante (telas existem e chamam os endpoints corretos — `importacoes-api.ts` confirmado por leitura), mas é uma lacuna de evidência, não de implementação. |
| SC-006 (ações diferentes por permissão) | ✅ | Cenário 7 (§4) |
| SC-007 (branding/tema preservado) | ✅ | Cenário 11, 4 PNGs (§4) |
| SC-008 (zero mudança no envio em massa legado) | ✅ | dec-053 cita "produção 4/4 antes/depois"; `git diff --stat` confirma nenhum arquivo do fluxo de envio em massa legado (`routes/`, exceto o novo `hub-importacoes.js`) alterado |

## 9. Blast radius e segurança

- Toda escrita de ambiente confinada a recursos `hub-*` (`hub-homolog`,
  containers `hub_homolog_*`) — confirmado por `03-rls-importacoes-
  integration.txt` e ausência de qualquer stack/compose de produção no
  diff.
- `git diff --name-only main...feat/hub-importacoes | grep -iE
  "docker-compose\.yml$|\.env$|swarm"` → **vazio** (nenhum arquivo de
  infraestrutura viva tocado nesta onda).
- Isolamento multi-tenant (Constitution II, NON-NEGOTIABLE): RLS
  verificado nas 5 tabelas novas (Cenário 8 + `03-rls-importacoes-
  integration.txt`, 15 asserts PASS).
- Sem dado pessoal real nas evidências: PNGs de `cenario11-*` são de
  ambiente sintético `hub-homolog`; `lgpd-zero-vazamentos.md` confirma
  grep negativo nos logs.

## 10. Métricas de execução (proxy de custo)

Fonte: `.accumulated_metrics` do `state.json` (tool_calls não é exposto
pela harness — dec-005 herdada; nenhum valor de custo inventado):

- `waves_total`: 14 (10 antes desta onda + esta onda de review)
- `decisions_total`: 56 (antes desta onda; +2/+3 nesta onda de review)
- `human_blocks_total`: 0
- `max_depth_reached`: 2
- `subagents_spawned`: 2

## 11. Follow-ups não-bloqueantes para o operador

1. **Trailer de commit desatualizado** (pendência recorrente desde S1):
   `CLAUDE.md` pede `Claude Opus 4.8`; os commits desta feature usam o
   modelo vigente. Requer decisão do operador.
2. **SC-005 sem evidência de jornada fim-a-fim gravada pela UI** (§8) —
   telas e endpoints existem e estão corretos (Cenário 6 via API + telas
   auditadas por `ui-ux-pro-max`), mas falta uma gravação/screenshot
   sequencial mostrando o fluxo completo só de clique. Sugestão: se o
   operador quiser essa evidência, é um passe leve de captura, não de
   implementação.
3. **CHK036 do checklist** com checkbox textual desatualizado (§6) —
   corrigido nesta onda para refletir a decisão já tomada.
4. **Migration 0017 fora do range original do plano** (0010-0016) — é um
   grant adicional pós-FASE7 (`0017_grant_delete_importacao_linha_erro.
   sql`), expand-only, aplicado e confirmado idempotente; citado aqui só
   para rastreabilidade.

## 12. Conclusão

Pipeline SDD completo (specify → clarify → plan → checklist → create-tasks
→ execute-task ×7 fases → review-task), sem drift de escopo, sem gate
crítico/alto pendente, sem escrita em produção. Testes reexecutados nesta
onda confirmam de forma independente as métricas citadas nas fases
anteriores (143/143 unit hub-importacoes, 210/210 unit hub completo,
121/121 vitest frontend, tsc/eslint limpos). **Recomendação: aprovar para
revisão humana do PR** — merge/deploy permanecem sob autorização explícita
do operador (rito de produção do CLAUDE.md); cutover para produção
(gate G3) só ocorre no fechamento da S10 do plano mestre.

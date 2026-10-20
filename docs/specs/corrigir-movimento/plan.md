# Implementation Plan: Corrigir o valor de um movimento antes do envio da nota

**Feature**: `corrigir-movimento` · **Spec**: [`spec.md`](./spec.md) · **Data**: 2026-10-20
**Artefatos**: [`research.md`](./research.md) · [`data-model.md`](./data-model.md) ·
[`contracts/correcao-valor-api.md`](./contracts/correcao-valor-api.md) ·
[`quickstart.md`](./quickstart.md)

---

## Summary

Hoje não existe caminho para corrigir o valor de um movimento: a tela mostra **Valor** como
editável, responde *"Registro atualizado com sucesso!"* e **não grava** — porque
`updateEnvioMassa` monta o corpo do `PATCH` apenas para `tipo === "men1"|"men2"` e `valor`
nunca entra nele (`server.js:1050-1057`). E reimportar a planilha corrigida **duplica** as
linhas, porque o `/upload` faz um `INSERT` cego do lote.

A abordagem tem quatro movimentos, todos por **reuso** do que já existe:

1. **Reconhecer antes de inserir** (reimportação): uma passada de consultas em lote,
   dirigida pela lista de `cnpj_prestador`, resolve **os dois ramos** da chave dupla —
   `uuid` em memória sobre o mesmo resultado, fallback por
   `id_empresa`+`cnpj_prestador`+período. Usa o índice que a 0109 **já** criou; **nenhum
   índice novo**.
2. **Gravar o valor de fato** (tela): incluir `valor`/`gorjeta` no caminho de escrita e
   devolver o **desfecho real**, nunca sucesso presumido.
3. **Ajustar o texto da mensagem** sem inventar formato: na reimportação o texto vem da
   planilha; na tela, substitui-se **apenas o número**, ancorado na frase, avisando quando a
   âncora não existe.
4. **Tornar guarda + gravação + auditoria indivisíveis** numa função no banco, cobrindo
   também o painel legado — que hoje não gera trilha alguma.

**O que esta feature NÃO faz** (FR-025): não reabre nem recalcula apuração de repasse, não
altera o cálculo do valor, a origem ou o layout da planilha, e (decisão do plano, não parte de FR-025)
não mexe no modelo de acesso (GRANTs; a tabela não tem RLS) de `EnvioMassa`.

---

## Technical Context

| Campo | Valor | Fonte |
|---|---|---|
| Linguagem/runtime | Node.js 20 (`node:20-alpine`) | `Dockerfile.hub`; `docker run … node --version` → `v20.20.2` (CLAUDE.md) |
| Backend | Express, rotas em `server.js` + `routes/` | `app_homologacao/backend/` |
| Frontend | Next.js (App Router) + Tailwind 4 + Base UI | `app_homologacao/frontend_v2/` |
| Persistência | PostgreSQL via **PostgREST**, **sem ORM** | `lib/hub-postgrest.js`, `postgrestRequest` |
| Tabela alvo | `EnvioMassa` (schema legado) | `0033_schema_legado_envio_massa.sql` |
| Testes | backend `node --test`; frontend `vitest`; E2E Playwright por driver | `package.json`, `infra/hub/testes/*.sh` |
| Migrations | série única `infra/hub/migrations/NNNN_*.sql` via `migrate.sh` | CLAUDE.md |
| Deploy | container Docker no Swarm, Traefik | constitution §V |
| Escala | ~980 linhas/lote, crescendo; teto de 10 s | spec FR-010, SC-005 |

**Language/Version**: Node.js 20 (`node:20-alpine`) · **Primary Dependencies**: Express,
PostgREST (HTTP, sem ORM), Next.js App Router · **Storage**: PostgreSQL via PostgREST,
tabela `EnvioMassa` (schema legado da 0033) · **Testing**: `node --test` (backend),
`vitest` (frontend_v2), Playwright por driver (E2E do hub) ·
**Target Platform**: container Docker em Docker Swarm, roteado por Traefik (fonte: constitution §V + briefing — eixo estrutural herdado do projeto, não decidido por este plano; backend buildado por `Dockerfile.hub`, frontend_v2 em Next.js standalone) ·
**Project Type**: web (backend + frontend) · **Performance Goals**: lote de ~980 linhas
respondido em até 10 s (SC-005), sem consulta por linha (FR-010) ·
**Constraints**: sem ORM e sem transação multi-statement na aplicação; `express.json()`
global de 100 KB; `EnvioMassa` não é escopada pelo banco · **Scale/Scope**: ~980 linhas por
lote semanal, crescendo; 2 rotas HTTP existentes + 1 função nova no banco.

**NEEDS CLARIFICATION restantes: 0.** Os seis eixos estruturais são **herdados do projeto**
(briefing + constitution) e não são reabertos por esta feature.

---

## Constitution Check

*GATE: passou antes do Phase 0; re-checado após o Phase 1 (§Re-check).*

| Princípio | Status | Notas |
|---|---|---|
| **I. Autenticação & Segredos** (NON-NEGOTIABLE) | **PASS** | Nenhuma mudança em auth. Reusa `authenticateTokenCompartilhado` nas duas rotas. Nenhum segredo novo; nada logado além do que já se loga. |
| **II. Isolamento Multi-Tenant** (NON-NEGOTIABLE) | **PASS, com obrigação explícita** | O `empresa_id` vem do corpo mas é **validado** contra o escopo derivado do token por `resolveEmpresaAlvo` (`routes/grupo.js:831`), *fail-closed* (403 fora do escopo, 503 se o escopo não resolve, **nunca** degradação para `user.empresaId`) — conforme o Amendment v1.1.0. **Obrigação que o design assume**: `id_empresa` explícito em toda consulta **e** como parâmetro da função, porque o banco **não escopa** `EnvioMassa` (Decision 7). |
| **III. Contratos de API & Proxy** | **PASS** | Frontend continua falando só via proxy `/api/*`; nenhuma mudança de CORS nem de cookies. Campos novos em rotas existentes, `snake_case` coerente com o módulo legado. |
| **IV. Qualidade e Revisão** | **PASS** | Branch dedicada, Conventional Commits, gates com números (`quickstart.md`), controle negativo obrigatório, `owasp-security` previsto. |
| **V. Deploy Conteinerizado** (NON-NEGOTIABLE) | **PASS** | Nenhum serviço ou container novo. A migration é **aditiva** (função + `GRANT`), aplicada por `migrate.sh`, sem tocar containers existentes. |

**Nenhum FAIL em princípio MUST.** `Complexity Tracking` não se aplica (ver §Complexity).

---

## Decisões técnicas (resumo; detalhe e evidência em `research.md`)

| # | Decisão | Fecha |
|---|---|---|
| 1 | Casamento em **uma passada**, dirigida pela lista de CNPJ; `uuid` resolvido em memória no mesmo resultado | FR-001, FR-007, FR-010 |
| 2 | **Nenhum índice novo** — o `idx_envio_massa_cnpj_periodo` da 0109 serve; `EnvioMassa.uuid` **não** tem índice e não precisa | FR-010 |
| 3 | Período do fallback vem do **range da requisição**, comparado por **faixa**, nunca `::date` | FR-001, FR-010 |
| 4 | Texto: planilha na reimportação; **substituição ancorada na frase** na tela, com aviso se a âncora falta | FR-003, FR-014 |
| 5 | **Função no banco (RPC)** — único jeito de atomicidade sobre PostgREST | FR-017, FR-021, FR-023 |
| 6 | Reusar `Auditoria`; `usuario_id = NULL` no legado. FR-024 **já satisfeito** pelo schema | FR-021, FR-022, FR-024 |
| 7 | Filtro de `id_empresa` **explícito** em toda query e na função — o banco não escopa | FR-019 |
| 8 | Reusar `envio_massa.criar`; **já** protege as duas rotas | FR-020 |
| 9 | Tudo-ou-nada **preservado** para inválida, **quebrado** para ambígua | FR-005, FR-006 |
| 10 | `/upload` é multipart ⇒ os 100 KB do `express.json()` **não** se aplicam; resumo vai na **resposta** | — |
| 11 | Reusar `buscarEmLotes` com **cliente injetado** (sem cruzar auth) | FR-010 |
| 12 | **Controle negativo obrigatório** com a lista de quais testes falham | SC-002 |

---

## Project Structure

### Documentação (feature dir) — real

```
docs/specs/corrigir-movimento/
├── spec.md                          (existente)
├── research.md                      (criado)
├── data-model.md                    (criado)
├── quickstart.md                    (criado)
├── plan.md                          (este)
└── contracts/
    └── correcao-valor-api.md        (criado)
```

### Código-fonte — árvore real, caminhos verificados

```
app_homologacao/backend/
├── server.js
│   ├── :156-172   auditarEnvioMassaSeViaHub      → cobertura do legado (Decision 6)
│   ├── :1041-1072 updateEnvioMassa               → causa raiz: `valor` fora do updateData
│   ├── :1079      PATCH /update-envio-massa/:id  → caminho da tela
│   ├── :1778      toTimestamptzMidnightSP        → reuso para o período (Decision 3)
│   └── :1789      POST /upload                   → caminho da reimportação
├── lib/
│   ├── hub-postgrest-lotes.js   :29  buscarEmLotes  → ganha `fetcher` opcional (Decision 11)
│   └── hub-auditoria.js              registrarAuditoria (existente)
├── middleware/
│   └── hub-envio-massa-permission.js :33  (reuso; sem mudança)
├── routes/grupo.js              :831  resolveEmpresaAlvo (reuso; sem mudança)
└── tests/                             suítes novas + controle negativo

app_homologacao/frontend_v2/
└── hooks/use-envio-massa.ts     :97-101 updateRecord → envia valor + motivo

infra/hub/migrations/
└── NNNN_envio_massa_corrigir_valor.sql   (novo; próxima da série, aditivo)
```

**Nenhum diretório novo.** Nenhum serviço novo. A feature toca 1 arquivo de backend
substancialmente (`server.js`), 1 helper (`+1 parâmetro opcional`), 1 hook de frontend e
adiciona 1 migration.

---

## Convenções de Borda

| Camada | Case style | Validação | Fonte da verdade |
|---|---|---|---|
| Colunas do banco (PostgreSQL) | `snake_case` | DDL da migration | `infra/hub/migrations/*.sql` |
| Parâmetros da função (RPC) | `p_<snake_case>` | assinatura SQL | migration nova |
| Corpo/resposta HTTP (rotas legadas) | `snake_case` | validação manual no handler | `server.js` (`/upload`, `/update-envio-massa/:id`) |
| Cliente frontend | `snake_case` no payload | tipos TS | `frontend_v2/hooks/use-envio-massa.ts` |

**Mapper layer (DB ↔ DTO)**: **não existe, e não se introduz uma aqui.** Este módulo é o
painel **legado** e trafega `snake_case` ponta a ponta — verificável em
`use-envio-massa.ts` (`empresa_id`) e em `server.js:1819-1820` (`dt_inicial`, `dt_final`).
O hub usa `camelCase`, mas estas duas rotas não são do hub; trocar a convenção delas seria
mudança de contrato público sem pedido (decisão do plano, não requisito da spec).

**ORM auto-mapping**: **NÃO** — não há ORM; o backend fala HTTP com PostgREST.

**Validação Zod**: **não se aplica** — este módulo legado não usa Zod. A
validação numérica do `valor` **reusa o parser da importação** (FR-012), em vez de um
segundo validador.

---

## Riscos e armadilhas já conhecidas

| Risco | Mitigação no plano |
|---|---|
| `::date` numa coluna de data mata o índice | Faixa `>= d AND < d+1` (Decision 3), com `EXPLAIN` como gate (Cenário 12) |
| `in.()` grande estoura o header do PostgREST (PR #50) | `buscarEmLotes`, lotes de 100 (Decision 11) |
| Confundir `uuid` com `entregador_uuid` | Documentado: só `entregador_uuid` tem índice (0046), e é **outra** coluna (Decision 2) |
| Teste que **afirma o defeito** | Controle negativo com lista de quais falham (Decision 12) |
| Fuso `03:00 UTC` virar duplicata silenciosa | Faixa de um dia em vez de igualdade exata (Decision 3) |
| Substituir o número errado na mensagem (gorjeta, CNPJ, CEP, códigos) | Âncora é a **frase**, não `R$<número>` (Decision 4); Cenário 6 verifica os quatro |
| Auditoria *best-effort* passar por FR-023 | Gravada **dentro** da função (Decision 5) |
| `id` de outra empresa alcançar o `UPDATE` | `p_id_empresa` no `WHERE`; `SECURITY DEFINER` torna isso a **única** fronteira (Decision 7) |
| Disco cheio derrubar o banco durante build | `df -h /` antes, abortar < ~20 GB (quickstart) |
| `package-lock.json` reescrito pelo container do Playwright | Conferir e reverter antes de commitar (quickstart) |

---

## Gate de segurança (`owasp-security`) — 6 achados, 2 HIGH **fechados no plano**

Rodado sobre `plan.md`, `contracts/correcao-valor-api.md` e `data-model.md`.
Referências: OWASP Top 10:2025, API Security Top 10:2023, CWE Top 25:2025.

| # | Severidade | Achado | Desfecho |
|---|---|---|---|
| SEC-1 | **HIGH** | **BOPLA / mass assignment** (API3:2023, CWE-862). O corpo do `PATCH` já carrega 5 campos e ganharia `valor`/`gorjeta`; repassar `req.body` para a escrita deixaria um cliente autenticado gravar `numnota`, `erro_validacao`, `mov_fechado`, datas ou `id_empresa` — **contornando** as guardas de FR-015/FR-016 e o isolamento de FR-019. | **CORRIGIDO NO PLANO**: allowlist literal (`valor`, `gorjeta`, `mensagem1`) obrigatória, proibido repassar/spread do `req.body` — `contracts` §2.2 SEC-1 |
| SEC-2 | **HIGH** | **Injeção na query string do PostgREST** (A05:2025, CWE-89). Os `cnpj_prestador` do `in.()` vêm de **células de planilha** (entrada não confiável); um valor com `,`/`)`/operador escapa do filtro. Agravante: o `uuid` é gravado **cru** da planilha (`server.js:1989`), sem validação alguma. | **CORRIGIDO NO PLANO**: lista construída só de valores `onlyDigits`+`isCNPJ14`, célula bruta proibida; e o `uuid` **nunca** entra em query (resolvido em memória por Decision 1, o que elimina o vetor por construção) — `contracts` §1.4 SEC-2 |
| SEC-3 | MEDIUM | **Escalonamento por `SECURITY DEFINER`** (A01:2025). A função ignora RLS, então `p_id_empresa` passa a ser a **única** fronteira de tenant; um `p_id_empresa` arbitrário operaria sobre qualquer empresa. | **Controle já especificado**: `p_id_empresa` **MUST** vir de `resolveEmpresaAlvo` (validado contra o token, *fail-closed*), nunca do corpo — `contracts` §3 req 7, Decision 7. Verificar na implementação. |
| SEC-4 | MEDIUM | **PII em log** (A09:2025). `console.error('[UPLOAD] Primeira linha preparada:', JSON.stringify(dataToInsert[0]))` (`server.js:2035`) despeja `nome` + `cnpj_prestador` no log. | **PRÉ-EXISTENTE**, não introduzido por esta feature. Obrigação **nova**: o caminho de correção **MUST NOT** logar `motivo` nem o texto da mensagem. Reduzir o log pré-existente fica fora de escopo (FR-025) — registrado para quem decidir tratá-lo. |
| SEC-5 | LOW | **Fail-closed da guarda** (A10:2025). | **Satisfeito por construção**: a guarda vive no `WHERE` do `UPDATE` (Decision 5); linha que não casa o predicado simplesmente **não é alterada** — o modo de falha é *não alterar*, que é o conservador (FR-016). |
| SEC-6 | LOW | **Consumo de recurso** (API4:2023): import de ~980 linhas é pesado e repetível. | **PRÉ-EXISTENTE**. Não agravado: Decision 1 **reduz** o custo (de 0 para ~10 consultas em lote, em vez de 980 individuais). Rate limit por IP seria bug em produto multi-operador — não proposto. |

**LLM Top 10 / Agentic 2026**: **N/A** — a feature não tem componente de LLM, agente,
RAG ou MCP.

**Nenhum achado HIGH ou CRITICAL carregado adiante** ⇒ nenhum BloqueioHumano exigido por
este gate. SEC-1 e SEC-2 foram **corrigidos no artefato**, não aceitos como risco; SEC-3 é
controle já especificado a verificar na implementação; SEC-4/5/6 são pré-existentes ou já
satisfeitos.

---

## Complexity Tracking

**N/A — nenhuma violação de constitution a justificar.** A feature **não** adiciona serviço,
container, dependência, tabela, coluna nem índice. O único artefato novo é uma função no
banco, e ela existe para **satisfazer** requisitos (FR-017/FR-021/FR-023) que não são
atingíveis sobre PostgREST sem ela — não para generalizar nada.

Registrado para o revisor, por honestidade: a função é a peça de maior custo do plano.
A alternativa mais barata (`PATCH` com os predicados de guarda no `WHERE`) **satisfaria
FR-017**, e foi rejeitada por FR-021+FR-023 — precisa do `valor` anterior e da auditoria no
mesmo átomo (`research.md` Decision 5, *Alternatives considered*). Se o operador aceitar
afrouxar FR-023 para *best-effort*, o plano encolhe e a migration desaparece — mas isso é
decisão do operador sobre um requisito da spec, não do plano.

---

## Re-check de constitution (pós-Phase 1)

| Pergunta | Resposta |
|---|---|
| O design introduziu complexidade não justificada? | Não. Zero dependências, zero tabelas, zero índices, zero colunas, zero serviços. Quatro reusos (`buscarEmLotes`, `toTimestamptzMidnightSP`, `resolveEmpresaAlvo`, `Auditoria`) e uma função pedida por requisito. |
| Princípio II segue respeitado após o design? | **Sim, e foi reforçado**: o design torna o filtro explícito de `id_empresa` uma obrigação declarada em três lugares (consulta de casamento, parâmetro da função, `WHERE` da função), justamente porque se verificou que o banco **não** escopa a tabela. |
| Princípio V segue respeitado? | Sim — migration aditiva via `migrate.sh`, nenhum container afetado. |
| Algum MUST passou a FAIL? | Não. |

**Resultado do re-check: PASS.**

---

## Próximos passos

1. `/checklist` — quality gate dos requisitos antes de implementar.
2. `/create-tasks` — decompor em backlog.
3. `/analyze` — consistência cross-artifact depois das tasks.

⚠️ **Dependência de medição**: o gate de performance (SC-005) e a Decision 2 (nenhum índice
novo) dependem do `EXPLAIN (ANALYZE, BUFFERS)` do Cenário 12, a rodar **no ambiente do
hub** — ele não estava no ar quando o plano foi escrito (só `hub_homolog_frontend`,
`_backend`, `_traefik`), e medir em produção é vedado pela cláusula pétrea. Reprovou ⇒
reabrir a alternativa (B) de Decision 2, não "aceitar e seguir".

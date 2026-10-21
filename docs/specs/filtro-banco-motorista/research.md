# Research — filtro-banco-motorista (Phase 0)

Todas as decisões abaixo foram **medidas** contra o repo e a fixture real
(`node -e` descartável sobre `lib/fixtures/bancos-compe.json`, 463 bancos), não
inferidas. Nenhum `NEEDS CLARIFICATION` restante.

---

## Decision 1 — Onde vive o mapa de nomes comerciais

**Decision**: módulo novo `app_homologacao/backend/lib/bancos-busca.js`, exportando
a função de busca **e** a constante `APELIDOS_BANCOS`. Fonte única (FR-009).

**Rationale**: é a convenção declarada do repo ("a lógica pura testável extraída
para `lib/`" — CLAUDE.md), e `lib/` já tem 49 módulos nesse formato (`ls -1 lib/*.js | wc -l` = 49). A busca com
tiers é lógica pura (entrada: lista + termo; saída: lista ordenada) e fica testável
sem subir HTTP. A rota (`routes/motorista-adiantamento.js`, já com 979 linhas)
continua um one-liner que delega.

**Alternatives considered**:
- *Constante no módulo da rota*: aceitável em tamanho, mas a lógica de ranking
  ficaria sem teste unitário direto e a rota já é longa.
- *Campo na fixture COMPE* (`bancos-compe.json`): **descartado por restrição** — a
  §4 (Restrições) do BRIEFING.md da feature proíbe reescrever a fixture; apelido é camada de busca, nunca
  renomeação. A fixture tem `dataExtracao`/`fonte` e é regerável por
  `scripts/extrair-bancos-compe.js`; um campo editado à mão seria perdido na
  próxima extração.

---

## Decision 2 — Tiers de ordenação e critério de desempate

**Decision**: 4 tiers, avaliados em ordem, com **dedup** (um banco aparece uma única
vez, no melhor tier em que se qualifica). Desempate **dentro** de cada tier: ordem
estável da fixture (ordem do CSV do BCB); exceção T1, onde a ordem é a declarada no
mapa de apelidos.

| Tier | Nome | Regra |
|------|------|-------|
| T0 | código por prefixo | `codigo` começa com o termo |
| T1 | apelido mapeado | o termo é **prefixo de** um apelido → os códigos daquele apelido |
| T2 | nome começa com | nome normalizado começa com o termo |
| T3 | nome contém | nome normalizado contém o termo |

**Rationale do desempate**: ordem da fixture é o que a rota **já** faz hoje
(`todos.filter(...)` preserva a ordem do array), então adotá-la mantém a superfície
de regressão no mínimo (SC-004) e é determinística. Ordenar por código ou
alfabeticamente mudaria resultados hoje corretos sem ganho pedido.

**Rationale de T1 por prefixo do apelido** (e não igualdade exata): dá busca
progressiva — `n`, `nu`, `nub`, `nuba`, `nubank` todos levam a 260 — o que atende
literalmente o pedido do operador ("ao digitar `nu` o banco já deveria retornar")
**sem** precisar de uma entrada `nu` separada no mapa. `nubank` é a única chave.

**Resultados medidos** (prova de que os tiers produzem o pedido):

| Termo | Hoje | Com os tiers | Mecanismo |
|---|---|---|---|
| `nubank` | **0 itens** | `[260]` | T1 (`nubank` prefixo de `nubank`) |
| `nu` | 9 itens, **1º = 360 TRINUS** | 9 itens, **1º = 260** | T1 põe 260 antes de T2 (386, 419, 140) e T3 (360, 408, …) |
| `itau` | 1 item (**479**), 341 ausente | `[341, 479]` | T2 pega 341 (acento normalizado); T3 pega 479 |
| `mercado pago` | `[323]` | `[323]` | T1 |
| `picpay` | — | `[380, 079, 469]` | T1, na ordem do mapa (pagamento antes da DTVM) |
| `inter` | — | `[077, 525, 290]` | T1 = 077; T2 = 525; T3 = 290 (não exclui ninguém) |
| `c6` | — | `[336, 626]` | T1 (nenhum dos dois **começa** com "c6": ambos são "BCO C6 …") |
| `260` | `[260]` | `[260]` | T0 |

**Alternatives considered**: score numérico somado por sinal (peso de código + peso
de apelido + peso de prefixo). Descartado — mesma saída nos casos reais, com um
número mágico por sinal para justificar e depurar. Tier fechado é mais barato de ler
e de testar.

---

## Decision 3 — Normalização: reusar o helper, e o gap de whitespace

**Decision**: reusar `normalizarNome` de `lib/hub-motoristas-dto.js:56-62` (NFD +
strip de diacríticos + lowercase + trim) nos **dois** lados da comparação, e aplicar
em cima dele **duas** etapas que o helper não cobre:

1. colapso de espaços internos (`/\s+/` → um espaço);
2. se o termo normalizado não tem nenhum caractere alfanumérico, tratá-lo como vazio.

**Rationale**: medido — `normalizarNome` **não** colapsa espaço interno, e a spec
exige que `mercado  pago` (dois espaços) dê o mesmo resultado que `mercado pago`.
Medido também: `´` (U+00B4, acento solto) **não** é marca combinante, então NFD não o
remove e ele sobreviveria à normalização, fazendo a busca retornar 0 itens — a spec
exige que "acentos soltos" sejam tratados como vazio (lista limitada a 20). Ambas as
etapas verificadas: `mercado  pago` → `[323]`; `´` → 20 itens.

Isto **não** é uma segunda implementação de normalização de acento (o que FR-009
proíbe): a remoção de diacríticos continua vindo exclusivamente do helper reusado.

**Alternatives considered**: estender `normalizarNome` com o colapso de whitespace.
Descartado — o helper é consumido por `routes/hub-motoristas.js` (busca de motorista
por nome) e tem par funcional no SQL (`hub_normaliza_nome()`); mudá-lo arrastaria
risco para fora do escopo desta feature por conveniência.

---

## Decision 4 — Busca por código: prefixo, nunca trecho do meio

**Decision**: T0 compara `codigo.startsWith(termo)`, mantido exatamente como hoje.

**Rationale**: FR-005. Códigos COMPE são 3 dígitos com zero à esquerda (`001`,
`077`); prefixo é como o motorista lê o código no comprovante. Medido: `60` → `[604,
600]` e **não** devolve `260` — nenhum casamento de trecho do meio. Como nenhum
código contém letra, aplicar T0 incondicionalmente (sem testar se o termo é
numérico) é inócuo: um termo com letra nunca prefixa um código. Shortest diff.

---

## Decision 5 — FR-006: termo inteiro, nunca fragmentado

**Decision**: todos os 4 tiers comparam o termo **completo** como string única
(`startsWith`/`includes`). Em nenhum ponto o termo é tokenizado, dividido em
n-gramas ou casado por partes.

**Rationale**: é o que FR-006 proíbe — `banco` não pode devolver resultados por casar
"ban" ou "co". Medido: `banco` casa 31 bancos reais e é cortado em 20, e **100% dos
20 devolvidos contêm literalmente a palavra "banco" no nome** (verificado). Logo os
31 são resultado legítimo de um termo genérico, não descontrole de relevância; o teto
de 20 é o mecanismo que protege a tela do celular. Nenhuma mudança necessária.

---

## Decision 6 — Como o smoke HTTP sobe o processo (SC-005)

**Decision**: um arquivo de teste `tests/motorista-bancos-smoke.test.js` que sobe
`express` + o `router` real em `app.listen(0)`, com um middleware de 1 linha
simulando `authenticateMotorista`, e exercita os 7 casos via `fetch` global, imprimindo
tabela PASS/FAIL por caso. Rodável isolado (`node --test tests/motorista-bancos-smoke.test.js`)
e incluído em `npm test`.

**Rationale**: medido — o router **boota puro**, sem mock de `../lib/hub-postgrest`,
sem env, sem PostgREST e sem banco: `require('./routes/motorista-adiantamento.js')` +
`listen(0)` + `GET /motorista/bancos?q=260` devolveu `200
{"itens":[{"codigo":"260","nome":"NU PAGAMENTOS - IP"}]}`. A rota é fixture-em-memória
(o teste existente já assere `chamadasPostgrest.length === 0`), então o smoke não
precisa do `Module._load` de ~60 linhas do harness de rotas — são ~20 linhas. Node do
host é v22.22.3 (`node --version`, medido nesta onda), com `fetch` global, dispensando o
wrapper `node:http`.

Isso satisfaz "roda por HTTP, antes do merge" sem subir `server.js` completo — que
exigiria env, PostgREST e cunhar um JWT de motorista para passar pelo
`authenticateMotorista` real, sem exercitar nada a mais desta rota.

**Alternatives considered**:
- *Script `scripts/smoke-bancos.js` fora de `tests/`*: entregaria a mesma tabela, mas
  ficaria fora de `npm test` e seria um gate que ninguém roda por inércia.
- *Subir `server.js` + curl externo*: exige infra e segredo para zero cobertura
  adicional desta rota. Fica para o operador, pós-deploy, na tela real (fora de escopo).

---

## Decision 7 — Segurança do parâmetro `q`

**Decision**: (a) **proibido** construir `RegExp` a partir de `q` — a comparação é só
`startsWith`/`includes` sobre string normalizada; (b) `q` nunca entra em log; (c) cap
de 60 caracteres em `q` antes de normalizar.

**Rationale**: `q` é entrada de cliente, logo fronteira de confiança. Sem regex
derivada de input não há superfície de ReDoS. O cap existe porque `normalize('NFD')`
sobre string arbitrariamente longa é trabalho proporcional ao input vindo de fora; 60
é **exatamente** o comprimento do maior nome oficial da fixture (`332 ACESSO SOLUÇÕES
DE PAGAMENTO S.A. - INSTITUIÇÃO DE PAGAMENTO`, 60 caracteres; o 2º maior tem 59, e o
maior apelido tem 12) — medido, não estimado. Logo nenhuma busca legítima por nome
completo é truncada. E o truncamento é benigno mesmo se uma reextração futura trouxer
nome mais longo: o termo cortado segue sendo **prefixo** daquele nome, então T2 ainda
casa. Sem log porque o termo não tem valor
de auditoria e a rota não registra auditoria hoje.

Não há dado de tenant, PII ou segredo nesta rota: a fixture COMPE é lista pública e a
resposta é idêntica para todo motorista autenticado — nada a escopar por empresa
(Constitution II permanece satisfeita por vacuidade de dado de negócio).

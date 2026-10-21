# Quickstart — filtro-banco-motorista

Dois portões, nesta ordem: **controle negativo** (prova que o teste detecta o
defeito) e **smoke HTTP de 9 casos** (prova que a correção funciona). Ambos rodam
antes do merge, sem banco, sem PostgREST, sem deploy.

---

## Cenário 1 — Controle negativo (SC-002), ANTES de tocar a rota

Objetivo: provar que os testes novos falham pelo motivo certo. Um teste que passa
antes e depois da mudança não prova nada.

1. Na branch, escrever os testes novos (unit de `lib/bancos-busca.js` + smoke HTTP)
   **sem** ainda alterar `routes/motorista-adiantamento.js` nem criar
   `lib/bancos-busca.js` com os tiers.
2. Rodar:
   ```bash
   cd app_homologacao/backend
   node --test tests/motorista-bancos-smoke.test.js
   ```
3. Conferir **quais** casos falham, nome por nome — não basta "algum falhou".

**Expected** (medido contra o código de hoje):

| Caso | Hoje | Deve |
|---|---|---|
| `nubank` → 260 no topo | `{"itens":[]}` | **FALHAR** (ausência) |
| `itau` → 341 presente e antes de 479 | só `479 BCO ITAUBANK S.A.` | **FALHAR** (ausência) |
| `nu` → 260 no topo | acha 260, mas em 2º (1º é `360 TRINUS CAPITAL DTVM`) | **FALHAR** (posição) |
| `mercado pago` → 323 no topo | `[323]` já no topo | **PASSAR** nos dois lados (guarda)¹ |
| `260` → banco 260 | `[260]` | **PASSAR** nos dois lados (guarda) |
| `banco` → ≤ 20 e todo item contém "banco" | 31 cortados em 20 | **PASSAR** nos dois lados (guarda) |
| vazio → exatamente 20 | 463 cortados em 20 | **PASSAR** nos dois lados (guarda) |

Reprovados de hoje: **3** — `nubank`, `itau` e `nu`. Guardas de não-regressão: **4** —
`mercado pago`, `260`, `banco` e vazio.

¹ A redação original de FR-010/SC-002 listava `mercado pago` entre os reprovados e `nu`
entre as guardas. A medição inverteu os dois: `mercado pago` **já** devolve `323 MERCADO
PAGO IP LTDA.` como único resultado no topo (casa por substring do nome oficial) e `nu`
**reprova** por posição. A spec foi **emendada** (ver a nota sob FR-010 e SC-002); manter
a lista antiga faria o controle negativo incluir um caso que passa dos dois lados — ou
seja, um teste que não prova nada. **Declarar as duas correções no corpo do PR.**

**Se algum dos "deve FALHAR" passar**: o teste está oco — não prova nada. Corrigir o
teste antes de tocar a implementação.

4. Só então implementar `lib/bancos-busca.js` + ligar a rota, e seguir ao Cenário 2.

---

## Cenário 2 — Smoke funcional por HTTP (SC-001, SC-005)

Sobe o router real sobre HTTP de verdade, sem infra: `express` + `router` +
`app.listen(0)` + `fetch` global (Node v22.22.3). **Medido**: o router boota sem mock
de `../lib/hub-postgrest`, sem env e sem PostgREST — a rota é fixture-em-memória.
Um middleware de uma linha simula `authenticateMotorista`.

```bash
cd app_homologacao/backend
node --test tests/motorista-bancos-smoke.test.js
```

O arquivo imprime uma tabela PASS/FAIL por caso e sai non-zero se **qualquer** caso
reprovar.

**Expected — 9 de 9 PASS** (a tabela abaixo traz os 7 casos medidos no protótipo
do algoritmo, não supostos; o smoke implementado acrescentou mais 2 — `´` →
20 itens e as chaves hostis → 200 sem 500 — ver Emenda 2 sob FR-010 da spec):

| # | `q` | Asserção | Resultado medido |
|---|---|---|---|
| 1 | `nubank` | `itens[0].codigo === '260'` | `[260]` |
| 2 | `itau` | contém `341`, e `341` antes de `479` | `[341, 479]` |
| 3 | `mercado pago` | `itens[0].codigo === '323'` | `[323]` |
| 4 | `nu` | `itens[0].codigo === '260'` | `[260, 386, 419, 140, 360, …]` (9) |
| 5 | `260` | `itens` é exatamente `[{codigo:'260',nome:'NU PAGAMENTOS - IP'}]` | idem |
| 6 | `banco` | `itens.length <= 20` **e** todo item contém a **substring** `banco` no nome (não a palavra — `081 BANCOSEGURO S.A.` é resultado legítimo) | 20 itens, 100% contêm | 
| 7 | *(sem `q`)* | `itens.length === 20` | 20 itens |

### O laço (requisito do operador, SC-005)

```text
rodar portão  →  7/7 ?  →  sim → libera para merge
                   │
                   não → ajustar código
                          → rodar a suíte COMPLETA de novo (não só o caso que falhou)
                          → repetir o portão DO ZERO
```

Qualquer caso reprovado **bloqueia a promoção**. Não vale re-rodar só o caso que
falhou: o ajuste pode ter quebrado outro. O portão inteiro reinicia, sempre.

---

## Cenário 3 — Roundtrip de borda (backend ↔ app motorista)

Verifica que a resposta real casa o contrato que o cliente já consome, sem mock.

1. Com o servidor do Cenário 2 no ar, capturar o payload real de
   `GET /motorista/bancos?q=nubank`.
2. Comparar o *shape* contra `interface Banco { codigo: string; nome: string }`
   (`frontend_motorista/lib/adiantamento-api.ts`).

**Expected**: `{"itens":[{"codigo":"260","nome":"NU PAGAMENTOS - IP"}]}` — exatamente
duas chaves por item, ambas string, `ispb` ausente. Nenhuma mudança de cliente
necessária (FR-008).

Observação: as duas camadas usam **camelCase** e o payload não tem campo composto,
então não há a classe de drift snake_case↔camelCase que exigiria mapper.

---

## Cenário 4 — Não-regressão dos testes existentes (FR-008, SC-004)

```bash
cd app_homologacao/backend
node --test tests/motorista-adiantamento-rotas-unit.test.js
node --test tests/adiantamento-bancos-compe-unit.test.js
```

**Expected** — os 4 testes de `describe('GET /motorista/bancos')` continuam verdes,
em especial os dois sensíveis a ordem/forma:

| Teste existente | Por que sobrevive (medido) |
|---|---|
| `q=260` com `assert.deepEqual(itens, [{codigo:'260',nome:'NU PAGAMENTOS - IP'}])` — **asserção exata** | T0 casa só o código 260; nenhum nome contém "260" e não há apelido `260` ⇒ resultado de 1 item, idêntico |
| `q=BRASILIA` espera `070` presente | normaliza para `brasilia`; `BRB - BCO DE BRASILIA S.A.` casa em T3 ⇒ `[070]` |
| sem `q` ⇒ ≤ 20 itens e **nenhuma RPC** | lista cortada em 20; nada de PostgREST |
| `q=zzzznaoexiste` ⇒ `itens` vazio | nenhum tier casa ⇒ `[]` |

E a suíte da fixture passa inalterada — a fixture não é tocada.

---

## Cenário 5 — Suíte completa (portão final antes do PR)

```bash
cd app_homologacao/backend
npm test
node scripts/checar-testes-orfaos.js
```

**Expected**: suíte verde, com números relatados, e o checador de órfãos sem achado
— ou seja, `tests/motorista-bancos-smoke.test.js` (e o unit de `bancos-busca`) foram
**registrados na lista explícita** do script `test` do `package.json`. Arquivo de
teste não registrado é teste que nunca roda.

---

## Fora destes cenários (do operador, pós-merge)

Confirmação na tela real: abrir o cadastro de conta bancária no app motorista,
digitar `nubank` e ver o banco aparecer. O agente prova apenas que o código servido é
o novo — a conferência visual é do operador (spec §Fora de escopo).

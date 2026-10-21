# Implementation Plan — Busca de banco pelo nome que o motorista conhece

**Feature**: `filtro-banco-motorista`
**Spec**: [`spec.md`](./spec.md) · **Research**: [`research.md`](./research.md) ·
**Data model**: [`data-model.md`](./data-model.md) ·
**Contrato**: [`contracts/bancos-api.md`](./contracts/bancos-api.md) ·
**Quickstart**: [`quickstart.md`](./quickstart.md)
**Branch a criar**: `fix/filtro-banco-motorista` (branch atual é `main` — nunca commitar nela)

## Summary

Hoje o motorista só acha o banco se souber o código ou a razão social exata. Duas
causas medidas: acento que o teclado do celular não produz (`itau` não acha `341
ITAÚ UNIBANCO`), e marca diferente da razão social (`nubank` não acha nada).

A correção é **backend-only**: extrair a busca da rota para `lib/bancos-busca.js`,
normalizar os dois lados com o helper que já existe, somar um mapa de apelidos de 5
marcas e ordenar o resultado em 4 tiers. Nem o contrato nem o cliente nem a fixture
COMPE mudam. Diff: 1 arquivo novo em `lib/`, as 6 linhas do handler da rota
(733-738) trocadas por ~3, 2 arquivos de teste novos, e 1 linha do `package.json`
(onde entram os 2 caminhos de teste).

**Sem banco, sem PostgREST, sem migration, sem RLS, sem índice, sem cache** — a
fixture de 463 bancos já está em memória por `require`.

## Technical Context

| Campo | Valor |
|---|---|
| Linguagem/runtime | Node.js — host **v22.22.3** (`node --version`, medido nesta onda); imagem de produção `node:20-alpine` (`Dockerfile.hub` — `CLAUDE.md` §Comandos) |
| Framework | Express (router existente) |
| Dependências novas | **nenhuma** |
| Persistência | nenhuma — fixture JSON em memória (`lib/fixtures/bancos-compe.json`, 463 bancos) |
| Testes | `node --test` (node:test + node:assert/strict) |
| Plataforma | container do backend em Docker Swarm (inalterado) |
| Escala | 463 itens, varredura linear por requisição; sem índice, sem cache |
| Frontend | **não tocado** (conclusão medida — ver §Convenções de Borda) |

**Target Platform**: container do backend (`node:20-alpine`, `Dockerfile.hub`) em Docker
Swarm, inalterado — fonte: `docs/constitution.md` §V e `CLAUDE.md` §Comandos.

Nenhum `NEEDS CLARIFICATION` — o clarify fechou sem perguntas e as 7 decisões do
Phase 0 estão resolvidas com medição.

## Constitution Check

*GATE antes do Phase 0; re-checado após o Phase 1 (§Re-check).*

| Princípio | Status | Notas |
|---|---|---|
| I. Autenticação & Segredos (NON-NEGOTIABLE) | PASS | Rota já atrás de `authenticateMotorista`; nenhum segredo, token ou hash tocado. |
| II. Isolamento Multi-Tenant (NON-NEGOTIABLE) | PASS | A fixture COMPE é lista pública, idêntica para todo motorista; nenhum dado de negócio e nenhum id lido de query/corpo (só `q`, um termo de busca). |
| III. Contratos de API & Proxy | PASS | Forma da resposta inalterada (`{itens:[{codigo,nome}]}`); cliente não requer mudança. Contrato documentado em `contracts/bancos-api.md`, extraído do código real. |
| IV. Qualidade e Revisão | PASS | Branch dedicada, Conventional Commits, teste por FR, controle negativo, `git add` por caminho explícito. |
| V. Deploy Conteinerizado (NON-NEGOTIABLE) | N/A | Nenhum serviço, container, label ou env novo. Deploy é do operador, fora de escopo. |

Zero violações ⇒ §Complexity Tracking vazio.

## Algoritmo de busca

### Normalização do termo (e do nome), em 3 etapas

1. **Cap de tamanho**: `q` truncado em **60 caracteres** antes de qualquer trabalho
   (fronteira de confiança — research.md Decision 7).
2. **`normalizarNome`** de `lib/hub-motoristas-dto.js:56-62`, **reusado por import**
   (FR-009): NFD + strip de diacríticos + lowercase + trim. Aplicado nos **dois**
   lados da comparação.
3. **Duas etapas em cima do helper** — gaps medidos que ele não cobre:
   - colapso de espaços internos (`mercado  pago` ≡ `mercado pago`; o helper só faz
     `trim`, não colapsa interno);
   - termo sem nenhum caractere alfanumérico ⇒ tratado como **vazio**. Necessário
     porque `´` (U+00B4) não é marca combinante e sobrevive ao NFD; sem esta etapa
     um acento solto retornaria 0 itens, e a spec exige lista limitada a 20.

   Isto **não** duplica a normalização de acento: os diacríticos continuam saindo
   exclusivamente do helper reusado.

### Os 4 tiers

Avaliados em ordem; concatenados; **dedup** — um banco aparece **uma única vez**, no
melhor tier em que se qualificou.

| Tier | Nome | Regra | Desempate interno |
|---|---|---|---|
| **T0** | código por prefixo | `codigo` começa com o termo | ordem da fixture |
| **T1** | apelido mapeado | termo é **prefixo de** um apelido ⇒ os códigos daquele apelido | **ordem declarada no mapa** |
| **T2** | nome começa com | nome normalizado começa com o termo | ordem da fixture |
| **T3** | nome contém | nome normalizado contém o termo | ordem da fixture |

Resultado final cortado em **20** itens (teto mantido — FR-004).

**Critério de desempate, declarado**: dentro de T0/T2/T3, a ordem é a **ordem estável
da fixture** (ordem do CSV do BCB). É exatamente o que a rota já faz hoje
(`todos.filter(...)` preserva a ordem do array), então adotá-la mantém a superfície
de regressão no mínimo e é determinística. Em T1, a ordem é a declarada no mapa — o
único lugar onde se ajusta qual banco de uma marca aparece primeiro.

**T1 casa por prefixo do apelido** (não igualdade): dá busca progressiva — `n`,
`nu`, `nub`, … `nubank` todos levam a `260` — atendendo literalmente o pedido do
operador sem precisar de uma chave `nu` separada.

### Por que os tiers produzem o que foi pedido (medido)

| `q` | Hoje | Depois | Mecanismo |
|---|---|---|---|
| `nubank` | **0 itens** | `[260]` | T1 |
| `nu` | 9 itens, **1º = `360 TRINUS`** | 9 itens, **1º = `260`** | T1 põe 260 à frente de T2 (386, 419, 140) e T3 (360, 408, 444, 511, 508) |
| `itau` | `[479]`, **341 ausente** | `[341, 479]` | T2 pega 341 (acento normalizado); T3 pega 479 — **341 antes de 479** |
| `itaú` | `[341]` | `[341, 479]` | mesma normalização ⇒ mesmo resultado que `itau` |
| `mercado pago` | `[323]` | `[323]` | T1 (e T2 dedup) |
| `picpay` | — | `[380, 079, 469]` | T1, na ordem do mapa (pagamento antes da DTVM — ver data-model.md inv. 3) |
| `inter` | — | `[077, 525, 290]` | T1=077, T2=525, T3=290 — marca primeiro, **sem excluir** os outros |
| `c6` | — | `[336, 626]` | T1 (nenhum dos dois *começa* com "c6": ambos são `BCO C6 …`) |
| `260` | `[260]` | `[260]` | T0 |

**A busca não escolhe pelo motorista**: `picpay` mostra as 3 entradas, `inter` mostra
as 3, `c6` mostra as 2. Ele escolhe.

### Código: prefixo, nunca trecho do meio (FR-005)

T0 compara `codigo.startsWith(termo)` — inalterado. Medido: `60` → `[604, 600]` e
**não** devolve `260`. Como nenhum código COMPE contém letra, aplicar T0 sem testar
se o termo é numérico é inócuo (termo com letra nunca prefixa um código) e é o diff
mais curto.

### Termo inteiro, nunca fragmentado (FR-006)

Os 4 tiers comparam o termo **completo** como string única (`startsWith`/`includes`).
Em nenhum ponto o termo é tokenizado, dividido em n-gramas ou casado por partes — é
exatamente o que FR-006 proíbe (`banco` não pode casar "ban" ou "co").

Medido: `banco` casa **31** bancos reais, cortados em 20, e **100% dos 20 devolvidos
contêm literalmente a palavra "banco"** no nome oficial. Logo os 31 são resultado
legítimo de um termo genérico, não descontrole de relevância; o teto de 20 é o que
protege a tela do celular. **Nenhuma mudança necessária** para FR-006.

## Interface de `lib/bancos-busca.js` [PROPOSTA — módulo novo]

Contrato do módulo, para a decomposição em tarefas não precisar adivinhar. Assinaturas,
não implementação.

| Export | Tipo | Assinatura / forma |
|---|---|---|
| `APELIDOS_BANCOS` | `Object<string, string[]>` | apelido normalizado → códigos, na ordem de exibição (data-model.md) |
| `normalizarTermo` | função | `(texto: string) => string` — cap de 60 → `normalizarNome` (importado) → colapso de `\s+` → `''` se não houver alfanumérico |
| `buscarBancos` | função | `(todos: Banco[], termo: string, limite = 20) => Banco[]` |

**Injeção de dependência**: `buscarBancos` recebe a lista por parâmetro — **não** dá
`require` na fixture. Isso mantém o módulo puro e deixa o teste unitário passar listas
sintéticas pequenas. Quem dá `require('../lib/fixtures/bancos-compe.json')` continua
sendo a rota, como hoje (linha 40). É o mesmo padrão de `validarBanco(codigo,
bancosDisponiveis)` no app motorista.

**Divisão de responsabilidade**:

| Responsabilidade | Onde |
|---|---|
| normalização, 4 tiers, dedup, **aplicação do teto** | `lib/bancos-busca.js` (`buscarBancos` já devolve ≤ `limite`) |
| `require` da fixture, leitura de `req.query.q` (com o guard `typeof === 'string'`), projeção `{codigo, nome}` e `res.json` | a rota |

A rota fica com ~3 linhas: guard de tipo, chamada a `buscarBancos`, `res.json` do
`map` para `{codigo, nome}`. A projeção fica na rota porque é forma de resposta HTTP, não
regra de busca — e porque é o que mantém `ispb` fora do payload sem a lib saber de HTTP.

`normalizarTermo` é exportado (não só interno) porque o teste de invariante do mapa
precisa dele para assertar que toda chave de `APELIDOS_BANCOS` já está normalizada.

## Rastreabilidade — FR/SC → teste

FR-010 exige teste automatizado por requisito. `U` = `tests/bancos-busca-unit.test.js`,
`S` = `tests/motorista-bancos-smoke.test.js`, `E` = teste já existente.

| Req | Arquivo | Caso |
|---|---|---|
| FR-001 (acento nos 2 lados) | U, S | `itau`→341; `itaú`≡`itau`; nome oficial sem acento buscado **com** acento |
| FR-002 (5 marcas) | U | `nubank`→260; `mercado pago`→323; `picpay`→380/079/469 nessa ordem; `inter`→077 1º; `c6`→336/626 |
| FR-003 (só camada de busca) | U | cada item devolvido é idêntico à entrada da fixture (código **e** nome) |
| FR-004 (relevância + teto 20) | U, S | ordem dos tiers; `banco`→20 itens |
| FR-005 (código por prefixo) | U, E | `260`→1 item; `60`→604/600 e **não** 260 |
| FR-006 (termo inteiro) | U, S | `banco`: todo item contém a **substring** "banco" (não a palavra: `081 BANCOSEGURO S.A.` entra); nenhum casamento de fragmento |
| FR-007 (vazio ⇒ 20) | U, S, E | `''`, `'   '`, `'´'` → 20 itens |
| FR-008 (contrato compatível) | S, E | `deepEqual` exato de `q=260`; shape `{codigo,nome}` sem `ispb` |
| FR-009 (reuso + fonte única) | U | `normalizarTermo` delega a `normalizarNome`; mapa importado, nunca redeclarado; todo código do mapa existe na fixture; toda chave já normalizada |
| FR-010 (controle negativo) | S | quickstart Cenário 1: `nubank`/`itau`/`nu`/`´` reprovam antes (4 casos — Emenda 2 da spec; medido 5 pass / 4 fail) |
| SC-001 (9 casos) | S | os 9, com tabela PASS/FAIL (eram 7 no plano original — Emenda 2 da spec) |
| SC-002 (negativo) | S | idem FR-010 |
| SC-003 (5 marcas numa busca) | U | idem FR-002 — **não** está nos 9 casos do smoke; a cobertura das 5 marcas é unit |
| SC-004 (zero regressão) | U, E | 82 pass/0 fail da baseline; `itaú` segue achando 341; item idêntico à fixture |
| SC-005 (smoke em laço) | S | exit non-zero em qualquer reprovado (o laço é procedimento, quickstart §Cenário 2) |
| *(sem FR — decisão do plano)* cap de 60 em `q` | U | termo de 200 caracteres não estoura e é tratado como os 60 primeiros |
| *(sem FR — decisão do plano)* guard de tipo de `q` | U, S | `?q=a&q=b` (array) e `?q[x]=1` (objeto) ⇒ tratados como termo vazio, não 500 |

As duas últimas linhas **não** derivam de FR da spec: são decisões de robustez deste
plano (research.md Decision 7 + notas do gate de segurança). Ficam registradas aqui para
não entrarem no código sem teste nem rastro.

## Project Structure

### Documentação (esta feature)

```text
docs/specs/filtro-banco-motorista/
├── spec.md
├── plan.md               (este arquivo)
├── research.md           (7 decisões do Phase 0)
├── data-model.md         (Banco + mapa de apelidos)
├── quickstart.md         (5 cenários: controle negativo, smoke, roundtrip, não-regressão, suíte)
└── contracts/bancos-api.md
```

### Código (árvore real; `+` novo, `~` alterado)

```text
app_homologacao/backend/
├── lib/
│   ├── bancos-busca.js                      + função de busca + APELIDOS_BANCOS (fonte única)
│   ├── hub-motoristas-dto.js                  (reusado: normalizarNome — NÃO alterado)
│   └── fixtures/bancos-compe.json             (NÃO alterado — proibido)
├── routes/
│   └── motorista-adiantamento.js            ~ linhas 733-738: delega para lib/bancos-busca
├── tests/
│   ├── bancos-busca-unit.test.js            + tiers, dedup, normalização, apelidos, invariantes
│   ├── motorista-bancos-smoke.test.js       + smoke HTTP, 9 casos, tabela PASS/FAIL
│   └── motorista-adiantamento-rotas-unit.test.js   (NÃO alterado — os 4 testes atuais sobrevivem)
└── package.json                             ~ registrar os 2 arquivos novos no script `test`

app_homologacao/frontend_motorista/          (NADA — conclusão medida)
```

**`package.json`**: o script `test` é uma **lista explícita** de arquivos. Os dois
testes novos precisam ser registrados lá, ou nunca rodam. `scripts/checar-testes-orfaos.js`
existe exatamente para pegar isso e entra no portão final.

## Convenções de Borda

Atravessa uma borda: backend ↔ app motorista. O app **não** chama o backend direto: ele
tem **proxy próprio** em `frontend_motorista/app/api/[...path]/route.ts` ("Proxy reverso
para o backend Express"), e o cliente usa `const BASE = '/api'`
(`frontend_motorista/lib/api-client.ts:7`) — mesmo padrão do `frontend_v2`, com ajuste de
origem. O browser nunca fala com o backend direto, o que mantém Constitution III
satisfeita. Nada disso muda nesta feature (o proxy repassa `?q=` sem interpretar).

| Camada | Case style | Validação | Fonte da verdade |
|---|---|---|---|
| Fixture JSON (`bancos-compe.json`) | camelCase (`dataExtracao`) | teste de invariante da fixture | `lib/fixtures/bancos-compe.json` |
| Backend response | camelCase (`codigo`, `nome`, `itens`) | asserções do teste de rota | `contracts/bancos-api.md` |
| Cliente TS (app motorista) | camelCase | `interface Banco` (tipagem `tsc`) | `frontend_motorista/lib/adiantamento-api.ts:225-228` |
| URL query param | `q` (uma letra, minúscula) | — | mesma rota |

**Mapper layer (DB ↔ DTO)**: **N/A** — não há banco nem ORM nesta feature. A rota
projeta `{codigo, nome}` a partir da fixture e omite `ispb`.

**Validação Zod**: **N/A** — o projeto não usa Zod nesta borda; o cliente tipa por
`interface` e valida o banco escolhido por **código** contra a lista viva
(`validarBanco(codigo, bancosDisponiveis)`).

**Sem drift snake_case↔camelCase possível**: as duas pontas são camelCase, nenhum
campo composto, nenhum campo novo. O roundtrip real está no Cenário 3 do quickstart.

## Riscos e o que os contém

| Risco | Contenção |
|---|---|
| Apelido aponta para código que não existe (ou sai numa reextração da fixture) | Teste de invariante: todo código do mapa existe na fixture (data-model.md inv. 1) |
| Mudança de ordem quebra teste existente de asserção exata (`q=260`) | Medido: T0 casa só o 260, nenhum nome contém "260", nenhum apelido `260` ⇒ resultado idêntico de 1 item |
| Apelido vira renomeação disfarçada | O `nome` devolvido vem **sempre** da fixture; o mapa só contém códigos. Teste: **cada item devolvido é idêntico à entrada da fixture — mesmo `codigo` e mesmo `nome`** (SC-004). *(Não vale testar "a resposta não contém o apelido digitado": `inter` devolve `BANCO INTER`, `picpay` devolve `PICPAY …` — o apelido coincide com o nome oficial e o teste seria contraditório.)* |
| Mapa duplicado (rota + lib, ou lib + teste) | Fonte única em `lib/bancos-busca.js`; os testes **importam** a constante, nunca a redeclaram |
| Teste novo não registrado no `package.json` | `node scripts/checar-testes-orfaos.js` no portão final |
| ReDoS por `q` | **Proibido** construir `RegExp` a partir de `q`; só `startsWith`/`includes` em string normalizada |
| `q` arbitrariamente longo normalizado | Cap de 60 caracteres antes de normalizar |
| `q` vazando em log | `q` não entra em log — a rota não registra auditoria e não deve passar a registrar |
| `?q=a&q=b` (array) ou `?q[x]=1` (objeto) mudando o contrato calado | **Preservar o guard `typeof req.query.q === 'string'`** que a rota já tem ao extrair para a lib; não-string ⇒ termo vazio |
| Leitura de protótipo no mapa de apelidos | **Proibido** consultar o mapa por chave (`mapa[q]`, `q in mapa`): `q=constructor`/`__proto__` devolveria função de `Object.prototype` ⇒ 500. T1 **itera** (`Object.entries`), o que já é seguro |

## Limitação conhecida (medida) — prefixo "banco " + marca

Consequência direta de FR-006 (termo inteiro, nunca fragmentado), medida com o algoritmo
proposto:

| Termo | Resultado |
|---|---|
| `banco nubank` · `banco c6` · `banco itau` · `banco picpay` · `banco mercado pago` | **0 itens** |
| `banco inter` | `[077 BANCO INTER]` — acha por acidente, porque o nome oficial é literalmente "BANCO INTER" |

É digitação natural, então vale declarar em vez de descobrir em produção. **Não está no
escopo desta entrega** (nem a spec nem o briefing pedem), e o motorista acha o banco
digitando só a marca.

Correção, **se** o operador quiser depois: tratar um `banco ` inicial como stopword e
repetir a busca sem ele — uma linha, e **não** viola FR-006 (continua casando o termo
inteiro após remover o prefixo, nunca fragmentos). Fica como decisão do operador, não
como scope creep desta entrega.

## Segurança — veredito do gate

`owasp-security` rodou sobre este plano: **clean, 0 findings** (0 critical / 0 high /
0 medium / 0 low). Medido pelo gate: nenhuma `RegExp` derivada de `q`; as regexes
constantes (strip de diacríticos, colapso de espaço, teste de alfanumérico) são
lineares e rodam sobre ≤ 60 caracteres; sem SQL, PostgREST, arquivo ou shell; `q` não
é refletido na resposta nem logado; a fixture não é mutada (`slice`/`map` criam
objetos novos).

**Rate limit: dispensado, com fundamento.** 0,13 ms por requisição mesmo normalizando
os 463 nomes a cada chamada; `authenticateMotorista` é `jwt.verify` sem I/O; o app já
faz debounce; e o contrato do projeto declara que leituras seguem sem limiter próprio
(`GET /conta-bancaria`, que chama PostgREST, é mais caro e também não tem). Um limiter
apertado quebraria a busca-conforme-digita sem ganho.

**Cap de 60 é higiene, não a barreira**: o Node já limita o header a ~16 KB, e NFD de
16 KB leva 0,02 ms. Mantido porque é de graça e torna termo maior semanticamente
irrelevante. NFD expande no máximo ~3× (o plano **não** usa NFKD, que expandiria 18×).

As duas notas INFO do gate foram incorporadas à tabela de riscos acima (guard de tipo
de `q`; proibição de lookup por chave no mapa de apelidos).

## Gates — o que roda e o que não roda

**Roda:**

| Gate | Comando | Quando |
|---|---|---|
| Controle negativo | `node --test tests/motorista-bancos-smoke.test.js` **antes** de implementar | obrigatório, 1º |
| Unit da lib | `node --test tests/bancos-busca-unit.test.js` | por FR |
| Smoke HTTP 9 casos | `node --test tests/motorista-bancos-smoke.test.js` | portão de promoção |
| Não-regressão | `node --test tests/motorista-adiantamento-rotas-unit.test.js tests/adiantamento-bancos-compe-unit.test.js` | antes do PR |

**Baselines medidas nesta onda** (antes de qualquer mudança) — são os números contra os
quais comparar; qualquer `fail` depois da mudança é regressão desta entrega, não falha
herdada:

| Escopo | Comando | Resultado |
|---|---|---|
| Não-regressão `/bancos` + fixture | `node --test tests/adiantamento-bancos-compe-unit.test.js tests/motorista-adiantamento-rotas-unit.test.js` | **82 pass / 0 fail** (2,4 s) |
| Suíte completa do backend | `npm test` | **1941 pass / 0 fail**, 389 suites (7,0 s) |

A suíte do backend está **verde sem falha herdada** — diferente da baseline de lint do
app motorista (vermelha pré-existente). Logo, aqui, vermelho é regressão.
| Suíte completa | `npm test` (backend), com números relatados | antes do PR |
| Órfãos | `node scripts/checar-testes-orfaos.js` | antes do PR |

**NÃO roda, e por quê (medido):**

- **`next build`** — nenhum arquivo do `frontend_motorista` é tocado. `buscarBancos`
  já repassa o termo e `validarBanco` casa por código contra a lista viva; forma e
  códigos não mudam (FR-008).
- **Testes do app motorista** — mesma razão. (E, quando rodam, é `node --test`, não
  vitest — o vitest é do `frontend_v2`.)
- **ESLint do app motorista** — o app **não tem config de eslint**: baseline vermelha
  pré-existente, não é regressão desta entrega.
- **E2E do hub / `test:hub:integration`** — o hub não é tocado.
- **`docker build` / `df -h /`** — não há build nesta entrega. (Nota: `/` está com
  **20 GB livres** (`df -h /` → `150G 125G 20G 87%`, medido nesta onda em 21/10 — valor
  transitório, reconferir na hora), no limite da regra dos ~20 GB; se um build entrar no
  escopo depois, conferir disco e swap antes.)
- **`tsc --noEmit` e lint do backend** — o backend é JS sem TypeScript e **não tem
  script de lint** no `package.json`. O gate 1 do rito pede lint comparado com a
  baseline; aqui não há baseline porque não há lint. O `tsc` do rito se aplica ao
  frontend, que não é tocado.

**Rollback**: reverter o PR (a mudança é backend-only, sem migration e sem estado). Se
já tiver ido a produção, voltar à imagem anterior anotada por `docker service ls` —
procedimento do operador, fora de escopo.

**Performance**: medida pelo gate de segurança em **0,13 ms por requisição**, mesmo
normalizando os 463 nomes a cada chamada. O briefing §5 pede atenção a performance; esse
é o número, e não justifica índice nem cache (ponytail: não adicionar camada sem medição
que a peça).

## Ordem de implementação

1. Criar branch `fix/filtro-banco-motorista`.
2. Escrever os testes (unit + smoke) **primeiro**; rodar o **controle negativo** e
   conferir que os 3 casos esperados falham, **nome por nome** (quickstart Cenário 1).
3. Criar `lib/bancos-busca.js`: `APELIDOS_BANCOS` + função de busca (normalização de
   3 etapas, 4 tiers, dedup, teto).
4. Trocar o corpo de `GET /bancos` para delegar à lib (a rota fica um one-liner).
5. Registrar os 2 testes no script `test` do `package.json`.
6. Rodar o portão: unit → smoke 7/7 → não-regressão → `npm test` → órfãos.
7. Qualquer reprovado ⇒ ajustar e **reiniciar o portão do zero** (suíte completa, não
   só o caso que falhou).
8. Commit (Conventional Commits, `git add` por caminho explícito), PR com números e
   com a correção de SC-002 declarada (`mercado pago` já passava hoje — ver
   quickstart Cenário 1, nota ¹).

## Re-check de Constitution (pós-Phase 1)

| Pergunta | Resposta |
|---|---|
| O design introduziu complexidade não justificada? | Não. 1 módulo em `lib/` (convenção do repo), 0 dependências, 0 abstração com uma implementação, 0 config para valor que não muda. |
| Algum MUST deixou de ser respeitado? | Não — os 5 princípios seguem PASS/N/A pelos mesmos motivos da tabela inicial. |
| Surgiu camada nova (serviço, persistência, cache)? | Não. |

Veredito: **PASS**, sem itens em Complexity Tracking.

## Complexity Tracking

Vazio — nenhuma violação de constitution a justificar.

## Fora de escopo

- Deploy e confirmação na tela real do app (do operador — spec §Fora de escopo).
- Reescrever, renomear ou reordenar a fixture COMPE.
- Busca aproximada/fuzzy ou casamento por pedaços do termo (descartado pelo operador).
- Alterar `normalizarNome` (tem outros consumidores e par funcional no SQL).
- Qualquer mudança de banco, migration, permissão ou tela.

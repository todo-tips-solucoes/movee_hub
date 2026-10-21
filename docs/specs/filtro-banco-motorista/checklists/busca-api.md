# Checklist de Requisitos: Busca de banco pelo nome que o motorista conhece

**Purpose**: validar a QUALIDADE dos requisitos (spec + plan), nao o codigo. Dominios: contrato de API, seguranca, performance, testabilidade.
**Created**: 2026-10-21
**Feature**: [spec.md](../spec.md) · [plan.md](../plan.md) · [research.md](../research.md) · [data-model.md](../data-model.md) · [contracts/bancos-api.md](../contracts/bancos-api.md) · [quickstart.md](../quickstart.md)

Legenda: `{auto}` verificavel por leitura/medicao dos artefatos; `{humano}` depende de decisao do operador (nao bloqueia o avanco).

## 1. Os 7 casos do smoke — veredito certo de cada um (SC-001/SC-002/FR-010)

Regra: item que passa ANTES e DEPOIS da mudanca e **guarda de nao-regressao** e NAO prova a correcao; so os reprovados provam.

- [x] CHK001 - Os 7 casos estao enumerados com o resultado esperado exato (`nubank`, `itau`, `mercado pago`, `nu`, `260`, `banco`, vazio)? [Completude, Spec §SC-001] {auto}
- [x] CHK002 - `nubank` esta classificado como REPROVADO hoje (0 itens) e e prova da correcao: espera `260` em 1o? [Mensurabilidade, Spec §SC-002] {auto}
- [x] CHK003 - `itau` esta classificado como REPROVADO hoje (acha so `479`, nao `341`) e e prova: espera `341` presente e antes de `479`? [Mensurabilidade, Spec §SC-002] {auto}
- [x] CHK004 - `nu` esta classificado como REPROVADO hoje **por posicao** (1o e `360 TRINUS CAPITAL DTVM`, nao `260`) e e prova: espera `260` em 1o? [Mensurabilidade, Spec §FR-010 emenda] {auto}
- [x] CHK005 - `mercado pago` esta classificado como GUARDA (ja devolve `323`, por substring do nome oficial) e NAO e contado como prova da correcao? [Consistencia, Spec §FR-010 emenda] {auto}
- [x] CHK006 - `260`, `banco` e vazio estao classificados como GUARDA de nao-regressao, nao como prova? [Consistencia, Spec §FR-010] {auto}
- [x] CHK007 - O controle negativo exige conferir QUAIS casos falham (exatamente `nubank`, `itau`, `nu`), nome por nome, e nao so que "algum teste falha"? [Mensurabilidade, quickstart §Cenario 1] {auto}
- [x] CHK008 - A asserção de `banco` esta operacionalizada como SUBSTRING no nome oficial (`081 BANCOSEGURO S.A.` e legitimo), e nao como "palavra" (que falharia falsamente)? [Clareza, Spec §SC-001] {auto}
- [x] CHK009 - SC-003 (as 5 marcas numa busca) esta coberto por teste unit, ja que as 5 marcas NAO estao todas nos 7 casos do smoke? [Rastreabilidade, plan §Rastreabilidade] {auto}

## 2. Gaps de normalizacao achados pelo plan

- [x] CHK010 - Ha requisito/teste para espaco interno multiplo (`mercado  pago` com 2 espacos ≡ `mercado pago`), dado que `normalizarNome` so faz `trim` e NAO colapsa espaco interno? [Gap fechado, plan §Normalizacao etapa 3; Spec §Edge Cases] {auto}
- [x] CHK011 - Ha requisito/teste para `´` (U+00B4), que NAO e marca combinante e sobrevive ao NFD: termo sem alfanumerico ⇒ tratado como vazio ⇒ 20 itens (e nao 0)? [Gap fechado, plan §Normalizacao; Spec §FR-007] {auto}
- [x] CHK012 - O colapso de espaco e a guarda de alfanumerico ficam EM CIMA do helper reusado, sem reimplementar a remocao de diacriticos (FR-009)? [Consistencia, plan §Normalizacao] {auto}
- [x] CHK013 - O reuso de `normalizarNome` (`lib/hub-motoristas-dto.js:56`, exportado) esta decidido e medido, e o plan registra que ele NAO e alterado (tem outros consumidores)? [Rastreabilidade, research.md; plan §Fora de escopo] {auto}
- [x] CHK014 - Esta registrado que se buscou helper/modulo existente antes de criar `lib/bancos-busca.js` (o unico modulo novo; 0 dependencias; 0 abstracao de implementacao unica)? [Consistencia, plan §Re-check] {auto}

## 3. Regras de implementacao vindas do gate de seguranca (INFO)

- [x] CHK015 - E requisito explicito PRESERVAR o guard `typeof req.query.q === 'string'`; nao-string (`?q=a&q=b`, `?q[x]=1`) ⇒ termo vazio, nao 500? [Seguranca, plan §Riscos] {auto}
- [x] CHK016 - E PROIBIDO consultar o mapa de apelidos por chave (`mapa[q]`, `q in mapa`)? `q=constructor`/`__proto__` devolveria funcao de `Object.prototype` ⇒ 500; T1 deve ITERAR (`Object.entries`). [Seguranca, plan §Riscos] {auto}
- [x] CHK017 - Ha teste que exerce `q=constructor` e `q=__proto__` (resposta 200, sem 500), e teste do guard de tipo? [Rastreabilidade, plan §Rastreabilidade] {auto}
- [x] CHK018 - E PROIBIDO construir `RegExp` a partir de `q` (ReDoS); so `startsWith`/`includes` em string normalizada? [Seguranca, plan §Riscos] {auto}
- [x] CHK019 - O cap de 60 caracteres em `q` esta declarado como higiene (nao como barreira), com teste de 200 caracteres? [Clareza, plan §Seguranca] {auto}
- [x] CHK020 - `q` nao e logado nem refletido na resposta; `ispb` fica fora do payload? [Seguranca, plan §Riscos; contracts/bancos-api.md] {auto}
- [x] CHK021 - A decisao de NAO adicionar rate limit esta fundamentada com numero (0,13 ms/requisicao) e precedente do projeto? [Mensurabilidade, plan §Seguranca] {auto}

## 4. Contrato de API e compatibilidade (FR-003/FR-008)

- [x] CHK022 - A forma da resposta `{itens:[{codigo,nome}]}` e declarada inalterada, com teste `deepEqual` exato de `q=260`, e o cliente do app nao muda? [Consistencia, Spec §FR-008; contracts/bancos-api.md] {auto}
- [x] CHK023 - Esta declarado, com fonte, que o app motorista tem proxy proprio (`app/api/[...path]/route.ts`, `BASE='/api'`) e nao chama o backend direto? [Consistencia, plan §Convencoes de Borda] {auto}
- [x] CHK024 - Todo item devolvido e verificavel como identico a entrada da fixture (codigo E nome); o mapa de apelidos contem so codigos e nunca renomeia? [Mensurabilidade, Spec §FR-003, SC-004] {auto}
- [x] CHK025 - Todo codigo do mapa existe na fixture e toda chave ja esta normalizada (invariantes testados, para reextracao da fixture nao quebrar calado)? [Cobertura, data-model.md] {auto}
- [x] CHK026 - O criterio de desempate dentro de cada tier esta declarado (ordem estavel da fixture; em T1, ordem do mapa) e dedup garante uma aparicao por banco? [Clareza, plan §Os 4 tiers] {auto}

## 5. Performance e escala

- [x] CHK027 - Ha numero medido de latencia (0,13 ms/requisicao) justificando a ausencia de indice/cache para 463 itens? [Mensurabilidade, plan §Performance] {auto}
- [x] CHK028 - O teto de 20 itens e aplicado dentro de `buscarBancos` e testado (`banco` ⇒ 20; vazio ⇒ 20)? [Rastreabilidade, plan §Interface] {auto}

## 6. Smoke e portao (SC-005, dec-012)

- [x] CHK029 - O smoke `tests/motorista-bancos-smoke.test.js` esta desenhado com `express` + router real + `listen(0)` + `fetch`, sem mock de `hub-postgrest`, sem env, sem PostgREST (o plan mediu que o router boota puro, ~20 linhas)? [Clareza, plan §Rastreabilidade] {auto}
- [ ] CHK030 - O smoke e exigido rodar ISOLADO (`node --test tests/motorista-bancos-smoke.test.js`) E DENTRO do `npm test` (registrado no script `test` do `package.json`), com `scripts/checar-testes-orfaos.js` no portao? [Completude, plan §Package.json] {auto}
- [x] CHK031 - O smoke emite tabela PASS/FAIL dos 7 casos e sai non-zero em qualquer reprovado? [Mensurabilidade, Spec §SC-005] {auto}
- [x] CHK032 - O laço de reprovacao reinicia o portao do ZERO (suite completa, nao so o caso falho)? [Consistencia, plan §Ordem passo 7] {auto}

## 7. Baselines pre-mudanca — vermelho e regressao

- [x] CHK033 - Baseline de nao-regressao registrada: `adiantamento-bancos-compe-unit` + `motorista-adiantamento-rotas-unit` = **82 pass / 0 fail**? [Mensurabilidade, plan §Baselines] {auto}
- [x] CHK034 - Baseline da suite completa registrada: `npm test` = **1941 pass / 0 fail** (389 suites)? [Mensurabilidade, plan §Baselines] {auto}
- [x] CHK035 - Esta declarado que o backend NAO tem falha herdada, portanto QUALQUER `fail` apos a mudanca e regressao desta entrega e bloqueia? [Clareza, plan §Baselines] {auto}
- [x] CHK036 - Esta declarado o que NAO roda e por que (next build, testes/eslint do app, E2E do hub, docker build, tsc/lint do backend inexistentes), sem baseline falsa de lint? [Completude, plan §Gates] {auto}

## 8. Pontos para o operador (nao bloqueiam)

- [ ] CHK037 - **Ordem do apelido `picpay`** (`380, 079, 469`): fundamentada no nome oficial (`469 PICPAY INVEST` e DTVM, nao quem recebe repasse), score 2; os tres aparecem, so a ordem muda; custo de trocar = 1 linha do mapa. Operador confirma qual entidade os motoristas usam? [Ambiguidade, data-model.md inv. 3] {humano}
- [ ] CHK038 - **`banco nubank`, `banco c6`, `banco itau`, `banco picpay`, `banco mercado pago` ⇒ 0 itens** (so `banco inter` acha, por acidente). DECLARADO, NAO implementado (ninguem pediu; consequencia de FR-006). Custo se o operador quiser: 1 linha (stopword `banco ` inicial, repetindo a busca com o termo inteiro restante, sem violar FR-006). [Gap declarado, plan §Limitacao conhecida] {humano}
- [ ] CHK039 - **Duas emendas de spec a declarar no PR**: (a) reclassificacao de `mercado pago` (guarda) e `nu` (reprovado por posicao) — ja registrada sob FR-010; (b) asserção de `banco` e SUBSTRING, nao palavra. Ambas citadas no corpo do PR? [Rastreabilidade, Spec §FR-010, §SC-001] {humano}

## Notas de processo

- Itens `[ ]` {auto} (CHK030) sao verificados na execucao (portao), nao no texto dos artefatos; os `{humano}` (CHK037-039) NAO bloqueiam: sao decisoes/declaracoes do operador.
- Controle negativo obrigatorio ANTES de implementar, com a classificacao corrigida (reprovados reais: `nubank`, `itau`, `nu`).

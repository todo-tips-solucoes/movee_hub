# Quickstart / Cenários de Teste: Corrigir o valor de um movimento

**Feature**: `corrigir-movimento` · **Fase**: Phase 1 (plan) · **Data**: 2026-10-20

Backend é `node --test` (`app_homologacao/backend/`); frontend_v2 é `vitest`.
Nenhum cenário abaixo roda contra produção.

---

## Gates do repositório (relatar **com números**)

| Gate | Comando | Quando |
|---|---|---|
| Tipos | `npx tsc --noEmit` | se tocar frontend |
| Unit backend | `cd app_homologacao/backend && npm test` | sempre |
| Unit frontend | `cd app_homologacao/frontend_v2 && npm test` | se tocar frontend |
| Build | `cd app_homologacao/frontend_v2 && npm run build` | se tocar frontend |
| Lint | `npm run lint` comparado com a **baseline** | sempre (erro novo bloqueia; pré-existente não) |
| Segurança | skill `owasp-security` | sempre — a feature altera o que o motorista vai faturar |
| Migration | `infra/hub/scripts/migrate.sh` no ambiente do hub | se criar a função |

⚠️ Antes de qualquer `docker build` / `next build`: **`df -h /`** (abortar com menos de
~20 GB livres) e swap ativa. Disco cheio já derrubou o banco de produção.

---

## Cenário 1 — Reimportar planilha corrigida **atualiza** em vez de duplicar (US1, P1)

1. Partir de uma empresa com um lote já importado para o período `28/09`–`04/10`.
2. Corrigir `valor` e `gorjeta` de ~10 linhas na planilha exportada (que tem `uuid` em
   100% das linhas) e salvar.
3. `POST /upload` com o **mesmo** range `dt_inicial=28/09/2026` / `dt_final=04/10/2026`,
   `empresa_id` da empresa e `motivo` preenchido.
4. **Expected**:
   - total de movimentos da empresa **inalterado** (0 duplicatas) — SC-001;
   - `resumo.atualizados = 10`, `resumo.criados = 0`, `resumo.inalterados` = resto;
   - os 10 movimentos com o valor novo persistido;
   - soma dos sete desfechos = `total_linhas` (INV-11).

## Cenário 2 — Planilha preenchida à mão (quase **sem** `uuid`) cai no fallback (US1, FR-007)

1. Usar a planilha manual (268 de 271 linhas **sem** `uuid` — medido).
2. `POST /upload` com o range do período já importado.
3. **Expected**: as linhas casam pelo fallback
   (`id_empresa` + `cnpj_prestador` + `dt_inicial` + `dt_final`) e são **atualizadas**;
   `resumo.criados` ≈ 0. **Falha de regressão esperada sem a correção**: 268 linhas criadas,
   duplicando o lote.
4. **Expected**: nenhuma linha é criada por *ausência de `uuid`* sozinha — só quando não
   existe movimento daquele CNPJ no período (FR-007).

## Cenário 3 — Idempotência (US1, FR-004, SC-008)

1. Rodar o Cenário 1 **de novo**, com o mesmo arquivo.
2. **Expected**: `resumo.atualizados = 0`, `resumo.inalterados = total_linhas`,
   **0 novos registros** em `Auditoria` (`SELECT count(*)` antes e depois idêntico).

## Cenário 4 — Movimento com nota enviada **não** é alterado (US3, P1)

1. Preparar 3 movimentos: (a) `nota_ok` preenchida e `erro_validacao` vazio;
   (b) `nota_ok` preenchida **com** `erro_validacao`; (c) sem nota.
2. Reimportar com valores novos para os três.
3. **Expected**: (a) mantém o valor e conta em `pulados_nota_enviada`; (b) **é corrigido** —
   nota com erro de validação **não** é nota enviada (FR-015); (c) é corrigido. SC-003.
4. Repetir pela tela (`PATCH`): (a) ⇒ `409 pulado_nota_enviada`, valor intacto.

## Cenário 5 — Corrigir pela tela grava **de fato** (US2, P2 — o defeito original)

1. Abrir um movimento, alterar o **Valor**, informar `motivo`, salvar.
2. **Expected**: valor **persistido**; releitura confirma. SC-002.
3. **Expected**: `motivo` vazio ⇒ `400`, nada gravado (FR-011).
4. **Expected**: valor não numérico ⇒ rejeitado pela **mesma** validação da importação (FR-012).

## Cenário 6 — A mensagem reflete o valor corrigido (US2, FR-014, SC-007)

1. Movimento cuja `mensagem1` contém `O valor total para emissão da NF é de R$242,24.`
2. Corrigir o valor para `300,00`.
3. **Expected**: a mensagem passa a trazer o valor novo; **o resto do texto intacto** —
   em especial o CNPJ `48.904.673/0001-00`, o CEP `04726-170` e os códigos `02461`,
   `53.20.20-2`, `26.01.01`, `1.0703.00.00` **inalterados**, e a **gorjeta não trocada**
   pelo valor da NF.
4. Repetir com a variante **com espaço** (`R$ 21,20`) — ambas as grafias funcionam, e a
   grafia encontrada é preservada (Decision 4).
5. Movimento cuja `mensagem1` **não** tem a âncora ⇒ **Expected**: valor gravado,
   `mensagem_ajustada: false` + aviso. **Nunca** sucesso pleno silencioso.

## Cenário 7 — Ambiguidade lista, mas **não** trava o lote (FR-006, Q4)

1. Criar duas duplicatas do mesmo `cnpj_prestador` no mesmo período.
2. Reimportar um lote de 50 linhas, uma delas ambígua.
3. **Expected**: `ambiguos = 1` com os `id` candidatos listados, os dois candidatos
   **intocados**, e as outras 49 linhas **aplicadas** — não é `400`.

## Cenário 8 — Linha inválida mantém o tudo-ou-nada (FR-005)

1. Lote com uma linha de valor não numérico.
2. **Expected**: `400` com `errors` por linha; **nenhuma** linha criada **nem atualizada**.

## Cenário 9 — Isolamento entre empresas (FR-019, SC-006)

1. Como empresa A, `PATCH` no `id` de um movimento da empresa B.
2. **Expected**: `404 nao_encontrado` — nunca `403` com confirmação de existência, nunca
   alteração. 0 alterações cruzadas.
3. `empresa_id` de empresa fora do escopo do token ⇒ `403` por `resolveEmpresaAlvo`.
4. **Expected**: toda consulta de casamento carrega `id_empresa=eq.` explícito — o banco
   **não** escopa esta tabela (sem RLS) (Decision 7).

## Cenário 10 — Auditoria nos **dois** caminhos (US4, FR-021/022, SC-004)

1. Corrigir um movimento numa sessão do **hub**.
2. **Expected**: registro em `Auditoria` com `usuario_id` = a pessoa, `id_empresa`,
   `recurso_id` = id do movimento, e `detalhes` com `valor_anterior`, `valor_novo`,
   `motivo`, `origem: "tela"`.
3. Corrigir um movimento numa sessão do **painel legado**.
4. **Expected**: registro **existe** (hoje não existiria — `server.js:157` retorna cedo),
   com `usuario_id = NULL` e `id_empresa` identificando a conta da empresa.
   **Nenhum usuário sintético.**
5. **Expected**: `motivo` com número parecido com CPF/e-mail é gravado **integral**.
6. **Expected**: `UPDATE`/`DELETE` em `Auditoria` falham (trigger da 0004) — FR-024.

## Cenário 11 — Atomicidade (FR-017, FR-023)

1. Movimento corrigível; simular falha no `INSERT` de auditoria.
2. **Expected**: o valor **não** fica alterado — sem registro não há alteração (FR-023).
3. **Expected**: a guarda de nota e o `UPDATE` são o mesmo comando — não há consulta
   intermediária entre eles (auditável no código da função).

## Cenário 12 — Performance (FR-010, SC-005)

1. Reimportar lote de ~980 linhas.
2. **Expected**: resposta em **até 10 s**; medir e **relatar o número**.
3. **Expected**: ~10 round trips de casamento (lotes de 100), **nenhuma** consulta por linha.
4. **Expected** (gate de Decision 2): `EXPLAIN (ANALYZE, BUFFERS)` da consulta de casamento
   mostra `Index Scan`/`Bitmap Index Scan` em `idx_envio_massa_cnpj_periodo` e **nenhum
   `Seq Scan`** em `EnvioMassa`. Rodar no ambiente do hub (`infra/hub/`), **nunca** em
   produção. Reprovou ⇒ reabrir a alternativa (B) de Decision 2 (índice
   `(id_empresa, dt_inicial, dt_final)`), não "aceitar e seguir".

## Cenário 13 — Roundtrip End-to-End (borda backend↔frontend)

1. Com o backend **real** no ar (ambiente do hub, não mock, não fixture), corrigir um valor
   pela tela e **capturar o payload de resposta**.
2. **Expected**: o shape bate com `contracts/correcao-valor-api.md` §2.3 — inclusive
   `mensagem_ajustada` e `aviso`, que só aparecem no caminho de sucesso parcial.
3. **Expected**: a tela exibe o aviso de `mensagem_ajustada: false`; não mostra "sucesso"
   seco (FR-013/FR-014).

---

## Controle negativo — **obrigatório** (Decision 12)

Rodar a suíte nova contra o código **ANTIGO** e conferir **quais** testes falham, não apenas
que algum falhou. Mapeamento esperado:

| Cenário | Contra o código antigo | Por quê |
|---|---|---|
| 2 (fallback sem `uuid`) | **FALHA** | hoje cria 268 duplicatas |
| 3 (idempotência) | **FALHA** | hoje a 2ª importação duplica |
| 5 (grava pela tela) | **FALHA** | `updateData` nunca inclui `valor` (`server.js:1050-1057`) |
| 6 (mensagem) | **FALHA** | hoje nada ajusta o texto |
| 10.4 (auditoria no legado) | **FALHA** | `server.js:157` retorna cedo |
| 4 (nota enviada) | **FALHA** | hoje não há guarda |
| 9 (isolamento no `PATCH`) | **PASSA** | o filtro composto `id`+`id_empresa` já existe |
| 8 (inválida tudo-ou-nada) | **PASSA** | comportamento preservado (FR-005) |

**Um teste que passa nas duas versões não está testando a correção** — exceto 9 e 8, que
são **testes de não-regressão** e devem passar nas duas por construção. Se 9 ou 8 falharem
contra o código antigo, o teste está errado, não o código.

⚠️ Este repositório já teve teste que **afirmava o defeito** (um teste consagrava o filtro
que escondia 71 movimentos de 62 motoristas). Por isso o controle negativo exige a lista de
**quais** falham, e a conferência de que 9 e 8 **não** estão nela.

⚠️ Se rodar o E2E do hub: o container do Playwright **reescreve `package-lock.json`** via
bind mount — conferir e reverter antes de commitar (já pego 2× na mesma sessão).

# Quickstart / Cenários de Teste — Validação de XML em Lote Idempotente

Cenários derivados do plano mestre §9 + spec (US1–US4). Fixtures: os 3 XMLs reais em
`docs/nota_entrego/` (padrão nacional NFS-e, tomador MOVEE `48904673000100`):

- `35503082243568174000168000000000009826065650835650.xml` (numnota 98, prestador 43568174000168)
- `35503082244890502000100000000000014626068428829820.xml` (numnota 146, prestador 44890502000100)
- `35503082255330677000180000000000011426063133427076.xml` (numnota 114, prestador 55330677000180)

> **Sem deploy.** Cenários rodam contra o backend local / ambiente de testes do operador. Para
> os cenários que precisam de movimentos correspondentes, seedar `EnvioMassa` (empresa-alvo,
> `mov_fechado=false`) com `cnpj_prestador`/`numnota`/`data_emissao` casando os fixtures.

---

## Cenário 1 — Lote nunca validado → `validada`

1. Seedar 3 movimentos abertos (empresa-alvo) com `nota_ok` vazio, casando os 3 fixtures.
2. `POST /validate-xml-batch` com os 3 XMLs.
3. **Expected**: cada linha `status=validada`, `match_criterio=chave` (ou `fallback` se a chave
   não casar), `movimento_id` preenchido. `nota_ok`/`erro_validacao` gravados nos 3 movimentos.
   `stats.validada=3`.

## Cenário 2 — Reenvio idêntico → tudo `ja_validada` e NADA muda no banco (idempotência, INV-1)

1. Partindo do estado pós-Cenário 1 (3 notas aprovadas: `nota_ok` cheio + `erro_validacao` vazio).
2. `SELECT id, nota_ok, erro_validacao, valor FROM "EnvioMassa" WHERE id IN (…)` → snapshot A.
3. Reenviar o MESMO lote dos 3 XMLs.
4. **Expected**: cada linha `status=ja_validada`; `stats.ja_validada=3`. Nenhuma chamada à FastAPI.
5. `SELECT …` → snapshot B. **`diff(A,B) == vazio`** (nenhuma escrita; INV-1/INV-2). `valor`
   inalterado (INV-4).

## Cenário 3 — Reprovada + XML novo → `revalidada`

1. Seedar 1 movimento aberto REPROVADO (`nota_ok` cheio + `erro_validacao` cheio) casando 1 fixture.
2. Enviar esse XML.
3. **Expected**: `status=revalidada`; FastAPI chamada 1x; `PATCH` grava o novo
   `nota_ok`/`erro_validacao`. `valor` inalterado (INV-4).

## Cenário 4 — Mesmo XML 2x no lote → 1 `validada` + 1 `duplicada_no_lote`

1. Seedar 1 movimento aberto sem validação casando 1 fixture.
2. Enviar o MESMO XML **duas vezes** no mesmo upload.
3. **Expected**: 1ª ocorrência `status=validada` (FastAPI 1x + PATCH); 2ª `status=duplicada_no_lote`
   (sem FastAPI, sem PATCH). `stats.validada=1`, `stats.duplicada_no_lote=1`.

## Cenário 5 — XML sem movimento → `sem_movimento` (P3)

1. Garantir que NÃO há movimento aberto casando um fixture (ou empresa-alvo sem seed).
2. Enviar esse XML.
3. **Expected**: `status=sem_movimento`, `match_criterio=none`, `movimento_id=null`. **Nenhum
   registro novo criado** (`SELECT count` em `EnvioMassa` antes/depois = igual).

## Cenário 6 — Tenant/empresa errada → não casa, não vaza (INV-3, US4)

1. Seedar o movimento que casa o fixture em **empresa B**; operador autenticado como **empresa A**.
2. `POST /validate-xml-batch` (empresa-alvo = A) com o XML.
3. **Expected**: `status=sem_movimento` para A (o movimento de B é invisível). Nenhum `PATCH` no
   movimento de B. (Caso o usuário tente `empresa_id=B` fora do seu escopo → 403 do
   `resolveEmpresaAlvo`.)

## Cenário 7 — FastAPI infra down → `erro` (resiliência, FR-014/FR-015)

1. Simular FastAPI indisponível (timeout/5xx) para 1 XML; demais XMLs com serviço OK.
2. Enviar lote misto.
3. **Expected**: a linha afetada `status=erro`, `erro_validacao="serviço de validação
   indisponível"`, sem PATCH falso; as demais linhas processam normalmente.

---

## Roundtrip End-to-End (OBRIGATÓRIO — valida shape real, INV-5)

Razão: histórico do toolkit mostra drift snake_case×camelCase mascarado por testes sobre mocks.
Este cenário faz chamada REAL ao backend e compara o payload contra o contrato.

1. Subir o backend local (ou usar o ambiente de testes do operador) com FastAPI acessível.
2. Seedar 1 movimento aberto sem validação casando o fixture
   `35503082243568174000168000000000009826065650835650.xml`.
3. `POST /validate-xml-batch` REAL (não mock) com esse XML, autenticado, `empresa_id` da empresa-alvo.
4. Capturar o JSON de resposta cru.
5. **Expected (shape)**: `results[0]` contém EXATAMENTE as chaves snake_case
   `status`, `match_criterio`, `movimento_id` (+ `arquivo`, `cnpj_prestador`, `numnota`,
   `erro_validacao`); `stats` contém os 7 contadores (`total` + 6 por status). **NÃO** existem
   `valid`/`valid_cnpj_prestador`/`valid_valor` (foram substituídos — Q4). Confirma que o tipo
   `ValidationRow` do frontend espelha o JSON literal (sem camelCase nos campos novos).
6. **Expected (efeito)**: `status=validada`, `movimento_id` = id seedado, e o `SELECT` do
   movimento mostra `nota_ok` preenchido. Reexecutar o passo 3 → `status=ja_validada` e diff de
   banco vazio (idempotência empírica).

---

## Frontend — verificação visual (US2/US3)

1. Abrir `app/dashboard/validacao-xml` e enviar um lote misto (estados variados).
2. **Expected**: cada linha exibe badge com **cor + ícone + texto** distintos por status
   (a11y color-not-only); resumo no topo ("N validadas, M preservadas, P erros"); `movimento_id`
   visível quando casado; critério de casamento indicado (chave/fallback). EntreGô 2.0 e
   responsividade preservados; sem dependências novas.

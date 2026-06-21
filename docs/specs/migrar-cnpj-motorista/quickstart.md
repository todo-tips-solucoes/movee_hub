# Quickstart / Cenários de Teste — migrar-cnpj-motorista

Cenários de validação manual + roundtrip E2E. Backend testado com unit
(supertest/jest ou padrão do projeto) mockando `postgrestRequest`; o roundtrip
final usa chamada REAL.

## C1 — Happy path: corrigir digitação de CNPJ (grupo Movee, motorista existe) [P1]

1. Empresa do grupo Movee tem 3 movimentos com `cnpj_prestador = "11222333000181"` (digitado errado), e existe `Motorista(cnpj_prestador="11222333000181", senha=<hash>, nome="X", ativo=true)`.
2. Admin abre o diálogo de edição de 1 movimento, troca o CNPJ para `"11222333000199"`, clica Salvar.
3. `PATCH /update-envio-massa/:id` com `cnpj_prestador="11222333000199"`.
4. **Expected**: 200. Os **3** movimentos passam a `"...0199"` (FR-002/FR-012). `Motorista` migra para `"...0199"` preservando `id/nome/senha/ativo` (FR-005). Login do motorista com o CNPJ novo funciona.

## C2 — Empresa fora do grupo Movee: só troca movimentos, não toca Motorista [FR-013]

1. Empresa **id=2** (não-Movee) tem movimentos com `cnpj_prestador="33444555000166"`.
2. Admin troca para `"33444555000177"` e salva.
3. **Expected**: 200. Movimentos da empresa 2 trocados (escopo `id_empresa=eq.2`). **Nenhuma** query a `Motorista` (sem 409, sem PATCH, sem POST). A base de login do grupo Movee permanece intacta.

## C3 — Conflito 409: CNPJ novo já tem motorista cadastrado [P2]

1. Grupo Movee. Existe `Motorista(cnpj_prestador="33333333000100")` (motorista B).
2. Admin tenta trocar o CNPJ de um movimento para `"33333333000100"`.
3. **Expected**: 409 `{ error: "CNPJ já possui motorista cadastrado — altere manualmente se necessário" }`. **Nenhum** movimento trocado, **nenhuma** conta fundida, senha de B intacta. Diálogo no front permanece aberto com valores anteriores (toast de erro).

## C4 — Antigo inexistente → pré-cadastro (grupo Movee) [P3]

1. Grupo Movee. Movimentos com `cnpj_prestador="44555666000122"`, mas **não** existe `Motorista` com esse CNPJ.
2. Admin troca para `"44555666000133"`.
3. **Expected**: 200. Movimentos trocados. `Motorista` recebe POST de pré-cadastro `{ cnpj_prestador:"...0133", ativo:true, senha:null }` (FR-007). Motorista poderá definir senha no primeiro `/register`.

## C5 — Idempotência: CNPJ não muda [FR-009 idempotência]

1. Admin edita só `mensagem` de um movimento; `cnpj_prestador` no body é igual ao atual (ou ausente).
2. **Expected**: 200. `enviado/mensagem/tipo` atualizados. **Nenhuma** troca em lote, **nenhuma** query a `Motorista`, **nenhum** 409 (`cnpjNovo===cnpjAntigo` → no-op de CNPJ).

## C6 — CNPJ inválido → 400 [FR-008 backend]

1. Admin (ou cliente API) envia `cnpj_prestador="123"` (< 14 dígitos) ou com letras.
2. **Expected**: 400 `{ error: "CNPJ inválido — deve conter 14 dígitos." }`. Nada modificado. (No front, o botão Salvar já estaria desabilitado — backend é a fonte da verdade.)

## C7 — Falha parcial: movimentos OK, Motorista falha → 500 sem reverter [FR-011]

1. Grupo Movee. Simular falha do PostgREST **no PATCH do Motorista** (após o PATCH em lote dos movimentos ter sucesso).
2. **Expected**: 500 `{ error: "Inconsistência ao migrar cadastro do motorista. Verifique manualmente." }`. Movimentos **permanecem** com o CNPJ novo (NÃO revertidos). Log registra a inconsistência sem expor segredos. Re-tentar a edição é idempotente (movimentos já em novo → no-op; Motorista re-tenta).

## C8 — IDOR: não vazar troca para outra empresa [Princípio II]

1. Empresa A e empresa B ambas têm movimentos com `cnpj_prestador="55666777000188"` (coincidência).
2. Admin da empresa A troca para `"55666777000199"`.
3. **Expected**: 200. **Só** os movimentos de A trocados (filtro `id_empresa=eq.${A}`). Movimentos de B intactos.

## C9 (frontend) — Validação no diálogo [P4 / FR-008 / FR-014]

1. Admin abre o diálogo, apaga dígitos do CNPJ deixando 10.
2. **Expected**: botão Salvar **desabilitado** enquanto `onlyDigits(valor).length !== 14`. Campo mostra máscara. Aviso fixo visível: "Isto também atualizará o login do motorista no app." Ao completar 14 dígitos, Salvar habilita.

## C10 — Roundtrip End-to-End (chamada REAL ao backend)

> Obrigatório para borda backend↔frontend. NÃO mock.

1. Subir backend local apontando para uma instância PostgREST de teste com seed: 1 empresa Movee, 2 movimentos com `cnpj_prestador="99888777000111"`, 1 `Motorista` com o mesmo CNPJ.
2. `curl -X PATCH .../update-envio-massa/<id>` com body real `{"cnpj_prestador":"99.888.777/0001-22","empresa_id":<movee>}` + cookie `accessToken` válido.
3. Capturar o payload de resposta (status + body).
4. **Expected**: 200; comparar o shape do body contra o contrato (`contracts/patch-update-envio-massa.md` §Respostas). Confirmar via SELECT read-only que os 2 movimentos e o `Motorista` foram para `"99888777000122"`. Expor qualquer divergência de case/shape antes do merge (lição das 40 ondas snake_case/camelCase).

# Quickstart / Cenários de Teste: Cadastro de Filiais

Cenários derivados das User Stories e Success Criteria da spec. Cada um é um
fluxo verificável manualmente (ou via teste). Mapeamento de SC/FR ao final.

## Pré-condições

- DDL `004-cadastro-filiais-cnpj.sql` aplicado pelo operador (coluna `cnpj` + UNIQUE + GRANT).
- Backend com `grupoRoutes.init({ postgrestRequest, bcrypt })` e endpoint `POST /grupo/empresas`.
- Frontend com formulário "Cadastrar filial" em `/dashboard/configuracoes/grupo`.
- Login como empresa-pai (`is_grupo_pai = true`).

---

## Cenário 1 — Happy path: criar filial pelo formulário (US1, P1)

1. Logar como admin do grupo → abrir `/dashboard/configuracoes/grupo`.
2. Preencher o formulário: nome, e-mail, senha (atende ao medidor), CNPJ (14 dígitos).
3. Submeter.
4. **Expected**: feedback de loading → sucesso; a filial aparece na lista
   **sem recarregar a página**; nenhum ID numérico foi informado. (SC-001)

## Cenário 2 — id_grupo vem do token, não do body (US1, SC-004)

1. Via proxy autenticado, enviar `POST /api/grupo/empresas` com body contendo
   `"id_grupo": 999` (valor forjado) além dos campos válidos.
2. **Expected**: filial criada com `id_grupo` = grupo do admin (do token), **não** 999.
   A resposta 201 traz o `id_grupo` real do admin. (SC-004, FR-002)

## Cenário 3 — Filial faz login imediatamente (US1, SC-003)

1. Criar uma filial com e-mail/senha definidos pelo admin.
2. Deslogar e logar com as credenciais da filial.
3. **Expected**: login bem-sucedido sem etapa de "primeiro acesso". (FR-005, SC-003)

## Cenário 4 — E-mail duplicado (US2, P2)

1. Tentar cadastrar filial com um e-mail já existente no sistema.
2. **Expected**: `400`; mensagem específica em português abaixo do campo e-mail;
   página não recarrega. (FR-004, SC-002)

## Cenário 5 — CNPJ duplicado (US2)

1. Tentar cadastrar filial com um CNPJ já cadastrado.
2. **Expected**: `409`; mensagem específica abaixo do campo CNPJ. (FR-003, SC-002)

## Cenário 6 — CNPJ inválido e senha fraca (US2)

1. Submeter com CNPJ de 11 dígitos e/ou senha sem maiúscula.
2. **Expected**: `400`; foco automático no primeiro campo inválido; mensagens por campo. (FR-003, FR-005, FR-008)

## Cenário 7 — Limite de 100 filiais (US4, P4)

1. Em um grupo que já possui 100 filiais, tentar cadastrar a 101ª.
2. **Expected**: `422`; mensagem informando o limite; nenhum registro criado. (FR-006)

## Cenário 8 — Não-admin bloqueado (US3, P3)

1. Logar como empresa **sem** `is_grupo_pai`; acessar `/dashboard/configuracoes/grupo`.
2. **Expected**: tela de bloqueio amigável; chamada direta a `POST /grupo/empresas` retorna `403`. (FR-007, SC-005)

## Cenário 9 — Estado vazio e regressão dos endpoints mantidos (FR-010, SC-005)

1. Grupo sem filiais → lista exibe estado vazio amigável.
2. `GET /grupo/filhos` lista filiais; `DELETE /grupo/filhos/:id` desvincula com sucesso.
3. **Expected**: comportamento pré-existente intacto após a mudança da UI.

---

## Cenário 10 — Roundtrip End-to-End (OBRIGATÓRIO — borda backend↔frontend)

Valida o **shape real** do payload contra o contrato (evita drift snake/camel).

1. Com backend rodando, chamar **realmente** `POST /api/grupo/empresas`
   (não mock, não fixture) com um body válido, autenticado como admin.
2. Capturar o JSON de resposta `201`.
3. Comparar o shape contra o contrato (`contracts/grupo-empresas-api.md`):
   chaves esperadas `id`, `nome_empresa`, `email`, `id_grupo` — todas em **snake_case**.
4. Confirmar que `pass` **não** está presente na resposta.
5. **Expected**: shape idêntico ao contrato; nenhuma chave em camelCase; a filial
   aparece subsequentemente no `GET /grupo/filhos` com `nome_empresa` em snake_case.

## Cenário 11 — Build de produção limpo (SC-006)

1. Rodar `next build` no `frontend_v2`.
2. **Expected**: build sem erros de TypeScript/compilação.

---

## Mapeamento SC/FR → Cenários

| Critério | Cenário(s) |
|----------|-----------|
| SC-001 (criar < 2min, sem ID) | 1 |
| SC-002 (erros específicos em PT, sem reload) | 4, 5, 6 |
| SC-003 (login imediato) | 3 |
| SC-004 (id_grupo do token) | 2, 10 |
| SC-005 (estado vazio + bloqueio admin) | 8, 9 |
| SC-006 (build limpo) | 11 |
| FR-001..FR-007 | 1–8 |
| FR-008 (medidor + foco no inválido) | 6 |
| FR-009 (loading/sucesso, recarrega lista sem reload) | 1 |
| FR-010 (endpoints mantidos) | 9 |
| FR-011 (cnpj UNIQUE, DDL pelo operador) | pré-condição + 5 |

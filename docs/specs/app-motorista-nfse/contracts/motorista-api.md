# Contracts — App Motorista API (backend `/motorista/*`)

**Feature**: `app-motorista-nfse` | **Date**: 2026-06-04

Novas rotas no backend Express existente (`app_homologacao/backend/`). O frontend PWA
chama **sempre via proxy** `/api/motorista/*` (repassa cookies httpOnly). Payloads em
`camelCase` (request/response). Auth por cookie `accessToken` (claim `cnpjPrestador`),
exceto onde indicado público.

---

## POST /motorista/login  (público)

Autentica o motorista e emite cookies httpOnly.

**Request** (JSON):
```json
{ "cnpjPrestador": "12345678000199", "senha": "..." }
```

**Response 200**: emite `Set-Cookie: accessToken` (15m) + `refreshToken` (7d),
`httpOnly; SameSite=Strict; Secure(em prod)`. Body:
```json
{ "authenticated": true, "nome": "João Motorista" }
```

**Erros**:
- `401` credenciais inválidas → `{ "error": "Credenciais inválidas." }`
  (sem revelar qual campo falhou — FR-001/Acceptance 2)
- `403` conta inativa → `{ "error": "Conta inativa. Procure o suporte." }`
- `400` corpo inválido → `{ "error": "Informe CNPJ e senha." }`

---

## POST /motorista/register  (público)

Auto-cadastro do motorista (R-2 / FR-017).

**Request** (JSON):
```json
{ "cnpjPrestador": "12345678000199", "senha": "...", "nome": "João Motorista" }
```

**Guard (server-side, obrigatório)**:
1. `cnpjPrestador` deve existir em `EnvioMassa` (`EnvioMassa?cnpj_prestador=eq.{}&limit=1`).
2. Não pode já existir conta (`Motorista?cnpj_prestador=eq.{}`).
3. `senha` com tamanho mínimo (ex.: ≥ 8) — validar antes de hashear.

**Response 201**: cria `Motorista` (senha em bcrypt, `ativo=true`). Body:
```json
{ "created": true }
```

**Erros** (mensagens não devem virar oráculo de enumeração — ver OWASP, FASE 7):
- `409` CNPJ não elegível ou já cadastrado → `{ "error": "Não foi possível concluir o cadastro. Verifique os dados ou procure o suporte." }`
- `400` corpo/senha inválidos → `{ "error": "Informe CNPJ, nome e senha (mínimo 8 caracteres)." }`

---

## POST /motorista/token/refresh  (cookie refreshToken)

Renova o `accessToken` a partir do `refreshToken`. Espelha o padrão existente
`POST /token/refresh` da Empresa, mas valida claim `cnpjPrestador`.

**Response 200**: novo `Set-Cookie: accessToken`. Body `{ "refreshed": true }`.
**Erro 401**: refresh ausente/expirado → redireciona ao login no cliente.

---

## POST /motorista/logout  (autenticado)

Limpa os cookies. **Response 200** `{ "ok": true }`.

---

## GET /motorista/verify-auth  (autenticado)

Confirma sessão (usado pelo `auth-context` do PWA).
**Response 200**: `{ "authenticated": true, "nome": "...", "cnpjPrestador": "..." }`.
**Erro 401**: `{ "authenticated": false }`.

---

## GET /motorista/movimento-aberto  (autenticado)

Retorna o movimento em aberto do motorista (escopo por `cnpjPrestador` do token).

Backend → PostgREST:
`EnvioMassa?cnpj_prestador=eq.{cnpjPrestador}&mov_fechado=eq.false`

**Response 200** (movimento existe):
```json
{
  "id": 123,
  "valor": "1500.00",
  "dtInicial": "2026-05-01",
  "dtFinal": "2026-05-31",
  "nome": "João Motorista",
  "cnpjTomador": "99888777000166",
  "cnpjPrestador": "12345678000199",
  "tribnac": "1",
  "notaOk": false,
  "erroValidacao": null
}
```

**Response 200** (sem movimento aberto) — estado vazio (FR-004):
```json
{ "movimento": null }
```

**Erros**: `401` não autenticado; `502/504` falha PostgREST →
`{ "error": "Não foi possível carregar seus dados. Tente novamente." }`

> Se houver mais de um movimento aberto, retornar o mais recente (`order=created_at.desc`,
> `limit=1`). Caso de borda raro; documentado para não quebrar a tela.

---

## POST /motorista/validar-nota  (autenticado, multipart)

Recebe o XML da NFS-e do motorista, chama a validação e persiste o resultado.

**Request**: `multipart/form-data`, campo `file` = arquivo XML (`multer.single('file')`).

**Pré-condições (validadas no backend)**:
1. Existe movimento aberto para o `cnpjPrestador`. Senão → `409`
   `{ "error": "Nenhum movimento em aberto para validar." }`
2. O movimento ainda **não** está `notaOk` (FR-008). Se já estiver → `409`
   `{ "error": "Nota já aprovada. Reenvio bloqueado.", "notaOk": true }`
3. O arquivo é XML bem-formado (parse `xml2js`). Senão → `400`
   `{ "error": "Arquivo inválido: envie um XML de NFS-e válido." }` (FR-011)

**Chamada externa** (server-side — FR-015; ver research.md Decision 5):
- `POST https://fastapihomologacaonexus.todo-tips.com/validade_nfse`
- form-encoded: `xml_input = JSON.stringify([{ filename, data }])`
  (`data` = conteúdo do XML em UTF-8), `validar_descricao_servico = false`,
  `nexus = false`
- Header `Authorization: {FASTAPI_VALIDATION_TOKEN}`

**Response 200 — nota válida** (FR-007): persiste `nota_ok` no movimento; body:
```json
{ "valid": true, "notaOk": true, "mensagem": "Nota ok! Validação aprovada." }
```

**Response 200 — nota inválida** (FR-009): persiste `erro_validacao`; body:
```json
{
  "valid": false,
  "notaOk": false,
  "camposInvalidos": [
    { "campo": "valid_valor", "mensagem": "Valor da nota não confere com o valor do movimento." }
  ],
  "instrucao": "Cancele esta nota e emita uma nova com os campos corrigidos."
}
```

**Erros**:
- `400` XML inválido (pré-condição 3)
- `409` sem movimento aberto / nota já aprovada (pré-condições 1, 2)
- `502/503` serviço de validação indisponível ou resposta inesperada (FR-012) →
  `{ "error": "Serviço de validação indisponível. Tente novamente em instantes." }`
  **sem** marcar a nota como reprovada (não altera `nota_ok`/`erro_validacao`).

---

## Convenções desta API

- **Idempotência do reenvio**: a checagem de `notaOk` no servidor é a autoridade; o
  bloqueio no cliente é apenas UX. Duplo toque não cria duas aprovações.
- **Mensagens de erro** sempre em pt-BR, sem vazar token/stack (Constituição I,
  Padrões de Qualidade).
- **Mapeamento de erros** (flag → mensagem) vive em um único módulo no backend e é
  reproduzido na resposta — o cliente apenas renderiza `camposInvalidos[].mensagem`.

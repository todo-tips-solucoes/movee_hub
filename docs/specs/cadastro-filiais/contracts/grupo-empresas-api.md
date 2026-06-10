# API Contract: Grupo — Cadastro de Filiais

Base: `/grupo` (montado com `authenticateToken` no `server.js`).
Frontend acessa via proxy `/api/grupo/*` com `credentials: 'include'`.
Case style: **snake_case** em request e response (ver plan.md §Convenções de Borda).

---

## POST /grupo/empresas  *(NOVO)*

Cria uma empresa filial **já vinculada ao grupo do admin autenticado**.

**Auth**: `authenticateToken` + `requireGrupoPai` (403 se `is_grupo_pai !== true`).

### Request body (snake_case)

```json
{
  "nome_empresa": "Filial Centro LTDA",
  "email": "filial.centro@exemplo.com",
  "senha": "Senha123",
  "cnpj": "12345678000199",
  "endereco": "Rua A",          // opcional
  "numero": "100",              // opcional
  "cep": "01001000",            // opcional
  "email_nota": "nf@exemplo.com", // opcional
  "observacao": "filial piloto"   // opcional
}
```

**Invariante crítico (Princípio II / SC-004)**: qualquer `id_grupo`, `id_empresa`
ou `id` recebido no body é **ignorado**. O `id_grupo` é derivado exclusivamente
de `req.user` (token JWT) via `resolveOrCreateGrupo(req.user)`.

### Validações e respostas

| Condição | Status | Body de resposta (exemplo) |
|----------|--------|----------------------------|
| Sucesso | `201` | `{ "id": 42, "nome_empresa": "...", "email": "...", "id_grupo": 7 }` |
| `nome_empresa` ausente/vazio | `400` | `{ "error": "Nome da empresa é obrigatório." }` |
| `email` formato inválido | `400` | `{ "error": "E-mail inválido." }` |
| `email` já cadastrado | `400` | `{ "error": "Este e-mail já está em uso." }` |
| `senha` fraca (< 6, sem maiúscula, sem dígito) | `400` | `{ "error": "A senha não atende aos requisitos mínimos." }` |
| `cnpj` != 14 dígitos numéricos | `400` | `{ "error": "CNPJ deve conter 14 dígitos." }` |
| `cnpj` já cadastrado | `409` | `{ "error": "Este CNPJ já está cadastrado." }` |
| grupo já tem 100 filiais | `422` | `{ "error": "O grupo atingiu o limite de 100 empresas filhas." }` |
| token não é admin do grupo | `403` | `{ "error": "Apenas o administrador do grupo pode executar esta operação." }` |

Mensagens de erro em **português** (Padrões de Qualidade da constitution).
`pass` (hash) **nunca** aparece no response.

### Fluxo interno (handler)

1. `requireGrupoPai` valida o admin → 403 se não for pai.
2. Validar body (nome, email-formato, senha-regra, cnpj-formato) → 400.
3. Checar unicidade de e-mail (`Empresa?email=eq.{email}`) → 400 se existir.
4. Checar unicidade de CNPJ (`Empresa?cnpj=eq.{cnpj}`) → 409 se existir.
5. `resolveOrCreateGrupo(req.user)` → garante o `Grupo` do pai (idempotente).
6. Checar limite de 100 filiais do grupo → 422.
7. `POST Empresa { nome_empresa, email, pass: bcrypt.hash(senha,10), cnpj,
   id_grupo: <grupo resolvido>, endereco, numero, cep, email_nota, observacao }`.
8. Responder `201` com `{ id, nome_empresa, email, id_grupo }`.

---

## Helper interno: resolveOrCreateGrupo(user)  *(NOVO, extraído de POST /grupo/filhos)*

Extraído da lógica das linhas ~188-223 do `POST /grupo/filhos`, sem alterar o
comportamento de `/filhos`. Reusado por `/filhos` e `/empresas`.

- **Input**: `user` (`req.user` com `empresaId`).
- **Output**: `id_grupo` (number) do grupo do pai.
- **Idempotência**: `Grupo.id_empresa_pai` é UNIQUE → get-or-create seguro.

---

## Endpoints MANTIDOS (contrato inalterado — FR-010)

### GET /grupo/filhos
Lista filiais do grupo. Response: `{ "id_grupo": <int>, "filhos": [{ id, nome_empresa, email }] }`.
Auth: `authenticateToken` + `requireGrupoPai`. Mantido sem mudança.

### DELETE /grupo/filhos/:empresaIdFilho
Desvincula filial (`SET id_grupo = NULL`). Response 200: `{ "desvinculado": true, "empresa_id_filho": <int> }`.
Auth: `authenticateToken` + `requireGrupoPai`. Mantido sem mudança.

### POST /grupo/filhos  *(MANTIDO — não quebrar contrato)*
Vincula uma empresa **já existente** por ID. Continua funcionando após o
refactor (agora chama `resolveOrCreateGrupo` internamente). A **UI** que o
consumia é substituída pelo formulário, mas o **endpoint permanece**.

---

## Proxy (Princípio III)

`app/api/[...path]/route.ts` encaminha `/api/grupo/empresas` → backend `/grupo/empresas`
**sem mudança** (catch-all já cobre `/api/grupo/*`). Cookies httpOnly repassados.

## Documentação viva (Princípio III SHOULD)

`backend/README.md` deve ser atualizado na mesma mudança documentando
`POST /grupo/empresas` (payload, respostas, códigos).

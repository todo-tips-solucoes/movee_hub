# Contract: Escopo do Grupo + Helper resolveEmpresaAlvo

**Feature**: `movimento-por-filial` · `routes/grupo.js`

---

## Helper: `resolveEmpresaAlvo(user, requestedId)`

Helper compartilhado (definido e exportado em `routes/grupo.js`, reaproveitando
`resolveScope`). É o **único ponto** de validação de empresa-alvo — todos os 7
endpoints de movimento o consomem.

### Assinatura

```
async function resolveEmpresaAlvo(user, requestedId) -> Promise<number>
```

| Parâmetro | Tipo | Origem |
|-----------|------|--------|
| `user` | object | `req.user` (do JWT): `{ empresaId, id_grupo, is_grupo_pai, ... }` |
| `requestedId` | string \| null | valor cru de `req.query.empresa_id` ou `req.body.empresa_id` |

### Contrato de comportamento

| Entrada `requestedId` | Resultado |
|-----------------------|-----------|
| `null` / `undefined` / `''` | retorna `user.empresaId` (**default backward-compatible**) |
| inteiro válido **∈** `resolveScope(user)` | retorna o inteiro |
| inteiro válido **∉** escopo | lança erro com `.status = 403` |
| não-numérico (`"abc"`, `"1 OR 1=1"`) | lança erro com `.status = 403` |

### Pseudocódigo de referência

```js
async function resolveEmpresaAlvo(user, requestedId) {
  if (requestedId == null || requestedId === '') return user.empresaId;
  const alvo = parseInt(requestedId, 10);
  if (!Number.isInteger(alvo)) {
    const err = new Error('empresa_id inválido'); err.status = 403; throw err;
  }
  const escopo = await resolveScope(user);          // IDs saem do token
  if (!escopo.includes(alvo)) {
    const err = new Error('empresa fora do escopo'); err.status = 403; throw err;
  }
  return alvo;
}
```

### Invariantes (Princípio II, NON-NEGOTIABLE)

- O conjunto de IDs aceitáveis sai **exclusivamente** de `resolveScope(user)`
  (token), nunca do `requestedId`.
- Fora do escopo → **403** (nunca 500, nunca 200 com dados vazios que vazem
  existência). Mensagem genérica, sem revelar dados da empresa-alvo
  (edge case "forjar empresa_id" da spec).
- Não-numérico tratado como fora do escopo (403). `parseInt` + `Number.isInteger`
  bloqueia injeção PostgREST (mesma defesa que `resolveScope` já aplica ao
  `id_grupo`).

### Tratamento de erro nos handlers

Cada handler que chama o helper deve capturar e mapear `.status`:

```js
let idEmp;
try {
  idEmp = await resolveEmpresaAlvo(req.user, <fonte>);
} catch (e) {
  return res.status(e.status || 500).json({ error: e.message });
}
```

---

## Endpoint: `GET /grupo/escopo`

Alimenta o combobox de filial. Acessível a **qualquer** usuário autenticado do
grupo (pai OU filho) — **SEM** `requireGrupoPai` (≠ `/grupo/filhos`, que é
pai-only).

### Request

```
GET /api/grupo/escopo
Auth: authenticateToken (cookie httpOnly) — herdado do mount app.use('/grupo', authenticateToken, ...)
```

Sem parâmetros. O escopo vem do token.

### Response 200

```json
{
  "empresas": [
    { "id": 6,  "nome_empresa": "Movee" },
    { "id": 17, "nome_empresa": "Filial Centro" },
    { "id": 18, "nome_empresa": "Filial Sul" }
  ],
  "default": 6
}
```

| Campo | Tipo | Notas |
|-------|------|-------|
| `empresas` | array | Empresa-pai (do token) + todas as filiais do grupo. `id` + `nome_empresa`. |
| `empresas[].id` | int | `Empresa.id`. |
| `empresas[].nome_empresa` | string | snake_case (fonte da verdade: coluna PostgREST). |
| `default` | int | `req.user.empresaId` (filial pré-selecionada por padrão = FR-003). |

### Regras de montagem (server-side)

1. `escopo = resolveScope(req.user)` → `[empresaId, ...idsFilhos]`.
2. Se `escopo.length === 1` → retornar `{ empresas: [{ id: empresaId, nome_empresa: req.user.nome_empresa }], default: empresaId }` (1 item → o front oculta o combobox).
3. Se `escopo.length > 1` → buscar nomes via PostgREST:
   `Empresa?id=in.(${escopo.join(',')})&select=id,nome_empresa` e ordenar com o
   pai (`empresaId`) primeiro.
4. `default = req.user.empresaId`.

### Response 401

Sem cookie válido → 401 (do `authenticateToken`).

### Notas de contrato

- **Princípio III**: consumido pelo front via proxy `/api/grupo/escopo`. Rota
  nova passa pelo `[...path]/route.ts` sem alteração.
- O `nome_empresa` do pai está no token (`req.user.nome_empresa`); para os
  filhos vem da query PostgREST. Alternativamente, buscar todos via
  `id=in.(...)` (inclui o pai) — preferível por simplicidade.
- **Limite implícito**: alinhado com `/grupo/filhos` (100 filhos, dec-025).
  Se `escopo` exceder, o endpoint ainda retorna (leitura), mas o front pagina
  via busca do combobox (FR-006).

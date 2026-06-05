# Contracts: Grupo API (config-ui-tenant)

Gestão de grupo/filhos. **Somente o CNPJ pai** opera estes endpoints. Escopo
resolvido server-side via `resolveScope` / claim do token (Princípio II — nunca
ids do corpo definem o escopo). Auth: cookie httpOnly `accessToken`.

Convenção: payload snake_case; path kebab-case.

---

## GET /grupo/filhos

Lista as empresas filhas do grupo do token (próprias + filhos). Usado no fluxo do
pai para visualizar e gerenciar vínculos.

### Request
- **Auth**: `authenticateToken` + `is_grupo_pai === true`.

### Response (200)
```json
{
  "id_grupo": 12,
  "pai": { "id": 5, "nome_empresa": "D&G Matriz" },
  "filhos": [
    { "id": 7, "nome_empresa": "D&G Filial SP" },
    { "id": 9, "nome_empresa": "D&G Filial RJ" }
  ]
}
```

### Error Responses
| Status | Quando | Body |
|--------|--------|------|
| 401 | sem token | `{ "error": "Acesso negado..." }` |
| 403 | token não é pai (ou empresa sem grupo) | `{ "error": "Apenas o administrador do grupo pode listar filhos." }` |

---

## POST /grupo/filhos

Vincula uma empresa filha ao grupo do pai. Cria o `Grupo` na primeira vinculação,
se necessário. **Transação atômica** (FR-INFRA-LOCK) — evita corrida multi-pod.

### Request
- **Auth**: `authenticateToken` + `is_grupo_pai` (ou pai que ainda não tem grupo).
- **Body**:
  ```json
  { "empresa_id_filho": 7 }
  ```
  Validações (FR-004): a empresa filho **existe** na base; **não pertence** a outro
  grupo (`id_grupo` IS NULL); não é o próprio pai.

### Response (201)
```json
{ "id_grupo": 12, "empresa_id_filho": 7, "vinculado": true }
```

### Error Responses
| Status | Quando | Body |
|--------|--------|------|
| 400 | filho inexistente / já em outro grupo / é o próprio pai | `{ "error": "Empresa não encontrada \| já pertence a um grupo." }` |
| 401 | sem token | `{ "error": "Acesso negado..." }` |
| 403 | token não é pai | `{ "error": "Apenas o administrador do grupo pode vincular filhos." }` |
| 409 | corrida de vínculo concorrente | `{ "error": "Vínculo em conflito, tente novamente." }` |

---

## DELETE /grupo/filhos/:empresaIdFilho

Desvincula uma filha (`UPDATE Empresa SET id_grupo = NULL`). Só o pai.

### Request
- **Auth**: `authenticateToken` + `is_grupo_pai`.
- **Path param**: `empresaIdFilho` — validado server-side como pertencente ao grupo
  do token (não aceita filho de outro grupo).

### Response (200)
```json
{ "empresa_id_filho": 7, "desvinculado": true }
```

### Error Responses
| Status | Quando | Body |
|--------|--------|------|
| 401 | sem token | `{ "error": "Acesso negado..." }` |
| 403 | token não é pai, ou filho não é do grupo do token | `{ "error": "Operação não permitida." }` |
| 404 | filho não vinculado a este grupo | `{ "error": "Empresa não está vinculada a este grupo." }` |

---

## Helper: resolveScope(user)  (server-side, não é endpoint)

Contrato do helper que todos os handlers de escopo expandido consomem.

**Input**: `req.user` (do token JWT) — `{ empresaId, id_grupo, is_grupo_pai, ... }`.

**Output**: array de `empresaId`s que o token pode acessar.

| Situação do token | Retorno |
|-------------------|---------|
| `id_grupo` NULL (sem grupo) | `[empresaId]` |
| `is_grupo_pai === true` | `[empresaId, ...ids dos filhos]` (query `Empresa?id_grupo=eq.<id_grupo>&select=id`) |
| tem `id_grupo` mas `is_grupo_pai === false` (é filho) | `[empresaId]` — **escopo NÃO expandido** |

**Invariante (Princípio II v1.1.0)**: o conjunto sai **exclusivamente** do token;
nenhum `empresaId` vem do corpo/query do cliente. Consultas de dados de negócio
para o pai passam a usar `id_empresa=in.(<lista do resolveScope>)`; rotas
existentes (escopo individual) seguem inalteradas — filhos continuam vendo só a
própria empresa.

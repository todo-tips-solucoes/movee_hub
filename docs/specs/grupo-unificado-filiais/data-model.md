# Data Model — Grupo Unificado de Filiais

**Feature**: `grupo-unificado-filiais`
**Data**: 2026-06-10
**Status**: Completo

> Nenhuma alteração de schema (DDL). Esta feature é somente lógica de aplicação
> sobre o schema existente (CL-003 — RESOLVIDO). Os scripts `001`..`006` já estão
> aplicados no ambiente de homologação.

---

## Entidades Existentes (sem alteração de schema)

### Entity: Empresa

| Campo | Tipo | Notas para esta feature |
|-------|------|------------------------|
| `id` | integer PK | Identificador único |
| `nome_empresa` | text | Editável via `PUT /grupo/empresas/:id` |
| `email` | text UNIQUE | Obrigatório, editável (checagem de unicidade excluindo próprio ID) |
| `pass` | text | Hash bcrypt. **Ignorado** no `PUT /grupo/empresas/:id` (FR-B). Bloqueado no login de filial (CL-002=A) |
| `cnpj` | text UNIQUE | 14 dígitos, editável (checagem de unicidade excluindo próprio ID) |
| `id_grupo` | integer FK → Grupo | Nullable. Setado quando a empresa pertence a um grupo |
| `endereco` | text | Opcional, editável |
| `numero` | text | Opcional, editável |
| `cep` | text | Opcional, editável |
| `email_nota` | text | Opcional, editável |
| `observacao` | text | Opcional, editável |
| `workflow_id` | text | Não editável nesta feature |
| `sender` | text | Não editável nesta feature |
| `tk` | text | Não editável nesta feature |
| `connection_id` | text | Não editável nesta feature |

**Invariantes relevantes**:
- `email` UNIQUE: verificar na edição excluindo `id = <filialId>`.
- `cnpj` UNIQUE: idem.
- `pass` NÃO é atualizado pelo `PUT /grupo/empresas/:id` (FR-B). Senha é irrelevante
  para filiais após implantação do módulo C (filiais não fazem login).
- Filial = `id_grupo != null` e `id != Grupo.id_empresa_pai`.
- Empresa-pai = `id_grupo != null` e `Grupo.id_empresa_pai = id`.
- Empresa standalone = `id_grupo IS NULL`.

### Entity: Grupo

| Campo | Tipo | Notas para esta feature |
|-------|------|------------------------|
| `id` | integer PK | Identificador do grupo |
| `nome` | text | Nome do grupo |
| `id_empresa_pai` | integer FK → Empresa UNIQUE | A empresa administradora do grupo |

**Uso**:
- `Grupo?id_empresa_pai=eq.<id>` → verifica se a empresa é administradora (pai) do grupo.
  Usado no `POST /login` (módulo C) e no helper `mesmoGrupoQue`.
- `Grupo?id=eq.<id_grupo>&select=id_empresa_pai` → obtém o ID da empresa-pai para
  checagem de membresia.

**Não há novas tabelas, colunas ou índices.**

---

## Helper: `mesmoGrupoQue(idEmpresa, idReferencia, cache)`

**Localização**: `app_homologacao/backend/routes/grupo.js` (exportado junto com
`resolveScope`, `resolveEmpresaAlvo`).

**Assinatura**:
```javascript
async function mesmoGrupoQue(idEmpresa, idReferencia, cache = {})
// → boolean
```

**Algoritmo**:

```
1. Se cache.ids já populado → usar diretamente (sem consulta ao banco).
2. Se cache.ids null/undefined:
   a. Buscar: Grupo?id_empresa_pai=eq.<idReferencia>&select=id
      → idGrupoRef (inteiro)
   b. Se não encontrado → cache.ids = new Set([idReferencia]); retornar idEmpresa === idReferencia
   c. Buscar: Empresa?id_grupo=eq.<idGrupoRef>&select=id
      → lista de membros (inclui o próprio pai — pai também tem id_grupo setado)
   d. cache.ids = new Set([idReferencia, ...ids dos membros])
3. Retornar cache.ids.has(Number(idEmpresa))
```

**Performance**: Máximo de 2 consultas PostgREST por ciclo de operação (FR-005).
Cada chamada subsequente do mesmo ciclo usa `cache.ids` (Set) — O(1).

**Fail-safe**: Se qualquer consulta falhar (erro de rede, PostgREST indisponível),
a função captura o erro, loga `[mesmoGrupoQue] erro: <msg>` e retorna `false`
(comportamento "sem grupo" — backward-compat, FR-006).

---

## Estado de Transição: Login de Filial (Módulo C)

**Antes** (estado atual):
```
POST /login(email, senha)
  → Empresa?email=eq.<email> → user
  → bcrypt.compare(senha, user.pass)
  → gerar tokens → 200
```

**Depois** (módulo C implantado):
```
POST /login(email, senha)
  → Empresa?email=eq.<email> → user
  [NOVO] → se user.id_grupo != null:
             → Grupo?id_empresa_pai=eq.<user.id> → grupoCheck
             → se grupoCheck vazio (empresa é filial, não é pai):
               → 403 { error: "Acesse o painel usando o login do grupo" }
  → bcrypt.compare(senha, user.pass)  ← só chega aqui se é pai ou standalone
  → gerar tokens → 200
```

**Invariantes de segurança**:
- O bloqueio ocorre ANTES do `bcrypt.compare` (sem timing oracle).
- Empresas standalone (`id_grupo IS NULL`) nunca entram no ramo de bloqueio.
- A empresa-pai (`id_empresa_pai = user.id`) NÃO é bloqueada.

---

## Token JWT (sem alteração de schema)

O payload já existente continua sem mudança:

```json
{
  "empresaId": <int>,
  "nome_empresa": "<string>",
  "workflow_id": "<string>",
  "sender": "<string>",
  "tk": "<string>",
  "connection_id": "<string>",
  "id_grupo": <int | null>,
  "is_grupo_pai": <boolean>
}
```

O `is_grupo_pai` já é calculado corretamente no `POST /login` atual (linhas 161-177
de `server.js`). Com o módulo C, apenas filiais nunca chegam ao ponto de gerar o
token — logo o token de uma empresa-pai continua com `is_grupo_pai: true` e o
`resolveScope` / `EmpresaSelector` / `resolveEmpresaAlvo` continuam funcionando sem
alteração.

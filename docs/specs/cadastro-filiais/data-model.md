# Data Model: Cadastro de Filiais

Sem ORM — acesso via PostgREST sobre PostgreSQL. As tabelas já existem
(`Empresa`, `Grupo`); a única mudança de schema é a coluna `cnpj` na `Empresa`.

## Entity: Empresa (filial)

Tabela existente. A feature **adiciona** a coluna `cnpj` e **passa a gravar**
campos que o `POST /register` não gravava (`id_grupo`, campos fiscais).

| Campo | Tipo | Origem no cadastro | Notas |
|-------|------|--------------------|-------|
| `id` | bigserial (PK) | gerado pelo banco | retornado no 201 |
| `nome_empresa` | text | body (obrigatório) | FR-001; validado não-vazio → 400 |
| `email` | text | body (obrigatório) | FR-001; formato + unicidade → 400 (FR-004) |
| `pass` | text | body `senha` → `bcrypt.hash(senha, 10)` | FR-005; nunca retornado |
| `cnpj` | **text (NOVO, UNIQUE)** | body (obrigatório) | FR-003; 14 dígitos numéricos; duplicata → 409 |
| `id_grupo` | bigint (FK → `Grupo.id`) | **token JWT (server-side)** | FR-002/SC-004; NUNCA do body |
| `endereco` | text | body (opcional) | FR-001 |
| `numero` | text | body (opcional) | FR-001 |
| `cep` | text | body (opcional) | FR-001 |
| `email_nota` | text | body (opcional) | FR-001 |
| `observacao` | text | body (opcional) | FR-001 |
| `workflow_id`, `sender`, `tk`, `connection_id` | — | NÃO setados no cadastro | colunas existentes, fora do escopo desta feature |

**Validações (no handler, antes do POST)**:
- `nome_empresa`: presente e não-vazio (trim).
- `email`: formato válido (regex) + único (`Empresa?email=eq.{email}` sem resultado).
- `senha`: `length >= 6 && /[A-Z]/ && /\d/` (regra do `register`).
- `cnpj`: exatamente 14 dígitos numéricos (`/^\d{14}$/`) + único (`Empresa?cnpj=eq.{cnpj}`).
- limite: o grupo do admin não pode já ter 100 filiais (reusar checagem 422).

**Constraint nova (DDL 004)**: `UNIQUE (cnpj)` — permite múltiplos NULL
(empresas legadas sem CNPJ permanecem válidas).

## Entity: Grupo

Tabela existente (criada pelo DDL 001 da feature config-ui-tenant). **Não muda**.

| Campo | Tipo | Notas |
|-------|------|-------|
| `id` | bigserial (PK) | referenciado por `Empresa.id_grupo` |
| `id_empresa_pai` | bigint NOT NULL **UNIQUE** (FK → `Empresa.id`) | garante 1 grupo por empresa-pai → base da idempotência |
| `nome` | text | nome do grupo (definido na criação preguiçosa) |

**Resolução preguiçosa (helper `resolveOrCreateGrupo(user)`)**:
1. Buscar `Grupo?id_empresa_pai=eq.{user.empresaId}`.
2. Se existir → retornar o `id`.
3. Se não existir → `POST Grupo { nome, id_empresa_pai: user.empresaId }` e retornar o `id`.
4. `id_empresa_pai UNIQUE` torna o passo 3 idempotente sob concorrência.

## Relacionamentos

```
Empresa (pai, is_grupo_pai=true)  1 ──< (id_empresa_pai)  Grupo  1 ──< (id_grupo)  Empresa (filiais)
```

- Uma empresa-pai tem no máximo 1 `Grupo` (UNIQUE em `id_empresa_pai`).
- Um `Grupo` agrega até 100 filiais (`Empresa.id_grupo` = `Grupo.id`).
- A filial criada é uma `Empresa` normal com `id_grupo` setado e
  `is_grupo_pai` falso/ausente → pode logar imediatamente (FR-005, SC-003).

## State transitions

A `Empresa` filial não tem máquina de estado própria. Ciclo no cadastro:
`(inexistente)` → **POST /grupo/empresas** → `(criada, vinculada ao grupo, login habilitado)`.
Desvínculo posterior via `DELETE /grupo/filhos/:id` (SET `id_grupo = NULL`) —
comportamento existente, mantido (FR-010).

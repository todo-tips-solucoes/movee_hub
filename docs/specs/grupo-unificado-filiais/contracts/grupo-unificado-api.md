# Contratos de API — Grupo Unificado de Filiais

**Feature**: `grupo-unificado-filiais`
**Data**: 2026-06-10

---

## Endpoints Existentes (sem alteração de contrato)

Os seguintes endpoints existentes são reusados sem modificação de interface:

| Endpoint | Localização | Notas |
|----------|-------------|-------|
| `GET /grupo/escopo` | `routes/grupo.js:495` | Retorna empresas do escopo do token; usado pelo `EmpresaSelector` |
| `GET /grupo/filhos` | `routes/grupo.js:154` | Lista filiais do grupo |
| `POST /grupo/empresas` | `routes/grupo.js:293` | Cria filial; senha passa a ser opcional/ignorada internamente (FR-B) |
| `DELETE /grupo/filhos/:id` | `routes/grupo.js:440` | Desvincula filial |
| `POST /login` | `server.js:142` | Autenticação; **modificado** (módulo C — bloqueio de filial) |

---

## Endpoint Novo: `PUT /grupo/empresas/:id`

**Rota**: `PUT /grupo/empresas/:id`
**Auth**: `authenticateToken` + `requireGrupoPai`
**Arquivo**: `app_homologacao/backend/routes/grupo.js`

### Request

**Path param**: `id` — inteiro, ID da empresa filial a editar.

**Body** (`application/json`):

```json
{
  "nome_empresa": "Filial SP",
  "email": "filial@exemplo.com",
  "cnpj": "12345678000195",
  "endereco": "Rua Exemplo, 100",
  "numero": "100",
  "cep": "01310100",
  "email_nota": "nota@exemplo.com",
  "observacao": "Observação opcional"
}
```

| Campo | Obrigatório | Regras |
|-------|-------------|--------|
| `nome_empresa` | sim | string, não vazio |
| `email` | sim | formato email; UNIQUE excluindo o próprio ID |
| `cnpj` | sim | exatamente 14 dígitos numéricos; UNIQUE excluindo o próprio ID |
| `senha` | não | **ignorada** mesmo se enviada (FR-B) |
| `endereco` | não | string livre |
| `numero` | não | string livre |
| `cep` | não | string numérica |
| `email_nota` | não | string livre |
| `observacao` | não | string livre |

### Responses

**200 OK** — Atualização bem-sucedida:
```json
{
  "id": 42,
  "nome_empresa": "Filial SP",
  "email": "filial@exemplo.com",
  "id_grupo": 1
}
```

**400 Bad Request** — Validação de campo:
```json
{ "error": "Campo obrigatório ausente: nome_empresa." }
{ "error": "Formato de e-mail inválido." }
{ "error": "CNPJ inválido: deve conter exatamente 14 dígitos numéricos." }
{ "error": "E-mail já cadastrado." }
```

**403 Forbidden** — Não é admin de grupo, ou filial não pertence ao grupo:
```json
{ "error": "Apenas o administrador do grupo pode executar esta operação." }
{ "error": "Empresa não pertence ao grupo deste administrador." }
```

**404 Not Found** — Filial não encontrada:
```json
{ "error": "Empresa não encontrada." }
```

**409 Conflict** — CNPJ duplicado:
```json
{ "error": "CNPJ já cadastrado." }
```

**500 Internal Server Error**:
```json
{ "error": "Erro no servidor." }
```

### Checagens de Segurança

1. `requireGrupoPai` — token deve ter `is_grupo_pai = true`.
2. A filial editada deve ter `id_grupo = token.id_grupo` (Princípio II — sem cross-group).
3. Checar que `id` não é o próprio `empresaId` do token (admin não edita a si mesmo
   por esta rota — admin edita dados pelo perfil, não pelo `/grupo/empresas`).
4. `pass` NUNCA é atualizada, independente do body recebido.

---

## Endpoint Modificado: `POST /login`

**Mudança** (módulo C): inserção de guarda antes do `bcrypt.compare`.

**Comportamento novo** (apenas para filiais):
- Se `user.id_grupo != null` E `Grupo?id_empresa_pai=eq.<user.id>` retorna vazio
  (empresa é filial, não é pai do grupo):

```json
HTTP 403
{ "error": "Acesse o painel usando o login do grupo" }
```

**Comportamento preservado** para:
- Empresa-pai (`id_empresa_pai = user.id`)
- Empresa standalone (`id_grupo IS NULL`)

---

## Helper Modificado: `POST /grupo/empresas` — senha ignorada

**Mudança** (FR-B): o campo `senha` do body continua sendo recebido (sem breaking change
de interface), mas **não é gravado** para filiais. O `pass` da empresa filial criada
fica como `null` ou mantém o hash anterior (se existir).

> **Nota de implementação**: a validação de senha no `POST /grupo/empresas` deve ser
> removida ou transformada em opcional. Se `senha` não for enviada, o campo `pass`
> não é incluído no payload do INSERT. Se enviado, é ignorado.

---

## Helper Existente: `mesmoGrupoQue`

**Assinatura** (exportada em `routes/grupo.js`):

```javascript
async function mesmoGrupoQue(
  idEmpresa: number,
  idReferencia: number,
  cache: { ids?: Set<number> }
): Promise<boolean>
```

**Contrato**:
- Retorna `true` se `idEmpresa` é membro do grupo de `idReferencia` (incluindo o
  próprio `idReferencia`).
- Retorna `false` se `idEmpresa` não tem grupo ou não é do grupo de `idReferencia`.
- `cache` é preenchido na primeira chamada e reutilizado nas subsequentes.
- Fail-safe: retorna `false` em caso de erro (backward-compat).
- Máximo 2 queries PostgREST por ciclo.

# Contracts: Perfil, RBAC e troca de entidade (`/api/v1/me*`)

## GET /api/v1/me

**Auth**: `accessToken` válido (`requirePermission` não se aplica — qualquer usuário
autenticado pode consultar o próprio perfil).

### Response (200)

| Field | Type | Description |
|-------|------|--------------|
| usuario | object | `{ id, email, nome }` |
| entidades | array | lista de `{ empresa_id, papel, ativo }` — todos os vínculos ativos da pessoa (FR-010) |
| entidade_ativa | int \| null | `empresa_id` atualmente ativo na sessão |
| modulos | array | módulos habilitados para a entidade ativa (`ModuloEntidade.ativo = true`) cruzados com as permissões efetivas da pessoa |
| permissoes | array\<string\> | códigos `modulo.acao` efetivos (união de todos os papéis aplicáveis — Decision 5), já filtrados pelo cache TTL 60s |

### Error Responses

| Status | Code | Description |
|--------|------|--------------|
| 401 | NAO_AUTENTICADO | sem `accessToken` válido |

## POST /api/v1/me/entidade

Troca a entidade ativa da sessão corrente sem exigir novo login (FR-010).

**Auth**: `accessToken` válido.

### Request

| Field | Type | Required | Validation |
|-------|------|----------|------------|
| empresa_id | int | yes | deve corresponder a um `UsuarioEntidade` ativo da pessoa autenticada |

### Response (200)

| Field | Type | Description |
|-------|------|--------------|
| entidade_ativa | int | novo `empresa_id` ativo |

Efeito colateral: o `accessToken` é reemitido com a nova claim de entidade ativa (mesmo
padrão de reemissão de token usado no restante do sistema); o JWT do PostgREST gerado
para requisições subsequentes (Decision 3) passa a carregar `empresa_ativa` = este valor.

### Error Responses

| Status | Code | Description |
|--------|------|--------------|
| 401 | NAO_AUTENTICADO | sem `accessToken` válido |
| 403 | SEM_VINCULO | a pessoa não tem `UsuarioEntidade` ativo para o `empresa_id` solicitado (FR-011) |

## Middleware: `requirePermission('modulo.acao')`

Não é um endpoint — é o contrato interno usado por toda rota nova do hub (FR-012).
Comportamento:

1. Resolve as permissões efetivas da pessoa autenticada (via `hub-rbac-cache.js`,
   populando o cache em cache-miss).
2. Se `modulo.acao` ∉ permissões efetivas → `403 { erro: "PERMISSAO_NEGADA" }`, e a ação
   protegida NUNCA executa (SC-003: 100% das tentativas sem permissão são recusadas).
3. Se permitido → `next()`.
4. **Fail-closed obrigatório** (remediação `owasp-security`, research.md Decision 13):
   qualquer erro na resolução de permissões (PostgREST indisponível, exceção não
   tratada, cache corrompido) resulta em `403`, nunca em `next()`. Não existe caminho de
   código que permita a ação por causa de uma falha de infraestrutura.

Nenhuma rota nova do hub pode ser registrada sem passar por este middleware (gate de
revisão manual + Quality Gate `owasp-security` verificam isso no `plan`/`create-tasks`).

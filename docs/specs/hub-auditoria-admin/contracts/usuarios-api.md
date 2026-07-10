# Contrato — /api/v1/usuarios

Padrões herdados do hub: `/api/v1`, cookie `accessToken` HS256, entidade do
token, erros `{ "erro": "CODIGO" }`, camelCase na borda. Router NOVO:
`routes/hub-usuarios.js`, montado em `server.js` sob `/api/v1/usuarios`.
Todas as rotas sob middleware `requireModuloAtivo('usuarios')` +
`requirePermission('usuarios.gerenciar')` + checagem por-entidade
(`obterPermissoesEfetivasPorEntidade`).

**Escopo**: admin_entidade opera SOMENTE usuários vinculados à
`entidade_ativa` (vínculos de outras entidades nunca aparecem nem são
mutáveis); admin_plataforma opera qualquer entidade (claim
`admin_plataforma`). Escrita de senha: bcrypt; senha NUNCA em `detalhes` de
auditoria (scrub por construção).

**Auditoria (FR-006)**: toda rota de escrita registra evento via
`registrarAuditoria` — ações: `usuario_criado`, `usuario_editado`,
`usuario_vinculo_criado`, `usuario_papel_alterado`,
`usuario_vinculo_desativado`.

**Invalidação de cache (FR-011/SC-004)**: toda mutação de vínculo/papel →
`invalidarUsuario(usuarioId)` SÍNCRONO antes da resposta.

## GET /usuarios

| Param | Tipo | Default | Nota |
|-------|------|---------|------|
| `busca` | string | — | `ilike` sobre nome/email |
| `entidadeId` | int | entidade ativa | SÓ admin_plataforma pode divergir da ativa |
| `page` / `pageSize` | int | 1 / 20 | pageSize max 100 |

**Response 200**:

```json
{
  "usuarios": [
    {
      "id": 17,
      "nome": "Maria QA",
      "email": "qa.importacoes@moveelog.local",
      "ativo": true,
      "vinculos": [
        { "id": 33, "entidadeId": 9001, "papelId": 2, "papel": "admin_entidade", "ativo": true }
      ]
    }
  ],
  "total": 4, "page": 1, "pageSize": 20
}
```

## POST /usuarios

Cria usuário + primeiro vínculo em um passo (SC-008).

**Request**:

```json
{
  "nome": "Novo Operador",
  "email": "op@cliente.com",
  "senha": "S3nh@Forte!",
  "vinculo": { "entidadeId": 9001, "papelId": 3 }
}
```

**Regras**: `senha` validada por força (`isStrongPassword`, padrão do
painel); `vinculo.entidadeId` deve estar no escopo do chamador; `papelId`
deve existir no catálogo fixo (dec-008 — nenhuma criação de papel);
e-mail duplicado → `409 EMAIL_JA_CADASTRADO`.

Nota de risco (gate owasp, finding L1 — aceito e auditado): a senha inicial
é conhecida pelo administrador até o usuário trocá-la (tela de perfil /
recuperar-senha). Risco inerente ao modelo admin-provisiona (o admin já
controla papel/vínculo da conta); o evento `usuario_criado` registra o
admin como responsável. Troca forçada no primeiro login fica como evolução
futura (campo `senha` do PUT já suporta).

**Response 201**: `{ "usuario": { "id": ..., "nome": ..., "email": ..., "vinculos": [...] } }` — SEM senha/hash.

## PUT /usuarios/:id

Edita dados cadastrais (`nome`, `ativo`; `senha` opcional — redefine).
**Response 200** com o usuário atualizado. `404 USUARIO_NAO_ENCONTRADO` se o
usuário não tem vínculo visível no escopo do chamador (não vaza existência
cross-tenant).

## POST /usuarios/:id/vinculos

Vincula usuário existente a uma entidade com papel.

```json
{ "entidadeId": 9001, "papelId": 4 }
```

`409 VINCULO_JA_EXISTE` se `UNIQUE(usuario_id, empresa_id)` violado (usar
PUT do vínculo para trocar papel/reativar).

## PUT /usuarios/:id/vinculos/:vinculoId

Altera `papelId` e/ou `ativo` do vínculo (troca de papel = FR-011; permissões
efetivas refletem <2s via `invalidarUsuario`).

```json
{ "papelId": 4, "ativo": true }
```

**Response 200**: vínculo atualizado. Não existe DELETE de vínculo
(desativação = `ativo:false` — modelo sem DELETE da S2).

**Erros comuns**: `401 NAO_AUTENTICADO` · `403 PERMISSAO_NEGADA` /
`MODULO_DESABILITADO` · `400 DADOS_INVALIDOS` / `SENHA_FRACA` ·
`404 USUARIO_NAO_ENCONTRADO` / `PAPEL_NAO_ENCONTRADO`.

Nota de vocabulário: entidade fora do escopo do chamador responde
`403 PERMISSAO_NEGADA` (mesmo código usado em `auditoria-api.md` para o
caso análogo — vocabulário unificado, sem código dedicado).

# Contrato — /api/v1/papeis

Padrões herdados do hub (ver `auditoria-api.md`). Router NOVO:
`routes/hub-papeis.js`, montado sob `/api/v1/papeis`, middleware
`requireModuloAtivo('usuarios')` (a matriz vive sob o módulo `usuarios` —
research Decision 10).

Catálogo de papéis é FIXO da plataforma (FR-016/dec-008): não existem rotas
de criar/editar/excluir papel. A única escrita é o toggle de célula da
matriz, restrito a `admin.gerenciar` (admin_plataforma).

## GET /papeis

Matriz papel × permissão completa (FR-010). **Permissão**:
`usuarios.gerenciar` — admin_entidade acessa em modo somente leitura (a
resposta inclui `podeEditar` para a UI desenhar checkboxes desabilitados).

**Response 200**:

```json
{
  "papeis": [
    { "id": 1, "nome": "admin_plataforma", "escopo": "global", "isSistema": true },
    { "id": 2, "nome": "admin_entidade", "escopo": "entidade", "isSistema": true },
    { "id": 3, "nome": "operador", "escopo": "entidade", "isSistema": true },
    { "id": 4, "nome": "leitura", "escopo": "entidade", "isSistema": true }
  ],
  "permissoes": [
    { "id": 12, "codigo": "auditoria.consultar", "modulo": "auditoria" },
    { "id": 20, "codigo": "usuarios.gerenciar", "modulo": "usuarios" }
  ],
  "matriz": [
    { "papelId": 1, "permissaoId": 12 },
    { "papelId": 2, "permissaoId": 12 }
  ],
  "podeEditar": false
}
```

`podeEditar = true` somente quando o chamador tem `admin.gerenciar` E vínculo
ativo com papel `admin_plataforma` (mesma condição do claim).

## PUT /papeis/:papelId/permissoes/:permissaoId

Toggle de célula da matriz. **Permissão**: `admin.gerenciar`; execução via
RPC `hub_papel_permissao_set(p_papel_id, p_permissao_id, p_ativo)`
(SECURITY DEFINER, guard `hub_jwt_admin_plataforma()` — dupla barreira:
middleware + banco).

**Request**: `{ "ativo": true }` (marca) ou `{ "ativo": false }` (desmarca).

**Response 200**: `{ "papelId": 2, "permissaoId": 12, "ativo": false }`.

**Efeitos colaterais obrigatórios**: (1) `limparCache()` global do RBAC
(mudança de matriz afeta conjunto não-enumerado de usuários — research
Decision 6); (2) auditoria `papel_permissao_alterada` com
`detalhes: { papel, permissao, ativo }`.

**Guard anti-lockout (gate owasp, finding M2)**: a RPC RECUSA
(`ERRCODE '42501'`, borda responde `409 OPERACAO_BLOQUEADA`) desmarcar a
célula (`admin_plataforma`, `admin.gerenciar`) — remover a permissão de
administração do próprio papel de plataforma deixaria o sistema sem
administração recuperável apenas via psql.

**Erros**: `401 NAO_AUTENTICADO` · `403 PERMISSAO_NEGADA` (admin_entidade
SEMPRE cai aqui — FR-010/FR-016) · `404 PAPEL_NAO_ENCONTRADO` /
`PERMISSAO_NAO_ENCONTRADA` · `400 DADOS_INVALIDOS` ·
`409 OPERACAO_BLOQUEADA` (anti-lockout).

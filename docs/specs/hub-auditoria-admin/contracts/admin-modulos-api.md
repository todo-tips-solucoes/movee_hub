# Contrato — /api/v1/admin (módulos por entidade)

Padrões herdados do hub (ver `auditoria-api.md`). Router NOVO:
`routes/hub-admin.js`, montado sob `/api/v1/admin`. TODAS as rotas (GET e
PUT) sob `requireModuloAtivo('admin')` + `requirePermission('admin.gerenciar')`
— leitura E escrita exclusivas do admin_plataforma (FR-017/dec-009).
admin_entidade não tem acesso a NENHUMA rota deste router (403), percebendo o
efeito apenas via nav/`GET /me` e pelos 403 `MODULO_DESABILITADO` dos módulos.

## GET /admin/modulos

Catálogo de módulos da plataforma (para montar a tela).

**Response 200**:

```json
{
  "modulos": [
    { "id": 1, "codigo": "dashboard", "nome": "Dashboard", "ordem": 10, "ativo": true },
    { "id": 8, "codigo": "auditoria", "nome": "Auditoria", "ordem": 80, "ativo": true }
  ]
}
```

## GET /admin/entidades/:id/modulos

Estado de habilitação de cada módulo para a entidade `:id` (qualquer
entidade — visão global via claim `admin_plataforma` no branch de SELECT da
RLS de `ModuloEntidade`, migration 0036).

**Response 200**:

```json
{
  "entidadeId": 9001,
  "entidadeNome": "QA Hub Envio Massa - Matriz",
  "modulos": [
    { "moduloId": 1, "codigo": "dashboard", "nome": "Dashboard", "habilitado": true },
    { "moduloId": 9, "codigo": "admin", "nome": "Administração", "habilitado": false }
  ]
}
```

`habilitado` = existe linha `ModuloEntidade(modulo_id, empresa_id)` com
`ativo=true`. Módulo sem linha = `habilitado:false` (deny by default).

## PUT /admin/entidades/:id/modulos/:codigo

Habilita/desabilita um módulo para a entidade (FR-007).

**Request**: `{ "habilitado": false }`

**Implementação**: UPSERT em `ModuloEntidade` (`ativo = habilitado`) —
nunca DELETE. RLS de escrita exige claim `admin_plataforma` (0036, backstop
do middleware).

**Response 200**: `{ "entidadeId": 9001, "codigo": "envio_massa", "habilitado": false }`

**Efeitos colaterais obrigatórios (FR-008/SC-005)**:
1. `invalidarEntidadeModulos(entidadeId)` SÍNCRONO → próximo request de
   qualquer usuário da entidade já vê o middleware `requireModuloAtivo`
   respondendo `403 MODULO_DESABILITADO`, mesmo com sessão ativa.
2. `GET /me` reflete imediatamente (consulta `ModuloEntidade` direto) → item
   some/volta ao nav na próxima renderização, sem novo login.
3. Auditoria `modulo_entidade_alterado` com
   `detalhes: { codigo, habilitado }` e `id_empresa = :id` (o evento pertence
   à entidade afetada — o admin da entidade pode vê-lo na SUA trilha).

**Guard anti-lockout (gate owasp, finding M3)**: `PUT` com
`habilitado:false` para o módulo `admin` na entidade ATIVA do próprio
chamador responde `409 OPERACAO_BLOQUEADA` — desabilitar a própria tela de
administração deixaria a recuperação dependente de psql. Desabilitar
`admin` para OUTRAS entidades permanece permitido.

**Erros**: `401 NAO_AUTENTICADO` · `403 PERMISSAO_NEGADA` (qualquer
não-admin_plataforma, incl. admin_entidade — FR-017) ·
`404 ENTIDADE_NAO_ENCONTRADA` / `MODULO_NAO_ENCONTRADO` ·
`400 DADOS_INVALIDOS` · `409 OPERACAO_BLOQUEADA` (anti-lockout).

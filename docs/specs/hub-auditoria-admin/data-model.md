# Data Model — hub-auditoria-admin (S9)

**Feature**: `hub-auditoria-admin` · **Data**: 2026-07-09 · **Fonte**:
migrations reais `infra/hub/migrations/0003, 0004, 0006, 0007, 0009` +
research.md (Decisions 2, 4, 5, 12).

Nenhuma TABELA nova. A feature reusa integralmente o schema S2 e adiciona
apenas: 1 helper de claim, políticas RLS (SELECT substituída em `Auditoria`;
INSERT/UPDATE novas em `ModuloEntidade`), 1 RPC DEFINER e seeds.

---

## Entity: Auditoria (EXISTENTE — sem alteração de colunas)

Tabela `"Auditoria"` (migration 0004). Registro imutável de ação relevante.

| Campo | Tipo | Notas |
|-------|------|-------|
| `id` | bigserial PK | |
| `id_empresa` | int NULL | NULL = evento global (auth pré-entidade) |
| `usuario_id` | int NULL → `Usuario(id)` | responsável |
| `acao` | text NOT NULL | ex.: `login_sucesso`, `usuario_criado` |
| `recurso` | text NOT NULL | ex.: `Usuario`, `ModuloEntidade` |
| `recurso_id` | text NULL | id do recurso afetado |
| `detalhes` | jsonb NOT NULL DEFAULT '{}' | SEMPRE scrubbed na escrita (`scrubDetalhes`) |
| `ip` | inet NULL | |
| `criado_em` | timestamptz NOT NULL DEFAULT now() | |

**Imutabilidade (FR-005/SC-003, já garantida — 0004)**: (a) `REVOKE UPDATE,
DELETE FROM authenticated`; (b) trigger incondicional
`trg_auditoria_bloqueia_alteracao` → `hub_bloqueia_alteracao_auditoria()`
(RAISE em UPDATE/DELETE, bloqueia até owner). S9 NÃO altera esse mecanismo —
apenas o cobre com E2E.

**Índices**: `idx_auditoria_usuario_id`, `idx_auditoria_criado_em` (0004),
`idx_auditoria_id_empresa` (0009). Suficientes para a listagem filtrada
(research Decision 8 — sem MV).

**RLS — mudança desta feature (migration 0035)**:

| Política | Antes (0006/0009) | Depois (0035) |
|----------|-------------------|---------------|
| SELECT `auditoria_select_por_escopo` | `id_empresa IS NULL OR id_empresa = ANY(hub_jwt_escopo_ids())` | `hub_jwt_admin_plataforma() OR (id_empresa IS NOT NULL AND id_empresa = ANY(hub_jwt_escopo_ids()))` |
| INSERT `auditoria_insert_por_escopo` | (0009 — inalterada) | inalterada |

Efeito: eventos globais (`id_empresa IS NULL`) deixam de ser visíveis a
qualquer autenticado e passam a ser exclusivos da visão admin_plataforma
(edge case da spec; simetria com o hardening de INSERT da 0009).

---

## Entity: Papel / Permissao / PapelPermissao (EXISTENTES — catálogo fixo, dec-008)

Migration 0003 + seed 0007. Sem mudança de colunas.

- `"Papel"(id, nome UNIQUE, escopo CHECK IN('global','entidade'), is_sistema)`
  — 4 papéis-sistema: `admin_plataforma`(global), `admin_entidade`,
  `operador`, `leitura`. **Nenhuma política de escrita existe nem será
  criada** → criar/editar/excluir papel é impossível por qualquer via
  (FR-016, RLS deny-by-default).
- `"Permissao"(id, codigo UNIQUE, modulo_id → Modulo)` — catálogo seedado
  (0007 + 0026/0029/0032). Sem escrita.
- `"PapelPermissao"(papel_id, permissao_id, PK composta)` — matriz. GRANT
  atual: SELECT/INSERT/UPDATE sem DELETE. **Única via de escrita da S9**: RPC
  `hub_papel_permissao_set()` (SECURITY DEFINER, guard
  `hub_jwt_admin_plataforma()`, migration 0037) — marca célula via
  `INSERT ... ON CONFLICT DO NOTHING`, desmarca via `DELETE` interno da RPC
  (research Decision 5). Sem GRANT DELETE direto.

---

## Entity: Modulo (EXISTENTE — sem alteração)

`"Modulo"(id, codigo UNIQUE, nome, icone, ordem, ativo)` — 9 módulos seedados
(0007): `dashboard`(10) … `usuarios`(70), `auditoria`(80), `admin`(90). Os 3
módulos das telas S9 JÁ EXISTEM no catálogo; nenhum seed de módulo novo.

---

## Entity: ModuloEntidade (EXISTENTE — ganha políticas de ESCRITA)

`"ModuloEntidade"(modulo_id → Modulo, empresa_id, ativo DEFAULT true,
UNIQUE(modulo_id, empresa_id))` — a habilitação módulo×entidade (FR-007). Já
consumida por `GET /me` (nav data-driven).

**RLS — mudança desta feature (migration 0036)**:

| Política | Situação |
|----------|----------|
| SELECT `moduloentidade_select_por_escopo` (0006) | inalterada (`empresa_id = ANY(hub_jwt_escopo_ids())`) — **acrescida** de branch `hub_jwt_admin_plataforma()` para o GET admin listar qualquer entidade |
| INSERT (nova) | `WITH CHECK (hub_jwt_admin_plataforma())` |
| UPDATE (nova) | `USING/WITH CHECK (hub_jwt_admin_plataforma())` |

GRANTs INSERT/UPDATE já existem desde 0003; sem DELETE (toggle é
`ativo=true|false`, soft — research Decision 4).

---

## Entity: Usuario / UsuarioEntidade (EXISTENTES — sem alteração de schema)

- `"Usuario"` (0002): conta com `senha_hash` bcrypt (constitution I).
- `"UsuarioEntidade"(id, usuario_id → Usuario, empresa_id, papel_id → Papel,
  ativo, criado_em, UNIQUE(usuario_id, empresa_id))` — vínculo com papel
  (FR-009). GRANT SELECT/INSERT/UPDATE sem DELETE (desativação =
  `ativo=false`). Políticas RLS de escrita existentes da S2 permanecem; os
  endpoints de usuários escrevem via PostgREST com claims do próprio backend
  (escopo da entidade-alvo verificado ANTES no middleware de permissão).

**Invariante de cache (FR-011/SC-004)**: toda mutação em `UsuarioEntidade`
(papel/vínculo/ativo) → `invalidarUsuario(usuarioId)` síncrono; toda mutação
via `hub_papel_permissao_set` → `limparCache()` global (research Decision 6).

---

## Objetos NOVOS de banco (todos em migrations 0035+)

| Objeto | Tipo | Migration | Guard |
|--------|------|-----------|-------|
| `hub_jwt_admin_plataforma()` | function → boolean (claim reader) | 0035 | n/a (lê claim `admin_plataforma` do JWT, default false) |
| `auditoria_select_por_escopo` | POLICY (substituída) | 0035 | claim + escopo |
| Políticas INSERT/UPDATE `ModuloEntidade` + branch admin no SELECT | POLICY (novas/substituída) | 0036 | claim |
| `hub_papel_permissao_set(p_papel_id, p_permissao_id, p_ativo)` | RPC plpgsql SECURITY DEFINER, `SET search_path = public, pg_temp`, `REVOKE ALL FROM PUBLIC` + `GRANT EXECUTE TO authenticated` | 0037 | `IF NOT hub_jwt_admin_plataforma() THEN RAISE ... ERRCODE '42501'` |
| Seeds `ModuloEntidade` (usuarios+auditoria p/ entidades com vínculo; admin p/ QA 9001) | INSERT `ON CONFLICT DO NOTHING` | 0038 | n/a |

## Migrations desta fase (resumo)

| # | Arquivo | Conteúdo | Idempotência |
|---|---------|----------|--------------|
| 0035 | `0035_auditoria_visao_global.sql` | helper `hub_jwt_admin_plataforma()` + SELECT policy da Auditoria | `CREATE OR REPLACE FUNCTION`; `DROP POLICY IF EXISTS` + `CREATE POLICY` |
| 0036 | `0036_moduloentidade_escrita_admin.sql` | políticas de escrita ModuloEntidade + branch admin no SELECT | idem |
| 0037 | `0037_rpc_papel_permissao_set.sql` | RPC DEFINER da matriz | `CREATE OR REPLACE FUNCTION` + REVOKE/GRANT |
| 0038 | `0038_seed_modulos_admin_qa.sql` | seeds de habilitação (Decision 12) | `ON CONFLICT DO NOTHING` |

Aplicação: `infra/hub/scripts/migrate.sh` (transação única por arquivo,
tracking em `"SchemaMigration"`, reload PostgREST via SIGUSR1). Alvo
EXCLUSIVO: `hub_homolog_db` (contexto vinculante #2). Todas aditivas —
constitution V.

## Mapa permissão lógica → código real

| Capacidade (spec) | Código real (seed) | Quem tem (0007) |
|-------------------|--------------------|-----------------|
| Consultar auditoria (FR-001..003) | `auditoria.consultar` | admin_plataforma, admin_entidade |
| Gestão de usuários (FR-009) | `usuarios.gerenciar` (+ `.listar/.criar/.editar` na leitura fina) | admin_plataforma, admin_entidade |
| Ver matriz papéis (FR-010 leitura) | `usuarios.gerenciar` | admin_plataforma, admin_entidade (read-only) |
| Ajustar matriz (FR-010/FR-016 escrita) | `admin.gerenciar` + claim `admin_plataforma` (RPC) | admin_plataforma |
| Administrar módulos (FR-007/FR-013/FR-017) | `admin.gerenciar` | admin_plataforma |

## State transitions

- **Evento de Auditoria**: `∅ → registrado` (INSERT único). Sem outras
  transições — UPDATE/DELETE bloqueados por GRANT + trigger (SC-003).
- **ModuloEntidade.ativo**: `true ⇄ false` (UPSERT admin) → invalidação
  síncrona do cache de módulos → efeito imediato em `GET /me` (nav) e no
  middleware `requireModuloAtivo` (403) — FR-008/SC-005.
- **UsuarioEntidade.papel_id / ativo**: mutação → `invalidarUsuario()`
  síncrono → permissões efetivas novas no request seguinte (<2s, SC-004).
- **PapelPermissao (célula da matriz)**: `presente ⇄ ausente` via RPC →
  `limparCache()` global.

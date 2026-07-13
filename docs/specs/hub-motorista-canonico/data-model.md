# Data Model: Motorista canônico do hub

Escopo: **apenas `hub_homolog_db`**. Nenhuma tabela nova — reuso de `Entregador`
(0010) e `ContaMotorista` (0021). As únicas mudanças de schema são **aditivas** e
idempotentes (migrations 0042+). Produção (chatmasterveloz) não recebe nenhuma DDL
(FR-023, D-C3).

## Entity: Entregador (motorista canônico) — EXISTENTE, reusada

Origem: `infra/hub/migrations/0010_entregador.sql`. Promovida a motorista canônico
do hub (D-C0). Nenhuma coluna nova nesta feature.

| Field | Type | Constraints | Notes |
|-------|------|-------------|-------|
| id | serial/int | PK | id interno do hub |
| id_empresa | int | NOT NULL | escopo multi-tenant (Princípio II) |
| id_externo | uuid | NOT NULL, `UNIQUE (id_empresa, id_externo)` | **chave canônica** — o uuid da planilha; imutável; único por empresa (FR-011/FR-013). Exposto como `idExterno` nos DTOs (FR-016). |
| nome | text | NOT NULL | editável (FR-015) |
| ativo | boolean | NOT NULL DEFAULT true | situação do motorista; **independente** da credencial (FR-015) |
| motorista_id | int NULL | FK → `ContaMotorista(id)`; índice único parcial `WHERE motorista_id IS NOT NULL` | vínculo 1↔1 com a credencial de acesso |

- Índice `(id_empresa, nome)` já existe (0010) — suporta a busca por nome do WS-B.
- Upsert por importação: `on_conflict = id_empresa, id_externo`
  (`lib/hub-import-processor.js`) — correlação sempre e só por uuid (FR-014).

## Entity: ContaMotorista (credencial de acesso) — EXISTENTE + coluna aditiva

Origem: `infra/hub/migrations/0021_conta_motorista.sql`. Passa a ser a **credencial
de acesso** do motorista ao app (D-C0/D-C5). Uma conta ↔ no máximo um `Entregador`
(índice único parcial em `Entregador.motorista_id`).

| Field | Type | Constraints | Notes |
|-------|------|-------------|-------|
| id | serial | PK | |
| cnpj_prestador | text | NOT NULL UNIQUE | identificação de login do app motorista |
| nome | text | NOT NULL | |
| ativo | boolean | NOT NULL DEFAULT true | ativa/desativa o acesso ao app (FR-018) — independente de `Entregador.ativo` |
| cadastro_completo | boolean | NOT NULL DEFAULT true | |
| **senha** | **text NULL** | **NOVA (migration 0042)** | **bcrypt** (nunca texto plano — Princípio I); NULL = sem credencial ainda; reset invalida a anterior imediatamente (FR-019, D-C5) |
| criado_em | timestamptz | NOT NULL DEFAULT now() | |
| atualizado_em | timestamptz | NOT NULL DEFAULT now() | |

- Índice trgm `hub_normaliza_nome(nome)` já existe (0021).
- Grants existentes (`SELECT, INSERT, UPDATE ... TO authenticated`) cobrem a coluna
  nova; nenhum grant adicional necessário para a app (a coluna `senha` NUNCA é
  exposta em DTO/SELECT de leitura — só lida internamente na autenticação).

## Entity: Atividade do motorista — read-only, correlacionada por uuid

Não é uma tabela única — é a **união read-only** de fontes já existentes,
correlacionadas por `Entregador.id_externo` (uuid): faturamento, performance e
validações de NF do app motorista. A visão do hub (detalhe do motorista, seção
"Atividades", FR-022) é estritamente informativa — sem ação de edição.

| Field (DTO) | Type | Notes |
|-------------|------|-------|
| tipo | enum | `faturamento` \| `performance` \| `validacao_nf` |
| data | timestamptz | usada para ordenação desc (mais recente primeiro) |
| descricao/valor | text/number | conforme o tipo |
| entregador_uuid | uuid | chave de correlação (FR-022A) |

**Mudança aditiva (WS-C / D-C2, FR-022A)**: onde uma atividade é gravada pelo app
motorista (`server.js` / `routes/motorista.js`), adicionar coluna
`entregador_uuid uuid NULL` (idempotente, só no `hub_homolog_db`) preenchida a partir
do `entregador_uuid` resolvido no login. Chaves atuais (cnpj) permanecem — nada é
reescrito. Atividade cujo uuid ainda não tem motorista cadastrado é gravada
normalmente e fica sem correlação até o cadastro (clarify Q4).

### Relationships

- `Entregador` 1:1 `ContaMotorista` via `Entregador.motorista_id` (FK + índice único
  parcial).
- `Entregador` 1:N `Atividade` via `id_externo` (uuid) — correlação lógica, não FK
  física (as fontes de atividade vivem em tabelas distintas).

### State Transitions

Motorista (`Entregador.ativo`) e Credencial (`ContaMotorista.ativo` + `senha`) são
**independentes** (FR-015/FR-018, clarify Q3):

```
Motorista:   ativo  ⇄  inativo            (edição de situação — FR-015)
Credencial:  (sem senha) → ativa  ⇄  desativada
             ativa → [reset-senha] → ativa (senha anterior invalidada — FR-019)
```

Inativar o motorista NÃO desativa a credencial; desativar o acesso exige ação
explícita separada.

## Migrations (idempotentes, só hub_homolog_db, 0042+)

| Migration | Conteúdo | Idempotência |
|-----------|----------|--------------|
| `0042_conta_motorista_senha.sql` | `ALTER TABLE "ContaMotorista" ADD COLUMN IF NOT EXISTS senha text NULL;` (D-C5) | `ADD COLUMN IF NOT EXISTS` |
| `0043_seed_permissao_motoristas_credencial.sql` | Insere a permissão `motoristas.credencial` e concede aos papéis admin (seed aditivo, D-C1); reusa `motoristas.editar` para cadastro/edição | `INSERT ... WHERE NOT EXISTS` / `ON CONFLICT DO NOTHING` |
| (WS-C, atividade) | `ADD COLUMN IF NOT EXISTS entregador_uuid uuid NULL` na(s) tabela(s) de atividade do app motorista **no hub** (FR-022A) | `ADD COLUMN IF NOT EXISTS` |

Aplicação: `infra/hub/scripts/migrate.sh -f infra/hub/compose.hub.homolog.yml`
(registra `SchemaMigration`, SIGUSR1 ao PostgREST). Numeração confirma a última
existente = `0041`.

## Permissões (RBAC) — reuso + 1 nova

| Permissão | Status | Uso |
|-----------|--------|-----|
| `motoristas.listar` | existente | leitura da lista (qualquer usuário autenticado da empresa — FR-020) |
| `motoristas.consultar` | existente | leitura do detalhe + histórico de atividades (FR-022, sem exigir escrita) |
| `motoristas.editar` | existente | **cadastro/edição** de motorista (POST criar + PATCH editar) — permissão #1 do clarify Q1 |
| `motoristas.credencial` | **NOVA (0043)** | **gestão de credencial** (criar/reset-senha/ativar-desativar) — permissão #2 do clarify Q1 |
| `faturamento.listar` / `performance.listar` | existentes | gate dos endpoints de busca de entregador (WS-B) |

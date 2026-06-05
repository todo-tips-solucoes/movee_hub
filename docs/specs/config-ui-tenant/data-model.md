# Data Model: config-ui-tenant

Entidades novas e alterações aditivas. Convenção de colunas: **snake_case**
(espelhada ponta-a-ponta — ver §Convenções de Borda do plan.md). Todo DDL é
aditivo e idempotente (`IF NOT EXISTS`), entregue como `.sql` ao operador
(classifier bloqueia banco), seguido de reload do schema PostgREST.

---

## Entity: Grupo

Representa uma holding: um CNPJ pai administrando zero ou mais CNPJs filhos.

| Campo | Tipo | Constraints | Notas |
|-------|------|-------------|-------|
| `id` | `bigint` / serial | PK | identidade do grupo |
| `nome` | `text` | NOT NULL | nome interno da holding (não é o nome de exibição da branding) |
| `id_empresa_pai` | `bigint` | NOT NULL, FK → `Empresa(id)`, UNIQUE | a empresa que administra o grupo; UNIQUE garante 1 pai por grupo |
| `created_at` | `timestamptz` | DEFAULT now() | |
| `updated_at` | `timestamptz` | DEFAULT now() | atualizar via trigger ou no handler |

### Relationships

- `Grupo 1 — N Empresa` via `Empresa.id_grupo` (filhos + o próprio pai apontam para o grupo).
- `Grupo 1 — 1 Branding` via `Branding.id_grupo` (UNIQUE).
- `Grupo.id_empresa_pai → Empresa.id` (quem administra).

### State Transitions

- **Criação**: ao primeiro vínculo de filho pelo pai (ou explicitamente na migração D&G).
- **Troca de pai**: `UPDATE Grupo SET id_empresa_pai = <novo>` — branding permanece
  ligada ao grupo (não migra). Filhos passam a herdar do mesmo grupo (sem efeito na branding).

---

## Entity: Empresa (alteração aditiva)

Tabela existente. Apenas **adiciona** a FK de grupo — nenhuma coluna existente muda.

| Campo (novo) | Tipo | Constraints | Notas |
|--------------|------|-------------|-------|
| `id_grupo` | `bigint` | **NULLABLE**, FK → `Grupo(id)` | NULL = empresa sem grupo (comportamento atual: escopo individual, fallback Movee) |

### Relationships

- `Empresa N — 1 Grupo` via `id_grupo` (filho pertence a no máximo um grupo; NULL permitido).

### State Transitions

- **Vincular filho**: `UPDATE Empresa SET id_grupo = <grupo>` — só pelo pai, validando
  que a empresa existe e não pertence a outro grupo (FR-004). Transação atômica
  (FR-INFRA-LOCK) para evitar corrida multi-pod.
- **Desvincular**: `UPDATE Empresa SET id_grupo = NULL`.
- **Empresa pré-existente**: `id_grupo` nasce NULL → idêntico ao comportamento atual.

---

## Entity: Branding

Configuração de identidade visual, 1:1 com `Grupo`. Empresa sem grupo não tem
branding própria no MVP — herda fallback Movee.

| Campo | Tipo | Constraints | Notas |
|-------|------|-------------|-------|
| `id` | `bigint` / serial | PK | |
| `id_grupo` | `bigint` | NOT NULL, FK → `Grupo(id)`, **UNIQUE** | UNIQUE impõe 1:1 com grupo |
| `logo_url` | `text` | NULLABLE | URL pública do Supabase Storage; NULL → sem logo (usa wordmark/nome) |
| `cor_primaria` | `text` | NULLABLE, formato hex `^#[0-9a-fA-F]{6}$` | validado no backend antes de persistir |
| `cor_destaque` | `text` | NULLABLE, formato hex | cor de destaque/gradiente |
| `nome_exibicao` | `text` | NULLABLE | nome mostrado no wordmark/header |
| `created_at` | `timestamptz` | DEFAULT now() | |
| `updated_at` | `timestamptz` | DEFAULT now() | |

> **Gradiente**: o MVP modela `cor_destaque` como uma cor única; no
> `frontend_motorista` ela substitui o ponto médio do gradiente Movee
> (`--warm-2`), derivando os extremos por luminância no provider, OU é aplicada
> como `--accent`. Decisão de derivação fica no `TenantThemeProvider` (ver
> research Decision 4). Campos extras de gradiente multi-stop ficam fora do MVP.

### Relationships

- `Branding 1 — 1 Grupo` via `id_grupo` (UNIQUE).
- Resolução de branding de uma empresa: `Empresa.id_grupo → Branding.id_grupo`.
  Empresa com `id_grupo = NULL` → sem branding → fallback Movee.

### State Transitions

- **Criação/Update**: `PUT /empresa/branding` (upsert pelo `id_grupo` do escopo do
  token pai). Validação de hex e de logo antes de persistir.
- **Herança**: filhos do grupo leem a mesma `Branding` do grupo (sem override por
  filho no MVP — FR-013).

---

## DDL aditivo (esqueleto — gerado como `.sql` na execução)

```sql
-- docs/sql/001-config-ui-tenant-schema.sql  (aplicar como operador)

CREATE TABLE IF NOT EXISTS "Grupo" (
  id              bigserial PRIMARY KEY,
  nome            text NOT NULL,
  id_empresa_pai  bigint NOT NULL UNIQUE REFERENCES "Empresa"(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE "Empresa"
  ADD COLUMN IF NOT EXISTS id_grupo bigint REFERENCES "Grupo"(id);

CREATE INDEX IF NOT EXISTS idx_empresa_id_grupo ON "Empresa"(id_grupo);

CREATE TABLE IF NOT EXISTS "Branding" (
  id            bigserial PRIMARY KEY,
  id_grupo      bigint NOT NULL UNIQUE REFERENCES "Grupo"(id),
  logo_url      text,
  cor_primaria  text,
  cor_destaque  text,
  nome_exibicao text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Recarregar schema do PostgREST (alternativa: docker kill -s SIGUSR1 pgadmin_postgrest)
NOTIFY pgrst, 'reload schema';
```

```sql
-- docs/sql/002-config-ui-tenant-dg-vinculo.sql  (PARAMETRIZADO — depende de docs/sql/dg-levantamento.sql)
-- BLOQUEIO HUMANO: a lista de CNPJs da D&G ainda será confirmada pelo usuário.
-- NÃO hardcode de ids. Exemplo com placeholders psql:

\set cnpj_pai      '00000000000000'   -- substituir pelo CNPJ pai da D&G
-- 1. cria o grupo a partir do CNPJ pai
INSERT INTO "Grupo" (nome, id_empresa_pai)
SELECT 'D&G', id FROM "Empresa" WHERE cnpj = :'cnpj_pai'
ON CONFLICT (id_empresa_pai) DO NOTHING;

-- 2. vincula filhos (lista parametrizada — preencher após levantamento)
UPDATE "Empresa"
SET id_grupo = (SELECT id FROM "Grupo" WHERE id_empresa_pai =
                  (SELECT id FROM "Empresa" WHERE cnpj = :'cnpj_pai'))
WHERE cnpj = ANY (:'cnpjs_filhos'::text[])   -- :cnpjs_filhos preenchido do dg-levantamento.sql
  AND id_grupo IS NULL;                        -- só vincula quem não tem grupo (FR-004)

NOTIFY pgrst, 'reload schema';
```

> A coluna real de CNPJ na `Empresa` (`cnpj`, `cnpj_prestador`, etc.) será
> confirmada contra o schema durante a execução; o esqueleto acima usa `cnpj` como
> placeholder.

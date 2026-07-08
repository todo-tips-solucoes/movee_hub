# Data Model — hub-motoristas (S5)

Fonte canônica: `01-plano-tecnico.md` §9.2 (`Entregador`, já existente) + D3 §18;
`research.md` desta fase (Decisions 2–7, 10–12). Segue o padrão S2/S4: colunas de
auditoria (`criado_em`/`atualizado_em timestamptz DEFAULT now()`),
`serial PRIMARY KEY`, GRANTs explícitos ao role `authenticated`, RLS por
`id_empresa` quando a tabela carrega escopo de tenant. Migrations expand-only
idempotentes começando em `0019`. Nomes de tabela em PascalCase com aspas,
colunas snake_case.

---

## Entity: Entregador (ALTERADA — migrations `0019`, `0021` acrescentam colunas/constraints; tabela já existe desde `0010`)

Dimensão pessoa-entregadora dos CSVs (≠ `ContaMotorista`, ver entidade nova
abaixo). Esta fase não recria a tabela — só adiciona, de forma aditiva:

| Coluna | Tipo | Constraint | Origem/Notas |
|--------|------|------------|--------------|
| id | serial | PK | (já existe — 0010) |
| id_empresa | int | NOT NULL | (já existe) |
| id_externo | uuid | NOT NULL | (já existe) |
| nome | text | NULL | (já existe) |
| motorista_id | int | **FK física `ContaMotorista(id)` (nova, migration 0021)** | antes "referência lógica sem FK" (0010); agora física — Decision 3 |
| ativo | bool | DEFAULT true | (já existe) |
| **nome_editado_manualmente** | **boolean** | **NOT NULL DEFAULT false (nova, migration 0019)** | protege `nome` de sobrescrita por reimportação — Decision 6 |
| criado_em / atualizado_em | timestamptz | (já existem) | |
| — | | UNIQUE (id_empresa, id_externo) | (já existe) |
| — | | **UNIQUE (motorista_id) WHERE motorista_id IS NOT NULL (nova, migration 0021)** | impõe FR-012 no banco — Decision 3 |

**Migration 0019** (`entregador_edicao_manual.sql`):
```sql
ALTER TABLE "Entregador"
    ADD COLUMN IF NOT EXISTS nome_editado_manualmente boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION hub_protege_nome_editado_entregador()
RETURNS trigger AS $$
BEGIN
    IF OLD.nome_editado_manualmente THEN
        NEW.nome := OLD.nome;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_entregador_protege_nome ON "Entregador";
CREATE TRIGGER trg_entregador_protege_nome
    BEFORE UPDATE ON "Entregador"
    FOR EACH ROW EXECUTE FUNCTION hub_protege_nome_editado_entregador();
```

**Migration 0021** (parte 2, junto de `ContaMotorista` — ver abaixo):
```sql
ALTER TABLE "Entregador"
    ADD CONSTRAINT fk_entregador_conta_motorista
        FOREIGN KEY (motorista_id) REFERENCES "ContaMotorista"(id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_entregador_motorista_id_unico
    ON "Entregador"(motorista_id) WHERE motorista_id IS NOT NULL;
```

RLS: já coberta desde `0015` (`id_empresa = ANY(hub_jwt_escopo_ids())`) —
nenhuma mudança de policy nesta fase.

---

## Entity: ContaMotorista (NOVA — migration `0021`)

Espelho local, isolado ao hub, dos dados de `Motorista` (produção) relevantes
para busca/sugestão de vínculo (research.md Decision 2). **Nunca** é fonte de
verdade — a fonte de verdade continua sendo `Motorista` em `chatmasterveloz`;
esta tabela existe só para tornar a feature testável/operável dentro do
isolamento do hub. Populada por seed determinístico
(`infra/hub/scripts/gen-seeds.py`), nunca por sincronização ao vivo.

| Coluna | Tipo | Constraint | Notas |
|--------|------|------------|-------|
| id | serial | PK | id local do hub — **não** presumir igual ao `Motorista.id` de produção (Decision 2, reconciliação de cutover é trabalho futuro fora de escopo) |
| cnpj_prestador | text | UNIQUE NOT NULL | chave natural espelhada de `Motorista.cnpj_prestador` |
| nome | text | NOT NULL | |
| ativo | bool | NOT NULL DEFAULT true | informativo — **NÃO** usado para elegibilidade (FR-010, resposta operador Q1/dec-009) |
| cadastro_completo | bool | NOT NULL DEFAULT true | informativo (espelha "tem senha definida"); **NÃO** usado para elegibilidade |
| criado_em / atualizado_em | timestamptz | DEFAULT now() | |

Sem RLS (tabela global, mesmo padrão de `Papel`/`Permissao`/`Modulo` — não
carrega `id_empresa`; a elegibilidade por grupo é resolvida via
`EmpresaGrupoMovee`, não por escopo de tenant desta tabela).

```sql
CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS "ContaMotorista" (
    id                 serial PRIMARY KEY,
    cnpj_prestador     text NOT NULL UNIQUE,
    nome               text NOT NULL,
    ativo              boolean NOT NULL DEFAULT true,
    cadastro_completo  boolean NOT NULL DEFAULT true,
    criado_em          timestamptz NOT NULL DEFAULT now(),
    atualizado_em      timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION hub_normaliza_nome(texto text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT lower(unaccent(coalesce(texto, '')));
$$;

CREATE INDEX IF NOT EXISTS idx_conta_motorista_nome_trgm
    ON "ContaMotorista" USING gin (hub_normaliza_nome(nome) gin_trgm_ops);

GRANT SELECT, INSERT, UPDATE ON "ContaMotorista" TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE "ContaMotorista_id_seq" TO authenticated;
```

(FK/índice único de `Entregador.motorista_id` incluídos nesta mesma migration —
ver bloco acima, precisa que `ContaMotorista` já exista.)

---

## Entity: EmpresaGrupoMovee (NOVA — migration `0022`)

Allowlist mínima de `id_empresa` (valores lógicos, mesmo padrão de referência
sem FK física já usado para `id_empresa` em `Entregador`/demais tabelas do hub)
que pertencem ao grupo Movee — resolve FR-010/FR-011 sem precisar reconstruir
`mesmoGrupoQue`/`Empresa`/`Grupo` dentro do banco isolado do hub (research.md
Decision 2, evidência: `0006_rls_policies.sql` "mesmoGrupoQue/resolveScope NÃO
se aplicam ao hub").

| Coluna | Tipo | Constraint | Notas |
|--------|------|------------|-------|
| id_empresa | int | PRIMARY KEY | id lógico da entidade (mesmo padrão de `Entregador.id_empresa`) |
| criado_em | timestamptz | DEFAULT now() | |

```sql
CREATE TABLE IF NOT EXISTS "EmpresaGrupoMovee" (
    id_empresa int PRIMARY KEY,
    criado_em  timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON "EmpresaGrupoMovee" TO authenticated;
```

Sem RLS (allowlist global, não sensível — mesma classe de `Papel`/`Modulo`).
Populada por seed por ambiente: em `hub_homolog`, contém o(s) `id_empresa`
sintético(s) usado(s) para demonstrar o ramo "elegível" (ex.: `empresa_id=9001`,
já usado como tenant de teste da S4 — ver seeds); qualquer outro `id_empresa`
sintético usado nos testes permanece **fora** da tabela para demonstrar o ramo
"não elegível" (FR-011).

---

## Uso combinado nas consultas de vínculo (FR-006 a FR-013)

**Mecanismo obrigatório de consulta (research.md Decision 10, gate
`owasp-security`)**: sugestão e busca manual são funções RPC do PostgREST
(`POST /rpc/hub_motoristas_candidatos`, `POST /rpc/hub_motoristas_busca`),
**nunca** SQL montado por concatenação de string no backend Node — o
PostgREST faz bind de parâmetros nativamente para chamadas RPC (mesma garantia
de uma prepared statement). Ambas fazem a checagem de elegibilidade de grupo
(`EmpresaGrupoMovee`) e o filtro por escopo de `Entregador` (via RLS)
**dentro** da função — único ponto de verdade, sem duplicar a regra em cada
endpoint.

```sql
CREATE OR REPLACE FUNCTION hub_motoristas_candidatos(p_entregador_id int)
RETURNS TABLE (
    conta_motorista_id int, nome text, cnpj_prestador text,
    similaridade real, ja_vinculado_a int, ja_vinculado_a_nome text
)
LANGUAGE sql STABLE SECURITY INVOKER AS $$
    -- RLS de Entregador filtra p_entregador_id fora do escopo -> 0 linhas
    -- (backend traduz "sem linhas" em 404, mesmo padrão de GET /motoristas/:id
    -- — research.md Decision 11).
    WITH alvo AS (
        SELECT id_empresa, nome FROM "Entregador" WHERE id = p_entregador_id
    )
    SELECT cm.id, cm.nome, cm.cnpj_prestador,
           similarity(hub_normaliza_nome(cm.nome), hub_normaliza_nome(alvo.nome)),
           e2.id, e2.nome
    FROM alvo
    JOIN "EmpresaGrupoMovee" g ON g.id_empresa = alvo.id_empresa
    CROSS JOIN "ContaMotorista" cm
    LEFT JOIN "Entregador" e2 ON e2.motorista_id = cm.id AND e2.id <> p_entregador_id
    WHERE similarity(hub_normaliza_nome(cm.nome), hub_normaliza_nome(alvo.nome)) >= 0.3
    ORDER BY 4 DESC
    LIMIT 10;
$$;

CREATE OR REPLACE FUNCTION hub_motoristas_busca(p_entregador_id int, p_termo text, p_limit int, p_offset int)
RETURNS TABLE (
    conta_motorista_id int, nome text, cnpj_prestador text,
    ja_vinculado_a int, ja_vinculado_a_nome text, total bigint
)
LANGUAGE sql STABLE SECURITY INVOKER AS $$
    WITH alvo AS (
        SELECT id_empresa FROM "Entregador" WHERE id = p_entregador_id
    ), elegivel AS (
        SELECT 1 FROM alvo JOIN "EmpresaGrupoMovee" g ON g.id_empresa = alvo.id_empresa
    ), base AS (
        SELECT cm.id, cm.nome, cm.cnpj_prestador, e2.id AS vinc_id, e2.nome AS vinc_nome
        FROM "ContaMotorista" cm
        LEFT JOIN "Entregador" e2 ON e2.motorista_id = cm.id AND e2.id <> p_entregador_id
        WHERE EXISTS (SELECT 1 FROM elegivel)
          AND hub_normaliza_nome(cm.nome) LIKE '%' || hub_normaliza_nome(p_termo) || '%'
    )
    SELECT id, nome, cnpj_prestador, vinc_id, vinc_nome, count(*) OVER ()
    FROM base ORDER BY nome LIMIT p_limit OFFSET p_offset;
$$;

GRANT EXECUTE ON FUNCTION hub_motoristas_candidatos(int) TO authenticated;
GRANT EXECUTE ON FUNCTION hub_motoristas_busca(int, text, int, int) TO authenticated;
```

`SECURITY INVOKER` (não `DEFINER`) — as funções rodam com os privilégios do
role `authenticated` chamador, então a RLS de `Entregador` se aplica
normalmente dentro da função (nenhum bypass de isolamento).

1. **Elegibilidade** (FR-010/FR-011): resolvida dentro das duas funções acima
   via `JOIN "EmpresaGrupoMovee"` — entidade fora do grupo nunca chega a
   `CROSS JOIN "ContaMotorista"` (retorna 0 linhas, backend responde
   `entidadeElegivel:false, items:[]`, nunca erro).
2. **Sugestões** (`GET /motoristas/:id/sugestoes`, FR-007): backend chama
   `POST /rpc/hub_motoristas_candidatos {p_entregador_id}`.
3. **Busca manual** (`GET /motoristas/contas-elegiveis?q=`, FR-009): backend
   chama `POST /rpc/hub_motoristas_busca {p_entregador_id, p_termo, p_limit,
   p_offset}` — sem corte por `similarity`, com paginação normal.
4. **Vínculo** (`POST /motoristas/:id/vinculo`, FR-006/FR-008/FR-012/FR-013):
   allowlist de campos do request = `{contaMotoristaId}` (nenhum outro campo é
   lido — research.md Decision 12); `UPDATE "Entregador" SET motorista_id =
   $contaId WHERE id = $entregadorId`. Duas violações possíveis, distintas:
   - FK inválida (`$contaId` não existe em `ContaMotorista`) → backend
     responde `404 NAO_ENCONTRADO`.
   - `idx_entregador_motorista_id_unico` (já vinculada a outro Entregador) →
     backend responde `409 CONFLITO` com o id/nome do Entregador já vinculado
     (consulta prévia para poder informar, ver contract).
5. **Desvínculo** (`DELETE /motoristas/:id/vinculo`, FR-006): `UPDATE
   "Entregador" SET motorista_id = NULL WHERE id = $entregadorId`.
6. **Edição** (`PATCH /motoristas/:id`, FR-004/FR-005): allowlist de campos do
   request = `{nome, ativo}` — nenhum outro campo do corpo (incluindo
   `motoristaId`/`nomeEditadoManualmente`) é lido ou repassado ao PostgREST
   (research.md Decision 12, fecha gap de mass assignment do gate
   `owasp-security`).

---

## Área de atuação (subpraça) — sem entidade nova (migration `0020`)

Resolvido por índice novo nos fatos já existentes (research.md Decision 5),
sem alterar `Entregador`:

```sql
CREATE INDEX IF NOT EXISTS idx_faturamento_empresa_subpraca
    ON "FaturamentoLancamento"(id_empresa, subpraca, entregador_id);
CREATE INDEX IF NOT EXISTS idx_performance_empresa_subpraca
    ON "PerformanceTurno"(id_empresa, subpraca, entregador_id);
```

- **Filtro por área** (FR-002, lista): `EXISTS (SELECT 1 FROM
  "FaturamentoLancamento" f WHERE f.id_empresa=$e AND f.entregador_id=E.id AND
  f.subpraca=$area) OR EXISTS (SELECT 1 FROM "PerformanceTurno" p WHERE
  p.id_empresa=$e AND p.entregador_id=E.id AND p.subpraca=$area)`.
- **Áreas distintas do detalhe** (FR-003): `SELECT subpraca, MAX(data) AS
  data_mais_recente FROM (SELECT subpraca, data_referencia AS data FROM
  "FaturamentoLancamento" WHERE entregador_id=$id UNION ALL SELECT subpraca,
  data_periodo FROM "PerformanceTurno" WHERE entregador_id=$id) t WHERE
  subpraca IS NOT NULL GROUP BY subpraca ORDER BY data_mais_recente DESC`.

---

## Resumo de indicadores do detalhe (FR-003 — contagens all-time)

```sql
SELECT
  (SELECT count(*) FROM "FaturamentoLancamento" WHERE entregador_id=$id) AS total_faturamento,
  (SELECT count(*) FROM "PerformanceTurno"      WHERE entregador_id=$id) AS total_performance,
  (SELECT max(data_referencia) FROM (
      SELECT data_referencia AS data FROM "FaturamentoLancamento" WHERE entregador_id=$id
      UNION ALL
      SELECT data_periodo FROM "PerformanceTurno" WHERE entregador_id=$id
   ) t) AS data_mais_recente;
```

Usa os índices `(id_empresa, entregador_id, data_referencia)` /
`(id_empresa, entregador_id, data_periodo)` já criados na S4 — nenhum índice
novo necessário para este ponto.

---

## Mapa permissão lógica → código real (consumido pelo `requirePermission`)

Nenhuma migration de RBAC nesta fase — `Permissao` do módulo `motoristas` já
semeada em `0007` (research.md Decision 7).

| Endpoint | Permissão real |
|----------|-----------------|
| GET /motoristas | `motoristas.listar` |
| GET /motoristas/:id | `motoristas.consultar` |
| PATCH /motoristas/:id | `motoristas.editar` |
| GET /motoristas/:id/sugestoes | `motoristas.editar` |
| GET /motoristas/contas-elegiveis | `motoristas.editar` |
| POST /motoristas/:id/vinculo | `motoristas.editar` |
| DELETE /motoristas/:id/vinculo | `motoristas.editar` |

---

## Migrations desta fase (resumo)

| Nº | Arquivo | Conteúdo |
|----|---------|----------|
| 0019 | `entregador_edicao_manual.sql` | coluna `nome_editado_manualmente` + trigger de proteção (Decision 6) |
| 0020 | `fatos_indices_subpraca.sql` | índices `(id_empresa, subpraca, entregador_id)` em `FaturamentoLancamento`/`PerformanceTurno` (Decision 5) |
| 0021 | `conta_motorista.sql` | tabela `ContaMotorista` + extensões `unaccent`/`pg_trgm` + índice trigram + FK/índice único em `Entregador.motorista_id` (Decisions 2–4) |
| 0022 | `empresa_grupo_movee.sql` | tabela `EmpresaGrupoMovee` (allowlist, Decision 2) |
| 0023 | `motoristas_rpc_candidatos.sql` | funções `hub_motoristas_candidatos`/`hub_motoristas_busca` + GRANTs EXECUTE (Decisions 10–11, gate `owasp-security`) |

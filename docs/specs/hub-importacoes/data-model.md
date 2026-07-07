# Data Model — hub-importacoes (S4)

Fonte canônica: `01-plano-tecnico.md` §9.2 (catálogo) + §10 (matriz CSV→banco).
Todas as tabelas novas seguem o padrão S2: colunas de auditoria (`criado_em
timestamptz DEFAULT now()`, `atualizado_em timestamptz DEFAULT now()`) presentes,
`serial PRIMARY KEY`, GRANTs explícitos ao role `authenticated`, RLS por
`id_empresa` (nega-por-padrão via `hub_jwt_escopo_ids()`). Migrations expand-only
idempotentes começando em `0010`. Nomes de tabela em PascalCase com aspas
(`"Entregador"`), colunas snake_case.

---

## Entity: Entregador  (migration 0010)

Dimensão pessoa-entregadora dos CSVs (≠ `Motorista`, base de login do app
motorista — vínculo opcional via `motorista_id`).

| Coluna | Tipo | Constraint | Origem/Notas |
|--------|------|------------|--------------|
| id | serial | PK | |
| id_empresa | int | FK Empresa NOT NULL | escopo tenant |
| id_externo | uuid | NOT NULL | `id_da_pessoa_entregadora` do CSV |
| nome | text | NULL | `recebedor`/`pessoa_entregadora` |
| motorista_id | int | FK Motorista NULL | vínculo opcional (D3) |
| ativo | bool | DEFAULT true | |
| — | | UNIQUE (id_empresa, id_externo) | upsert key |

Índices: `(id_empresa, nome)` (busca). RLS: `id_empresa = ANY(hub_jwt_escopo_ids())`.

---

## Entity: ImportacaoArquivo  (migration 0011)

Cabeçalho de cada importação (metadado + contadores + estado).

| Coluna | Tipo | Constraint | Notas |
|--------|------|------------|-------|
| id | serial | PK | |
| id_empresa | int | FK Empresa NOT NULL | |
| tipo | text | CHECK IN ('faturamento','performance','envio_massa') | `envio_massa` no CHECK desde já (usado na S8) |
| nome_arquivo | text | | sanitizado |
| hash_sha256 | char(64) | NOT NULL | sha256 do arquivo |
| tamanho_bytes | bigint | | |
| status | text | CHECK IN ('pending','validating','processing','completed','completed_with_errors','failed','cancelled') | |
| total_linhas | int | | |
| linhas_validas | int | | |
| linhas_invalidas | int | | |
| data_referencia | date | | extraída do conteúdo |
| iniciado_em | timestamptz | | |
| concluido_em | timestamptz | | |
| erro_resumo | text | | motivo de falha estrutural |
| criado_por | int | FK Usuario NULL | quem importou |
| — | | **UNIQUE (id_empresa, tipo, hash_sha256)** | dedupe de arquivo |

Índices: `(id_empresa, tipo, data_referencia DESC)`. RLS: `id_empresa = ANY(...)`.

**State transitions** (§12.2):
```
pending → validating → processing → completed | completed_with_errors | failed
cancelled  ← a partir de pending / validating / processing (entre lotes)
(reprocessar: failed|cancelled → pending [reset])
```

---

## Entity: ImportacaoLinhaErro  (migration 0012)

Erro por linha. `valor_mascarado` NUNCA carrega a linha bruta (LGPD §7.6).

| Coluna | Tipo | Constraint | Notas |
|--------|------|------------|-------|
| id | serial | PK | |
| importacao_id | int | FK ImportacaoArquivo NOT NULL | |
| id_empresa | int | FK Empresa NOT NULL | **denormalizado p/ RLS uniforme (Decision 4)** |
| numero_linha | int | NOT NULL | linha no CSV (1-based, pós-header) |
| motivo | text | NOT NULL | linguagem compreensível |
| campo | text | NULL | coluna problemática |
| valor_mascarado | text | NULL | valor mascarado, nunca bruto |

Índice: `(importacao_id)`. RLS: `id_empresa = ANY(hub_jwt_escopo_ids())`.

---

## Entity: FaturamentoLancamento  (migration 0013)

Fato append-only; grão = 1 linha do CSV de faturamento. Sem delete lógico.

| Coluna | Tipo | Constraint | Transformação (§10) |
|--------|------|------------|---------------------|
| id | serial | PK | |
| id_empresa | int | FK NOT NULL | |
| importacao_id | int | FK NOT NULL | |
| entregador_id | int | FK Entregador NULL | upsert por UUID; NULL se 4,5% sem UUID |
| recebedor_agregado | text | NULL | rótulo do bônus quando sem entregador |
| data_lancamento | date | NOT NULL | `data_do_lancamento_financeiro`, ISO |
| data_referencia | date | NOT NULL | `data_do_periodo_de_referencia` |
| data_repasse | date | | `data_do_repasse`, ≥ data_referencia |
| periodo | text | NULL | trim, uppercase |
| praca | text | | trim; extrair zona se sufixo "(ZONA)" |
| subpraca | text | | trim (header `subpraca`, sem `_`) |
| origem | text | NULL | trim |
| tipo | text | NOT NULL | Credito/Debito (novo valor = warning) |
| valor | numeric(12,2) | NOT NULL | **vírgula→ponto**; > 0; ≤ teto config |
| descricao | text | NOT NULL | categoria (nova = warning) |
| atingido | numeric(8,2) | NULL | vírgula→ponto; 0–1000 (D4, sem interpretar) |
| pct_tempo_disponivel | numeric(8,2) | NULL | idem |
| pct_aceitacao | numeric(8,2) | NULL | idem |
| pct_conclusao | numeric(8,2) | NULL | idem |
| criterio_tempo_disponivel | numeric(8,2) | NULL | idem |
| criterio_rotas_aceitas | numeric(8,2) | NULL | idem |
| criterio_rotas_concluidas | numeric(8,2) | NULL | idem |
| margem_fee_raw | text | NULL | cru (D4) |
| margem_fee_min | numeric(8,2) | NULL | regex `MIN:(x)` derivada |
| margem_fee_inter | numeric(8,2) | NULL | regex `INTER:(y)` derivada |
| hash_linha | char(64) | NOT NULL | sha256 da linha normalizada |
| — | | **UNIQUE (id_empresa, hash_linha)** | idempotência por linha |

Índices: `(id_empresa, data_referencia)`, `(id_empresa, entregador_id,
data_referencia)`, `(id_empresa, descricao)`. RLS: `id_empresa = ANY(...)`.

---

## Entity: PerformanceTurno  (migration 0014)

Fato append-only; grão = entregador × turno × dia (× subpraça). Decimal **ponto**.

| Coluna | Tipo | Constraint | Transformação (§10) |
|--------|------|------------|---------------------|
| id | serial | PK | |
| id_empresa | int | FK NOT NULL | |
| importacao_id | int | FK NOT NULL | |
| entregador_id | int | FK Entregador NOT NULL | UUID **obrigatório** (erro se ausente) |
| data_periodo | date | NOT NULL | `data_do_periodo`, ISO |
| periodo | text | NOT NULL | trim, uppercase |
| duracao | interval | | `duracao_do_periodo` HH:MM:SS |
| min_entregadores_escala | int | | ≥ 0 |
| tag | text | | trim |
| praca | text | | trim |
| subpraca | text | NULL | header `sub_praca` (com `_`) |
| origem | text | NULL | trim |
| tempo_disponivel_pct | numeric(6,2) | | ponto direto; 0–150 |
| tempo_disponivel | interval | | `tempo_disponivel_absoluto` HH:MM:SS |
| corridas_ofertadas | int | NOT NULL DEFAULT 0 | ≥ 0 |
| corridas_aceitas | int | NOT NULL DEFAULT 0 | aceitas+rejeitadas ≤ ofertadas |
| corridas_rejeitadas | int | NOT NULL DEFAULT 0 | |
| corridas_completadas | int | NOT NULL DEFAULT 0 | ≤ aceitas |
| corridas_canceladas | int | NOT NULL DEFAULT 0 | |
| pedidos_concluidos | int | | |
| taxas_centavos | int | | `soma_das_taxas...` em centavos (int direto) |
| hash_linha | char(64) | NOT NULL | sha256 da linha normalizada |
| — | | **UNIQUE (id_empresa, hash_linha)** | idempotência por linha |

Índices: `(id_empresa, data_periodo)`, `(id_empresa, entregador_id, data_periodo)`.
RLS: `id_empresa = ANY(...)`.

---

## Migration 0015 — RLS das 5 tabelas novas

Mesmo padrão de `0006`: `ENABLE ROW LEVEL SECURITY` + `DROP POLICY IF EXISTS` +
`CREATE POLICY ... USING (id_empresa = ANY(hub_jwt_escopo_ids()))` para SELECT e
`WITH CHECK` para INSERT/UPDATE, em `Entregador`, `ImportacaoArquivo`,
`ImportacaoLinhaErro`, `FaturamentoLancamento`, `PerformanceTurno`. Owner das
migrations mantém bypass (sem FORCE RLS) para seeds/administração. Nega-por-padrão:
claim `escopo` ausente → `hub_jwt_escopo_ids()` = `[]` → nenhuma linha casa.

## Migration 0016 — Seed corretivo de permissão (Decision 2)

```
INSERT INTO "Permissao" (codigo, modulo_id)
  SELECT 'importacoes.exportar', id FROM "Modulo" WHERE codigo='importacoes'
  ON CONFLICT (codigo) DO NOTHING;
-- concede a admin_plataforma e admin_entidade (NÃO operador/leitura)
INSERT INTO "PapelPermissao" (papel_id, permissao_id)
  SELECT p.id, perm.id FROM "Papel" p CROSS JOIN "Permissao" perm
  WHERE p.nome IN ('admin_plataforma','admin_entidade')
    AND perm.codigo='importacoes.exportar'
  ON CONFLICT DO NOTHING;
```

---

## Mapa permissão lógica → código real (consumido pelo `requirePermission`)

| Endpoint | Permissão real |
|----------|----------------|
| GET /importacoes, GET /importacoes/:id, GET .../erros | `importacoes.consultar` |
| POST /importacoes, POST .../reprocessar, POST .../cancelar | `importacoes.criar` |
| GET /importacoes/:id/original | `importacoes.exportar` (novo, 0016) |

`importacoes.importar` permanece semeada (0007) mas não é gate de nenhum endpoint
público nesta fase (reservada; upload usa `criar`).

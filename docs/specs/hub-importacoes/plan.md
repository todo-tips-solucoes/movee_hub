# Plano de Implementação — Pipeline de Importações (hub-importacoes / S4)

**Feature**: hub-importacoes · **Fase**: S4 do Hub de Frota · **Branch alvo**:
`feat/hub-importacoes` · **Ambiente**: hub-homolog ISOLADO (VPSTodo, recursos
`hub-*`) — NUNCA produção/`chatmasterveloz`.

## Summary

Pipeline idempotente de importação (upload → validação → persistência → erros →
histórico) + telas, para os tipos `faturamento` e `performance`. Requisito
primário: reimportar o mesmo arquivo produz **zero** duplicatas (dedupe duplo por
hash de arquivo e hash de linha). Abordagem técnica: 7 migrations expand-only
(`0010`–`0016`) que criam 5 tabelas novas (`Entregador`, `ImportacaoArquivo`,
`ImportacaoLinhaErro`, `FaturamentoLancamento`, `PerformanceTurno`) + RLS + seed
corretivo de permissão; backend `/api/v1/importacoes*` com parser POR TIPO
(dialetos numéricos distintos), processamento síncrono em lotes de 500 com `ON
CONFLICT DO NOTHING`, lock advisory por `(id_empresa, tipo)`, e erros por linha com
valor mascarado (LGPD); frontend `/hub/importacoes` + `/hub/importacoes/:id` via
`/ui-ux-pro-max` (EntreGô 2.0). Detalhes em research.md, data-model.md,
contracts/importacoes-api.md, quickstart.md.

## Technical Context

| Campo | Valor |
|-------|-------|
| Linguagem backend | Node.js 14 (Express) — `app_homologacao/backend/` |
| Linguagem frontend | Next.js (frontend_v2, node:20-alpine) — `app_homologacao/frontend_v2/` |
| Persistência | PostgreSQL do hub via **PostgREST** (`lib/hub-postgrest.js`) |
| Auth | JWT cookies httpOnly (`accessToken`/`refreshToken`); claims `sub`/`empresa_ativa`/`escopo` |
| RBAC | `middleware/hub-require-permission.js` (fail-closed) + `lib/hub-rbac-cache.js` |
| RLS | policies por `id_empresa = ANY(hub_jwt_escopo_ids())` (padrão 0006) |
| Migrations | `infra/hub/migrations/` (próxima=0010), aplicadas por `infra/hub/scripts/migrate.sh` (registra SchemaMigration + SIGUSR1 reload PostgREST) |
| Testing | unit (parser/normalizador, sem banco) + integração (PostgREST hub) — padrão `tests/hub-*.test.js` |
| Limites (§12) | upload ≤ 20 MB; ZIP 1 entrada ≤ 100 MB descomprimido, sem path traversal; lote 500; >50% inválidas → failed; timeout import 120 s |
| Design UI | EntreGô 2.0 preservado; toda tela nova via `/ui-ux-pro-max`; reusar `use-process-status`/`data-table`/`filters` |
| NEEDS CLARIFICATION restantes | 0 (5 Q/A do clarify integradas; D4 ratificado) |

## Constitution Check

*GATE: passou antes do Phase 0; re-checado após Phase 1 (§ no fim).*

| Princípio | Status | Notas |
|-----------|--------|-------|
| I. Segurança de Auth & Segredos (NON-NEGOTIABLE) | PASS | Auth por cookie httpOnly reusada; nenhum segredo novo; CSV bruto/PII nunca em log/git/contexto (LGPD, Decision 8) |
| II. Isolamento Multi-Tenant por Empresa (NON-NEGOTIABLE) | PASS | `id_empresa` sempre do token; RLS em todas as 5 tabelas (incl. `ImportacaoLinhaErro` denormalizado, Decision 4); filtro PostgREST `id_empresa=eq.` |
| III. Contratos de API & Proxy de Cookies | PASS | Endpoints sob `/api/v1/importacoes*`; contrato camelCase declarado (contracts/ + §Convenções de Borda); roundtrip real no quickstart |
| IV. Qualidade e Revisão de Mudanças | PASS | Unit-first; gates doc/security; fechamento só em review-task (DIARIO + PR draft) |
| V. Deploy Conteinerizado e Convivência (NON-NEGOTIABLE) | PASS | Só recursos `hub-*` isolados; migrations via migrate.sh do hub; sem tocar Swarm/stacks de produção |

Nenhuma violação de MUST. Prosseguir.

## Project Structure

### Documentação (feature dir)
```
docs/specs/hub-importacoes/
├── spec.md            (existente; clarify integrado)
├── plan.md            (este)
├── research.md        (Phase 0 — 10 decisions)
├── data-model.md      (5 entidades + 0015 RLS + 0016 seed)
├── contracts/
│   └── importacoes-api.md
└── quickstart.md      (10 cenários)
```

### Código (árvore real do projeto)
```
infra/hub/migrations/
├── 0010_entregador.sql              (novo)
├── 0011_importacao_arquivo.sql      (novo)
├── 0012_importacao_linha_erro.sql   (novo)
├── 0013_faturamento_lancamento.sql  (novo)
├── 0014_performance_turno.sql       (novo)
├── 0015_rls_importacoes.sql         (novo)
└── 0016_seed_permissao_importacoes.sql (novo)

app_homologacao/backend/
├── routes/hub-importacoes.js        (novo — endpoints §14)
├── lib/
│   ├── hub-import-parser.js         (novo — parser POR TIPO, unit-first)
│   ├── hub-import-normalizer.js     (novo — transformações §10, hash_linha)
│   ├── hub-import-processor.js      (novo — pipeline/estados/lotes/lock, interface ImportJob)
│   ├── hub-postgrest.js             (existente — reusar)
│   └── hub-auditoria.js             (existente — reusar p/ Auditoria)
├── middleware/hub-require-permission.js (existente — reusar)
└── tests/
    ├── hub-import-parser.test.js    (novo — unit)
    ├── hub-import-normalizer.test.js(novo — unit)
    └── hub-importacoes.test.js      (novo — integração)

app_homologacao/frontend_v2/
├── app/hub/importacoes/
│   ├── page.tsx                     (novo — histórico + upload)
│   └── [id]/page.tsx                (novo — detalhe/progresso/erros)
├── components/hub/
│   └── import-wizard.tsx            (novo — via /ui-ux-pro-max)
└── lib/hub/
    └── importacoes-dto.ts           (novo — mapper camelCase)
```

## Convenções de Borda

| Camada | Case style | Validação | Fonte da verdade |
|--------|------------|-----------|------------------|
| DB columns (PostgreSQL) | snake_case | CHECK + constraint na migration | `infra/hub/migrations/00{10..16}_*.sql` |
| PostgREST payload | snake_case | — (espelha DB) | tabelas do hub |
| Backend DTO / API payload (request/response) | **camelCase** | shaping no route + mapper | `app_homologacao/backend/routes/hub-importacoes.js` |
| Frontend DTO (TS) | camelCase | parse no fetch | `app_homologacao/frontend_v2/lib/hub/importacoes-dto.ts` |
| URL query/path params | camelCase (`pageSize`) / :id | router Express | `contracts/importacoes-api.md` |

**Mapper layer (DB ↔ DTO)**: `routes/hub-importacoes.js` traduz snake_case do
PostgREST → camelCase da API (mesmo padrão de `hub-me.js`/`lib/hub/me-dto.ts`).
ORM auto-mapping: **NÃO** (PostgREST REST puro; mapeamento manual explícito).
**Validação**: shape do request validado no backend; response validada no roundtrip
E2E (quickstart Cenário 10) — evita drift snake↔camel histórico.

## Plano por fases (ordem do briefing)

1. **Migrations** (`0010`–`0016`) — tabelas + índices + GRANTs `authenticated` +
   RLS + seed corretivo `importacoes.exportar`. Aplicar via `migrate.sh` no
   hub-homolog; verificar reload PostgREST (SIGUSR1). Idempotência: re-rodar =
   no-op.
2. **Parser + normalizador** (unit-first) — `hub-import-parser.js` (BOM, `;`,
   streaming, seleção por tipo) + `hub-import-normalizer.js` (§10 coluna-a-coluna,
   dialetos numéricos, HH:MM:SS→interval, margem_fee regex, hash_linha). Testes
   unit cobrindo os dois dialetos + edge cases ANTES de tocar banco.
3. **POST upload + dedupe** — validação extensão/MIME/tamanho/conteúdo/ZIP-seguro;
   sha256; 409 duplicado; armazenamento do original por id; cria `ImportacaoArquivo`.
4. **Processamento em lote + erros** — `hub-import-processor.js`: estados, lotes de
   500 `ON CONFLICT DO NOTHING`, upsert `Entregador`, lock advisory `(id_empresa,
   tipo)`, >50% → failed (rollback), erros por linha (valor mascarado), interface
   `ImportJob` isolada.
5. **Endpoints de consulta/ação** — GET lista/detalhe/erros(+csv anti-injection),
   GET original (`exportar`), POST reprocessar/cancelar; `requirePermission` com
   códigos reais (data-model.md mapa).
6. **Telas** — `/hub/importacoes` + `/hub/importacoes/:id` via `/ui-ux-pro-max`
   (wizard, progresso por polling, tabela de erros, download relatório, histórico,
   reprocessar/cancelar), reusando padrões existentes.
7. **E2E + evidências** — quickstart 10 cenários no hub-homolog com seeds
   anonimizados; roundtrip real (Cenário 10); coletar evidências (contadores,
   idempotência, gate export, isolamento).

## Complexity Tracking

Sem violações de constitution que exijam justificativa. Complexidade deliberadamente
contida: sem fila (interface `ImportJob` isolada para plugar depois — Decision 10);
sem particionamento (gatilho >10M linhas, §10.2); sem view materializada (gatilho
dashboard >1s, §12.6). Nenhum serviço/camada novo além do já existente no hub.

## Re-check de Constitution (pós-Phase 1)

Design não introduziu complexidade não justificada. Denormalização de `id_empresa`
em `ImportacaoLinhaErro` (Decision 4) é expand-only e *reforça* Princípio II (RLS
uniforme), não o enfraquece. Todas as 5 tabelas com RLS por token. Seed 0016 fecha
o gap que impediria US4-5 (gate de export). MUST I–V continuam PASS.

## Próximos passos

1. `/checklist` — quality gate antes de implementar.
2. `/create-tasks` — decompor este plano em backlog executável (ordem das 7 fases).
3. `/analyze` — validar consistência spec↔plan↔tasks após tasks.

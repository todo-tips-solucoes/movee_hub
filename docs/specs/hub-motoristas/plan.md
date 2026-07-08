# Plano de Implementação — Módulo Motoristas (hub-motoristas / S5)

**Feature**: hub-motoristas · **Fase**: S5 do Hub de Frota · **Branch alvo**:
`feat/hub-motoristas` · **Ambiente**: hub-homolog ISOLADO (VPSTodo, recursos
`hub-*`) — NUNCA produção/`chatmasterveloz`.

## Summary

Tela e API unificadas de gestão de pessoas entregadoras (`Entregador`, dimensão
da S4) no hub: listar/filtrar (nome, situação, área de atuação — subpraça —,
com/sem vínculo) com paginação server-side; detalhe com resumo de indicadores
all-time e áreas distintas; editar nome (protegido de sobrescrita por
reimportação futura) e situação; vincular/desvincular a uma conta de acesso do
app motorista via sugestão automática por semelhança de nome (`pg_trgm`/
`unaccent`, top 10, limiar mínimo) ou busca manual — confirmação humana sempre
obrigatória, nunca automática. Abordagem técnica: como o hub é um ambiente
isolado sem conectividade real a `chatmasterveloz` (onde mora `Motorista`),
esta fase introduz um espelho local `ContaMotorista` (populado por seed
sintético, nunca sincronização ao vivo) + allowlist `EmpresaGrupoMovee` para
resolver a elegibilidade de grupo sem reconstruir `mesmoGrupoQue`. 5 migrations
expand-only (`0019`–`0023`). Detalhes em `research.md`, `data-model.md`,
`contracts/motoristas-api.md`, `quickstart.md`.

## Technical Context

| Campo | Valor |
|-------|-------|
| Linguagem backend | Node.js 14 (Express) — `app_homologacao/backend/` (imagem `Dockerfile.hub`, Node 20 no container do hub) |
| Linguagem frontend | Next.js (frontend_v2, node:20-alpine) — `app_homologacao/frontend_v2/` |
| Persistência | PostgreSQL 13 do hub via **PostgREST** (`lib/hub-postgrest.js`) — isolado, sem acesso a `chatmasterveloz` |
| Auth | JWT cookies httpOnly (`accessToken`/`refreshToken`); claims `sub`/`empresa_ativa`/`escopo` |
| RBAC | `middleware/hub-require-permission.js` (fail-closed) + `lib/hub-rbac-cache.js`; módulo/permissões `motoristas.*` JÁ semeados em `0007` (research.md Decision 7) |
| RLS | `Entregador` já coberta desde `0015` (`id_empresa = ANY(hub_jwt_escopo_ids())`); `ContaMotorista`/`EmpresaGrupoMovee` são globais, sem RLS (mesmo padrão de `Papel`/`Modulo`) |
| Migrations | `infra/hub/migrations/` (próxima=0019), aplicadas por `infra/hub/scripts/migrate.sh` |
| Similaridade de nome | `pg_trgm` + `unaccent` nativos do Postgres (research.md Decision 4) — sem dependência Node nova |
| Testing | unit (normalização/permissão) + integração (PostgREST hub) — padrão `tests/hub-*.test.js` |
| Design UI | EntreGô 2.0 preservado; tela via `/ui-ux-pro-max`; rota real `/hub/dashboard/motoristas` (research.md Decision 8, segue convenção da S4, não o rascunho `/motoristas` do plano técnico) |
| NEEDS CLARIFICATION restantes | 0 (5 Q/A do clarify integradas: Q1/Q3 por heurística autônoma dec-009/dec-010; Q2/Q4/Q5 por resposta do operador dec-015/dec-016/dec-017) |

## Constitution Check

*GATE: passou antes do Phase 0 (feature-00c-preflight); re-checado após Phase 1 (§ no fim).*

| Princípio | Status | Notas |
|-----------|--------|-------|
| I. Segurança de Auth & Segredos (NON-NEGOTIABLE) | PASS | Auth por cookie httpOnly reusada, sem segredo novo; `cnpjPrestadorMascarado` nunca expõe CNPJ completo (LGPD, mesmo padrão de `valor_mascarado` da S4) |
| II. Isolamento Multi-Tenant por Empresa (NON-NEGOTIABLE) | PASS | `id_empresa` sempre do token; RLS já existente em `Entregador`; `ContaMotorista`/`EmpresaGrupoMovee` são catálogos globais análogos a `Papel`/`Modulo` (não carregam dado de negócio por tenant); elegibilidade de grupo (FR-010/011) resolvida por consulta explícita à allowlist, nunca por comparação direta com uma única empresa |
| III. Contratos de API & Proxy de Cookies | PASS | Endpoints sob `/api/v1/motoristas*`; contrato camelCase declarado (contracts/ + §Convenções de Borda); roundtrip real no quickstart (Cenário 11) |
| IV. Qualidade e Revisão de Mudanças | PASS | Unit-first (normalização de nome/similaridade, validação de vínculo); gates doc/security; fechamento só em review-task (DIARIO + PR) |
| V. Deploy Conteinerizado e Convivência (NON-NEGOTIABLE) | PASS | Só recursos `hub-*` isolados; migrations via `migrate.sh` do hub; **nenhuma** integração ao vivo com `chatmasterveloz` — `ContaMotorista` é espelho local por seed, nunca uma ponte de rede para produção (research.md Decision 2, alternativas `dblink`/chamada HTTP cruzada explicitamente rejeitadas por violarem este princípio) |

Nenhuma violação de MUST. Prosseguir.

## Project Structure

### Documentação (feature dir)
```
docs/specs/hub-motoristas/
├── spec.md            (existente; clarify integrado — Clarifications + FR-002/003/004/007)
├── plan.md            (este)
├── research.md        (Phase 0 — 12 decisions)
├── data-model.md       (Entregador alterada + ContaMotorista + EmpresaGrupoMovee)
├── contracts/
│   └── motoristas-api.md
└── quickstart.md       (12 cenários)
```

### Código (árvore real do projeto)
```
infra/hub/migrations/
├── 0019_entregador_edicao_manual.sql   (novo — coluna + trigger, Decision 6)
├── 0020_fatos_indices_subpraca.sql     (novo — índices em fatos, Decision 5)
├── 0021_conta_motorista.sql            (novo — tabela + extensões + FK/índice único, Decisions 2-4)
├── 0022_empresa_grupo_movee.sql        (novo — allowlist, Decision 2)
└── 0023_motoristas_rpc_candidatos.sql  (novo — funções RPC de sugestão/busca, Decisions 10-11)

infra/hub/scripts/
└── gen-seeds.py                        (existente — estender: seeds de ContaMotorista/EmpresaGrupoMovee)

app_homologacao/backend/
├── routes/hub-motoristas.js            (novo — endpoints do contracts/motoristas-api.md)
├── lib/
│   ├── hub-motoristas-dto.js           (novo — mapper snake_case↔camelCase + máscara de CNPJ)
│   ├── hub-motoristas-similaridade.js  (novo — chama os RPCs `hub_motoristas_candidatos`/`hub_motoristas_busca`, Decision 10; unit-first no mapeamento de resposta)
│   ├── hub-postgrest.js                (existente — reusar)
│   └── hub-auditoria.js                (existente — reusar, sem alteração)
├── middleware/hub-require-permission.js (existente — reusar, sem alteração)
├── lib/hub-import-processor.js         (existente — **NENHUMA alteração**; o trigger de banco protege `nome` sem tocar este arquivo, research.md Decision 6)
└── tests/
    ├── hub-motoristas-dto.test.js      (novo — unit, mapper + máscara)
    ├── hub-motoristas-similaridade.test.js (novo — unit, normalização/corte/limiar)
    └── hub-motoristas.test.js          (novo — integração, PostgREST hub)

app_homologacao/frontend_v2/
├── app/hub/dashboard/motoristas/
│   ├── page.tsx                        (novo — lista + filtros, padrão de .../importacoes/page.tsx)
│   └── [id]/page.tsx                   (novo — detalhe/edição + painel de vínculo)
├── components/hub/
│   └── vinculo-motorista-dialog.tsx    (novo — via /ui-ux-pro-max: sugestões + busca manual + confirmação)
└── lib/hub/
    ├── motoristas-api.ts               (novo — chamadas ao backend)
    └── motoristas-dto.ts               (novo — tipos + mapper camelCase)
```

## Convenções de Borda

| Camada | Case style | Validação | Fonte da verdade |
|--------|------------|-----------|------------------|
| DB columns (PostgreSQL) | snake_case | CHECK/constraint na migration | `infra/hub/migrations/00{19..23}_*.sql` |
| PostgREST payload | snake_case | — (espelha DB) | tabelas do hub |
| Backend DTO / API payload (request/response) | **camelCase** | shaping no route + `hub-motoristas-dto.js` | `app_homologacao/backend/routes/hub-motoristas.js` |
| Frontend DTO (TS) | camelCase | parse no fetch | `app_homologacao/frontend_v2/lib/hub/motoristas-dto.ts` |
| URL query/path params | camelCase (`pageSize`, `comVinculo`) / `:id` | router Express | `contracts/motoristas-api.md` |

**Mapper layer (DB ↔ DTO)**: `routes/hub-motoristas.js` + `lib/hub-motoristas-dto.js`
traduzem snake_case do PostgREST → camelCase da API (mesmo padrão de
`hub-me.js`/`lib/hub/me-dto.ts` e de `hub-importacoes.js`/`importacoes-dto.ts`),
incluindo o mascaramento de `cnpj_prestador` → `cnpjPrestadorMascarado` (nunca
o dado bruto sai do backend). ORM auto-mapping: **NÃO** (PostgREST REST puro).
**Validação**: shape do request validado no backend; response validada no
roundtrip E2E (quickstart Cenário 11) — evita drift snake↔camel histórico
(mesma lição de dec-172/dec-173 citada na skill `/plan`).

## Plano por fases (ordem do briefing)

1. **Migrations** (`0019`–`0023`) — coluna+trigger de proteção de nome,
   índices de subpraça nos fatos, tabela `ContaMotorista` (+ extensões
   `pg_trgm`/`unaccent` + índice trigram) com FK/índice único de
   `Entregador.motorista_id`, tabela `EmpresaGrupoMovee`. Aplicar via
   `migrate.sh` no hub-homolog; verificar reload PostgREST (SIGUSR1).
   Idempotência: re-rodar = no-op.
2. **Seeds sintéticos** — estender `infra/hub/scripts/gen-seeds.py` para gerar
   `ContaMotorista` (nomes variando acento/caixa/espaçamento contra
   `Entregador` existentes, para exercitar similaridade) e
   `EmpresaGrupoMovee` (incluir o `id_empresa` de teste elegível, deixar outro
   de fora para o ramo não-elegível).
3. **Lista/detalhe (leitura)** — `GET /motoristas`, `GET /motoristas/:id`:
   filtros server-side (nome/ativo/área/vínculo), paginação, resumo de
   indicadores all-time, áreas distintas ordenadas por recência.
4. **Edição (update/ativo)** — `PATCH /motoristas/:id`; grava
   `nomeEditadoManualmente=true` quando `nome` muda; auditoria
   `motorista.editado`.
5. **Sugestão + busca manual** — migration `0023` (funções RPC
   `hub_motoristas_candidatos`/`hub_motoristas_busca`, `pg_trgm`/`unaccent`,
   corte top 10 + limiar 0.3, elegibilidade de grupo resolvida dentro da
   função — Decisions 10/11); `hub-motoristas-similaridade.js` só chama os RPCs
   e mapeia a resposta; `GET /motoristas/:id/sugestoes`; `GET
   /motoristas/contas-elegiveis`.
6. **Vínculo/desvínculo** — `POST`/`DELETE /motoristas/:id/vinculo` com
   allowlist de campos (`{contaMotoristaId}` — Decision 12); FK inválida →
   `404`, violação de índice único (já vinculada a outro Entregador) → `409
   CONFLITO` amigável; auditoria `motorista.vinculado`/`motorista.desvinculado`.
7. **Telas** — `/hub/dashboard/motoristas` + `/hub/dashboard/motoristas/:id`
   via `/ui-ux-pro-max` (reusar padrões shadcn/hook server-side da S4);
   diálogo de vínculo com sugestões + busca manual + confirmação explícita.
8. **E2E + evidências** — quickstart 12 cenários no hub-homolog com seeds
   sintéticos; roundtrip real (Cenário 11); branding claro/escuro (Cenário
   12); coletar evidências.

## Complexity Tracking

Sem violações de constitution que exijam justificativa. Complexidade
deliberadamente contida: nenhuma fila/serviço novo; similaridade resolvida por
extensão nativa do Postgres (`pg_trgm`) em vez de biblioteca/serviço externo de
fuzzy-matching; nenhuma sincronização em tempo real com `chatmasterveloz`
(deliberadamente fora de escopo — ver research.md Decision 2, "fora do escopo
desta fase"); nenhuma view materializada (volume de milhares por entidade não
atinge o gatilho de §12.6).

## Re-check de Constitution (pós-Phase 1)

Design não introduziu complexidade não justificada. A introdução de
`ContaMotorista`/`EmpresaGrupoMovee` (2 tabelas novas) é o mínimo necessário
para tornar FR-006–FR-013 testáveis dentro do isolamento do hub — a alternativa
de conectar o hub isolado a produção foi explicitamente rejeitada por violar o
Princípio V. O FK físico novo em `Entregador.motorista_id` **reforça** FR-012
(banco impõe unicidade), não enfraquece nenhum princípio. `nome_editado_
manualmente` + trigger é aditivo e não exige alterar o pipeline S4 já em
produção (hub-homolog). MUST I–V continuam PASS.

**Remediação do gate `owasp-security`** (rodado sobre este plano antes da
fase `create-tasks`): 3 gaps de especificação identificados e corrigidos
diretamente nos artefatos desta revisão, sem que nenhuma linha de código
insegura chegasse a existir — (a) consulta de similaridade especificada agora
como função RPC parametrizada, nunca SQL concatenado (Decision 10, A05
Injection); (b) BOLA em `/sugestoes`/`/contas-elegiveis` tornado explícito
como já coberto pela RLS de `Entregador` (Decision 11, A01); (c) allowlist
explícita de campos em `PATCH`/`POST vinculo` contra mass assignment (Decision
12, API3 BOPLA). Nenhum finding residual crítico/alto — Princípios I/II
continuam PASS sem exceção registrada.

## Próximos passos

1. `/checklist` — quality gate antes de implementar.
2. `/create-tasks` — decompor este plano em backlog executável (ordem das 8 fases).
3. `/analyze` — validar consistência spec↔plan↔tasks após tasks.

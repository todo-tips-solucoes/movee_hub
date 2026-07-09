# Plano de Implementação — hub-auditoria-admin (S9 Auditoria e Administração da Plataforma)

**Feature**: `hub-auditoria-admin` · **Branch sugerida**: `feature/hub-auditoria-admin`
**Input**: `docs/specs/hub-auditoria-admin/spec.md` (clarificada — dec-008 catálogo
fixo de papéis; dec-009 módulos exclusivos do admin_plataforma) · briefing S9
`docs/plans/hub-frota/briefings/s9-auditoria-administracao.md` · constitution v1.1.0.

## Summary

Transformar a trilha de auditoria acumulada nas fases S2–S8 em superfície
consultável (tela + `GET /api/v1/auditoria` com filtros/paginação, escopo por
papel: admin_entidade vê a própria entidade, admin_plataforma vê tudo) e
entregar a administração da plataforma por telas: gestão de usuários/vínculos/
papéis, matriz papel×permissão (read-only p/ admin_entidade; ajuste só
plataforma) e habilitação de módulos por entidade com efeito imediato.

Abordagem técnica (research.md, 12 decisões): NENHUMA tabela nova — o schema
S2 (`Auditoria`, `Papel/Permissao/PapelPermissao`, `Modulo/ModuloEntidade`,
`Usuario/UsuarioEntidade`) já suporta tudo. As migrations 0035–0038 adicionam
apenas: claim/helper `hub_jwt_admin_plataforma()` + política SELECT global da
Auditoria (0035), políticas de escrita em `ModuloEntidade` (0036), RPC
DEFINER `hub_papel_permissao_set` para a matriz (0037) e seeds de habilitação
QA (0038). No backend Express: 3 routers novos (`hub-usuarios.js`,
`hub-papeis.js`, `hub-admin.js`), 1 middleware novo (`requireModuloAtivo`),
evolução aditiva do `GET /auditoria` existente, wiring do
`invalidarUsuario()` (existente e órfão desde a S2) e varredura de cobertura
`registrarAuditoria` nos writes S3–S8. No frontend: 3 páginas novas sob
`/hub/dashboard/{auditoria,usuarios,admin}` (+ sub-rota `usuarios/papeis`),
no molde client-component + `lib/hub/<mod>-api.ts` — o nav não muda (é
data-driven do `GET /me`).

## Technical Context

| Campo | Valor |
|-------|-------|
| Language/Version | Backend: Node 14 (Express, CommonJS, `app_homologacao/backend/`); Frontend: Node 20-alpine, Next.js App Router + TS (`app_homologacao/frontend_v2/`) |
| Primary Dependencies | PostgREST (dados), `jsonwebtoken` (HS256 pinado), bcrypt, shadcn/ui + lucide-react, jq/psql nos scripts |
| Storage | PostgreSQL `hub_homolog_db` (container hub) via PostgREST; migrations `infra/hub/migrations/0035+` aplicadas por `scripts/migrate.sh` (tracking `SchemaMigration`, SIGUSR1 reload) |
| Testing | Unit frontend (`*.test.tsx` padrão do repo); integração bash efêmera `infra/hub/testes/*.sh` (projeto `hub-test-<runid>`, `PASS:`/`FAIL:`); E2E homolog `hub-e2e-homolog.sh` |
| Target Platform | Docker compose hub (`hub-homolog`), Traefik :8443; exceção standing hub-* (G1) |
| Performance Goals | SC-001 evento localizável <30s (filtros + índices existentes); SC-004 papel→permissões <2s (invalidação síncrona); lista auditoria p95 <500ms no volume homolog |
| Constraints | DDL idempotente/aditiva SÓ no hub_homolog_db; diff mínimo em `server.js` legado (issue #62 fora de escopo); sem retenção/expurgo (FR-014) e sem export (FR-015); trilha imutável por construção |
| Scale/Scope | 4 superfícies de API (1 evoluída + 3 novas), 4 migrations, 3 páginas + 1 sub-rota, varredura de ~6 routers hub p/ cobertura de auditoria |

## Constitution Check

*GATE inicial: PASS. Re-check pós-Phase 1 na seção final.*

| Princípio | Status | Notas |
|-----------|--------|-------|
| I. Segurança de Autenticação & Segredos | PASS | Cookies httpOnly existentes; senha inicial de usuário com bcrypt (Decision 7); senha NUNCA em `detalhes` de auditoria (scrub por construção); nenhum segredo novo |
| II. Isolamento Multi-Tenant | PASS | Entidade SEMPRE de `payload.entidade_ativa`; dupla checagem (`requirePermission` + `obterPermissoesEfetivasPorEntidade`); RLS backstop em todas as superfícies; visão global só via claim verificado contra vínculo `admin_plataforma` real |
| III. Contratos de API & Proxy de Cookies | PASS | Tudo sob `/api/v1` proxied; `credentials: 'include'` no molde `lib/hub/<mod>-api.ts`; CORS inalterado |
| IV. Qualidade e Revisão | PASS | Branch `feature/hub-auditoria-admin`; Conventional Commits; PR com checklist de cobertura de auditoria |
| V. Deploy Conteinerizado & Convivência | PASS | Migrations 0035–0038 aditivas/idempotentes; zero restart de serviços de produção; tudo confinado a recursos hub-* |

## Project Structure

### Documentação (feature dir)

```
docs/specs/hub-auditoria-admin/
├── spec.md              # clarificada (dec-008/dec-009)
├── plan.md              # este arquivo
├── research.md          # 12 decisões (Phase 0)
├── data-model.md        # entidades existentes + objetos novos 0035–0038
├── quickstart.md        # 9 cenários (incl. roundtrip obrigatório)
└── contracts/
    ├── auditoria-api.md
    ├── usuarios-api.md
    ├── papeis-api.md
    └── admin-modulos-api.md
```

### Código (árvore real do projeto)

```
infra/hub/migrations/
├── 0035_auditoria_visao_global.sql        # NOVO — helper claim + SELECT policy
├── 0036_moduloentidade_escrita_admin.sql  # NOVO — write policies + branch admin
├── 0037_rpc_papel_permissao_set.sql       # NOVO — RPC DEFINER matriz
└── 0038_seed_modulos_admin_qa.sql         # NOVO — seeds habilitação (Decision 12)

app_homologacao/backend/
├── server.js                              # EDIT mínimo: mounts /api/v1/{usuarios,papeis,admin}
├── middleware/
│   ├── hub-require-permission.js          # existente (inalterado)
│   └── hub-require-modulo.js              # NOVO — requireModuloAtivo(codigo)
├── lib/
│   ├── hub-rbac-cache.js                  # EDIT aditivo: obterModulosAtivosPorEntidade + invalidarEntidadeModulos
│   ├── hub-auditoria.js                   # existente (registrarAuditoria/scrubDetalhes — inalterado)
│   ├── hub-postgrest-jwt.js               # EDIT aditivo: claim admin_plataforma
│   └── hub-postgrest.js                   # existente (inalterado)
└── routes/
    ├── hub-me.js                          # EDIT: GET /auditoria — filtros/paginação/visão global
    ├── hub-usuarios.js                    # NOVO
    ├── hub-papeis.js                      # NOVO
    ├── hub-admin.js                       # NOVO
    └── hub-{importacoes,motoristas,faturamento,performance}.js  # EDIT: varredura registrarAuditoria + requireModuloAtivo (1 linha/router)

app_homologacao/frontend_v2/
├── app/hub/dashboard/
│   ├── auditoria/page.tsx                 # NOVO — lista + filtros + drawer detalhe
│   ├── usuarios/page.tsx                  # NOVO — CRUD usuários/vínculos
│   ├── usuarios/papeis/page.tsx           # NOVO — matriz papel×permissão
│   └── admin/page.tsx                     # NOVO — módulos por entidade
├── lib/hub/
│   ├── auditoria-api.ts / auditoria-dto.ts   # NOVO (molde faturamento-api)
│   ├── usuarios-api.ts / usuarios-dto.ts     # NOVO
│   └── admin-api.ts / admin-dto.ts           # NOVO (papéis + módulos)
└── components/hub/module-nav.tsx          # inalterado (nav é data-driven)

infra/hub/testes/
├── hub-auditoria-admin-integration.sh     # NOVO — cenários 1–7 do quickstart
└── hub-e2e-homolog.sh                     # EDIT: roundtrip cenário 8/9
```

## Convenções de Borda

| Camada | Case style | Validação | Fonte da verdade |
|--------|------------|-----------|------------------|
| DB (PostgreSQL) | snake_case (`id_empresa`, `criado_em`, `papel_id`) | DDL + RLS + trigger imutabilidade | `infra/hub/migrations/*.sql` |
| PostgREST payload interno | snake_case | RLS/GRANT + claims do JWT interno | `lib/hub-postgrest.js` (claims via `generateHubPostgrestJWT`) |
| API `/api/v1/*` (request/response) | camelCase (`entidadeId`, `criadoEm`, `papelId`) | mapper explícito no handler + roundtrip cenário 8 | `contracts/*.md` desta feature |
| Erros | `{ "erro": "UPPER_SNAKE_CASE" }` — vocabulário fechado por contrato | testes de integração | `contracts/*.md` |
| Frontend DTO (TS) | camelCase | parse no fetch + `*.test.ts` | `lib/hub/<mod>-dto.ts` |
| URL/rotas de tela | código do módulo (`/hub/dashboard/<codigo>`) | `moduloParaRota()` — nada hardcoded | `lib/hub/module-nav.ts` |
| Query params | camelCase (`usuarioId`, `pageSize`, `entidadeId`) | validação no handler (400 fechado) | `contracts/*.md` |

**Mapper layer (DB ↔ API)**: no handler de cada rota backend (padrão
existente de `hub-me.js`/`hub-faturamento.js`) — snake_case do PostgREST →
camelCase da borda, campo a campo. SEM ORM/auto-mapping. O roundtrip
(quickstart cenário 8) é o teste que trava esta convenção — qualquer chave
snake_case vazando na borda é FAIL.

**Validação**: request validado no backend (borda de segurança); response
parseado no frontend pelos DTOs. JWT `HS256` pinado (`algorithms:['HS256']`)
em toda verificação. Claim `admin_plataforma` NUNCA derivado de input do
cliente — só de consulta a `UsuarioEntidade`+`Papel` no request — e emitido
com menor privilégio: apenas nos handlers que exigem visão/escrita global
(auditoria global, `/admin/*`, RPC da matriz), nunca por padrão em todo
request (gate owasp). Guards anti-lockout nos contratos de papéis e módulos
(findings M2/M3); filtros de auditoria com vocabulário fechado +
`encodeURIComponent` (finding M1).

## Plano por fases (ordem do briefing)

1. **FASE DB (0035–0038)**: migrations + testes de política via psql
   (imutabilidade, visão global, escrita ModuloEntidade, RPC matriz).
2. **FASE cobertura de auditoria (FR-006)**: inventário grep
   `router.(post|put|patch|delete)` nos `routes/hub-*.js` +
   `lib/hub-import-processor.js`; adicionar `registrarAuditoria` faltantes;
   checklist endpoint-a-endpoint no PR.
3. **FASE endpoint auditoria**: evoluir `GET /auditoria` (filtros, paginação
   `page`/`pageSize`+`total`, visão global via claim, `PERIODO_INVALIDO`).
4. **FASE admin backend**: `hub-usuarios.js`, `hub-papeis.js`,
   `hub-admin.js`, `hub-require-modulo.js`, cache de módulos + invalidações
   síncronas (`invalidarUsuario` wiring — fecha o gap S2).
5. **FASE telas** (ordem: auditoria → usuários → papéis → módulos), molde
   client-component shadcn (cards mobile + Table desktop), design via
   `/ui-ux-pro-max`.
6. **FASE E2E + evidências**: `hub-auditoria-admin-integration.sh`
   (cenários 1–7), roundtrip (cenário 8), cobertura (cenário 9), a11y smoke.

## Complexity Tracking

| Violação | Por Que Necessário | Alternativa Simples Rejeitada Porque |
|----------|--------------------|--------------------------------------|
| — | — | — |

Nenhuma violação de constitution identificada — tabela vazia por design.
Notas de contenção deliberada: sem MV (Decision 8 — sem agregação na S9);
sem tabela nova; RPC DEFINER usada só onde RLS não expressa (matriz,
Decision 5); `GET /auditoria/:id` não criado (Decision 9).

## Re-check de Constitution (pós-Phase 1)

Design final re-validado contra v1.1.0: nenhum princípio MUST tocado
negativamente. O design REFORÇA II (isolamento): fecha a visibilidade de
eventos globais a não-plataforma (0035), adiciona backstop RLS de escrita em
`ModuloEntidade` (0036) e mantém catálogo de papéis imutável por ausência de
política (dec-008). Nenhuma complexidade nova não justificada (0 serviços
novos, 0 tabelas novas). **PASS.**

## Próximos passos

1. `/checklist` — quality gate de requisitos antes de implementar.
2. `/create-tasks` — decompor este plano em backlog executável (fases 1–6).
3. `/analyze` — validar consistência spec ↔ plan ↔ tasks.

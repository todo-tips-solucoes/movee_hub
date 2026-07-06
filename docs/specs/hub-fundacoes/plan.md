# Implementation Plan: Fundações — Contas, Papéis e Trilha de Auditoria do Hub

**Feature**: `hub-fundacoes` | **Date**: 2026-07-06 | **Spec**: [spec.md](./spec.md)

## Summary

Construir, sobre o ambiente isolado já ratificado (`hub-homolog`, G2 — S1), a base de
contas de usuário (`Usuario`), vínculo a entidades com papel (`UsuarioEntidade`), RBAC por
permissão nomeada (`Papel`/`Permissao`/`PapelPermissao`/`Modulo`/`ModuloEntidade`), trilha
de auditoria imutável (`Auditoria`) e uma camada de isolamento por entidade via RLS —
reforçando (não substituindo) a verificação de permissão feita no backend. A abordagem
técnica reaproveita o MESMO codebase Express já existente
(`app_homologacao/backend/`), buildado por um Dockerfile alternativo (`Dockerfile.hub`,
Node 20 LTS) e apontado, só nos ambientes `hub-*`, para o banco isolado do hub — o backend
de produção (`Dockerfile`, Node 14, stack `envio-massa-homologacao_*`) permanece
byte-a-byte intocado. A migração de contas (`Empresa.pass → Usuario`) é expand-only e
idempotente (§11.5 do plano técnico); o login legado continua funcionando sem qualquer
alteração perceptível durante toda a convivência (S2–S10).

## Technical Context

**Language/Version**: Node.js 20 LTS para o backend do hub (`Dockerfile.hub`, novo) — o
`Dockerfile` de produção (Node 14) não muda. Mesmo código-fonte CommonJS/Express usado
pelos dois Dockerfiles.
**Primary Dependencies**: Express 4 (já em uso), `bcrypt` (hash de senha — já em uso),
`jsonwebtoken` (JWT de sessão + JWT do PostgREST — já em uso), `cookie-parser` (já em
uso), `express-rate-limit` (já em uso, `server.js:83`), módulo nativo `node:crypto`
(`randomBytes`/`randomUUID` para tokens de refresh e recuperação — sem nova dependência).
Camada de dados via **PostgREST v14.1** (`infra/hub/compose.hub.*.yml`) sobre
**PostgreSQL 13** (mesma versão do S1).
**Storage**: PostgreSQL 13, bancos `hub_dev`/`hub_test`/`hub_homolog` (efêmeros em
dev/test via `tmpfs`; `hub_homolog` persistente com backup diário — já provido pela S1).
Acesso do backend ao banco é **sempre via PostgREST** (nunca `pg` direto), mesmo padrão
usado hoje para `Empresa`/`Motorista`/`EnvioMassa`.
**Testing**: `node --test` (test runner nativo do Node, já usado em
`app_homologacao/backend/tests/*.test.js` — sem framework novo). Testes de integração
contra banco real rodam sobre `compose.hub.test.yml` (projeto efêmero
`-p hub-test-<runid>`, já provido pela S1).
**Target Platform**: Docker Compose isolado (`infra/hub/compose.hub.{dev,test,homolog}.yml`)
sobre o mesmo host VPSTodo, roteado pelo Traefik próprio do hub
(`infra/hub/traefik/dynamic/hub.yml`) — nunca pelo Traefik/Swarm de produção.
**Project Type**: web-service (API REST). Esta fundação **não inclui nenhuma tela** —
apenas capacidades de backend/dados consumidas por módulos futuros (S3+).
**Performance Goals**: sem SLA numérico explícito na spec; cache de permissões in-memory
com TTL de 60 s evita recalcular RBAC a cada requisição, respeitando o teto de SC-004
(mudança de papel reflete em ≤60 s).
**Constraints**: (a) zero alteração perceptível no fluxo de login legado durante toda a
convivência (FR-003, critério de aceite #6 — diff limpo em endpoints legados); (b)
revogação de sessão/permissão refletida em ≤60 s mesmo sem novo login (FR-013, FR-018,
SC-004); (c) bloqueio de conta após 5 falhas consecutivas / 15 min (FR-017, SC-006); (d)
execução restrita a recursos `hub-*`/`hub_` — produção (`chatmasterveloz`, stack
`envio-massa-homologacao_*`) é zona proibida (exceção standing G1).
**Scale/Scope**: migração inicial de dezenas/centenas de contas `Empresa` ativas; tráfego
baixo nesta fase (fundação interna, sem usuários finais navegando ainda — só APIs).

## Constitution Check

*GATE: Deve passar antes do Phase 0. Re-checar após Phase 1.*

| Princípio | Status | Notas |
|-----------|--------|-------|
| I. Segurança de Autenticação & Segredos | PASS | Cookies `httpOnly` reaproveitados (access 15 min / refresh 7 dias, `sameSite=Strict`); segredos (`JWT_SECRET`, `JWT_REFRESH_SECRET`, `PGRST_JWT_SECRET`, `POSTGREST_API_KEY`) já provisionados em `/var/lib/hub_secrets` (fora do git); senhas em `bcrypt` (hash copiado da migração, ninguém troca senha). |
| II. Isolamento Multi-Tenant por Empresa | PASS (expandido) | Escopo resolvido server-side a partir do token nunca do corpo da requisição (mesmo invariante); RLS (FR-026–028) é reforço **adicional**, não substitui a checagem em `requirePermission`. Camada nova é nega-por-padrão quando claim de entidade ausente/inverificável. |
| III. Contratos de API & Proxy de Cookies | N/A nesta fundação | Sem frontend/proxy Next.js nesta sessão (S2 é backend/dados puro) — o princípio passa a valer a partir da S3 (shell do hub), quando existir um cliente HTTP consumindo `/api/v1/*`. |
| IV. Qualidade e Revisão de Mudanças | PASS | Branch dedicada, Conventional Commits, revisão de segurança OWASP obrigatória aplicada nesta fase (auth + RBAC + RLS é superfície crítica) via Quality Gate `owasp-security`. |
| V. Deploy Conteinerizado e Convivência de Serviços | PASS | Todo serviço novo é container Docker roteado pelo Traefik **próprio do hub**; nenhuma mudança em containers de produção; exceção standing G1 (recursos `hub-*`/`hub_`) já ratificada cobre esta sessão. |

## Project Structure

### Documentation (this feature)

```
docs/specs/hub-fundacoes/
├── spec.md
├── plan.md          # This file
├── research.md       # Phase 0 output
├── data-model.md      # Phase 1 output
├── quickstart.md      # Phase 1 output
└── contracts/         # Phase 1 output
    ├── auth.md
    ├── rbac-me.md
    └── auditoria.md
```

### Source Code (repository root)

```
app_homologacao/backend/
├── Dockerfile                      # produção (Node 14) — NÃO MUDA
├── Dockerfile.hub                  # NOVO — Node 20 LTS, mesma árvore de código
├── server.js                       # aditivo: 2-4 linhas novas de app.use() para
│                                    # montar os routers novos; ZERO diff nos
│                                    # handlers/rotas legados existentes
├── routes/
│   ├── grupo.js                    # existente — reusado (mesmoGrupoQue/resolveScope
│                                    # NÃO se aplicam ao hub; hub usa UsuarioEntidade)
│   ├── hub-auth.js                 # NOVO — /api/v1/auth/*
│   └── hub-me.js                   # NOVO — /api/v1/me, /api/v1/me/entidade
├── middleware/
│   └── hub-require-permission.js   # NOVO — requirePermission('modulo.acao')
├── lib/
│   ├── hub-rbac-cache.js           # NOVO — cache in-memory TTL 60s + invalidação
│   ├── hub-postgrest-jwt.js        # NOVO — JWT do PostgREST por request (claims
│                                    # empresa_ativa + escopo), evolução isolada de
│                                    # generatePostgrestJWT (server.js:99-106) —
│                                    # NÃO edita a função legada, usada só pelo hub
│   └── hub-auditoria.js            # NOVO — helper de escrita em Auditoria (scrub)
├── db/                              # série de migrations de PRODUÇÃO — INTOCÁVEL
│                                    # (migrations do hub NÃO entram aqui — ver
│                                    # research.md Decision 1)
└── tests/
    ├── hub-auth-unit.test.js               # NOVO
    ├── hub-rbac-unit.test.js               # NOVO
    ├── hub-rls-integration.test.js         # NOVO (contra hub-test)
    └── hub-auditoria-integration.test.js   # NOVO (contra hub-test)

infra/hub/
├── migrations/
│   ├── 0000_schema_migration.sql            # existente (S1)
│   ├── 0001_postgrest_roles.sql             # existente (S1) — hub_web_anon
│   ├── 0002_usuario.sql                     # NOVO
│   ├── 0003_papel_permissao_modulo.sql      # NOVO
│   ├── 0004_auditoria.sql                   # NOVO — inclui REVOKE + trigger
│   ├── 0005_sessao_refresh.sql              # NOVO
│   ├── 0006_rls_policies.sql                # NOVO — policies + role authenticated
│   ├── 0007_seed_papeis_permissoes_modulos.sql  # NOVO
│   └── 0008_migracao_empresa_para_usuario.sql   # NOVO — expand-only, idempotente
├── compose.hub.dev.yml                      # EDITADO — novo serviço `backend`
├── compose.hub.test.yml                     # EDITADO — novo serviço `backend`
├── compose.hub.homolog.yml                  # EDITADO — novo serviço `backend`
└── mocks/mailpit-like/                      # NOVO (ou reuso do placeholder) —
                                              # mock de envio de e-mail p/ recuperação
```

**Structure Decision**: reaproveitar o MESMO codebase Express
(`app_homologacao/backend/`) em vez de criar um segundo backend/repositório —
elimina duplicação de lógica de auth (rate-limit, dummy-hash, bcrypt) já madura no
código legado. O ambiente hub apenas builda essa árvore com um Dockerfile alternativo
(Node 20) e a aponta, via variáveis de ambiente do `compose.hub.*`, para o banco isolado
do hub. Os endpoints legados (`/login`, `/upload`, `/envio-massa`, `/validate-xml-batch`)
não recebem nenhuma linha de diff — os novos ficam inteiramente em arquivos novos
(`routes/hub-*.js`, `middleware/hub-*.js`, `lib/hub-*.js`), registrados em `server.js` por
`app.use()` estritamente aditivo (ver research.md Decision 5 para o mecanismo exato que
preserva "diff limpo" no critério de aceite #6).

## Convenções de Borda

| Camada | Case style | Validação | Fonte da verdade |
|--------|------------|-----------|-------------------|
| DB tables (PostgreSQL) | PascalCase singular | migration | `infra/hub/migrations/000X_*.sql` (mesmo padrão de `Empresa`/`Motorista`/`Grupo`/`Branding` no legado) |
| DB columns (PostgreSQL) | snake_case | constraint/CHECK na migration | `infra/hub/migrations/000X_*.sql` |
| PostgREST response | snake_case (passthrough, sem view de rename) | — | reflete a coluna 1:1, mesmo padrão já usado hoje (`cnpj_prestador`, `nota_ok`, `id_grupo` trafegam snake_case do DB até o JSON de resposta sem mapper) |
| Backend Express JSON (request/response) | snake_case | validação manual em cada rota (sem Zod nesta codebase) | `routes/hub-*.js` — **decisão deliberada**: não introduzir camelCase nesta fundação para não repetir o drift snake_case↔camelCase já documentado como lição (dec-172/173 de outra execução); quando a S3 introduzir frontend/proxy, declarar ali se um mapper é necessário |
| URL query/path params | kebab-case / snake_case (`/me/entidade`) | router | `routes/hub-*.js` |

**Mapper layer (DB ↔ DTO)**: NENHUM — PostgREST expõe as colunas como estão e o
Express repassa/consome sem transformação, replicando o padrão já usado no restante da
API legada. **Validação**: manual, por rota (sem lib de schema nesta codebase — mesmo
padrão do legado, que não usa Zod/Joi).

## Complexity Tracking

*Nenhuma violação de princípio MUST identificada — tabela vazia.*

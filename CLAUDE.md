# CLAUDE.md

Instruções para o Claude Code (e qualquer agente) que opera neste repositório.

## ⚠️ Rito de produção — REGRA CRÍTICA

**O ambiente chamado de "homologação" É produção: é o que os clientes usam.** Não existe um
ambiente de produção separado. Todo deploy nesse ambiente atinge clientes reais
imediatamente. O nome "homologação" nos recursos é histórico — trate-o como produção.

Ambiente do cliente:

| | Identificação |
|---|---|
| Host | `VPSTodo` |
| Serviços (Docker Swarm) | `envio-massa-homologacao_backend_homologacao` · `envio-massa-homologacao_frontend_v2_homologacao` |
| Banco | `chatmasterveloz` no container `pgadmin_db` |
| Domínios | `https://app.moveelog.com.br` (painel) · `https://app.motorista.moveelog.com.br` (app motorista) |
| Registry | `registry.todo-tips.com/envio-massa-backend` · `.../envio-massa-frontend-v2` |

### O que exige rito de produção (escrita no ambiente vivo)

- `docker service update` (deploy de imagem)
- DDL ou qualquer escrita no banco do cliente (`pgadmin_db`)
- alteração de configuração/segredos/labels dos serviços
- qualquer comando que mude estado do host de produção

### O que NÃO exige (fluxo normal)

- escrever/alterar código; abrir, revisar e mergear PR
- buildar e dar `push` de imagem (a imagem só vira produção no `service update`)
- testes/lint locais, gerar artefatos e documentação

### Os 5 gates (nesta ordem, antes de qualquer escrita no ambiente vivo)

1. **Autorização explícita** para *aquela* mudança específica — não vale autorização
   genérica, antiga ou implícita.
2. **Janela combinada** com o operador.
3. **Plano de rollback à mão** antes de aplicar (imagem anterior anotada via `docker service ls`;
   rollback = `docker service update --with-registry-auth --image <anterior> <serviço>`; DDL
   sempre idempotente/aditiva, com `pg_dump -t` antes de seed/alteração de dados).
4. **Aplicar com `docker service update --image`** — **nunca** `docker stack deploy`.
5. **Smoke test** (HTTP, sem expor segredos) antes de declarar OK.

**Em qualquer dúvida: parar e devolver ao operador.** Nunca procurar rota alternativa (SSH,
credenciais, rede) para contornar um gate. O agente **nunca** decide sozinho aplicar em
produção — entrega artefatos (código, PRs, DDLs, runbooks) e só executa escrita no ambiente
vivo com os 5 gates satisfeitos.

Detalhe completo em [`docs/RITO-PRODUCAO.md`](docs/RITO-PRODUCAO.md).

### Exceção escopada — recursos `hub-*` (gate G1 do hub-frota, 2026-07-05)

O operador concedeu uma **exceção standing e auditada** ao rito, válida durante as fases
S1–S10 do hub de frota (registro completo em
[`docs/plans/hub-frota/DIARIO.md`](docs/plans/hub-frota/DIARIO.md)): o agente **pode**
criar e gerir neste host **somente** recursos prefixados `hub-`/`hub_` — projetos compose
`hub-dev`/`hub-test-*`/`hub-homolog`, redes/volumes/containers `hub_*`, o banco novo do
hub e push/pull de tags `hub-*` no registry. **Dentro desse escopo, esta exceção
prevalece sobre a regra geral acima.** Fora dele — Swarm, stacks existentes,
`chatmasterveloz`, `.env`, Traefik, tags de produção — o rito integral continua valendo,
e na dúvida se um recurso é do hub: parar e devolver ao operador.

## Mapa do repositório e arquitetura

```
app_homologacao/          # produto em produção (Swarm)
├── backend/              # API Express (server.js + routes/ + lib/), porta 3000
├── frontend_v2/          # Next.js App Router — serve painel legado E hub
├── frontend_motorista/   # PWA do app motorista (Next.js, porta 3001)
└── frontend/             # v1 estático legado (Nginx) — não evolui
infra/hub/                # infra-as-code do ambiente isolado do hub (compose, migrations, scripts, testes)
docs/                     # constitution.md, RITO-PRODUCAO.md, plans/ (planos versionados), specs/, sql/ (DDL do legado)
```

- **Persistência sem ORM**: o backend fala HTTP com **PostgREST** — o legado no banco
  `chatmasterveloz`; o hub em banco próprio (`hub_homolog`) com RLS e JWT assinado por
  requisição (`lib/hub-postgrest.js` / `lib/hub-postgrest-jwt.js`). Integrações externas:
  **n8n** (disparo de mensagens) e **FastAPI** de validação de nota fiscal.
- **Dois produtos no mesmo backend**: o envio em massa legado vive em `server.js` (~2,8k
  linhas, rotas inline) + `routes/{motorista,grupo,branding,admin-motorista}.js`; o **hub de
  frota** vive em `routes/hub-*.js`, com a lógica pura testável extraída para `lib/` (DTOs,
  parser/normalizer de importação, RBAC, auditoria, `envio-gate.js`).
- **frontend_v2 serve os dois apps**: painel legado em `app/{login,dashboard,…}` e hub em
  `app/hub/*`; `app/api/[...path]` é o proxy que repassa os cookies httpOnly ao backend —
  o browser nunca chama o backend direto. UI: Tailwind 4 + **Base UI** (`@base-ui/react`,
  **não** Radix — ex.: `Select` exige `items` no Root para exibir o rótulo) + shadcn.
- **Migrations do hub**: série única `infra/hub/migrations/NNNN_*.sql`, aplicada por
  `infra/hub/scripts/migrate.sh` (idempotente; registra em `"SchemaMigration"`). Nunca
  editar migration já aplicada — criar a próxima `NNNN`. Segredos do hub vivem **somente**
  em `/var/lib/hub_secrets/` (fora do git; templates `.env.hub.*.example`; geração via
  `scripts/gen-secrets.sh`).
- **Auth (constitution §I–III)**: JWT em cookies httpOnly (`accessToken` 15 min +
  `refreshToken`), nunca em localStorage/query/header exposto; escopo multi-tenant é
  resolvido server-side a partir do token, nunca do corpo da requisição.

## Comandos

Backend (`app_homologacao/backend/`):

```bash
npm start                            # node server.js (porta 3000)
npm test                             # todas as suítes unit (node --test; exige Node ≥18 no host)
npm run test:hub:unit                # unit do hub
npm run test:hub:integration         # integração do hub (exige ambiente hub no ar)
node --test tests/<arquivo>.test.js  # um arquivo de teste só
```

⚠️ A imagem de produção do backend legado é `node:14` — código carregado por `server.js`
(fora de `tests/`) não pode usar sintaxe/API posterior ao Node 14. O `Dockerfile.hub` usa
node 20.

Frontend_v2 (`app_homologacao/frontend_v2/`):

```bash
npm run dev | build | lint
npm test                   # vitest run (jsdom)
npx vitest run <arquivo>   # um teste só
npm run test:e2e:hub       # Playwright do hub — rodar sempre via driver (abaixo)
```

Testes de integração e E2E do hub rodam pelos drivers `infra/hub/testes/*.sh` (ex.:
`hub-shell-e2e-browser.sh` executa o Playwright dentro do container oficial
`mcr.microsoft.com/playwright` — nunca instalar browsers no host). Cada
`playwright.config.<cenário>.ts` tem seu driver correspondente.

Ambiente isolado do hub (na raiz do repo; operação completa em `infra/hub/RUNBOOK.md`):

```bash
# preflight é OBRIGATÓRIO antes do primeiro up (aborta se alcançar produção)
infra/hub/scripts/preflight.sh -f infra/hub/compose.hub.homolog.yml -p hub-homolog -e /var/lib/hub_secrets/.env.hub.homolog
docker compose -f infra/hub/compose.hub.homolog.yml -p hub-homolog --env-file /var/lib/hub_secrets/.env.hub.homolog up -d
infra/hub/scripts/migrate.sh -f infra/hub/compose.hub.homolog.yml -p hub-homolog -e /var/lib/hub_secrets/.env.hub.homolog
```

Builds pesados no host (`next build`, `docker build`) seguem o rito anti-starvation:
garantir swap ativa e limitar com `--memory=2g` (incidente de starvation 2026-06-11).
Limpeza docker sempre com filtro `hub_*` — nunca prune genérico. Gotcha turbopack:
comentário JSX `{/* */}` imediatamente após `return (` quebra o build — usar `//` na
linha acima do `return`.

## Convenções de deploy

- Deploy = `docker build` → `docker push` → `docker service update --with-registry-auth --image …`.
  **Nunca** `docker stack deploy` (preserva env/labels/segredos do serviço).
- Backend roda em `node:14`; frontend_v2 em `node:20-alpine` (Next.js standalone). O
  `.dockerignore` exclui `node_modules`, então módulos nativos (ex.: `bcrypt`) recompilam no
  build — não copiar binários do host.
- ⚠️ O `ENV BACKEND_URL` do Dockerfile do `frontend_v2` aponta para a API do ambiente; conferir
  antes de buildar para outro destino.

## Regras de domínio — App Motorista / base `Motorista`

O **app motorista** (login + validação de nota fiscal, domínio
`app.motorista.moveelog.com.br`) é **exclusivo do grupo Movee**. "Grupo Movee" = empresa
`id=6` **+ suas filiais**, resolvido por `mesmoGrupoQue(idEmpresa, 6, cache)` (em
`routes/grupo.js`) — **nunca** `id_empresa === 6` estrito (hoje a Movee não tem filiais, mas
terá; o critério de grupo deixa o sistema correto quando elas existirem). Decorrências:

- **Base `Motorista`** (pré-cadastro: `cnpj_prestador`, `nome`, `ativo`; sem coluna de empresa):
  o `/upload` (`upsertMotoristasFromLote` em `server.js`) só cura/popula essa base quando o
  upload é do **grupo Movee**. Uploads de outras empresas **não** devem inserir motoristas —
  senão a base de login/validação fica poluída com motoristas de outros tenants.
- **Roteamento da FastAPI de validação** (validação em massa no `server.js` e `validar-nota` em
  `routes/motorista.js`): grupo Movee → endpoint **não-nexus** (`fastapihomologacao`, sempre
  `id_empresa=6`); demais empresas → endpoint **nexus** (`fastapihomologacaonexus`,
  `nexus=true`). Os dois pontos devem usar `mesmoGrupoQue(_, 6)` — manter consistência entre
  eles. Um movimento na empresa errada roteia para a FastAPI errada e a validação falha com
  "Nenhum motorista ativo encontrado para o CNPJ do prestador".
- Erros do serviço de validação: distinguir **negócio** (4xx com `detail` → propagar a mensagem
  real) de **infra** (timeout/5xx/sem resposta → 502 "indisponível"). Não mascarar regra de
  negócio como indisponibilidade.

## Governança

- Commit/push/merge/deploy **somente com autorização explícita** do operador.
- Mensagens de commit terminam com o trailer `Co-Authored-By` do modelo vigente
  (ex.: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`);
  corpos de PR terminam com `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
- Princípios de projeto em [`docs/constitution.md`](docs/constitution.md).

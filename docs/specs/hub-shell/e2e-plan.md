# Plano de execução — FASE 6 (E2E, Evidências e Segurança) — `hub-shell`

> Produzido por onda de INVESTIGAÇÃO read-only (execute-task, sem build/mutação).
> Objetivo: decidir COMO rodar os cenários E2E de `tasks.md` FASE 6 sem repetir o
> incidente de starvation de 2026-06-11 (host VPSTodo hospeda a produção real do
> cliente + o ambiente isolado hub-homolog no mesmo Swarm/host). Nenhum comando
> deste documento foi executado nesta onda — é o que a PRÓXIMA onda (execução)
> deve seguir, sob autorização do operador (ver bloqueio ao final).

## 0. Estado observado (fatos, não hipótese)

- `infra/hub/compose.hub.homolog.yml` **NÃO tem serviço de frontend** — só
  `db`, `postgrest`, `fastapi-mock`, `n8n-mock`, `mailpit-mock`, `backend`,
  `placeholder`, `traefik`, `backup`. Confirmado por `find`/grep (sem
  `frontend`/`next` em `infra/hub/`).
- `infra/hub/RUNBOOK.md` já documenta a intenção arquitetural: *"A partir da
  S2, o frontend do hub assume o banner e o placeholder sai do compose"*
  (seção "Identificação visual do ambiente §13.2") — ou seja, adicionar o
  serviço de frontend E remover `placeholder` (ajustando o roteamento do
  Traefik) já é o desenho pretendido, não uma decisão nova desta onda.
- `docs/specs/hub-shell/tasks.md` 6.1.2 e `plan.md` §4 já mandam
  explicitamente: **build do Next SEMPRE sob `docker build --memory=2g` com
  swap ativo**, nunca `next build`/`dev` solto no host.
- O contrato exato do `BACKEND_URL` do frontend do hub JÁ está decidido e
  registrado (`plan.md` §3.1, task 1.2.4, decisão `dec-031`):
  `BACKEND_URL=http://backend:3000/api` (hostname interno do compose +
  sufixo `/api`, porque `app/api/[...path]/route.ts` só remove o prefixo
  literal `/api` e o backend do hub monta as rotas em `/api/v1/*`). **Não há
  nada a decidir aqui de novo** — só aplicar ao criar o serviço.
- `NEXT_PUBLIC_APP_ENV` (lido por `components/hub/env-badge.tsx`) é var
  **`NEXT_PUBLIC_*`**: o Next.js a INLINE no bundle do cliente **em tempo de
  build**, diferente de `BACKEND_URL` (lida em runtime pelo processo do
  servidor Next, via `process.env.BACKEND_URL` em `route.ts`, avaliada uma
  vez na inicialização do processo — pode vir do `environment:` do compose
  sem rebuild). Isso implica: o Dockerfile do frontend do hub precisa
  receber `NEXT_PUBLIC_APP_ENV` como **build arg**, não só como env de
  runtime — senão o banner nunca aparece (SC-004 quebraria silenciosamente).
- `app_homologacao/frontend_v2/Dockerfile` (o genérico, produção) tem
  `ENV BACKEND_URL=https://envmassapihomologacao.todo-tips.com` fixo — **não
  usar este Dockerfile para o hub** (aponta pra API de produção do cliente).
  Precisa de um `Dockerfile.hub` próprio, no mesmo padrão do
  `app_homologacao/backend/Dockerfile.hub` já existente (Node 20, mesma
  árvore de código, comentário de proveniência).
- `infra/hub/migrations/0007_seed_papeis_permissoes_modulos.sql` já semeia 4
  papéis com permissões DIFERENTES: `admin_plataforma` (tudo),
  `admin_entidade` (tudo exceto `admin.gerenciar` — **inclui**
  `auditoria.consultar`), `operador` (sem `auditoria.consultar`, sem
  `usuarios.gerenciar`), `leitura` (só consulta, sem `auditoria.consultar`).
  → **par pronto para os cenários 6.2.1/6.2.2**: `admin_entidade` (vê
  Auditoria no menu + `GET /api/v1/auditoria` = 200) vs. `operador` (não vê
  Auditoria + `GET /api/v1/auditoria` direto por URL = 403). Nenhum seed novo
  de papel/permissão é necessário — só 2 linhas de `Usuario`/`UsuarioEntidade`.
- `infra/hub/testes/hub-e2e-homolog.sh` (S2, já mergeado) já prova o padrão
  seguro e auditável para criar/limpar esses 2 usuários no hub-homolog:
  e-mails `e2e-teste-*@example.test`, `empresa_id` numa faixa reservada
  (usa 940001/940002; a Fase 6 deve reservar outra faixa livre, ex.
  `950001`/`950002`, para não colidir se os dois scripts rodarem na mesma
  janela), hash bcrypt gerado via `docker compose exec backend node -e`,
  cleanup via `trap` mesmo em falha, superuser do banco bypassa RLS só para
  a limpeza. **Reusar este padrão**, não reinventar.
- Estado do host (observado agora, sem build): `swapon --show` → 1 swapfile
  persistente de 8G, 2.3G em uso, **5.7G livres**; `free -h` → RAM total
  15Gi, usado 8.4Gi, livre 1.4Gi, **disponível 6.8Gi** (conta cache
  reclamável). O swap persistente de 8G já existe desde a otimização de RAM
  de 2026-06-21 — não é preciso criar swap temporário como em features
  anteriores do envio-massa (essas usavam swap 4G *ad hoc* porque não havia
  swap persistente na época).
- 9 containers `hub_homolog_*` já no ar há 25-30h (ambiente persistente,
  como o RUNBOOK descreve — não é efêmero).
- Não há `playwright`/`axe-core`/`@axe-core/*` em
  `app_homologacao/frontend_v2/package.json` (só `vitest` como devDependency
  de teste). Nenhum `playwright.config.*` no repo.

## 1. Como rodar o shell (frontend_v2) contra o hub-homolog para a E2E

### Opção A — Adicionar serviço `frontend` real ao compose, build único sob cap (RECOMENDADA)

- Criar `app_homologacao/frontend_v2/Dockerfile.hub` (novo arquivo, não
  altera o `Dockerfile` de produção): mesmo padrão 2-stage do genérico, mas
  com `ARG NEXT_PUBLIC_APP_ENV` → `ENV NEXT_PUBLIC_APP_ENV=$NEXT_PUBLIC_APP_ENV`
  ANTES do `RUN npm run build` (para inlinar no bundle), e **sem** `ENV
  BACKEND_URL` fixo (deixa só a runtime, via compose `environment:`, igual
  ao contrato `dec-031`).
- Adicionar serviço `frontend` a `infra/hub/compose.hub.homolog.yml`, molde
  do `backend` (que já usa `build: {context, dockerfile}` + `mem_limit` +
  `cpus`): `networks: [hub_internal, hub_edge]` (precisa alcançar `backend`
  internamente E ser exposto via Traefik — diferente do `backend`, que só
  está em `hub_internal`); `mem_limit` baixo (256-384m — Next standalone
  runtime é leve, o consumo pesado é só durante o `build`, não o `run`);
  `environment: { BACKEND_URL: http://backend:3000/api, ... }`;
  `build.args: { NEXT_PUBLIC_APP_ENV: "${APP_ENV}" }`.
- Substituir a rota do Traefik (`infra/hub/traefik/dynamic/hub.yml`): trocar
  `hub-placeholder` → `hub-frontend` apontando para `http://frontend:3000`
  nos 2 routers (https/http), e remover o serviço `placeholder` do compose —
  exatamente como o `RUNBOOK.md` já anuncia.
- Build: `DOCKER_BUILDKIT=0 docker compose -f infra/hub/compose.hub.homolog.yml
  -p hub-homolog --env-file /var/lib/hub_secrets/.env.hub.homolog build
  --memory=2g frontend` (mesmíssimo padrão já em produção neste repo para o
  `backend`, ver `hub-e2e-homolog.sh` linha do `dc build --memory=2g backend`).
  Depois `up -d --wait frontend`.
- Custo de host: 1 build de Next (mais pesado que o `npm install` do
  backend, mas com HARD CAP de 2GiB via cgroup — se estourar, o processo de
  build é OOM-killed **dentro do container**, nunca no host; falha segura,
  não starvation). Runtime do container depois do build: leve (~150-300MB
  RSS típico de um server Next standalone servindo poucas rotas).
- Prós: é literalmente o que `tasks.md` 6.1.2 e o `RUNBOOK.md` já mandam;
  ambiente fica **persistente** (como os outros 9 serviços — não precisa
  rebuildar a cada rodada de E2E); Playwright/axe rodam contra a URL HTTPS
  real (`https://hub-homolog.todo-tips.com:8443`), fidelidade máxima
  (mesmo TLS self-signed, mesmo Traefik, mesmo banner) — cobre 6.2.4 sem
  esforço extra.
- Contras: é a única opção que precisa de 1 `docker build` de fato.

### Opção B — Container efêmero rodando `next dev`/`node` direto, sem imagem nem Traefik

- Um container `node:20-alpine` (`--memory=2g`, `--rm`) montando o código
  fonte via bind mount, na rede `hub_internal`, rodando `npm ci && npm run
  dev` (ou `next start` após `next build` dentro do próprio container, sem
  gerar imagem). Playwright rodaria contra `http://<container>:3000`
  diretamente, ou via `docker exec` de outro container na mesma rede.
- Prós: não mexe no compose "de verdade", não builda uma imagem versionada,
  reversível com um `docker rm`.
- Contras: **viola `plan.md` §4 ao pé da letra** ("nunca `next build`/`dev`
  solto no host" — aqui seria dentro de um container, mas ainda como
  processo de dev, não como o artefato produtivo que a Fase 6 deveria
  validar); modo dev do Next é mais pesado em RAM que produção (HMR,
  sourcemaps) e MENOS fiel (CSS/comportamento podem diferir do build real);
  não teria o banner do EnvBadge validado contra o mesmo TLS/domínio real
  (SC-004 ficaria parcialmente coberto); e não avança a arquitetura
  end-state que `RUNBOOK.md`/tasks.md já preveem — teria que ser refeito
  depois mesmo assim. **Não recomendada.**

### Opção C — Build a imagem (igual à Opção A) mas SEM tocar Traefik/placeholder

- Mesmo `Dockerfile.hub` + serviço `frontend`, mas só em `hub_internal`
  (sem `hub_edge`), sem alterar `traefik/dynamic/hub.yml` nem remover
  `placeholder`. Playwright rodaria de um container companheiro na mesma
  rede `hub_internal`, batendo em `http://frontend:3000` direto (HTTP puro,
  sem TLS).
- Prós: build ainda é necessário (não foge do cap), mas menor blast radius
  de configuração (não mexe no Traefik nem desliga o `placeholder`).
- Contras: deixa a arquitetura em estado intermediário/inconsistente com o
  que `RUNBOOK.md` já documentou como o desenho da fase (frontend substitui
  o placeholder); o domínio público `hub-homolog.todo-tips.com:8443` (usado
  pelo operador para conferência visual) continuaria mostrando o banner
  antigo do `placeholder`, não a tela real — o operador teria que saber
  entrar via outro caminho para ver o resultado. Adia trabalho que teria
  que ser feito de qualquer forma no fechamento da fase (7.2.1 já menciona
  fechar a S3 com PR+evidências, e as evidências de 6.5.1 são "prints por
  papel" — mais fiéis vindo do domínio real).

**Recomendação do orquestrador: Opção A.** É a única que fecha 6.1.2 como
especificado, reaproveita a decisão de `BACKEND_URL` já tomada (`dec-031`),
usa o padrão de build já testado neste mesmo repo para o `backend` do hub, e
não deixa dívida arquitetural para a Fase 7 (PR/encerramento).

## 2. Rito anti-starvation obrigatório antes do build

Checagem PRÉ-BUILD (a próxima onda deve rodar e registrar a saída antes de
buildar, não confiar neste snapshot):

```sh
swapon --show          # confirmar swapfile ativo (hoje: 8G, ~5.7G livre)
free -h                 # confirmar RAM disponível (hoje: 6.8Gi available)
docker ps --format '{{.Names}}\t{{.Status}}' | grep hub_homolog
```

- **Cap obrigatório no build**: `DOCKER_BUILDKIT=0 docker compose ... build
  --memory=2g frontend` (BuildKit desabilitado é o padrão já usado em
  `hub-e2e-homolog.sh` para o `backend` — manter consistência; BuildKit por
  padrão ignora `--memory` em alguns modos, por isso o repo já desliga).
- **Nunca** rodar o build concorrente com outro build/`next dev`/processo
  pesado no host (serializar).
- **Se RAM disponível cair abaixo de ~2Gi** no momento do build: abortar e
  escalar para o operador — não tentar liberar RAM sozinho (ex.: matar
  processos de produção) — mesma lição do incidente de 2026-06-11.
- Após o build: `docker ps` confirmar `frontend` `Up`/healthy antes de
  qualquer cenário E2E (task 6.1.3, smoke 200).
- Sem swap temporário a criar: o swap de 8G já é persistente no host.

## 3. Cenários E2E (6.2.1–6.2.6) — seeds e execução

- **2 contas** (task 6.1.1): reusar o padrão de
  `infra/hub/testes/hub-e2e-homolog.sh` (INSERT direto em `Usuario` +
  `UsuarioEntidade`, prefixo de e-mail `e2e-teste-*@example.test`, hash
  bcrypt via `docker compose exec backend node -e`, cleanup em `trap`):
  - Conta 1: papel `admin_entidade` (tem `auditoria.consultar`) →
    `e2e-teste-shell-admin@example.test`.
  - Conta 2: papel `operador` (NÃO tem `auditoria.consultar`, nem
    `usuarios.gerenciar`) → `e2e-teste-shell-operador@example.test`.
  - `empresa_id` sintético numa faixa não usada pelas outras suítes (940001/
    940002 já usados por `hub-e2e-homolog.sh`; sugerido `950001` para esta
    fase, único vínculo por conta — não precisa de 2 empresas aqui, já que
    o teste de troca de entidade (6.2.3) pode reusar a MESMA conta com 2
    vínculos, como já demonstrado no 6.3.1 do script S2).
  - Sem novo script python/gen-seeds — é SQL direto, mesmo padrão já
    auditado e revisado.
- **6.2.1/6.2.2** (menus diferentes + 403 em `/api/v1/auditoria`): login com
  cada conta via UI real (Playwright), inspecionar itens do `ModuleNav`
  renderizados; depois, autenticado como `operador`, chamar
  `GET /api/v1/auditoria` diretamente (via `fetch`/`request` do Playwright
  usando os cookies da sessão) e confirmar `403`.
- **6.2.3** (troca de entidade < 5s): usar uma conta com 2 vínculos
  (`UsuarioEntidade` x2, como no padrão S2), acionar `EntitySwitcher`,
  medir o tempo até os dados mudarem.
- **6.2.4** (banner de ambiente): screenshot de qualquer tela pós-login
  confirmando o `EnvBadge` visível (depende do `NEXT_PUBLIC_APP_ENV` correto
  no build, ver §0).
- **6.2.5** (sessão expira em meio de ação): forçar expiração/softlogout
  via SQL na tabela de sessão (`infra/hub/migrations/0005_sessao_refresh.sql`
  define o esquema) ou via manipulação do cookie no Playwright, igual ao
  truque já usado em `hub-e2e-homolog.sh` 6.3.3 (`bloqueado_ate` ajustado
  direto no banco em vez de esperar o tempo real).
- **6.2.6** (login sem vínculo): criar conta `e2e-teste-shell-sem-vinculo@
  example.test` sem nenhuma linha em `UsuarioEntidade`.
- **Cleanup**: mesmo padrão `trap` do script S2 — `DELETE FROM "Usuario"
  WHERE email LIKE 'e2e-teste-shell-%'` (cascata para `UsuarioEntidade`/
  sessão), rodando mesmo em caso de falha.

## 4. Como rodar axe (≥95) nas 6 telas

- Telas: `/hub/login`, `/hub/recuperar-senha`, `/hub/redefinir-senha`,
  `/hub/selecionar-entidade`, `/hub/dashboard`, `/hub/perfil` (confirmar
  paths exatos em `app/hub/*` na execução — os nomes acima seguem o padrão
  de `plan.md` §3.4).
- **Não instalar Playwright/browsers via `npx playwright install
  --with-deps` no host** — esse comando tenta `apt-get install` pacotes de
  sistema (Ubuntu/Debian), o que este ambiente proíbe (`bash-guard.sh`:
  bloqueia gerenciadores de pacote de host; VPSTodo é o host de produção do
  cliente, nenhuma instalação de pacote de sistema é aceitável fora do
  rito).
- **Alternativa segura**: rodar os testes de axe DENTRO da imagem oficial
  `mcr.microsoft.com/playwright:v1.x-jammy` (versão pinada, já traz
  Chromium + todas as deps de SO pré-instaladas — zero apt-get no host),
  via `docker run --rm --memory=1g -v <repo>/app_homologacao/frontend_v2:/work
  -w /work mcr.microsoft.com/playwright:<versão> npx playwright test
  <specs-axe>`, com `baseURL` = `https://hub-homolog.todo-tips.com:8443`
  (aceitando o certificado self-signed — `ignoreHTTPSErrors: true` na
  config do Playwright) OU conectado à rede `hub_homolog_edge`/`hub_internal`
  batendo direto no container `frontend` (HTTP puro, sem TLS) se preferir
  não depender de DNS externo.
  - `@playwright/test` + `@axe-core/playwright` entram como
    **devDependencies** do `frontend_v2` (só `npm install`, sem instalar
    nada de SO no host) — consistente com "sem nova dependência salvo
    justificativa" do `plan.md` §4, já que é dependência de TESTE, não de
    produção, e a própria Fase 6 do briefing exige axe automatizado.
  - Custo de host: baixo — um container efêmero, `--memory=1g`, rodando 6
    page-loads + auditoria de acessibilidade, nada comparável a um build.

## 5. Recomendação consolidada do orquestrador

1. Opção A (serviço `frontend` real no compose, substituindo `placeholder`,
   `Dockerfile.hub` próprio com `ARG NEXT_PUBLIC_APP_ENV`).
2. Build único sob `--memory=2g` + swap 8G persistente já existente (sem
   swap temporário a criar) — mesmo padrão já usado para o `backend` do hub
   neste repo.
3. Seeds via SQL direto (2 contas, papéis `admin_entidade`/`operador` já
   semeados na 0007), reusando literalmente o script/padrão de
   `hub-e2e-homolog.sh` (S2, já revisado e mergeado).
4. Playwright + axe rodando DENTRO da imagem oficial
   `mcr.microsoft.com/playwright` (nunca instalado via apt no host),
   contra a URL HTTPS real do hub-homolog.
5. Nenhum destes passos foi executado nesta onda — tudo fica condicionado à
   autorização do operador (bloqueio registrado a seguir).

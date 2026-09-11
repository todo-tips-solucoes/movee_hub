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
  resolvido server-side a partir do token, nunca do corpo da requisição. A sessão do hub
  renova sozinha: o proxy `app/api/[...path]` renova por `POST /api/v1/auth/refresh` ao ver
  o `accessToken` vencido/ausente (sem timer — timer no cliente derrota a inatividade). O
  refresh **desliza 6 h** (inatividade) e a família tem **teto absoluto de 24 h** desde o
  login (carimbado no próprio refresh token `<ms>.<hex>`, sem coluna nova).
  ⚠️ **Estado de sessão que só vive numa claim do `accessToken` (efêmero) e que só o
  `/refresh` recarrega é uma bomba armada:** a `entidade_ativa` (gravada pelo
  `POST /me/entidade`) morava só na claim, e o `/refresh` a descartava ao reemitir o token.
  Enquanto ninguém chamava o refresh isso ficou latente; ligar a renovação silenciosa o
  detonou — a cada refresh a entidade sumia e o hub caía em "sem módulos" (`/me` com
  `modulos:[]`) + 400 `ENTIDADE_NAO_SELECIONADA` (`hub-motoristas.js`). Correção (PR #161):
  o `/refresh` relê a claim do `accessToken` antigo **mesmo expirado** (`jwt.verify` com
  `ignoreExpiration` — assinatura HS256 ainda conferida, `sub` conferido, `/me` revalida
  contra os vínculos), e o **cookie** do access vive tanto quanto o refresh (o JWT segue
  expirando em 15 min). **Ao reemitir um token, preserve TODA claim de estado de sessão que
  o `/refresh` não recalcula do banco** — não só `sub`/`email`.

## Comandos

Backend (`app_homologacao/backend/`):

```bash
npm start                            # node server.js (porta 3000)
npm test                             # todas as suítes unit (node --test; exige Node ≥18 no host)
npm run test:hub:unit                # unit do hub
npm run test:hub:integration         # integração do hub (exige ambiente hub no ar)
node --test tests/<arquivo>.test.js  # um arquivo de teste só
```

⚠️ **A imagem de produção do backend é `node:20-alpine`, buildada pelo `Dockerfile.hub`** —
foi o que o cutover do hub (G3) colocou no serviço `envio-massa-homologacao_backend_homologacao`.
Confirmado em 2026-08-01: `docker run --rm <imagem em produção> node --version` → `v20.20.2`.
O `Dockerfile` (`node:14`) é o build ANTIGO e **não** corresponde mais ao que roda em
produção — buildar produção com ele derruba o runtime de 20 para 14 sob o código do hub.
Para gerar imagem de produção do backend, sempre:

```bash
DOCKER_BUILDKIT=0 docker build --memory=2g -f Dockerfile.hub -t <registry>/envio-massa-backend:<tag> .
```

e conferir com `docker run --rm <tag> node --version` antes de entregar a imagem.

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

Builds pesados no host (`next build`, `docker build`) exigem **duas** conferências
antes, cada uma nascida de um incidente real:

| Conferir | Como | Incidente de origem |
|---|---|---|
| **RAM/swap** | swap ativa; `docker build` sempre com `--memory=2g` | starvation 2026-06-11 (derrubou o Swarm inteiro) |
| **Espaço em disco** | `df -h /` — **abortar se houver menos de ~20 GB livres** | disco cheio 2026-08-30 (derrubou o `chatmasterveloz`) |

O check de disco é tão obrigatório quanto o de swap. Em 2026-08-30, cinco builds no
mesmo dia (backend 700 MB cada, frontend 281 MB, mais cache) levaram `/` a 100% e o
Postgres de produção entrou em crash loop: `could not write lock file
"postmaster.pid": No space left on device`. Cada imagem de backend custa ~700 MB e
o build cache cresce sozinho — 5 builds consomem vários GB.

Limpeza docker: **nunca** por impulso, e nunca `docker system prune -a` (apagaria as
imagens de rollback locais) nem `--volumes` (destruiria `envio_massa_hub_uploads`,
que guarda os arquivos originais das importações). Para recursos do hub, filtro
`hub_*`. Em emergência de disco, o que é seguro e reversível:
`docker builder prune -f` (só cache de build) e `docker image prune -f` **sem `-a`**
(só imagens sem tag) — foi o que recuperou 18 GB no incidente acima, sem tocar em
nenhuma imagem tagueada, volume ou container em uso.

Gotcha turbopack: comentário JSX `{/* */}` imediatamente após `return (` quebra o
build — usar `//` na linha acima do `return`.

## Convenções de deploy

- Deploy = `docker build` → `docker push` → `docker service update --with-registry-auth --image …`.
  **Nunca** `docker stack deploy` (preserva env/labels/segredos do serviço).
- Backend e frontend_v2 rodam em `node:20-alpine` (backend via `Dockerfile.hub`; frontend_v2
  em Next.js standalone). O `.dockerignore` exclui `node_modules`, então módulos nativos
  (ex.: `bcrypt`) recompilam no build — não copiar binários do host.
- **Antes de qualquer `service update`, conferir de qual Dockerfile veio a imagem que está
  no ar**: `docker service ls --filter name=envio-massa-homologacao_ --format '{{.Name}}\t{{.Image}}'`
  e `docker run --rm <imagem> node --version`. Anotar essa imagem — ela é o rollback.
- ⚠️ O `ENV BACKEND_URL` do Dockerfile do `frontend_v2` aponta para a API do ambiente; conferir
  antes de buildar para outro destino.

## Certificados TLS / Traefik — o que engana no diagnóstico

O Traefik (`traefik_traefik`, v3.5.3) termina o TLS de **tudo** no host e guarda os
certificados no `acme.json` (volume `volume_swarm_certificates`), que tem as **chaves
privadas** de todos os domínios, inclusive `registry.todo-tips.com` (de onde saem os
deploys). Nunca imprimir o conteúdo; editar só por programa
(`infra/producao/acme-podar.py`) e **com o Traefik parado** — no ar ele reescreve o
arquivo e a edição se perde. Alarme de validade: `infra/producao/cert-guard.js`
(timer diário 09:00; detalhe em `README-cert-guard.md`).

Os quatro enganos do incidente de 2026-09-09, cada um custou tempo:

- ⚠️ **Certificado multi-SAN com um nome já removido do DNS não renova — nunca.** Foi a
  causa: os certs do produto cobriam também o nome antigo do rebrand (`envmassv2`,
  `appmotorista`), apagado do DNS. A renovação pede **todos os nomes do certificado
  atual**, bate em NXDOMAIN no nome morto e a ordem **inteira** falha. Reemitir por cima
  não resolve; a correção é tirar o nome morto. Ao aposentar um domínio, conferir se ele
  é SAN de algum certificado vivo — `openssl x509 -ext subjectAltName`.
- ⚠️ **`CN` diferente do domínio roteado é falso alarme**: o `CN` é só o primeiro nome do
  certificado e o navegador valida pelo **SAN**. Julgar pelo `CN` inventa um problema que
  não existe e esconde o que existe.
- ⚠️ **O log do Traefik vive DENTRO do container** (`--log.filePath`, sem volume):
  `docker logs` não mostra nada de ACME, e **cada restart começa um arquivo novo**. Depois
  de reiniciar, `grep` no `traefik.log` não acha o que aconteceu antes — o que *parece*
  "não tentou" e é "o histórico foi embora". Copiar o log **antes** de reiniciar.
  Ler assim: `docker exec <tid> grep -i "Error renewing" /var/log/traefik/traefik.log`.
- ⚠️ **A Let's Encrypt deduplica ordens**: retentativas caem na mesma URL de `finalize`. Com
  `authorization already valid` no log, a validação **já passou** e retentar **não custa
  cota** — o limite de 5 falhas/hora é de *validação*, não de `finalize`. Antes de culpar
  rate limit, medir a conectividade com `acme-v02.api.letsencrypt.org`.

E duas armadilhas de ambiente: há **dois** Traefik no host (`traefik_traefik` é produção,
`hub_homolog_traefik` é o do hub isolado) — filtrar por `name=traefik_traefik`, nunca
`name=traefik | head -1`; e `curl` devolvendo `000` **não** é queda da aplicação, é o
próprio curl recusando o certificado — confirmar com `-k` antes de concluir qualquer coisa.

Incidente completo em [`docs/plans/infra-certificados/RUNBOOK-CORRECAO.md`](docs/plans/infra-certificados/RUNBOOK-CORRECAO.md).

## Rito do ciclo git — CLÁUSULA PÉTREA

Acordado com o operador em 2026-08-07. Vale para **toda** entrega neste repositório e
complementa (não substitui) o rito de produção dos 5 gates acima. Cada regra veio de uma
falha real, não de boas práticas genéricas — a justificativa está ao lado.

**A regra que o rito existe para proteger: produção nunca roda código que não está na `main`.**

| # | Etapa | Regra |
|---|-------|-------|
| 0 | Branch | Nunca commitar na `main`. Branch `<tipo>/<escopo>-<slug>`. Autorização é **por etapa**: commitar, pushar/PR e deployar são três permissões distintas — uma não implica a seguinte. |
| 1 | Gates | Todos verdes e relatados **com números**: `tsc --noEmit` · suíte unit · `next build` (se tocou frontend) · detector impeccable 0 achados (se tocou UI) · E2E do hub (se tocou o hub) · lint comparado com a **baseline** (erro pré-existente não bloqueia; erro novo bloqueia). |
| 2 | Staging | `git status` lido arquivo a arquivo. `git add` **sempre por caminho explícito** — nunca `git add -A`/`.`. |
| 3 | Commit | O quê, **por quê**, o que foi verificado, o que ficou de fora. Correção alheia ao escopo vai declarada no corpo, nunca escondida. Trailers de praxe (ver Governança). |
| 4 | PR | O que muda, risco, verificação com números, o que ficou deliberadamente de fora, e os achados que mudaram o produto durante a verificação. |
| 5 | **Merge** | Squash + branch deletada, depois `git checkout main && git pull --ff-only`. **Vem ANTES do deploy.** |
| 6 | Build | A partir da **main já mergeada**. Tag `<rótulo>-<sha7>` (`git rev-parse --short HEAD`). **`df -h /` e swap conferidos ANTES** (ver [Comandos](#comandos) — disco cheio derruba o banco). Conferir Dockerfile, `node --version` e `BACKEND_URL` antes de entregar. Anotar o digest. |
| 7 | Deploy | Os 5 gates do rito de produção, sem exceção. |
| 8 | Prova | Depois do deploy, **provar** que o bundle servido é o novo: buscar no artefato servido por produção uma string que só existe naquela entrega. HTTP 200 prova que o serviço subiu, não que subiu o código certo. |

Justificativas (todas com incidente de origem):

- **Merge antes do deploy** — nas rodadas 3 e 4 do impeccable, produção rodou código fora da
  `main` e o merge quase foi esquecido nas duas vezes. Um hotfix partindo da main teria
  partido de código diferente do que o cliente usa.
- **Tag com `sha7`** — sem ela, provar de qual código veio a imagem exige comparar
  `git rev-parse HEAD^{tree}` na mão.
- **`git add` explícito** — o repo tem untracked de longa data (`arquivos_complementares/`,
  backups, logs de E2E) que um `git add -A` arrastaria para o commit.
- ⚠️ **`package-lock.json` é reescrito pelo container do Playwright** (npm de outra versão)
  a cada execução do E2E, via bind mount. **Conferir e reverter antes de commitar** — foi
  pego por acaso 2× na mesma sessão.
- **Prova de bundle** — `NEXT_PUBLIC_*` é inlinada em build; já houve deploy com smoke 200 e
  bundle errado (incidente do banner de ambiente, PR #81).

Quando o `docker service update` for bloqueado pelo classificador do harness (acontece de
forma intermitente): **não contornar** — entregar o comando pronto para o operador executar.

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

## Robô EntreGô — acoplamentos que não se veem no código

Os dois timers de `infra/robo-entrego/` parecem independentes. **Não são.**

- ⚠️ **O import diário depende do timer de ENRIQUECIMENTO estar ligado.** O
  `entrego-enriquecimento-sob-demanda.timer` roda a cada 5 min e, com a fila vazia, faz
  *keep-alive* da sessão do portal (PR #159). É só isso que mantém a sessão viva: o
  **refresh token da EntreGô vive 60 min** (o cookie diz 24 h, mas o token não — decodificar
  o JWT, nunca ler `expires`). Desligue o timer de enriquecimento e, ~1 h depois, a sessão
  morre; o próximo import é forçado a **login completo**, que exige o **código de 6 dígitos
  por e-mail** (lido por IMAP em `src/imap-codigo.js`, janela de 5 min). Isso transforma uma
  rotina autônoma numa que depende de e-mail chegar a tempo — e um atraso de entrega já
  derrubou o import das 11h de 2026-09-07 (`falha_definitiva`, "nenhuma mensagem encontrada
  com assunto Código de Acesso"), enquanto o mesmo código era lido sem problema às 13h.
  **Antes de parar/desabilitar o timer de enriquecimento, saiba que está apostando o import
  do dia seguinte no e-mail do portal.**
- ⚠️ **Os dois compartilham a MESMA trava** (`flock -n`, `robo-entrego.lock`) e o
  **mesmo par conta/sessão** do portal (dec-039). Uma rodada de enriquecimento segurando a
  trava na hora do import (11h/13h/14h) faz o import daquele tick ser **pulado** — e não há
  novo tick até o dia seguinte, ou seja, o D-1 daquele dia não entra. Drenagem em massa
  precisa terminar (ou ser parada por timer agendado) **antes** da janela do import.
- ⚠️ **O limitador do backend cobre o robô inteiro**, inclusive o PATCH que grava o resultado
  de cada motorista (`routes/hub-robo-entrego.js`: 30 req / 15 min por usuário). Uma rodada
  custa 1 GET + até 20 PATCH = **21 requisições**: com o throttle padrão de 60 s dá ~16 por
  janela e passa; a 30 s dá ~31,5 e **estoura**. O worker hoje espera e retenta no 429
  (PR #166), mas o teto continua dimensionado para uso sob demanda, não para drenagem.
- Mudança de **fluxo** em `infra/robo-entrego/` se faz em **worktree**: o `ExecStart` aponta
  para o diretório vivo do repo, então `git checkout` muda o que roda e **merge = deploy**.
  Provar com a suíte **no diretório vivo**.

## Abrir outra frente de trabalho

`/clear` é **comando embutido** do Claude Code, não uma skill. Ele apaga a conversa da
sessão corrente e nada mais: sobrevivem a memória do projeto, o git, os arquivos em
disco e o estado das pipelines `*-00c`. Serve para começar uma frente **em seguida**,
nunca **em paralelo** — para isso, abra uma segunda sessão em outro terminal.

Antes de limpar ou abrir a frente nova, **versione um briefing** em `docs/plans/<tema>/`
e aponte a sessão nova para ele. Uma sessão limpa só sabe o que está na memória e neste
arquivo; tudo que foi medido e ainda não virou documento se perde. Briefings que
funcionaram como modelo: `docs/plans/robo-entrego/BRIEFING-LIMITADOR-CONTA-SERVICO.md` e
`docs/plans/infra-certificados/BRIEFING-CERTIFICADOS-EXPIRADOS.md` — ambos trazem o
problema **medido** (não suposto), o que já foi feito e não deve ser refeito, as
restrições, os entregáveis e os enganos que custaram tempo.

⚠️ **Duas sessões no mesmo repositório colidem.** Em 2026-09-09 havia 21 arquivos
`infra/hub/testes/*.sh` modificados por outra sessão durante uma entrega inteira — a
disciplina que salvou foi `git add` por caminho explícito e **nunca** reverter o que não
é seu. Se a frente nova tocar os mesmos diretórios, isole-a num **git worktree**
(`.claude/worktrees/<nome>`, convenção já usada no repo; `node_modules` por symlink).
Mantenha o worktree sob a raiz do projeto — as guardas e o servidor de estado das
pipelines só operam ali.

⚠️ **O diretório de trabalho da tool Bash PERSISTE entre chamadas.** Um `cd` de
conveniência numa chamada vira a "raiz" da retomada seguinte e faz a guarda
`session-scope` recusar com `verdict=diverged`. Ancore cada comando com `cd` explícito;
a saída não é `--allow-outside`, é voltar para a raiz.

## Governança

- Commit/push/merge/deploy **somente com autorização explícita** do operador, **uma por
  etapa** — autorizar o commit não autoriza o PR, que não autoriza o deploy.
- O ciclo completo é a cláusula pétrea em [Rito do ciclo git](#rito-do-ciclo-git--cláusula-pétrea).
- Mensagens de commit terminam com o trailer `Co-Authored-By` do modelo vigente
  (ex.: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`);
  corpos de PR terminam com `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
- Princípios de projeto em [`docs/constitution.md`](docs/constitution.md).

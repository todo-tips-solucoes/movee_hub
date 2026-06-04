# Handoff Operacional — App Motorista (PWA)

**Feature**: `app-motorista-nfse` | **Date**: 2026-06-04
**Status do código/docs**: COMPLETO (ondas 1–4).
**Status do DEPLOY**: ✅ **NO AR** em `https://appmotorista.todo-tips.com` (2026-06-04).

> ### ✅ Deploy realizado (2026-06-04)
> - Imagens buildadas e enviadas ao registry: `app-motorista-frontend:homologacao`
>   e `envio-massa-backend:homologacao` (com rotas `/motorista/*` + fix `form-data`).
> - Backend atualizado via `docker service update --image` (preservou as 7 envs).
> - Serviço `frontend_motorista_homologacao` criado no stack swarm `envio-massa-homologacao`
>   (deploy aditivo, sem `--prune`; os 3 serviços existentes não foram tocados).
> - TLS Let's Encrypt emitido; `https://appmotorista.todo-tips.com/` → 200, PWA standalone.
> - Proxy → backend validado: `/api/motorista/verify-auth` → 401 (middleware ativo).
>
> ### ✅ Tabela aplicada + validação E2E (2026-06-04)
> - Tabela `Motorista` aplicada no schema `public` (mesmo da `Empresa`).
> - **PEGADINHA**: PostgREST mantém um *schema cache*; após criar a tabela é
>   obrigatório recarregar, senão dá `PGRST205 Could not find table public.Motorista`.
>   Reload sem downtime: `docker kill -s SIGUSR1 $(docker ps -q -f name=pgadmin_postgrest)`
>   (ou `NOTIFY pgrst, 'reload schema';` no DB do EnvioMassa).
> - **Fluxo autenticado validado** pelo app público: login → cookies httpOnly →
>   `GET /api/motorista/movimento-aberto` (200, escopo por cnpj do token) → verify-auth.
> - **Guard anti-enumeração confirmado**: CNPJ inexistente → 409; só passa cnpj já
>   presente na `EnvioMassa`.
>
> **Pendência restante (menor)**: roundtrip empírico do `validade_nfse` com XML real
> (§3) — o code path multipart está cabeado, mas não foi exercido com uma nota real
> (precisa de um motorista com movimento aberto).

> Implementado e commitado: backend (`/motorista/*`), frontend PWA (`frontend_motorista`,
> Serwist), tabela `Motorista` (SQL), serviço no `docker-compose.yml`, 45 testes verdes,
> revisão OWASP, README do backend. Branch: `worktree-app-motorista-nfse`.

---

## 1. Banco de dados (PostgREST/PostgreSQL)

- [ ] **Aplicar a tabela `Motorista`** — rodar o SQL idempotente:
  ```bash
  psql "$DATABASE_URL" -f app_homologacao/backend/db/001_create_motorista.sql
  ```
  Cria `Motorista` (id, cnpj_prestador UNIQUE, senha, nome, ativo, created_at) + GRANTs
  para a role `authenticated` do PostgREST. (tarefa 1.1.1/1.1.2)
- [ ] **Recarregar o schema do PostgREST** (para ele enxergar a tabela nova):
  `NOTIFY pgrst, 'reload schema';` (ou reiniciar o container do PostgREST).
- [ ] **Seed de motorista de teste** (homologação) — tarefa 1.1.3:
  ```bash
  cd app_homologacao/backend && node db/seed-motorista.js
  # (ou aplicar db/002_seed_motorista_teste.sql)
  ```
- [ ] **Validar** (tarefa 1.1.4): `GET {POSTGREST_URL}/Motorista?cnpj_prestador=eq.<cnpj>`
  retorna o registro seedado.
- [ ] **Confirmar colunas `nota_ok`/`erro_validacao` na `EnvioMassa`** (tarefa 1.2.1):
  `GET {POSTGREST_URL}/EnvioMassa?limit=1` e checar a presença + tipo das colunas.
  Se ausentes, criar migração aditiva antes de usar a validação.

## 2. Variáveis de ambiente (`.env` — fora do git)

Garantir no `.env` do backend (já usados pelo código existente):
- [ ] `JWT_SECRET`, `JWT_REFRESH_SECRET` (reusa os mesmos cookies do padrão Empresa)
- [ ] `POSTGREST_URL`, `POSTGREST_API_KEY`
- [ ] `FASTAPI_VALIDATION_TOKEN` (header `Authorization` da validação)

No `frontend_motorista/.env`:
- [ ] `BACKEND_URL=https://envmassapihomologacao.todo-tips.com`

## 3. Roundtrip empírico do contrato de validação (R-1 / risco aberto)

> A divergência do `xml_input` (research.md Decision 5) foi **parcialmente** reconciliada:
> o schema OpenAPI confirmou `multipart/form-data` (bug de Content-Type corrigido). Falta
> a chamada com **payload real** — bloqueada no dev pelo classificador de rede do harness.

- [ ] **R2** (tarefa 7.1.2): com um XML de NFS-e de homologação, chamar a validação como o
  backend faz e conferir o shape da resposta `[{ valid, details: {...7 flags} }]`:
  ```bash
  curl -X POST https://fastapihomologacaonexus.todo-tips.com/validade_nfse \
    -H "Authorization: $FASTAPI_VALIDATION_TOKEN" \
    -F 'xml_input=[{"filename":"nota.xml","data":"<xml...>"}]' \
    -F 'validar_descricao_servico=false' -F 'nexus=false'
  ```
  Se a API **rejeitar** o `xml_input=[{filename,data}]`, cair para o formato da rota
  `validate-xml-batch` existente e atualizar `research.md` Decision 5 + `contracts/`
  (tarefas 7.1.3/7.1.4). O parser do backend já tolera resposta inesperada (FR-012).
- [ ] **R1** (tarefa 7.1.1): com backend + PostgREST reais, `GET /api/motorista/movimento-aberto`
  e conferir que o payload sai em camelCase conforme o contrato.

## 4. Deploy (Docker **Swarm** + Traefik) — Constituição V (aditivo, sem afetar produção)

> ⚠️ **O ambiente roda em Docker Swarm**, não `docker compose`. O stack
> `envio-massa-homologacao` é atualizado com `docker stack deploy` (re-deploy
> idempotente: adiciona o serviço novo sem recriar os existentes que não mudaram).
> O nome da imagem é o **referenciado no compose**:
> `registry.todo-tips.com/app-motorista-frontend:homologacao` (porta interna 3000).
> A imagem do motorista **já foi buildada** localmente na VPS em 2026-06-04
> (`docker images` confirma) — falta só o `push` + `stack deploy` (ações de infra
> que exigem autorização explícita; o classifier as bloqueia por padrão).

- [ ] **Criar DNS** `appmotorista.todo-tips.com` → **178.156.254.243** (IP da VPS, mesmo
  dos demais hosts homologação) para o Traefik emitir o TLS Let's Encrypt. (R-3) — **pré-condição estrita**.
- [ ] **Push da imagem** (já buildada; tarefa 6.1.3):
  ```bash
  docker push registry.todo-tips.com/app-motorista-frontend:homologacao
  ```
  Se precisar rebuildar: `cd app_homologacao/frontend_motorista && docker build -t registry.todo-tips.com/app-motorista-frontend:homologacao .`
- [ ] **Backend**: rebuildar + push `registry.todo-tips.com/envio-massa-backend:homologacao`
  com as rotas `/motorista/*` (o build vem de `app_homologacao/backend/`).
- [ ] **Deploy do stack** (aditivo — só adiciona o serviço novo e atualiza o backend):
  ```bash
  cd app_homologacao
  docker stack deploy -c docker-compose.yml envio-massa-homologacao --with-registry-auth
  ```
  Conferir antes que **nenhum** serviço de produção não relacionado seja recriado
  (só `frontend_motorista_homologacao` novo + `backend_homologacao` atualizado).
- [ ] Validar acesso externo por `https://appmotorista.todo-tips.com` após o DNS propagar
  e o Traefik emitir o certificado.

## 5. Validações manuais de UI/PWA

- [ ] Smoke local (tarefa 4.1.5): `npm run dev` no frontend, login devolve cookies via proxy.
- [ ] Cenários do quickstart (tarefa 7.3.2 / 5.x): login, cadastro elegível vs inelegível,
  movimento aberto, empty state, upload válido (bloqueia reenvio), upload inválido (lista
  campos), não-XML (400), serviço fora (502).
- [ ] **Lighthouse PWA** (tarefa 4.2.4): confirmar "installable"; instalar na tela inicial
  (Android/Chrome e iOS/Safari) e abrir em standalone.

## 6. Pull Request

- [ ] Abrir PR de `worktree-app-motorista-nfse` (ou `feature/app-motorista-nfse`) → `main`:
  ```bash
  git push -u origin worktree-app-motorista-nfse
  gh pr create --base main --title "feat: App Motorista (PWA) — consulta de NF + validação de XML" \
    --body "Pipeline SDD completo. Backend /motorista/*, frontend PWA, deploy aditivo. Ver docs/specs/app-motorista-nfse/."
  ```

---

## Riscos remanescentes
- **R-1**: contrato `validade_nfse` — só o roundtrip real (§3) fecha em definitivo.
- **R-3**: DNS do host novo é pré-condição para o TLS do Traefik.
- **Auto-cadastro**: guard anti-enumeração depende de a `EnvioMassa` ter o `cnpj_prestador`
  do motorista; validar com dados reais que o guard não bloqueia motoristas legítimos.

# S3 (hub-shell) — FASE 6: Evidências E2E, Segurança e Ambiente

> Ambiente isolado `hub-homolog` (VPSTodo, exceção standing G1). NENHUM dado
> pessoal real — apenas contas sintéticas `e2e-teste-shell-*@example.test`
> (criadas e removidas por `infra/hub/testes/hub-shell-e2e-homolog.sh` em cada
> execução). Nenhuma escrita em produção.

## 6.1 — Ambiente E2E (Opção A do e2e-plan.md, autorizada block-001/dec-045)

Artefatos (não alteram nada de produção):
- `app_homologacao/frontend_v2/Dockerfile.hub` — Next standalone, `node:20-alpine`,
  `ARG NEXT_PUBLIC_APP_ENV` (inlinado no bundle → banner) e SEM `ENV BACKEND_URL`
  fixo (runtime via compose, dec-031).
- `infra/hub/compose.hub.homolog.yml` — serviço `frontend` (substitui `placeholder`),
  redes `[hub_edge, hub_internal]`, `BACKEND_URL=http://backend:3000/api`,
  `HOSTNAME=0.0.0.0` (fix de bind do Next standalone).
- `infra/hub/traefik/dynamic/hub.yml` — router `hub-frontend` → `http://frontend:3000`.

### Rito anti-starvation (build sob cap `--memory=2g`)
- PRÉ-build: swap 8G ativo (5.7G livre), RAM `available` 6.7Gi, prod 8/8 Up.
- Build (`DOCKER_BUILDKIT=0 docker compose ... build --memory=2g frontend`): EXIT 0.
  Durante o build RAM `available` nunca caiu abaixo de ~6.5Gi; swap praticamente
  intocado (5.85G livre); produção permaneceu 8/8 Up o tempo todo.
- PÓS-build: prod 8/8 Up, `app.moveelog.com.br/login` → 200 (produção intacta).

### 6.1.3 — Smoke (via `https://hub-homolog.todo-tips.com:8443`, TLS self-signed)
```
/hub/login            -> 200
/hub/recuperar-senha  -> 200
/hub/redefinir-senha  -> 200
/hub/dashboard        -> 200
/hub/dashboard/perfil -> 200
```

## 6.2 — Cenários E2E (parte API/proxy verde; DOM/menu + timing na próxima onda)

Driver: `infra/hub/testes/hub-shell-e2e-homolog.sh` (padrão S2, requisições via o
proxy do Next — o mesmo caminho do browser real). 11/11 asserts PASS:

- **6.2.2 (SC-002)** — operador (sem `auditoria.consultar`) `GET /api/v1/auditoria`
  → **403**; admin_entidade (com a permissão) → **200** (contraprova). VERDE.
- **6.2.3 (SC-003, parte API)** — `POST /me/entidade` (A→B) reflete em `GET /me`
  (`entidade_ativa=B`) sem novo login. VERDE. (timing UI <5s → onda browser)
- **6.2.4 (SC-004)** — banner "HOMOLOGAÇÃO — dados fictícios" presente no HTML de
  `/hub/login`, `/hub/dashboard`, `/hub/dashboard/perfil`, `/hub/recuperar-senha`
  (EnvBadge global no layout raiz; `NEXT_PUBLIC_APP_ENV=homologation` inlinado). VERDE.
- **6.2.6 (FR-016, parte API)** — login de conta sem vínculo → `GET /me` com
  `entidades: []` (condição da tela "sem acesso"). VERDE. (print DOM → onda browser)

PENDENTE (requer Playwright/DOM, próxima onda): **6.2.1** (2 papéis veem menus
`ModuleNav` diferentes), **6.2.5** (expiração de sessão em meio de ação → redirect).

## 6.3 — Acessibilidade (axe ≥95): PENDENTE

Executar na imagem oficial `mcr.microsoft.com/playwright` (`docker run --rm
--memory=1g`, nunca apt/npx install no host), 6 telas. Próxima onda.

## 6.4 — Gate de segurança sobre o código real: VERDE

- **6.4.1** — cookies de auth do hub (`routes/hub-auth.js` `setAuthCookies`):
  `httpOnly: true`, `sameSite: 'strict'`, `secure` (quando `APP_ENV !== 'dev'`).
  NÃO existe `PermissionGate`/`hasPermission` no shell: o menu deriva de
  `me.modulos` (dado do servidor) e a autorização é enforçada pelo backend —
  o 403 do 6.2.2 é a prova empírica de que nada sensível é autorizado só no client.
- **6.4.2** — mutações do shell (troca de entidade, perfil, redefinição de senha)
  passam por endpoints do backend, que reautoriza por entidade (comprovado pelo
  403 do operador e pela troca de entidade autorizada). Sem PII/segredo novo em
  arquivos do shell (grep negativo).

## 6.5 — Evidências
- 6.5.3 (parcial): resultados API acima. 6.5.1 (prints por papel) e 6.5.2 (axe)
  pendem da onda browser. 6.5.4: este arquivo (parcial, será completado).

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

## 6.2 — Cenários E2E (parte API/proxy)

Driver: `infra/hub/testes/hub-shell-e2e-homolog.sh` (padrão S2, requisições via o
proxy do Next — o mesmo caminho do browser real). 11/11 asserts PASS:

- **6.2.2 (SC-002)** — operador (sem `auditoria.consultar`) `GET /api/v1/auditoria`
  → **403**; admin_entidade (com a permissão) → **200** (contraprova). VERDE.
- **6.2.3 (SC-003, parte API)** — `POST /me/entidade` (A→B) reflete em `GET /me`
  (`entidade_ativa=B`) sem novo login. VERDE.
- **6.2.4 (SC-004)** — banner "HOMOLOGAÇÃO — dados fictícios" presente no HTML de
  `/hub/login`, `/hub/dashboard`, `/hub/dashboard/perfil`, `/hub/recuperar-senha`
  (EnvBadge global no layout raiz; `NEXT_PUBLIC_APP_ENV=homologation` inlinado). VERDE.
- **6.2.6 (FR-016, parte API)** — login de conta sem vínculo → `GET /me` com
  `entidades: []` (condição da tela "sem acesso"). VERDE.

## 6.2/6.3 — Onda BROWSER (Playwright real, `@axe-core/playwright`)

Driver: `infra/hub/testes/hub-shell-e2e-browser.sh` — seeds efêmeros
(`e2e-teste-shell-browser-{admin,operador}-<HHMMSS>@example.test`, papéis
`admin_entidade`/`operador`, empresas sintéticas `950101`/`950102`, com
`ModuloEntidade` ativado p/ os 9 módulos — achado desta onda, ver abaixo),
cleanup em `trap`. Playwright roda DENTRO de `mcr.microsoft.com/playwright:v1.61.1-jammy`
(`docker run --rm --memory=1g --network host`), nunca instalado via apt/npx
no host. Specs em `app_homologacao/frontend_v2/tests/e2e-hub-browser/`
(config `playwright.config.hub.ts`). **10/10 testes PASS** (última execução
verde, log completo arquivado ao lado deste arquivo,
`fase6-browser-run-*.log`):

- **6.2.1 (SC-001/SC-005)** — `menus-por-papel.spec.ts`: admin_entidade vê
  8 itens no `ModuleNav` (inclui "Gestão de Usuários" + "Auditoria");
  operador vê exatamente 6 (sem os 2 exclusivos). Prints em
  `6.5.1-modulenav-admin_entidade.png` / `6.5.1-modulenav-operador.png`
  (mesmo diretório). VERDE.
- **6.2.3 (SC-003, parte UI)** — `troca-entidade-timing.spec.ts`: clique no
  `EntitySwitcher` até o rótulo refletir a nova entidade = **162ms**
  (gate <5000ms), sem novo login, mesma URL. VERDE.
- **6.2.5 (CHK017/task 4.5.3)** — `sessao-expira.spec.ts`: `accessToken`
  corrompido mid-ação (troca de entidade) → 401 → `authenticatedFetch` limpa
  `me` → `HubSessionGuard` redireciona a `/hub/login`, sem flash de conteúdo
  protegido residual. VERDE.
- **6.3.1/6.3.2 (axe ≥95)** — `axe-telas.spec.ts`, `@axe-core/playwright`,
  fórmula de score = penalidade ponderada por impacto (critical=25/serious=10/
  moderate=5/minor=2), piso 0 (Decisão dec-051):

  | Tela | Score | Violações |
  |------|-------|-----------|
  | `/hub/login` | **100** | 0 |
  | `/hub/recuperar-senha` | **100** | 0 |
  | `/hub/redefinir-senha` | **100** | 0 |
  | `/selecionar-entidade` (ramo escolha) | **100** | 0 |
  | `/hub/dashboard` | **100** | 0 |
  | `/hub/dashboard/perfil` | **100** | 0 |

  4 telas tinham achados reais na 1ª rodada (`landmark-one-main`,
  `page-has-heading-one`, `region` — moderate, scores 70/75/85/90):
  `/hub/login`, `/hub/recuperar-senha`, `/hub/redefinir-senha` e
  `/selecionar-entidade` renderizavam sem landmark `<main>` (login também
  sem `<h1>`). Corrigido nesta onda (6.3.2): `app/hub/login/page.tsx`,
  `app/hub/recuperar-senha/page.tsx`, `app/hub/redefinir-senha/page.tsx` e
  `app/selecionar-entidade/page.tsx` — outer `<div>` → `<main>` (nos ramos
  `role="status"` de `selecionar-entidade`, o `role` foi movido para um
  `<div className="contents">` interno, para não sobrescrever o role
  implícito de landmark do `<main>`); `CardTitle` do login ganhou `as="h1"`.
  20/20 testes unitários (vitest) das 4 telas continuam verdes após a mudança.

### Achado de ambiente — `ModuloEntidade` (bloqueou 6.2.1 na 1ª tentativa)

`GET /me` só inclui um módulo em `modulos[]` se ele estiver **ativo para a
ENTIDADE** (`ModuloEntidade.ativo=true`, `routes/hub-me.js` linhas 122-133)
*E* a pessoa tiver permissão nele — ter a permissão via `Papel`/`PapelPermissao`
sozinha NÃO basta. As empresas sintéticas `950101`/`950102` (novas, criadas só
para esta onda) não tinham nenhuma linha em `ModuloEntidade` — sem isso o
`ModuleNav` ficava vazio (`return null`) para **qualquer** papel (rendeu "Nenhum
módulo disponível para sua conta"). A suíte API S2/S3
(`hub-shell-e2e-homolog.sh`) nunca precisou disso porque não inspeciona o DOM.
Corrigido no driver browser: seed de `ModuloEntidade` (todos os 9 módulos,
`ativo=true`) para as 2 empresas sintéticas.

### Achado de robustez — rate limiter de `/auth/login`

`routes/hub-auth.js` tem `authRateLimiter` (chave `IP:email`, max=10/15min).
Como toda a suíte roda do mesmo container (mesma IP de origem, `--network
host`), repetir login via UI em cada teste (6+ logins por execução completa)
esgotava o limite em poucas rodadas de debug e produzia 429 em cascata — sem
relação com bugs reais do shell (confirmado em `docker logs hub_homolog_traefik`).
Fix: `global-setup.ts` loga **1x por papel** e persiste `storageState`
(cookies), reusado por todos os specs via `test.use({ storageState })` — 2
logins totais por execução da suíte. E-mails com sufixo `HHMMSS` por execução
(chave do limiter muda a cada rodada, sem depender de esperar a janela).

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

- **6.5.1** — prints por papel: `6.5.1-modulenav-admin_entidade.png` /
  `6.5.1-modulenav-operador.png` (este diretório), gerados pelo próprio spec
  Playwright (`menus-por-papel.spec.ts`).
- **6.5.2** — resultado do axe por tela: tabela na seção 6.2/6.3 acima (todas
  em 100/100 após as correções de 6.3.2); saída bruta (`AXE_RESULT ...`) no
  log arquivado `fase6-browser-run-*.log`.
- **6.5.3** — cenários E2E 6.2.1–6.2.6: todos VERDE (API + browser), ver
  detalhamento acima.
- **6.5.4** — consolidado neste arquivo (nota: vive em
  `docs/plans/hub-frota/evidencias/S3/`, convenção já estabelecida na onda
  anterior — `docs/specs/hub-shell/tasks.md` 6.5.4 referencia
  `docs/specs/hub-shell/evidencias/`, path que diverge; nenhuma evidência
  desta fase foi criada nesse segundo caminho).

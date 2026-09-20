// hub-shell (S3) FASE 6.2.5 — sessão expira EM MEIO a uma ação (troca de
// entidade) -> redirect para /hub/login, sem "vazar" a tela protegida
// (CHK017, contexts/hub-auth-context.tsx `authenticatedFetch` +
// components/hub/session-guard.tsx).
//
// Simulação: corromper os cookies de sessão DEPOIS do login (mid-action), em
// vez de esperar os 15min reais de TTL (routes/hub-me.js `ACCESS_TOKEN_TTL`)
// ou derrubar a sessão via SQL (SessaoRefresh.expira_em) — o accessToken JWT é
// verificado só por assinatura/expiry (routes/hub-me.js
// `decodificarAccessToken`), NUNCA contra a tabela SessaoRefresh por
// requisição; revogar a sessão no banco não invalidaria um accessToken
// ainda-válido. É determinístico e imediato, sem esperar tempo real (mesmo
// espírito de `infra/hub/testes/hub-e2e-homolog.sh` 6.3.3, que ajusta
// `bloqueado_ate` no banco em vez de esperar).
//
// ⚠️ É PRECISO CORROMPER OS DOIS COOKIES, e isto mudou em 2026-09-06.
// Até a renovação silenciosa (hub-sessao-inatividade), corromper só o
// `hub_accessToken` bastava para forçar 401. Hoje NÃO basta, e não deve
// bastar: `accessVenceEmBreve` (lib/hub/sessao-proxy.ts) trata token
// indecifrável como vencido, o proxy renova ANTES de encaminhar usando o
// `hub_refreshToken` — que continuaria válido — e a ação teria sucesso. Ou
// seja: com só o access corrompido o comportamento correto é RENOVAR, não
// expulsar (é o que o segundo teste deste arquivo trava).
// Sessão EXPIRADA, hoje, é REFRESH inválido. Corromper só o access aqui
// tornaria este teste um teste do caminho errado — foi assim que ele passou
// a falhar sem que ninguém tivesse quebrado a expulsão de sessão.
//
// Sessão vem de `storageState` gravado 1x em `global-setup.ts` (admin já
// chega autenticado E com uma entidade selecionada em /hub/dashboard) —
// evita repetir login via UI aqui (achado desta onda sobre o rate limiter
// de `/auth/login`, ver comentário em global-setup.ts).
import { test, expect } from '@playwright/test';
import { ADMIN_STATE } from './global-setup';

test.describe('6.2.5 — sessão expira em meio de ação (troca de entidade) -> redirect login', () => {
  test.use({ storageState: ADMIN_STATE });

  test('corromper accessToken mid-troca-de-entidade força logout e redirect para /hub/login', async ({
    page,
  }) => {
    await page.goto('/hub/dashboard');

    const combobox = page.getByRole('combobox', { name: 'Trocar entidade de trabalho' });
    await expect(combobox).toBeVisible();

    // Sessão "expira" — corrompe o accessToken DEPOIS do login, ANTES de
    // disparar a ação (mid-action: a ação em si é o gatilho da detecção).
    const url = new URL(page.url());
    const cookieCorrompido = (name: string) => ({
      // Cookies do HUB — desde 2026-08-04 têm nome próprio, para não colidir
      // com os do painel legado no mesmo domínio.
      name,
      value: 'e2e-teste-token-corrompido-sessao-expirada',
      domain: url.hostname,
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'Strict' as const,
    });
    await page.context().addCookies([
      cookieCorrompido('hub_accessToken'),
      // Sem este, o proxy renova a sessão e a ação tem sucesso — ver o aviso
      // no cabeçalho do arquivo.
      cookieCorrompido('hub_refreshToken'),
    ]);

    // Ação em andamento: troca de entidade -> POST /api/v1/me/entidade com
    // accessToken inválido -> 401 NAO_AUTENTICADO -> authenticatedFetch()
    // limpa `me` imediatamente -> HubSessionGuard redireciona.
    await combobox.click();
    await page.getByRole('option').last().click();

    await page.waitForURL('**/hub/login', { timeout: 10_000 });
    await expect(page).toHaveURL(/\/hub\/login$/);

    // Não deve haver "flash" de conteúdo protegido residual (session-guard
    // retorna null enquanto `semSessao` é true) — o formulário de login,
    // não o dashboard, é o que fica visível.
    await expect(page.getByRole('button', { name: 'Entrar' })).toBeVisible();
    await expect(combobox).not.toBeVisible();
  });

  // Contraprova do teste acima, e o motivo dele ter passado a falhar em
  // 2026-09-20: com o REFRESH ainda válido, access morto NÃO é sessão
  // expirada — o proxy renova (hub-sessao-inatividade) e a ação segue. Sem
  // esta asserção, alguém pode "consertar" a renovação de volta ao
  // comportamento antigo (expulsar a cada access vencido, derrotando a
  // inatividade de 6 h) e o teste de cima continuaria verde do mesmo jeito.
  test('accessToken morto com refresh válido RENOVA a sessão — não expulsa', async ({ page }) => {
    await page.goto('/hub/dashboard');

    const combobox = page.getByRole('combobox', { name: 'Trocar entidade de trabalho' });
    await expect(combobox).toBeVisible();

    const url = new URL(page.url());
    await page.context().addCookies([
      {
        name: 'hub_accessToken',
        value: 'e2e-teste-token-corrompido-mas-refresh-vivo',
        domain: url.hostname,
        path: '/',
        httpOnly: true,
        secure: true,
        sameSite: 'Strict',
      },
    ]);

    // A prova positiva é a RESPOSTA da ação: sem esperar por ela, um
    // `not.toHaveURL` passaria de imediato — antes de o redirect ter chance
    // de acontecer — e o teste estaria oco.
    const resposta = page.waitForResponse(
      (r) => r.url().includes('/me/entidade') && r.request().method() === 'POST',
      { timeout: 15_000 },
    );
    await combobox.click();
    await page.getByRole('option').last().click();
    expect((await resposta).status()).toBe(200);

    // E só então: continua autenticado, nada de /hub/login, shell de pé.
    await expect(page).not.toHaveURL(/\/hub\/login/);
    await expect(combobox).toBeVisible();
    await expect(page.getByRole('button', { name: 'Entrar' })).toHaveCount(0);
  });
});

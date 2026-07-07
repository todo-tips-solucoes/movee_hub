// hub-shell (S3) FASE 6.2.5 — sessão expira EM MEIO a uma ação (troca de
// entidade) -> redirect para /hub/login, sem "vazar" a tela protegida
// (CHK017, contexts/hub-auth-context.tsx `authenticatedFetch` +
// components/hub/session-guard.tsx).
//
// Simulação (dec desta onda — ver Decisão registrada no state.json):
// corromper o cookie `accessToken` DEPOIS do login (mid-action), em vez de
// esperar os 15min reais de TTL (routes/hub-me.js `ACCESS_TOKEN_TTL`) ou
// derrubar a sessão via SQL (SessaoRefresh.expira_em) — o accessToken JWT é
// verificado só por assinatura/expiry (routes/hub-me.js
// `decodificarAccessToken`), NUNCA contra a tabela SessaoRefresh por
// requisição; revogar a sessão no banco não invalidaria um accessToken
// ainda-válido. Corromper o cookie é a forma determinística e imediata de
// forçar o próximo `hubFetch` a receber 401 — o mesmo efeito observável de
// uma sessão que expirou, sem esperar tempo real (mesmo espírito do padrão
// de manipulação direta de estado de `infra/hub/testes/hub-e2e-homolog.sh`
// 6.3.3, que ajusta `bloqueado_ate` no banco em vez de esperar).
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
    await page.context().addCookies([
      {
        name: 'accessToken',
        value: 'e2e-teste-token-corrompido-sessao-expirada',
        domain: url.hostname,
        path: '/',
        httpOnly: true,
        secure: true,
        sameSite: 'Strict',
      },
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
});

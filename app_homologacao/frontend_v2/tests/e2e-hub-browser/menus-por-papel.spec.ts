// hub-shell (S3) FASE 6.2.1 — 2 papéis distintos autenticam e veem
// CONJUNTOS DIFERENTES de itens em `ModuleNav` (components/hub/module-nav.tsx),
// 100% data-driven a partir de `GET /me` -> `modulos[]` (FR-001/SC-001).
//
// Base fática (migrations/0007_seed_papeis_permissoes_modulos.sql):
//   - admin_entidade: todas as permissões exceto `admin.gerenciar` -> vê
//     8 módulos, incluindo `usuarios` e `auditoria` (o módulo `admin` fica
//     de fora porque sua única permissão, admin.gerenciar, é exclusiva de
//     admin_plataforma).
//   - operador: subconjunto operacional (dashboard/motoristas/faturamento/
//     performance/importacoes/envio_massa) -> 6 módulos, SEM `usuarios` nem
//     `auditoria`.
// Contraprova de API já coberta por infra/hub/testes/hub-shell-e2e-homolog.sh
// (6.2.2, GET /api/v1/auditoria: operador=403, admin_entidade=200). Este
// spec cobre a camada de DOM (o item nem aparece no menu para o operador).
//
// Sessões vêm de `storageState` gravado 1x por papel em `global-setup.ts` —
// nada de login via UI aqui (achado desta onda: repetir login por teste
// esgota o rate limiter de `/auth/login`, IP+email compartilhados por toda
// a suíte, ver comentário em global-setup.ts). `page.goto('/hub/dashboard')`
// direto já chega autenticado, com o ModuleNav renderizado.
import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { ADMIN_STATE, OPERADOR_STATE } from './global-setup';

const NAV = 'nav[aria-label="Navegação de módulos"]';
const ITENS_EXCLUSIVOS_ADMIN = ['Gestão de Usuários', 'Auditoria'];
// 6.5.1 — prints por papel (evidência). Grava DENTRO de `__dirname` (o único
// caminho que o container Playwright enxerga — só `frontend_v2` é bind-
// mounted, não o repo inteiro); o driver shell
// (`infra/hub/testes/hub-shell-e2e-browser.sh`) copia daqui para
// `docs/plans/hub-frota/evidencias/S3/` DEPOIS do container encerrar, com
// acesso ao repo completo. Grava fora de `test-results/` (que só existe em
// falha) para ficar disponível mesmo em execução 100% verde.
const EVID_DIR = path.join(__dirname, '.evidencias');
fs.mkdirSync(EVID_DIR, { recursive: true });

test.describe('6.2.1 — ModuleNav difere por papel (FR-001/SC-001)', () => {
  test.describe('admin_entidade', () => {
    test.use({ storageState: ADMIN_STATE });

    test('vê os itens exclusivos (usuários + auditoria)', async ({ page }) => {
      await page.goto('/hub/dashboard');
      const nav = page.locator(NAV).first();
      await expect(nav).toBeVisible();
      const itens = (await nav.locator('a').allTextContents()).map((t) => t.trim());

      expect(itens).toEqual(expect.arrayContaining(ITENS_EXCLUSIVOS_ADMIN));
      expect(itens.length).toBeGreaterThanOrEqual(8); // 8 módulos (todas permissões exceto admin.gerenciar)

      await page.screenshot({ path: path.join(EVID_DIR, '6.5.1-modulenav-admin_entidade.png') });
    });
  });

  test.describe('operador', () => {
    test.use({ storageState: OPERADOR_STATE });

    test('NÃO vê nenhum dos itens exclusivos (sem auditoria.consultar/usuarios.gerenciar)', async ({
      page,
    }) => {
      await page.goto('/hub/dashboard');
      const nav = page.locator(NAV).first();
      await expect(nav).toBeVisible();
      const itens = (await nav.locator('a').allTextContents()).map((t) => t.trim());

      for (const exclusivo of ITENS_EXCLUSIVOS_ADMIN) {
        expect(itens).not.toContain(exclusivo);
      }
      // Conjunto realmente menor (SC-001: "conjuntos diferentes de itens") —
      // módulos operacionais vs. os >= 8 do admin_entidade (contraprova acima).
      //
      // Era `toBe(6)` e quebrou quando o PR #85 semeou o módulo `validacao_xml`
      // com permissão de operador (viraram 7) — falha alheia à mudança que a
      // expôs. A contagem exata é do SEED, não da regra sob teste; o que o
      // SC-001 afirma é que o conjunto do operador é ESTRITAMENTE MENOR, e é
      // isso que se assere aqui (mesmo idioma do `toBeGreaterThanOrEqual(8)`
      // da contraprova, que já era robusto a módulo novo).
      expect(itens.length).toBeLessThan(8);
      expect(itens.length).toBeGreaterThan(0);

      await page.screenshot({ path: path.join(EVID_DIR, '6.5.1-modulenav-operador.png') });
    });
  });
});

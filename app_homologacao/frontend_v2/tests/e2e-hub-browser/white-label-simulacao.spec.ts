// hub-uiux-refresh FASE 3 (tasks 3.2.1/3.2.2/3.2.3) — validação de
// white-label no hub SEM depender de uma empresa com Branding configurado
// no hub_homolog_db.
//
// Contexto (block-004/dec-034/dec-037): nenhuma empresa QA do hub tem a
// tabela Branding (ela vive só no legado, feature config-ui-tenant, ainda
// não portada para o hub). Decisão do operador (bloqueio respondido
// 2026-08-05): simular o mecanismo injetando as MESMAS CSS custom
// properties que `TenantThemeProvider.applyBrandingTokens` (frontend_v2
// legado, contexts/tenant-theme-context.tsx) aplicaria — via
// `document.documentElement.style.setProperty` de --primary/--ring/
// --sidebar-primary/--accent/--sidebar-accent — e verificar o reflexo nos
// componentes shadcn/ui do hub em ambos os temas. Não seedar banco, não
// criar mecanismo novo: o hub já consome esses tokens (globals.css) do
// mesmo jeito que o legado — SC-006/US2-AC3 são validados pelo CONTRATO de
// override (se os componentes usam os tokens corretamente, a injeção
// funciona quando o backend do hub vier a expor Branding).
//
// Execução: escrito nesta onda (3.2), executado como parte da suíte
// consolidada de FASE 6 (6.1/6.2) junto com a auditoria de contraste axe —
// mesma convenção usada em 2.1.5.
import AxeBuilder from '@axe-core/playwright';
import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { ADMIN_STATE } from './global-setup';

// Tenant sintético (cores fora da paleta EntreGô default #2C67EA/#2CEABC —
// contraste suficiente em fundo claro E escuro para o axe color-contrast).
const TENANT_SIMULADO = {
  primaria: '#8B2FC9', // roxo
  destaque: '#C97A2F', // laranja queimado
};

// O container Playwright só enxerga `frontend_v2` (bind mount do driver —
// ver comentário em infra/hub/testes/hub-shell-e2e-browser.sh); `docs/plans`
// vive fora do mount e é INALCANÇÁVEL daqui. Escreve dentro de `.evidencias/`
// (visível também no host, já que fica sob o mount) — o driver copia para o
// diretório canônico de evidências depois que o container sai (mesmo padrão
// de EVID_DIR/EVID_SRC do driver do hub-shell). SEM subpasta: o `cp` do
// driver só pega `.evidencias/*.png` (raso, achado desta onda — uma
// subpasta `white-label/` era silenciosamente apagada pelo cleanup sem
// nunca ser copiada) — nomes já vêm prefixados `white-label-` para não
// colidir com as evidências `6.5.1-modulenav-*` do driver do hub-shell.
const SCREENSHOT_DIR = path.join(__dirname, '.evidencias');
const SCREENSHOT_PREFIX = 'white-label-';

/** Mesma conversão hex->oklch de contexts/tenant-theme-context.tsx —
 * duplicada aqui de propósito: o teste simula o CONSUMIDOR (backend/legado
 * injetando tokens), não importa código do app para não mascarar uma
 * eventual quebra da fórmula real. */
function hexToOklchApprox(page: Page, hex: string) {
  return page.evaluate((h) => {
    function hexToRgb(hex: string): [number, number, number] {
      const c = hex.replace('#', '');
      return [
        parseInt(c.slice(0, 2), 16) / 255,
        parseInt(c.slice(2, 4), 16) / 255,
        parseInt(c.slice(4, 6), 16) / 255,
      ];
    }
    function lin(c: number) {
      return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    }
    const [r, g, b] = hexToRgb(h);
    const [rl, gl, bl] = [lin(r), lin(g), lin(b)];
    const l_ = Math.cbrt(0.4122214708 * rl + 0.5363325363 * gl + 0.0514459929 * bl);
    const m_ = Math.cbrt(0.2119034982 * rl + 0.6806995451 * gl + 0.1073969566 * bl);
    const s_ = Math.cbrt(0.0883024619 * rl + 0.2817188376 * gl + 0.6299787005 * bl);
    const L = 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_;
    const a = 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_;
    const bv = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_;
    const C = Math.sqrt(a * a + bv * bv);
    const H = (Math.atan2(bv, a) * 180) / Math.PI;
    return `oklch(${L.toFixed(4)} ${C.toFixed(4)} ${(H < 0 ? H + 360 : H).toFixed(2)})`;
  }, hex);
}

/** Injeta os tokens do tenant simulado — mesmo conjunto de propriedades
 * que `applyBrandingTokens` (TenantThemeProvider) sobrescreve em :root. */
async function injetarBrandingSimulado(page: Page) {
  const primaryOklch = await hexToOklchApprox(page, TENANT_SIMULADO.primaria);
  const accentOklch = await hexToOklchApprox(page, TENANT_SIMULADO.destaque);
  await page.evaluate(
    ({ primaryOklch, accentOklch }) => {
      const root = document.documentElement;
      root.style.setProperty('--primary', primaryOklch);
      root.style.setProperty('--ring', primaryOklch);
      root.style.setProperty('--sidebar-primary', primaryOklch);
      root.style.setProperty('--accent', accentOklch);
      root.style.setProperty('--sidebar-accent', accentOklch);
    },
    { primaryOklch, accentOklch }
  );
}

async function limparBrandingSimulado(page: Page) {
  await page.evaluate(() => {
    const root = document.documentElement;
    for (const prop of ['--primary', '--ring', '--sidebar-primary', '--accent', '--sidebar-accent']) {
      root.style.removeProperty(prop);
    }
  });
}

/** Cor computada (rgb) resolvida para as classes Tailwind que consomem os
 * tokens de branding (`bg-primary`, `bg-sidebar-primary`, `bg-accent`) —
 * via um probe anexado ao DOM real da página (não um elemento isolado
 * fora da árvore), para herdar exatamente a mesma cascata de :root/.dark
 * que qualquer componente da página herdaria. Prova o CONTRATO de
 * override (SC-006): se a classe Tailwind resolve a cor nova, qualquer
 * componente do hub que já usa essa classe (kpi-card, status-badge,
 * module-nav, button variant=default, etc.) refletiria a mesma mudança
 * sem precisar de código novo. */
async function coresDosTokens(page: Page): Promise<{ primary: string; sidebarPrimary: string; accent: string }> {
  return page.evaluate(() => {
    const probes: Record<string, HTMLDivElement> = {
      primary: Object.assign(document.createElement('div'), { className: 'bg-primary' }),
      sidebarPrimary: Object.assign(document.createElement('div'), { className: 'bg-sidebar-primary' }),
      accent: Object.assign(document.createElement('div'), { className: 'bg-accent' }),
    };
    for (const el of Object.values(probes)) {
      el.style.position = 'fixed';
      el.style.top = '-9999px';
      document.body.appendChild(el);
    }
    const cores = {
      primary: getComputedStyle(probes.primary).backgroundColor,
      sidebarPrimary: getComputedStyle(probes.sidebarPrimary).backgroundColor,
      accent: getComputedStyle(probes.accent).backgroundColor,
    };
    for (const el of Object.values(probes)) el.remove();
    return cores;
  });
}

test.describe('3.2 — validação de white-label simulado (SC-006/US2-AC3, sem seed de banco)', () => {
  test.use({ storageState: ADMIN_STATE, viewport: { width: 1280, height: 800 } });

  for (const tema of ['dark', 'light'] as const) {
    test(`tema ${tema}: injetar CSS vars do tenant simulado reflete em botão primário/sidebar ativa`, async ({
      page,
    }) => {
      await page.goto('/hub/dashboard');

      // Garante o tema alvo do cenário (default é dark — FR-008).
      const html = page.locator('html');
      if (tema === 'light') {
        await page.getByRole('button', { name: 'Alternar tema' }).click();
        await expect(html).not.toHaveClass(/dark/);
      } else {
        await expect(html).toHaveClass(/dark/);
      }

      fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

      // "Antes" — cores default (EntreGô).
      const antes = await coresDosTokens(page);
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, `${SCREENSHOT_PREFIX}antes-${tema}.png`), fullPage: false });

      // Simula a injeção do branding do tenant (mecanismo do
      // TenantThemeProvider legado, mesmas 5 custom properties).
      await injetarBrandingSimulado(page);

      const depois = await coresDosTokens(page);
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, `${SCREENSHOT_PREFIX}depois-${tema}.png`), fullPage: false });

      // Reflexo real: as 3 classes Tailwind resolveram cor NOVA após a
      // injeção — os componentes consomem os tokens (não hex hardcoded),
      // em AMBOS os temas. Zero hex hardcoded é gotcha conhecido do hub.
      expect(depois.primary, 'bg-primary não refletiu a injeção').not.toBe(antes.primary);
      expect(depois.sidebarPrimary, 'bg-sidebar-primary não refletiu a injeção').not.toBe(antes.sidebarPrimary);
      expect(depois.accent, 'bg-accent não refletiu a injeção').not.toBe(antes.accent);

      // Contraste WCAG AA (1.3.1/SC-003) com a cor do tenant simulado:
      // reusa o mesmo axe-core já usado em 6.1, filtrado à regra
      // color-contrast — não reinventa fórmula de contraste aqui.
      const resultado = await new AxeBuilder({ page }).withRules(['color-contrast']).analyze();
      expect(
        resultado.violations,
        `contraste WCAG AA com tenant simulado (${tema}): ${JSON.stringify(resultado.violations)}`
      ).toEqual([]);

      await limparBrandingSimulado(page);
    });
  }
});

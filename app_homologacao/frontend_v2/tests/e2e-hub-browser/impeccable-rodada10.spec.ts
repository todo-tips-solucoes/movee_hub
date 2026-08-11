// impeccable rodada 10 — A7 da crítica medida: a matriz papel×permissão
// exibia código cru (`usuarios.gerenciar`) a quem concede acesso.
//
// O que estes casos protegem é o oposto de "tem tal texto na tela": é que a
// tradução aconteça para TODAS as permissões que o backend devolver, hoje e
// depois da próxima migration. Um rótulo faltando aparece como código cru na
// coluna — e é exatamente isso que o primeiro caso procura.
import { test, expect } from '@playwright/test';
import { ADMIN_STATE } from './global-setup';

test.describe('impeccable rodada 10 — permissões em português', () => {
  test.use({ storageState: ADMIN_STATE, viewport: { width: 1280, height: 800 } });

  test.beforeEach(async ({ page }) => {
    await page.goto('/hub/dashboard/usuarios/papeis');
    await page.waitForLoadState('networkidle');
  });

  test('nenhuma permissão chega ao usuário sem rótulo legível', async ({ page }) => {
    // A primeira célula de cada linha traz "<rótulo> [alto impacto] <codigo>".
    // Se a tradução falhar, o rótulo É o código e o texto começa com ele.
    const semRotulo = await page.evaluate(() => {
      const linhas = [...document.querySelectorAll('tbody tr')];
      const ruins: string[] = [];
      for (const tr of linhas) {
        const primeira = tr.querySelector('td');
        if (!primeira) continue; // linha de cabeçalho de grupo
        const rotulo = primeira.querySelector('span')?.textContent?.trim() ?? '';
        if (/^[a-z_]+\.[a-z_]+$/.test(rotulo)) ruins.push(rotulo);
      }
      return ruins;
    });
    expect(semRotulo, `permissões ainda em código cru: ${semRotulo.join(', ')}`).toEqual([]);
  });

  test('o código técnico continua visível para suporte e auditoria', async ({ page }) => {
    const corpo = await page.locator('tbody').innerText();
    expect(corpo).toContain('usuarios.gerenciar');
    expect(corpo).toContain('motoristas.credencial');
  });

  test('o consultar ambíguo é traduzido conforme o módulo tenha lista ou não', async ({ page }) => {
    const corpo = await page.locator('tbody').innerText();
    // motoristas TEM listar -> "Ver detalhes"; auditoria NÃO tem -> "Acessar o módulo".
    const linhaMotoristas = await page
      .locator('tbody tr', { hasText: 'motoristas.consultar' })
      .innerText();
    expect(linhaMotoristas).toContain('Ver detalhes');

    const linhaAuditoria = await page
      .locator('tbody tr', { hasText: 'auditoria.consultar' })
      .innerText();
    expect(linhaAuditoria).toContain('Acessar o módulo');

    expect(corpo).toContain('Ver a lista');
  });

  test('as permissões de alto impacto são marcadas, e as comuns não', async ({ page }) => {
    const gerenciar = await page
      .locator('tbody tr', { hasText: 'usuarios.gerenciar' })
      .innerText();
    expect(gerenciar).toContain('alto impacto');
    expect(gerenciar).toContain('Administrar tudo do módulo');

    const listar = await page.locator('tbody tr', { hasText: 'motoristas.listar' }).innerText();
    expect(listar).not.toContain('alto impacto');
  });

  test('as linhas vêm agrupadas por módulo, na ordem da navegação', async ({ page }) => {
    // Os cabeçalhos de grupo são <th> dentro do corpo da tabela. A comparação
    // ignora a caixa: o texto vem do banco em caixa mista e o `uppercase` é
    // decisão de estilo — travar a caixa aqui prenderia o CSS ao teste.
    const grupos = (await page.locator('tbody th').allInnerTexts()).map((t) =>
      t.trim().toLocaleLowerCase('pt-BR')
    );
    expect(grupos.length).toBeGreaterThan(1);
    expect(grupos).toContain('motoristas');
    expect(grupos).toContain('gestão de usuários');
    // A ordem é a do /me: Motoristas (20) antes de Gestão de Usuários (70).
    expect(grupos.indexOf('motoristas')).toBeLessThan(grupos.indexOf('gestão de usuários'));
  });

  test('toda permissão continua na tela — agrupar não pode esconder linha', async ({ page }) => {
    const checkboxes = await page.locator('[role="checkbox"]').count();
    const linhas = await page.locator('tbody tr td:first-child').count();
    const papeis = await page.locator('thead th').count();
    // 1ª coluna do cabeçalho é "Permissão"; as demais são papéis.
    expect(checkboxes).toBe(linhas * (papeis - 1));
  });
});

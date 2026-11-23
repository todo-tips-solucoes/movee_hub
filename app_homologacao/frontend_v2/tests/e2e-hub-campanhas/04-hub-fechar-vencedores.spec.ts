// Fase 4 (e): campanha FECHADA (o driver injetou o dado do último dia e rodou recalcular_ativas).
// O hub mostra os vencedores; registra a entrega do objeto; baixa a planilha de prêmios em dinheiro
// (o driver confere cabeçalho = CABECALHO_ESPERADO e a linha de cada vencedor) e o CSV do ranking.
import { test, expect } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { HUB, NOME_CAMPANHA, campanhaIdPorNome, env, loginHub } from './_comum';

test('e) vencedores, entrega do objeto e planilha de prêmios em dinheiro', async ({ page }) => {
  await loginHub(page, env('CAMP_ADMIN_EMAIL'), env('CAMP_ADMIN_SENHA'));
  const id = await campanhaIdPorNome(page, NOME_CAMPANHA);
  await page.goto(`${HUB}/hub/dashboard/campanhas/${id}`);
  await expect(page.getByRole('heading', { level: 1, name: NOME_CAMPANHA })).toBeVisible();
  await expect(page.getByText('Encerrada').first()).toBeVisible();
  await expect(page.getByText(/resultado final congelado em/)).toBeVisible();

  const vencedores = page.getByRole('region', { name: 'Vencedores' });
  const linhas = vencedores.locator('tbody tr');
  await expect(linhas).toHaveCount(3);
  await expect(linhas.nth(0)).toContainText('Aline Ribeiro Santos');
  await expect(linhas.nth(0)).toContainText('Bag térmica Movee');
  await expect(linhas.nth(0)).toContainText('Pendente');
  await expect(linhas.nth(1)).toContainText('Bruno Teixeira Souza');
  await expect(linhas.nth(1)).toContainText('R$ 100 no repasse');
  await expect(linhas.nth(1)).toContainText('Aguardando a planilha');
  await expect(linhas.nth(2)).toContainText('Carla Dias Moreira');
  await expect(linhas.nth(2)).toContainText('Aguardando a planilha');
  // KPI "Prêmios a entregar" = 3 (1 objeto + 2 dinheiro)
  await expect(page.locator('[data-slot="card"]', { hasText: 'Prêmios a entregar' })).toContainText('3');

  // registrar a entrega do objeto (só o objeto tem o botão)
  await expect(vencedores.getByRole('button', { name: /Marcar como entregue/ })).toHaveCount(1);
  await vencedores.getByRole('button', { name: /Marcar como entregue/ }).click();
  const dlg = page.getByRole('dialog');
  await expect(dlg.getByText('Marcar como entregue')).toBeVisible();
  await dlg.getByLabel(/Observação/).fill('Retirado na base, recibo E2E');
  await dlg.getByRole('button', { name: 'Registrar entrega' }).click();
  await expect(dlg).toBeHidden();
  await expect(linhas.nth(0)).toContainText(/Entregue/);
  await expect(linhas.nth(0)).toContainText('Retirado na base, recibo E2E');
  await expect(vencedores.getByRole('button', { name: /Marcar como entregue/ })).toHaveCount(0);

  // planilha de prêmios em dinheiro (o download é a UI real; o driver abre o arquivo)
  // errata W5 A1/A2: a planilha é POST (carimba exportado_em) e informa X-Premios-Adiados
  const respXlsx = page.waitForResponse((r) => r.url().includes('/premios-dinheiro.xlsx'));
  const [dlXlsx] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Baixar planilha de prêmios em dinheiro' }).click(),
  ]);
  const rx = await respXlsx;
  expect(rx.request().method()).toBe('POST');
  expect(rx.headers()['x-premios-adiados']).toBe('0');
  expect(dlXlsx.suggestedFilename()).toBe(`premios-campanha-${id}.xlsx`);
  // O blob é revogado logo após o clique (padrão do repo); no Chromium headless o artefato do download
  // pode sumir antes do saveAs. Se sumir, anota a falha e pega os MESMOS bytes pelo POST idempotente
  // (errata A1: o download repetido reproduz as mesmas linhas e datas).
  try {
    await dlXlsx.saveAs('/dl/premios.xlsx');
  } catch (e) {
    test.info().annotations.push({ type: 'download-artefato-ausente', description: `${await dlXlsx.failure()} / ${String(e).slice(0, 120)}` });
    const b64 = await page.evaluate(async (cid) => {
      const r = await fetch(`/api/v1/hub/campanhas/${cid}/premios-dinheiro.xlsx`, { method: 'POST', credentials: 'include' });
      const buf = new Uint8Array(await r.arrayBuffer());
      let bin = '';
      for (const b of buf) bin += String.fromCharCode(b);
      return btoa(bin);
    }, id);
    writeFileSync('/dl/premios.xlsx', Buffer.from(b64, 'base64'));
  }
  // Sem reload, de propósito: a tabela precisa refletir o carimbo logo após o download
  // (defeito achado no E2E W4 e corrigido com a key de VencedoresSecao).
  await expect(linhas.nth(1)).toContainText('Na planilha de');
  await expect(linhas.nth(2)).toContainText('Na planilha de');

  // CSV do ranking (lib/hub-csv.js)
  const [dlCsv] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Exportar CSV' }).click(),
  ]);
  try {
    await dlCsv.saveAs('/dl/ranking.csv');
  } catch (e) {
    test.info().annotations.push({ type: 'download-artefato-ausente', description: `csv: ${await dlCsv.failure()}` });
    const txt = await page.evaluate(async (cid) => (await fetch(`/api/v1/hub/campanhas/${cid}/ranking.csv`, { credentials: 'include' })).text(), id);
    writeFileSync('/dl/ranking.csv', txt);
  }
});

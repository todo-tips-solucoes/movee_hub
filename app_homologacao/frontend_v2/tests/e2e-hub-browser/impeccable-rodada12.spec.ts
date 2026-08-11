// impeccable rodada 12 (P1) — o alvo de toque dos checkboxes, medido pelo que
// RESPONDE ao dedo.
//
// Substitui o caso A2 da rodada 9 (removido de `impeccable-rodada9.spec.ts`
// nesta mesma entrega). Aquele media `(c.parentElement ?? c)
// .getBoundingClientRect()` — ou seja, o `<span>` de 44x44 que a própria r9
// tinha acabado de adicionar. Um `<span>` sem handler não é clicável: ele
// reserva espaço, não recebe ativação. O teste passou verde sobre um defeito
// intacto.
//
// A sonda daqui não pergunta "que tamanho tem o ancestral". Ela VARRE o
// entorno do controle pixel a pixel perguntando, em cada ponto, quem responde
// ao toque ali (`document.elementFromPoint`) — e devolve a extensão real da
// área que ativa o controle. O resultado é um número (40x32, 44x44), não um
// booleano: é o número que distingue "corrigido" de "parece corrigido".
import { test, expect, type Page } from '@playwright/test';
import { ADMIN_STATE } from './global-setup';

const MINIMO = 44;
const LIMITE = 30; // até onde varrer a partir do centro, em px

type Medida = { rotulo: string; largura: number; altura: number };

/**
 * Extensão real da área tocável de cada checkbox visível: a partir do centro,
 * anda para os 4 lados enquanto `elementFromPoint` devolver o próprio controle
 * (ou algo dentro dele, ou o <label> que o rotula) e para no primeiro ponto
 * que não responde. `medidos` existe para que "nenhum alvo pequeno" nunca
 * signifique "nenhum alvo medido" — a forma mais silenciosa de aprovar por
 * vacuidade.
 */
async function medirAlvos(page: Page) {
  return page.evaluate((LIM) => {
    const medidas: Medida[] = [];

    const caixas = [...document.querySelectorAll('[role="checkbox"]')]
      // O envio em massa renderiza DUAS árvores (cards no mobile, tabela no
      // desktop) e esconde uma por CSS; a escondida não tem client rect.
      .filter((c) => c.getClientRects().length > 0)
      .slice(0, 12); // amostra: a matriz tem 132 e cada um exige um scroll

    for (const c of caixas) {
      // A matriz rola na horizontal a 390px: sem centralizar, o alvo cai fora
      // da viewport e `elementFromPoint` devolveria null para todos.
      c.scrollIntoView({ block: 'center', inline: 'center' });
      const r = c.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;

      const responde = (x: number, y: number) => {
        const alvo = document.elementFromPoint(x, y);
        if (!alvo) return false;
        const eLabelDoControle = alvo instanceof HTMLLabelElement && alvo.contains(c);
        return alvo === c || c.contains(alvo) || eLabelDoControle;
      };
      // Alcance num sentido, em coordenadas CONTÍNUAS: uma varredura de 1px
      // erra por até 2px na soma dos dois lados (o centro do controle cai em
      // coordenada fracionária) e reprovaria um alvo de 44px legítimo — falso
      // positivo tem o mesmo custo de um falso negativo aqui.
      const alcance = (dx: number, dy: number) => {
        let lo = 0;
        let hi = LIM;
        while (hi - lo > 0.05) {
          const meio = (lo + hi) / 2;
          if (responde(cx + dx * meio, cy + dy * meio)) lo = meio;
          else hi = meio;
        }
        return lo;
      };
      const arred = (n: number) => Math.round(n * 10) / 10;

      if (!responde(cx, cy)) continue; // fora da viewport ou coberto: não mede
      medidas.push({
        rotulo: c.getAttribute('aria-label') || c.getAttribute('id') || '(sem nome)',
        largura: arred(alcance(-1, 0) + alcance(1, 0)),
        altura: arred(alcance(0, -1) + alcance(0, 1)),
      });
    }
    return medidas;
  }, LIMITE);
}

// Math.round absorve o resíduo da busca binária (0,05px), não uma folga de
// projeto: 43,4px continua reprovando.
const pequenos = (medidas: Medida[]) =>
  medidas.filter((m) => Math.round(m.largura) < MINIMO || Math.round(m.altura) < MINIMO);

// A lista do movimento vem vazia no ambiente de teste; sem linhas não há
// checkbox de disparo para medir. Mesmo mock da r8, reduzido ao necessário.
const LINHAS = [
  { id: 1, number: '001', nome: 'Motorista Alfa', enviado: 'ok' },
  { id: 2, number: '002', nome: 'Motorista Beta', enviado: 'erro' },
  { id: 3, number: '003', nome: 'Motorista Gama', enviado: 'off' },
].map((base) => ({
  ...base,
  valor: 100,
  cnpj_tomador: '00000000000191',
  cnpj_prestador: '00000000000272',
  mensagem1: '',
  mensagem2: '',
  retorno_envio_msg_1: null,
  retorno_envio_msg_2: null,
  tribnac: null,
  dCompet: null,
  numnota: null,
  nota_ok: null,
  data_emissao: null,
  erro_validacao: null,
  uuid: null,
  dt_inicial: '2026-08-01',
  dt_final: '2026-08-07',
  id_empresa: 1,
  created_at: '2026-08-07T00:00:00.000Z',
  mov_fechado: false,
}));

async function mockarMovimento(page: Page) {
  await page.route('**/api/envio-massa*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(LINHAS) })
  );
  await page.route('**/api/process-status*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"active":false}' })
  );
}

test.describe('impeccable rodada 12 — alvo de toque real a 390px', () => {
  test.use({ storageState: ADMIN_STATE, viewport: { width: 390, height: 844 } });

  test('a matriz de papéis responde ao toque nos 44px que aparenta ter', async ({ page }) => {
    await page.goto('/hub/dashboard/usuarios/papeis');
    await page.waitForLoadState('networkidle');
    await expect(page.locator('[role="checkbox"]:visible').first()).toBeVisible();

    const medidas = await medirAlvos(page);
    expect(medidas.length, 'nenhum checkbox medido — a sonda não viu a matriz').toBeGreaterThan(5);
    expect(
      pequenos(medidas),
      `alvos abaixo de ${MINIMO}px: ${JSON.stringify(pequenos(medidas).slice(0, 4))}`
    ).toEqual([]);
  });

  test('os checkboxes de disparo respondem ao toque nos 44px que aparentam ter', async ({ page }) => {
    // Mesmo padrão de `<span>` não clicável, no data-table, desde a r8 — e
    // aqui a caixa decide para quem a mensagem vai.
    await mockarMovimento(page);
    await page.goto('/hub/dashboard/envio_massa');
    await page.waitForLoadState('networkidle');
    await expect(page.locator('[role="checkbox"]:visible').first()).toBeVisible();

    const medidas = await medirAlvos(page);
    expect(medidas.length, 'nenhum checkbox medido — a sonda não viu a lista').toBeGreaterThan(1);
    expect(
      pequenos(medidas),
      `alvos abaixo de ${MINIMO}px: ${JSON.stringify(pequenos(medidas).slice(0, 4))}`
    ).toEqual([]);
  });

  test('a sonda mede o alvo pequeno quando ele existe (contraprova)', async ({ page }) => {
    // Sem esta contraprova, "nenhum alvo pequeno" não distingue produto
    // correto de sonda cega — o defeito exato que esta rodada conserta.
    await mockarMovimento(page);
    await page.goto('/hub/dashboard/envio_massa');
    await page.waitForLoadState('networkidle');
    await expect(page.locator('[role="checkbox"]:visible').first()).toBeVisible();

    await page.addStyleTag({ content: '[role="checkbox"]::after { inset: 0 !important; }' });
    const medidas = await medirAlvos(page);
    expect(medidas.length).toBeGreaterThan(1);
    // Sem o `after:` estendido sobra a caixa de 16px — a sonda tem de vê-la.
    expect(
      pequenos(medidas).length,
      `a sonda aprovou alvos de 16px: ${JSON.stringify(medidas.slice(0, 4))}`
    ).toBe(medidas.length);
  });
});

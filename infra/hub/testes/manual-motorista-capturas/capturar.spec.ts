// Capturas de tela do app motorista para o manual de uso. Dados 100% fictícios,
// /api/** stubado (mesmo contrato de adiantamento.spec.ts). Não é teste de regressão.
import { test, expect, type Page } from '@playwright/test';

const BASE = process.env.MOTORISTA_E2E_BASE_URL || 'http://127.0.0.1:3006';
const OUT = process.env.CAPTURA_OUT || '/out';
const CNPJ = '12345678000190';
const NOME = 'João da Silva';

test.use({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  colorScheme: 'light',
  locale: 'pt-BR',
  timezoneId: 'America/Sao_Paulo',
});

const conta = {
  id: 1, status: 'APROVADA', banco: '341 · Itaú', agencia: '1234', contaMascarada: '****5-6',
  tipoConta: 'CORRENTE', titularNome: 'João da Silva ME', documentoMascarado: '12.345.678/****-90',
  chavePixTipo: null, emailComprovante: null, solicitadaEm: '2026-09-20T10:00:00Z', motivoRejeicao: null,
};
const movimento = {
  id: 4101, valor: '1247.80', gorjeta: '82.50', dtInicial: '2026-10-05', dtFinal: '2026-10-11',
  nome: 'Transportes Exemplo Ltda', cnpjTomador: '98765432000110', cnpjPrestador: CNPJ,
  tribnac: '16.01.01', notaOk: null, erroValidacao: null,
  tomador: { razaoSocial: 'Transportes Exemplo Ltda', endereco: 'Rua das Acácias', numero: '500', cep: '01310-100', email: 'fiscal@exemplo.com.br', observacao: null },
};
const notasPendentes = [
  { id: 1, criadoEm: '2026-10-06T12:00:00Z', valor: '1247.80', dtInicial: '2026-09-28', dtFinal: '2026-10-04', cnpjTomador: '98765432000110', tomador: 'Transportes Exemplo Ltda', origem: 'MOVIMENTO' },
  { id: 2, criadoEm: '2026-09-29T12:00:00Z', valor: '860.40', dtInicial: '2026-09-21', dtFinal: '2026-09-27', cnpjTomador: '98765432000110', tomador: 'Transportes Exemplo Ltda', origem: 'MOVIMENTO' },
];
const disp = {
  canRequest: true, reason: null, requestDate: '2026-10-12', productionDate: '2026-10-11', timezone: 'America/Sao_Paulo',
  openingTime: '06:00', cutoffTime: '11:00', enabledDays: [1, 2, 3, 4, 5], percentage: 80, fee: '5.00',
  paymentForecast: '2026-10-13', nextAvailableAt: null,
  estimate: { available: true, production: '1247.80', gross: '998.24', fee: '5.00', net: '993.24', eligible: true, final: false },
  bankAccount: { status: 'APROVADA', bank: '341 · Itaú', masked: 'Ag. 1234 · CC ****5-6' },
  todayRequest: null, configVersion: 3, configuracaoId: 3,
};
const notificacoes = [
  { id: 1, categoria: 'adiantamento', titulo: 'Adiantamento liberado', corpo: 'Seu adiantamento de hoje foi liberado.', link: '/adiantamento/501', criadaEm: '2026-10-11T12:00:00Z', lida: false },
  { id: 2, categoria: 'conta_bancaria', titulo: 'Conta aprovada', corpo: 'Seus dados bancários foram aprovados.', link: '/conta-bancaria', criadaEm: '2026-10-09T09:00:00Z', lida: false },
  { id: 3, categoria: 'sistema', titulo: 'Manutenção programada', corpo: 'O sistema ficará indisponível às 22h.', link: null, criadaEm: '2026-10-07T08:00:00Z', lida: true },
];

type S = { auth: boolean; notas: unknown[]; validacao: unknown };

async function setup(page: Page, s: S) {
  await page.route('**/*', async (route) => {
    const u = route.request().url();
    if (u.startsWith(BASE) || /^https:\/\/fonts\.(googleapis|gstatic)\.com\//.test(u)) return route.continue(); // fonte de ícones (Material Symbols)
    return route.abort();
  });
  await page.route('**/api/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname.replace(/^\/api/, '');
    const m = req.method();
    const json = (b: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(b) });
    const nc = () => route.fulfill({ status: 204, body: '' });
    if (path === '/motorista/verify-auth') return json(s.auth ? { authenticated: true, cnpjPrestador: CNPJ, nome: NOME } : { authenticated: false });
    if (path === '/motorista/token/refresh') return json({});
    if (path === '/motorista/movimento-aberto') return json({ movimento });
    if (path === '/motorista/adiantamento/disponibilidade') return json(disp);
    if (path === '/motorista/adiantamento/regras') return json({ configVersion: 3, configuracaoId: 3, texto: '', itens: [], aceiteSha256: 'a'.repeat(64) });
    if (path === '/motorista/notas-pendentes') return json({ notas: s.notas });
    if (path === '/motorista/validar-nota' && m === 'POST') return json(s.validacao);
    if (path === '/motorista/conta-bancaria') return json({ aprovada: conta, pendente: null, ultimaRejeicao: null });
    if (path === '/motorista/bancos') return json({ itens: [{ codigo: '341', nome: 'Itaú Unibanco' }, { codigo: '001', nome: 'Banco do Brasil' }, { codigo: '260', nome: 'Nu Pagamentos' }] });
    if (path === '/motorista/notificacoes') return json({ itens: notificacoes, total: 3, pagina: 1, porPagina: 20 });
    if (path === '/motorista/notificacoes/nao-lidas') return json({ total: 2 });
    if (path === '/motorista/push/chave-publica') return json({ chavePublica: 'A'.repeat(43), keyId: 'stub' });
    if (path.startsWith('/motorista/push/')) return nc();
    return json({ erro: 'NAO_DISPONIVEL' }, 404);
  });
  await page.addInitScript(() => {
    class N { static permission = 'granted'; static requestPermission() { return Promise.resolve('default'); } }
    Object.defineProperty(window, 'Notification', { value: N, configurable: true, writable: true });
    const sub = { endpoint: 'https://fake-push.example.test/e/stub', toJSON() { return { endpoint: this.endpoint, keys: { p256dh: 'x', auth: 'y' } }; }, unsubscribe: async () => true };
    const reg = Object.assign(new EventTarget(), { pushManager: { getSubscription: async () => sub, subscribe: async () => sub }, update: async () => undefined });
    Object.defineProperty(navigator, 'serviceWorker', { value: Object.assign(new EventTarget(), { ready: Promise.resolve(reg), getRegistration: async () => reg, register: async () => reg, controller: null }), configurable: true });
    try { localStorage.setItem('theme', 'light'); } catch { /* */ }
  });
}

async function limpa(page: Page) {
  await page.addStyleTag({ content: '[data-sonner-toaster]{display:none!important} *{caret-color:transparent!important}' });
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.mouse.move(0, 0);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(1800); // CountUp / animações de entrada
}
// Selo "EXEMPLO / dados fictícios" gravado no pixel (elemento fixo, abaixo do cabeçalho z-20).
// Posição por tela, para nunca cobrir o conteúdo que a imagem existe para mostrar.
const POS_SELO: Record<string, string> = {
  '02-inicio': 'top:80px;right:16px', '04-card-pendentes': 'top:80px;right:16px',
  '10-conta-form': 'top:78px;right:16px',
};
async function foto(page: Page, nome: string, fullPage = false) {
  await limpa(page);
  await page.evaluate(([pos]) => {
    document.querySelectorAll('[data-selo-exemplo]').forEach((e) => e.remove());
    const d = document.createElement('div');
    d.setAttribute('data-selo-exemplo', '');
    d.style.cssText = `position:fixed;${pos};z-index:10;padding:4px 12px;border-radius:10px;text-align:center;pointer-events:none;background:rgba(190,24,93,.82);color:#fff;font:800 13px/1.1 sans-serif;letter-spacing:.14em;box-shadow:0 2px 8px rgba(0,0,0,.2)`;
    d.innerHTML = 'EXEMPLO<div style="font:600 9px/1.3 sans-serif;letter-spacing:.04em;opacity:.95">dados fictícios</div>';
    document.body.appendChild(d);
  }, [POS_SELO[nome] ?? 'bottom:86px;right:16px']);
  await page.screenshot({ path: `${OUT}/${nome}.png`, fullPage, animations: 'disabled' });
}
const novo = (over: Partial<S> = {}): S => ({ auth: true, notas: [], validacao: {}, ...over });

test('01 login', async ({ page }) => {
  await setup(page, novo({ auth: false }));
  await page.goto(`${BASE}/login`);
  await expect(page.getByText('Esqueci minha senha')).toBeVisible();
  await foto(page, '01-login');
});

test('02/03 início e dados fiscais', async ({ page }) => {
  await setup(page, novo());
  await page.goto(`${BASE}/movimento`);
  await expect(page.getByText('Total produzido')).toBeVisible();
  await foto(page, '02-inicio');
  await page.getByText('Dados Fiscais').scrollIntoViewIfNeeded();
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await foto(page, '03-dados-fiscais');
});

test('04 card pendentes', async ({ page }) => {
  await setup(page, novo({ notas: notasPendentes }));
  await page.goto(`${BASE}/movimento`);
  await expect(page.getByText('O pagamento depende do envio da nota.')).toBeVisible();
  await foto(page, '04-card-pendentes');
});

const xml = { name: 'nfse-joao-silva.xml', mimeType: 'text/xml', buffer: Buffer.from('<?xml version="1.0"?><NFSe>' + '<x>fictício</x>'.repeat(220) + '</NFSe>') };

test('05 validar vazio', async ({ page }) => {
  await setup(page, novo());
  await page.goto(`${BASE}/validar`);
  await expect(page.getByText('Toque ou arraste o XML')).toBeVisible();
  await foto(page, '05-validar');
});

test('06 validar aprovada', async ({ page }) => {
  await setup(page, novo({ validacao: { valid: true, notaOk: true, mensagem: 'Nota ok! Validação aprovada' } }));
  await page.goto(`${BASE}/validar`);
  await page.locator('input[type=file]').setInputFiles(xml);
  await page.getByRole('button', { name: 'Enviar para validação' }).click();
  await expect(page.getByText('Nota ok! Validação aprovada')).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await foto(page, '06-validar-aprovada');
});

test('07 validar reprovada', async ({ page }) => {
  await setup(page, novo({ validacao: { valid: false, notaOk: false, camposInvalidos: [
    { campo: 'valid_valor', mensagem: 'Valor da nota não confere com o valor do movimento.' },
    { campo: 'valid_trib_nac', mensagem: 'Tributação nacional (TribNac) está incorreta.' },
    { campo: 'valid_dCompet', mensagem: 'Data de competência (dCompet) está incorreta.' },
  ], instrucao: 'Corrija os campos acima, emita a nota novamente e reenvie o XML.' } }));
  await page.goto(`${BASE}/validar`);
  await page.locator('input[type=file]').setInputFiles(xml);
  await page.getByRole('button', { name: 'Enviar para validação' }).click();
  await expect(page.getByText('Corrija os campos acima')).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await foto(page, '07-validar-reprovada');
});

test('08 notas pendentes', async ({ page }) => {
  await setup(page, novo({ notas: notasPendentes }));
  await page.goto(`${BASE}/notas-pendentes`);
  await expect(page.getByText('Escolher XML').first()).toBeVisible();
  await foto(page, '08-notas-pendentes');
});

test('09 conta', async ({ page }) => {
  await setup(page, novo());
  await page.goto(`${BASE}/conta-bancaria`);
  await expect(page.getByText('Conta para pagamentos')).toBeVisible();
  await foto(page, '09-conta');
});

test('10 conta form', async ({ page }) => {
  await setup(page, novo());
  await page.goto(`${BASE}/conta-bancaria/alterar`);
  await expect(page.getByText('poupança não é aceita')).toBeVisible();
  await page.getByLabel('Nome ou razão social do titular').fill('João da Silva ME');
  await page.getByRole('combobox', { name: 'Banco' }).selectOption('341');
  await page.getByLabel('Agência').fill('1234');
  await page.getByLabel('Conta', { exact: true }).fill('56789');
  await page.getByLabel('Dígito').fill('0');
  await page.getByLabel('CNPJ do titular').fill('12.345.678/0001-90');
  await foto(page, '10-conta-form');
});

test('11 adiantamento', async ({ page }) => {
  await setup(page, novo());
  await page.goto(`${BASE}/adiantamento`);
  await expect(page.getByText('Você recebe (estimativa)')).toBeVisible();
  await foto(page, '11-adiantamento');
});

test('12 notificações', async ({ page }) => {
  await setup(page, novo());
  await page.goto(`${BASE}/notificacoes`);
  await expect(page.getByText('Adiantamento liberado')).toBeVisible();
  await foto(page, '12-notificacoes');
});

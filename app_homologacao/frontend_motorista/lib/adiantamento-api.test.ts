/**
 * Teste unitário — lib/adiantamento-api.ts + lib/erros-adiantamento.ts
 * (tasks.md 6.1.3).
 *
 * Roundtrip: os corpos abaixo reproduzem literalmente os campos que
 * `routes/motorista-adiantamento.js` emite (ver `mapDetalheMotorista`,
 * `router.get('/adiantamento/disponibilidade', ...)`, `mapContaBancariaAppResumo`
 * — fonte de verdade atual, mesmo critério da nota em tasks.md 2.5.3: "roundtrip
 * feito contra os shapes literais de contracts/*.md"). Stub puro de
 * `fetch` (mesmo padrão de lib/push-sincronizacao.test.ts) — sem jsdom, sem
 * mock de módulo.
 *
 *   node --experimental-strip-types --test lib/adiantamento-api.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buscarDisponibilidade,
  buscarRegras,
  solicitarAdiantamento,
  buscarDetalheAdiantamento,
  buscarContaBancaria,
  buscarBancos,
  buscarNotificacoes,
} from './adiantamento-api.ts';
import { ApiError } from './api-client.ts';
import { traduzirErroAdiantamento } from './erros-adiantamento.ts';

function fakeResponse(status: number, body?: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body ?? {},
  } as unknown as Response;
}

function stubFetch(rotas: Record<string, { status: number; body?: unknown }>): void {
  (globalThis as unknown as Record<string, unknown>).fetch = async (input: unknown): Promise<Response> => {
    const url = String(input);
    const chave = Object.keys(rotas).find((k) => url.includes(k));
    if (!chave) return fakeResponse(404, { erro: `rota não stubada: ${url}` });
    const { status, body } = rotas[chave];
    return fakeResponse(status, body);
  };
}

// ── 6.1.1: roundtrip dos campos reais do backend ─────────────────────────

test('buscarDisponibilidade: aceita o corpo real de GET /adiantamento/disponibilidade sem lançar', async () => {
  stubFetch({
    '/motorista/adiantamento/disponibilidade': {
      status: 200,
      body: {
        canRequest: false,
        reason: 'BANK_ACCOUNT_PENDING',
        requestDate: '2026-09-17',
        productionDate: '2026-09-16',
        timezone: 'America/Sao_Paulo',
        openingTime: '09:00',
        cutoffTime: '15:00',
        enabledDays: [1, 2, 3, 4, 5, 6],
        percentage: 60,
        fee: '0.35',
        paymentForecast: 'entre 17h e 18h de hoje',
        nextAvailableAt: '2026-09-18T09:00:00-03:00',
        estimate: {
          available: true, production: '120.00', gross: '72.00', fee: '0.35', net: '71.65', eligible: true, final: false,
        },
        bankAccount: { status: 'PENDENTE', bank: '260 – Nu Pagamentos', masked: 'Ag. 0001 · CORRENTE ******45-7' },
        todayRequest: null,
        configVersion: 3,
        configuracaoId: 42,
      },
    },
  });
  const r = await buscarDisponibilidade();
  assert.equal(r.reason, 'BANK_ACCOUNT_PENDING');
  assert.equal(r.configuracaoId, 42);
  assert.equal(r.configVersion, 3);
  assert.equal(r.estimate?.eligible, true);
  assert.equal(r.bankAccount?.masked, 'Ag. 0001 · CORRENTE ******45-7');
});

test('buscarDisponibilidade: estimate.eligible=false vem com net=null (3.8.1/dec-076), nunca negativo', async () => {
  stubFetch({
    '/motorista/adiantamento/disponibilidade': {
      status: 200,
      body: {
        canRequest: true, reason: null, requestDate: '2026-09-17', productionDate: '2026-09-16',
        timezone: 'America/Sao_Paulo', openingTime: '09:00', cutoffTime: '15:00', enabledDays: [1, 2, 3, 4, 5, 6],
        percentage: 60, fee: '0.35', paymentForecast: 'entre 17h e 18h de hoje', nextAvailableAt: null,
        estimate: { available: true, production: '0.30', gross: '0.18', fee: '0.35', net: null, eligible: false, final: false },
        bankAccount: null, todayRequest: null, configVersion: 3, configuracaoId: 42,
      },
    },
  });
  const r = await buscarDisponibilidade();
  assert.equal(r.estimate?.eligible, false);
  assert.equal(r.estimate?.net, null);
});

test('buscarRegras: aceita o corpo real de GET /adiantamento/regras sem lançar', async () => {
  stubFetch({
    '/motorista/adiantamento/regras': {
      status: 200,
      body: {
        configVersion: 3,
        configuracaoId: 42,
        texto: 'Regras vigentes...',
        itens: [{ titulo: 'Produção considerada', descricao: 'D-1' }],
        aceiteSha256: 'a'.repeat(64),
      },
    },
  });
  const r = await buscarRegras();
  assert.equal(r.configuracaoId, 42);
  assert.equal(r.itens.length, 1);
});

test('buscarDetalheAdiantamento: aceita o corpo real de GET /adiantamentos/:id (mapDetalheMotorista) sem lançar', async () => {
  stubFetch({
    '/motorista/adiantamentos/7': {
      status: 200,
      body: {
        id: 7,
        integrationId: 'ADV-000007',
        status: 'LIBERADA',
        motivoStatus: null,
        dataSolicitacao: '2026-09-16',
        dataProducao: '2026-09-15',
        solicitadaEm: '2026-09-16T09:05:00-03:00',
        configVersion: 3,
        calculo: {
          producao: '200.00', percentual: 60, bruto: '120.00', taxa: '0.35', liquido: '119.65',
          fonte: 'movimento', calculadoEm: '2026-09-16T09:10:00-03:00',
        },
        contaMascarada: { status: 'APROVADA', bank: '260 – Nu Pagamentos', masked: 'Ag. 0001 · CORRENTE ******45-7' },
        previsaoPagamento: 'entre 17h e 18h de hoje',
        timeline: [{ etapa: 'Solicitado', status: 'AGUARDANDO_CORTE', ocorridoEm: '2026-09-16T09:05:00-03:00', motivo: null }],
      },
    },
  });
  const r = await buscarDetalheAdiantamento(7);
  assert.equal(r.integrationId, 'ADV-000007');
  assert.equal(r.calculo?.liquido, '119.65');
  assert.equal(r.timeline.length, 1);
});

test('buscarContaBancaria: aceita o corpo real de GET /conta-bancaria (mapContaBancariaAppResumo) sem lançar', async () => {
  stubFetch({
    '/motorista/conta-bancaria': {
      status: 200,
      body: {
        aprovada: {
          id: 1, status: 'APROVADA', banco: '260 – Nu Pagamentos', agencia: '0001', contaMascarada: '****45-7',
          tipoConta: 'CORRENTE', titularNome: 'Fulano', documentoMascarado: '***.***.***-41',
          chavePixTipo: null, emailComprovante: null, solicitadaEm: '2026-08-01T00:00:00-03:00', motivoRejeicao: null,
        },
        pendente: null,
        ultimaRejeicao: null,
      },
    },
  });
  const r = await buscarContaBancaria();
  assert.equal(r.aprovada?.tipoConta, 'CORRENTE');
  assert.equal(r.pendente, null);
});

test('buscarBancos: aceita o corpo real de GET /bancos sem lançar', async () => {
  stubFetch({ '/motorista/bancos': { status: 200, body: { itens: [{ codigo: '260', nome: 'Nu Pagamentos' }] } } });
  const r = await buscarBancos('nu');
  assert.equal(r.itens[0].codigo, '260');
});

test('buscarNotificacoes: aceita o corpo real de GET /notificacoes sem lançar', async () => {
  stubFetch({
    '/motorista/notificacoes': {
      status: 200,
      body: {
        itens: [{ id: 1, categoria: 'adiantamento', titulo: 'Adiantamento liberado', corpo: '...', link: '/adiantamento/7', criadaEm: '2026-09-16T09:10:00-03:00', lida: false }],
        total: 1,
        pagina: 1,
        porPagina: 20,
      },
    },
  });
  const r = await buscarNotificacoes({ categoria: 'adiantamento', naoLidas: true });
  assert.equal(r.itens[0].link, '/adiantamento/7');
});

// ── 6.1.2: mapa de erro → mensagem pt-BR ─────────────────────────────────

test('solicitarAdiantamento: 409 SOLICITACAO_INDISPONIVEL com motivo vira mensagem pt-BR de negócio', async () => {
  stubFetch({
    '/motorista/adiantamentos': { status: 409, body: { erro: 'SOLICITACAO_INDISPONIVEL', motivo: 'ALREADY_REQUESTED' } },
  });
  await assert.rejects(
    () => solicitarAdiantamento({ aceite: true, chaveIdempotencia: 'a-b-c', configuracaoId: 42 }),
    (e: unknown) => {
      assert.ok(e instanceof ApiError);
      const traduzido = traduzirErroAdiantamento(e);
      assert.equal(traduzido.tipo, 'negocio');
      assert.equal(traduzido.mensagem, 'Você já tem uma solicitação de adiantamento hoje.');
      return true;
    },
  );
});

test('solicitarAdiantamento: 409 VERSAO_DESATUALIZADA vira mensagem pt-BR específica', async () => {
  stubFetch({ '/motorista/adiantamentos': { status: 409, body: { erro: 'VERSAO_DESATUALIZADA' } } });
  await assert.rejects(
    () => solicitarAdiantamento({ aceite: true, chaveIdempotencia: 'a-b-c', configuracaoId: 42 }),
    (e: unknown) => {
      const traduzido = traduzirErroAdiantamento(e);
      assert.equal(traduzido.mensagem, 'As regras do adiantamento foram atualizadas. Atualize a tela e tente de novo.');
      return true;
    },
  );
});

test('traduzirErroAdiantamento: 502 INDISPONIVEL (infra) nunca é confundido com negócio (CHK002)', () => {
  const erro = new ApiError('erro', 502, 'INDISPONIVEL');
  const traduzido = traduzirErroAdiantamento(erro);
  assert.equal(traduzido.tipo, 'infra');
  assert.equal(traduzido.mensagem, 'Serviço temporariamente indisponível. Tente novamente em instantes.');
});

test('traduzirErroAdiantamento: erro que não é ApiError (fetch falhou) vira infra genérico', () => {
  const traduzido = traduzirErroAdiantamento(new Error('network fail'));
  assert.equal(traduzido.tipo, 'infra');
});

test('traduzirErroAdiantamento: 400 DADOS_INVALIDOS vira mensagem pt-BR de negócio', () => {
  const erro = new ApiError('DADOS_INVALIDOS', 400, 'DADOS_INVALIDOS', 'chaveIdempotencia');
  const traduzido = traduzirErroAdiantamento(erro);
  assert.equal(traduzido.tipo, 'negocio');
  assert.equal(traduzido.mensagem, 'Alguns dados informados são inválidos. Confira e tente novamente.');
});

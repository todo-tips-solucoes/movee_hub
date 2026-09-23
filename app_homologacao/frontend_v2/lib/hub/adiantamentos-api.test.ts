// adiantamento-motorista — lib/hub/adiantamentos-api.test.ts (tasks.md 7.1.2)
//
// Roundtrip: os corpos abaixo reproduzem literalmente os campos que
// `routes/hub-adiantamentos.js` + `lib/adiantamento-dto.js` emitem (fonte
// lida diretamente no backend, não suposição — mesmo critério de
// `lib/adiantamento-api.test.ts` do app motorista, tasks.md 6.1.3). Stub de
// `fetch` global, mesmo molde de `lib/hub/avisos-api.test.ts`.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  aprovarConta,
  aprovarContasEmLote,
  cancelarLote,
  criarLote,
  encerrarSemPagamento,
  fecharRepasse,
  listarContas,
  listarSolicitacoes,
  obterConfiguracoes,
  obterConta,
  obterLote,
  obterRepasse,
  obterSolicitacao,
  previaLote,
  rejeitarSolicitacao,
  MARCADORES_MENSAGEM,
} from './adiantamentos-api';

function respostaFake(body: unknown, status = 200) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    headers: { get: () => null },
  } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('adiantamentos-api — roundtrip com payload real (routes/hub-adiantamentos.js)', () => {
  it('listarSolicitacoes: GET / — mapSolicitacaoResumo (adiantamento-dto.js:203-216)', async () => {
    const corpo = {
      itens: [
        {
          id: 501,
          integrationId: 'ADV-000501',
          motorista: { entregadorId: 42, nome: 'Motorista E2E' },
          dataSolicitacao: '2026-09-17',
          dataProducao: '2026-09-16',
          status: 'LIBERADA',
          motivoStatus: null,
          valorLiquido: '251.00',
          pendencias: [],
          loteId: null,
        },
      ],
      total: 1,
      page: 1,
      pageSize: 20,
    };
    vi.stubGlobal('fetch', vi.fn(async () => respostaFake(corpo)));
    await expect(listarSolicitacoes({ status: 'LIBERADA' })).resolves.toEqual(corpo);
  });

  it('obterSolicitacao: GET /:id — SolicitacaoDetalhe (routes/hub-adiantamentos.js:1283-1300)', async () => {
    const corpo = {
      id: 501,
      integrationId: 'ADV-000501',
      motorista: { entregadorId: 42, nome: 'Motorista E2E' },
      dataSolicitacao: '2026-09-17',
      dataProducao: '2026-09-16',
      status: 'PAGA',
      motivoStatus: null,
      valorLiquido: '251.00',
      pendencias: [],
      loteId: 9,
      calculo: {
        fonte: 'importacao',
        categorias: ['corrida'],
        producao: '320.00',
        porCategoria: { corrida: '320.00' },
        percentual: 80,
        bruto: '256.00',
        taxa: '5.00',
        liquido: '251.00',
        calculadoEm: '2026-09-17T11:00:00Z',
        versaoConfiguracao: 3,
      },
      contaMascarada: {
        id: 1, status: 'APROVADA', origem: 'APP', banco: '341 · Itaú', agencia: '1234',
        contaMascarada: '****5-6', tipoConta: 'CORRENTE', titularNome: 'Motorista E2E',
        documentoMascarado: '***.456.789-**', alertas: [], solicitadaEm: '2026-08-01T10:00:00Z', revisadaEm: null,
      },
      eventos: [
        { statusDe: null, statusPara: 'AGUARDANDO_CORTE', ocorridoEm: '2026-09-17T08:00:00Z', atorTipo: 'motorista', atorUsuarioId: null, motivo: null },
        { statusDe: 'AGUARDANDO_CORTE', statusPara: 'PAGA', ocorridoEm: '2026-09-18T09:00:00Z', atorTipo: 'sistema', atorUsuarioId: null, motivo: null },
      ],
      lotes: [],
    };
    vi.stubGlobal('fetch', vi.fn(async () => respostaFake(corpo)));
    await expect(obterSolicitacao(501)).resolves.toEqual(corpo);
  });

  it('rejeitarSolicitacao: POST /:id/rejeitar — devolve SolicitacaoResumo, não Detalhe (criarHandlerTransicao, linha 1366)', async () => {
    const corpo = {
      id: 501, integrationId: 'ADV-000501', motorista: { entregadorId: 42, nome: 'Motorista E2E' },
      dataSolicitacao: '2026-09-17', dataProducao: '2026-09-16', status: 'REJEITADA',
      motivoStatus: null, valorLiquido: '0.00', pendencias: [], loteId: null,
    };
    const fetchMock = vi.fn(async () => respostaFake(corpo));
    vi.stubGlobal('fetch', fetchMock);
    await expect(rejeitarSolicitacao(501, 'Vínculo não confirmado')).resolves.toEqual(corpo);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/adiantamentos/501/rejeitar',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ motivo: 'Vínculo não confirmado' }) })
    );
  });

  it('encerrarSemPagamento: POST /:id/encerrar-falha (D-23)', async () => {
    const corpo = {
      id: 501, integrationId: 'ADV-000501', motorista: { entregadorId: 42, nome: 'Motorista E2E' },
      dataSolicitacao: '2026-09-17', dataProducao: '2026-09-16', status: 'ENCERRADA',
      motivoStatus: null, valorLiquido: '0.00', pendencias: [], loteId: null,
    };
    vi.stubGlobal('fetch', vi.fn(async () => respostaFake(corpo)));
    await expect(encerrarSemPagamento(501, 'Pagamento não realizado pela Transfeera')).resolves.toEqual(corpo);
  });

  it('obterConfiguracoes: GET /configuracoes — mapConfiguracao (adiantamento-dto.js:106-129)', async () => {
    const corpo = {
      vigente: {
        versao: 3, vigenteDesde: '2026-08-01', timezone: 'America/Sao_Paulo', diasHabilitados: [1, 2, 3, 4, 5],
        horarioAbertura: '06:00', horarioCorte: '11:00', percentual: 80, taxaFixa: '5.00',
        fonteProducao: 'importacao', categoriasProducao: ['corrida'], previsaoPagamentoTexto: 'D+1',
        descricaoPixModelo: null, apuracaoDiaInicio: 1, apuracaoDiasAteRepasse: 7, apuracaoDataBase: null,
        categoriasExtrato: null, descontoAdiantamentos: true, descontoDebitos: false, repasseVisivelApp: false,
        completa: true,
      },
      historico: [{ versao: 3, vigenteDesde: '2026-08-01', criadoPor: { id: 1, nome: 'Financeiro' }, criadoEm: '2026-08-01', motivo: null }],
    };
    vi.stubGlobal('fetch', vi.fn(async () => respostaFake(corpo)));
    await expect(obterConfiguracoes()).resolves.toEqual(corpo);
  });

  it('listarContas/obterConta: mapContaMascaradaHub (routes/hub-adiantamentos.js:171-187)', async () => {
    const conta = {
      id: 2, status: 'PENDENTE', origem: 'CARGA_INICIAL', banco: '260 · Nu Pagamentos', agencia: '0001',
      contaMascarada: '****9-0', tipoConta: 'CORRENTE' as const, titularNome: 'Motorista E2E',
      documentoMascarado: '***.456.789-**', alertas: [], solicitadaEm: '2026-09-17T10:00:00Z', revisadaEm: null,
    };
    vi.stubGlobal('fetch', vi.fn(async () => respostaFake({ itens: [conta], total: 1, page: 1, pageSize: 20 })));
    await expect(listarContas({ status: 'PENDENTE' })).resolves.toEqual({ itens: [conta], total: 1, page: 1, pageSize: 20 });

    vi.stubGlobal('fetch', vi.fn(async () => respostaFake(conta)));
    await expect(obterConta(2)).resolves.toEqual(conta);
  });

  it('listarContas: 7.11.1/dec-105 — repassa origem/semAlertas/busca/banco na querystring', async () => {
    const fetchMock = vi.fn(async () => respostaFake({ itens: [], total: 0, page: 1, pageSize: 20 }));
    vi.stubGlobal('fetch', fetchMock);
    await listarContas({
      status: 'PENDENTE', origem: 'CARGA_INICIAL', semAlertas: true, busca: 'Joana', banco: '077',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/adiantamentos/contas?status=PENDENTE&origem=CARGA_INICIAL&semAlertas=true&busca=Joana&banco=077',
      expect.anything()
    );
  });

  it('aprovarConta/aprovarContasEmLote: {id,status}/{aprovadas,ignoradas} (hub_conta_bancaria_aprovar, migrations/0067:1328-1358 + routes:593-628)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => respostaFake({ id: 2, status: 'APROVADA' })));
    await expect(aprovarConta(2, 42)).resolves.toEqual({ id: 2, status: 'APROVADA' });

    vi.stubGlobal('fetch', vi.fn(async () => respostaFake({ aprovadas: 2, ignoradas: [{ id: 5, motivo: 'JA_APROVADA' }] })));
    await expect(aprovarContasEmLote([2, 3, 5])).resolves.toEqual({ aprovadas: 2, ignoradas: [{ id: 5, motivo: 'JA_APROVADA' }] });
  });

  it('previaLote/criarLote/cancelarLote/obterLote: mapLote (adiantamento-dto.js:259-276) + itens[] (routes:868-882)', async () => {
    const previa = {
      selecionadas: 2,
      aptas: [{ id: 501, integrationId: 'ADV-000501', motorista: 'Motorista E2E', valor: '251.00', bancoAgenciaContaMascarados: 'Ag. 1234 · CORRENTE ****5-6' }],
      // 12.5 (converge onda-044, FR-026): CONTA_AUSENTE/CONTA_NAO_APROVADA foram
      // fundidos em CONTA_ALTERADA por 11.5 — código real emitido hoje por
      // hub_adiantamento_lote_previa (0075:250), não um código morto.
      pendentes: [{ id: 502, pendencias: ['CONTA_ALTERADA'] }],
      quantidadeApta: 1,
      totalApto: '251.00',
    };
    vi.stubGlobal('fetch', vi.fn(async () => respostaFake(previa)));
    await expect(previaLote([501, 502])).resolves.toEqual(previa);

    const lote = {
      id: 9, numero: '000009', status: 'GERADO', criadoPor: { id: 1, nome: 'Financeiro' }, criadoEm: '2026-09-17T12:00:00Z',
      quantidade: 1, valorTotal: '251.00', arquivoNome: 'transfeera_adiantamentos_2026-09-17_lote-000009.xlsx',
      arquivoSha256: 'abc123', downloads: 0, primeiroDownloadEm: null, canceladoEm: null, canceladoMotivo: null, concluidoEm: null,
    };
    vi.stubGlobal('fetch', vi.fn(async () => respostaFake(lote, 201)));
    await expect(criarLote({ ids: [501], quantidadeEsperada: 1, totalEsperado: '251.00', chaveIdempotencia: 'chave-1' })).resolves.toEqual(lote);

    vi.stubGlobal('fetch', vi.fn(async () => respostaFake(lote)));
    await expect(cancelarLote(9, 'Erro no arquivo', true)).resolves.toEqual(lote);

    const loteDetalhe = {
      ...lote,
      itens: [{
        id: 501, nome: 'Motorista E2E', documentoMascarado: '***.456.789-**', banco: '341', agencia: '1234',
        contaMascarada: '56789-0', tipoConta: 'CORRENTE', valor: '251.00', integrationId: 'ADV-000501',
        descricaoPix: 'Adiantamento', situacao: 'incluido', situacaoMotivo: null, situacaoEm: '2026-09-17T12:00:00Z',
      }],
      historico: [],
    };
    vi.stubGlobal('fetch', vi.fn(async () => respostaFake(loteDetalhe)));
    await expect(obterLote(9)).resolves.toEqual(loteDetalhe);
  });

  it('obterRepasse/fecharRepasse: sem descontos{} separado (routes/hub-adiantamentos.js:1096-1124, 1217-1222)', async () => {
    const repasse = {
      periodo: { inicio: '2026-09-10', fim: '2026-09-16', dataRepasse: null, situacao: 'aberto' as const },
      totais: { creditos: '1200.00', adiantamentos: '256.00', debitos: '0.00', remanescente: '944.00', motoristas: 1 },
      itens: [{ entregadorId: 42, nome: 'Motorista E2E', creditos: '1200.00', adiantamentos: '256.00', debitos: '0.00', remanescente: '944.00', negativo: false, emProcessamento: false }],
      naoPagosNoPeriodo: 0,
      total: 1,
      page: 1,
      pageSize: 20,
    };
    vi.stubGlobal('fetch', vi.fn(async () => respostaFake(repasse)));
    await expect(obterRepasse({ periodo: '2026-09-10' })).resolves.toEqual(repasse);

    const fechamento = { apuracaoId: 7, motoristas: 1, total: '944.00', naoPagosNoPeriodo: 0 };
    vi.stubGlobal('fetch', vi.fn(async () => respostaFake(fechamento, 201)));
    await expect(fecharRepasse('2026-09-10')).resolves.toEqual(fechamento);
  });

  it('1 caso por código de erro comum — TRANSICAO_INVALIDA (409)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => respostaFake({ erro: 'TRANSICAO_INVALIDA' }, 409)));
    await expect(rejeitarSolicitacao(501, 'motivo qualquer')).rejects.toMatchObject({
      name: 'AdiantamentosApiError',
      status: 409,
      codigo: 'TRANSICAO_INVALIDA',
    });
  });

  // 7.8.4/D-23: APURACAO_COM_PENDENCIAS carrega `detalhe` com a contagem por
  // status (routes/hub-adiantamentos.js:1213-1216) — o diálogo de fechamento
  // usa isso para mostrar a contagem, não só uma mensagem genérica.
  it('fecharRepasse: APURACAO_COM_PENDENCIAS (409) carrega detalhe com a contagem por status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => respostaFake({ erro: 'APURACAO_COM_PENDENCIAS', detalhe: { LIBERADA: 2, FALHOU: 1 } }, 409)));
    await expect(fecharRepasse('2026-09-08')).rejects.toMatchObject({
      name: 'AdiantamentosApiError',
      status: 409,
      codigo: 'APURACAO_COM_PENDENCIAS',
      detalhe: { LIBERADA: 2, FALHOU: 1 },
    });
  });
});

// F4: a lista de marcadores que a tela mostra é uma CÓPIA da whitelist do
// backend. Cópia sem trava diverge em silêncio — e o sintoma seria o pior
// possível: a tela oferece um marcador que o salvamento recusa, ou esconde um
// que funciona. Este teste lê o arquivo do backend e compara.
describe('MARCADORES_MENSAGEM x whitelist do backend', () => {
  it('bate exatamente com PLACEHOLDERS_PERMITIDOS de lib/adiantamento-mensagem.js', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const fonte = readFileSync(
      resolve(__dirname, '../../../backend/lib/adiantamento-mensagem.js'), 'utf8');

    const bloco = /PLACEHOLDERS_PERMITIDOS = new Set\(\[([\s\S]*?)\]\)/.exec(fonte);
    expect(bloco, 'não achei PLACEHOLDERS_PERMITIDOS no backend — o teste ficou cego').not.toBeNull();
    const doBackend = [...bloco![1].matchAll(/'([^']+)'/g)].map((m) => m[1]);

    expect([...MARCADORES_MENSAGEM].sort()).toEqual([...doBackend].sort());
  });
});

// campanhas do motorista (W3a) — mapeamento dos tokens de erro do CONTRATOS §5
// para mensagem acionável, e o formato exato das chamadas (§7).

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CampanhaApiError,
  MENSAGENS_CAMPANHA,
  cancelarCampanha,
  criarCampanha,
  enviarFotoPremio,
  lancarCampanha,
  listarCampanhas,
  mensagemCampanha,
  obterOpcoes,
  obterRanking,
  registrarEntrega,
} from './campanhas-api';
import { formularioVazio } from './campanhas-form';

const TOKENS_5 = [
  'CAMPANHA_NAO_ENCONTRADA', 'CAMPANHA_IMUTAVEL', 'CAMPANHA_SITUACAO_INVALIDA', 'TETO_CAMPANHAS_ATIVAS',
  'PEDIDOS_SEM_COBERTURA', 'INICIO_NO_PASSADO', 'FAIXAS_SOBREPOSTAS', 'PESOS_INVALIDOS', 'CORTE_SEM_PESO',
  'OPCAO_DESCONHECIDA', 'FECHAMENTO_ANTECIPADO', 'FOTO_INVALIDA', 'CONFIRMACAO_AUSENTE', 'VALIDACAO',
];

function resp(body: unknown, status: number) {
  return { status, ok: status >= 200 && status < 300, json: async () => body } as unknown as Response;
}
function stubFetch(body: unknown, status: number) {
  const f = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => resp(body, status));
  vi.stubGlobal('fetch', f);
  return f;
}
afterEach(() => vi.unstubAllGlobals());

describe('tokens do §5 → mensagem em português', () => {
  it.each(TOKENS_5)('%s tem mensagem própria, sem o token cru', (t) => {
    const m = mensagemCampanha({ erro: t }, 422);
    expect(m).toBe(MENSAGENS_CAMPANHA[t]);
    expect(m).not.toContain(t);
    expect(m.length).toBeGreaterThan(20);
  });

  it('mensagens que mandam fazer algo (acionáveis)', () => {
    expect(mensagemCampanha({ erro: 'PEDIDOS_SEM_COBERTURA' }, 422)).toMatch(/peso 0/);
    expect(mensagemCampanha({ erro: 'FECHAMENTO_ANTECIPADO' }, 409)).toMatch(/3 dias/);
    expect(mensagemCampanha({ erro: 'TETO_CAMPANHAS_ATIVAS' }, 409)).toMatch(/10 campanhas/);
    expect(mensagemCampanha({ erro: 'CAMPANHA_IMUTAVEL' }, 409)).toMatch(/cancele/);
  });

  it('VALIDACAO cita o campo; token desconhecido cai no status', () => {
    expect(mensagemCampanha({ erro: 'VALIDACAO', campo: 'nome' }, 422)).toMatch(/campo: nome/);
    expect(mensagemCampanha({ erro: 'ALGO_NOVO' }, 500)).toBe('Erro 500. Tente novamente.');
    expect(mensagemCampanha({}, 502)).toBe('Erro 502. Tente novamente.');
  });

  it('o erro lançado carrega status, código e campo', async () => {
    stubFetch({ erro: 'VALIDACAO', campo: 'pesos' }, 422);
    await expect(listarCampanhas()).rejects.toMatchObject({
      name: 'CampanhaApiError', status: 422, codigo: 'VALIDACAO', campo: 'pesos',
    });
    await expect(listarCampanhas()).rejects.toBeInstanceOf(CampanhaApiError);
  });
});

describe('chamadas (CONTRATOS §7)', () => {
  it('lançar envia {confirmo:true} e aceita 204', async () => {
    const f = stubFetch(undefined, 204);
    await lancarCampanha(12);
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/v1/hub/campanhas/12/lancar');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ confirmo: true });
  });

  it('cancelar envia o motivo', async () => {
    const f = stubFetch(undefined, 204);
    await cancelarCampanha(12, 'Prêmio errado');
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/v1/hub/campanhas/12/cancelar');
    expect(JSON.parse(init.body as string)).toEqual({ motivo: 'Prêmio errado' });
  });

  it('criar devolve o id (201 {id}) e o corpo não leva chaves da UI', async () => {
    const f = stubFetch({ id: 77 }, 201);
    expect(await criarCampanha({ ...formularioVazio(), nome: 'X campanha' })).toBe(77);
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/v1/hub/campanhas');
    expect(Object.keys(JSON.parse(init.body as string))).toContain('pesos');
  });

  it('listar com e sem situação; opções omitem filtro "todas"', async () => {
    let f = stubFetch({ itens: [] }, 200);
    await listarCampanhas('em_andamento');
    expect(f.mock.calls[0][0]).toBe('/api/v1/hub/campanhas?situacao=em_andamento');
    f = stubFetch({ itens: [] }, 200);
    await listarCampanhas();
    expect(f.mock.calls[0][0]).toBe('/api/v1/hub/campanhas');
    f = stubFetch({ pracas: [], turnos: [], modais: [], coberturaPedidos: null, alcance: { rodaram: 0, semModal: 0 } }, 200);
    await obterOpcoes({ pracas: ['SAO PAULO', 'SANTOS'], turnos: null, modais: ['MOTO'] });
    expect(f.mock.calls[0][0]).toBe('/api/v1/hub/campanhas/opcoes?pracas=SAO%20PAULO%2CSANTOS&modais=MOTO');
  });

  it('ranking pede situação e página', async () => {
    const f = stubFetch({ itens: [], contagem: { classificado: 0, abaixoCorte: 0, semMinimo: 0, semModal: 0 }, pagina: 2, porPagina: 50 }, 200);
    await obterRanking(12, 'abaixo_corte', 2);
    expect(f.mock.calls[0][0]).toBe('/api/v1/hub/campanhas/12/ranking?situacao=abaixo_corte&pagina=2');
  });

  it('entrega vai na rota da posição; foto sobe como binário com o Content-Type do arquivo', async () => {
    let f = stubFetch(undefined, 204);
    await registrarEntrega(12, 1, 'retirado');
    expect(f.mock.calls[0][0]).toBe('/api/v1/hub/campanhas/12/vencedores/1/entrega');
    f = stubFetch(undefined, 204);
    const arq = new File([new Uint8Array([0xff, 0xd8, 0xff])], 'foto.jpg', { type: 'image/jpeg' });
    await enviarFotoPremio(12, 3, arq);
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/v1/hub/campanhas/12/premios/3/foto');
    expect(init.method).toBe('PUT');
    expect(init.body).toBe(arq);
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('image/jpeg');
  });
});

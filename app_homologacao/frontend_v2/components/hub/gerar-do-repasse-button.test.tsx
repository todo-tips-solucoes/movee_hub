// repasse-gera-movimento FASE 4 (4.2/4.3/4.4): o botão único "Gerar do repasse".
// Os 5 testes de guarda (A2 + os 4 de C4) vieram de `repasse/page.test.tsx`, onde exercitavam o
// `FecharApuracaoDialog`. As ASSERÇÕES são as mesmas; mudou só o NOME do controle ("Fechar apuração" ->
// "Gerar do repasse") e a função chamada (`fecharRepasse` -> `gerarMovimentos`). Preservam "informado, não
// bloqueado": a caixa é exigida, mas marcada ela o fluxo segue — migrar como recusa quebraria o teste A2.
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GerarDoRepasseButton, semanaAnterior } from './gerar-do-repasse-button';
import { AdiantamentosApiError } from '@/lib/hub/adiantamentos-api';

const mockUseHubAuth = vi.fn();
const mockGerarMovimentos = vi.fn();
const mockObterConfiguracoes = vi.fn();
const mockResumoExterno = vi.fn();
const { mockToast } = vi.hoisted(() => ({ mockToast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

vi.mock('sonner', () => ({ toast: mockToast }));
vi.mock('@/contexts/hub-auth-context', () => ({ useHubAuth: () => mockUseHubAuth() }));
vi.mock('@/lib/hub/lancamento-externo', async () => {
  const actual = await vi.importActual<typeof import('@/lib/hub/lancamento-externo')>('@/lib/hub/lancamento-externo');
  return { ...actual, obterResumoLancamentosExternos: (...a: unknown[]) => mockResumoExterno(...a) };
});
vi.mock('@/lib/hub/adiantamentos-api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/hub/adiantamentos-api')>('@/lib/hub/adiantamentos-api');
  return {
    ...actual,
    gerarMovimentos: (...a: unknown[]) => mockGerarMovimentos(...a),
    obterConfiguracoes: (...a: unknown[]) => mockObterConfiguracoes(...a),
  };
});

const PERIODO = '2026-09-10';
const OK = { qtdDeducao: 0, totalDeducao: 0, qtdCredito: 0, totalCredito: 0, flagDescontoLigada: true };
const GERADO = { apuracaoId: 7, gerados: 1, semTelefone: 0, recusados: [] };

beforeEach(() => {
  vi.clearAllMocks();
  mockUseHubAuth.mockReturnValue({ permissoes: ['adiantamentos.pagamento_confirmar'] });
  mockResumoExterno.mockResolvedValue({ ...OK, qtdNegativo: 0, totalNegativo: 0 });
  mockObterConfiguracoes.mockResolvedValue({ vigente: { apuracaoDiaInicio: 1 }, historico: [] });
});

const abrir = async (props: { periodo?: string; onSucesso?: () => void } = { periodo: PERIODO }) => {
  render(<GerarDoRepasseButton {...props} />);
  fireEvent.click(screen.getByRole('button', { name: 'Gerar do repasse' }));
  return screen.findByRole('alertdialog');
};
const botaoGerar = (d: HTMLElement) => within(d).getByRole('button', { name: 'Gerar do repasse' });

describe('GerarDoRepasseButton', () => {
  it('T22/C13: sem adiantamentos.pagamento_confirmar NADA é renderizado', () => {
    mockUseHubAuth.mockReturnValue({ permissoes: ['adiantamentos.pagamentos_consultar'] });
    const { container } = render(<GerarDoRepasseButton periodo={PERIODO} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('T24: gera UMA vez por acionamento, com o período da tela, e avisa o chamador', async () => {
    mockGerarMovimentos.mockResolvedValueOnce(GERADO);
    const onSucesso = vi.fn();
    const d = await abrir({ periodo: PERIODO, onSucesso });
    await waitFor(() => expect(botaoGerar(d)).toBeEnabled());
    fireEvent.click(botaoGerar(d));
    await waitFor(() => expect(onSucesso).toHaveBeenCalledTimes(1));
    expect(mockGerarMovimentos).toHaveBeenCalledTimes(1);
    expect(mockGerarMovimentos).toHaveBeenCalledWith(PERIODO);
    expect(mockToast.success).toHaveBeenCalled();
  });

  it('T24: sem `periodo` o seletor nasce na SEMANA ANTERIOR à corrente, em ISO, e é esse valor que vai à rota', async () => {
    mockGerarMovimentos.mockResolvedValueOnce(GERADO);
    const d = await abrir({});
    const campo = within(d).getByLabelText('Semana de apuração (início)') as HTMLInputElement;
    const esperado = semanaAnterior(new Date(), 1);
    await waitFor(() => expect(campo.value).toBe(esperado));
    expect(campo.value).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    await waitFor(() => expect(botaoGerar(d)).toBeEnabled());
    fireEvent.click(botaoGerar(d));
    await waitFor(() => expect(mockGerarMovimentos).toHaveBeenCalledWith(esperado));
  });

  it('semanaAnterior: sempre 7 dias antes do início da semana corrente (segunda a segunda)', () => {
    expect(semanaAnterior(new Date(2026, 9, 28), 1)).toBe('2026-10-19'); // qua 28/10 -> semana corrente seg 26/10
    expect(semanaAnterior(new Date(2026, 9, 26), 1)).toBe('2026-10-19'); // segunda
  });

  it('4.4: pendências — contagem por status e NOMES como texto, cap sinalizado; nenhum CNPJ/telefone/valor no DOM', async () => {
    mockGerarMovimentos.mockRejectedValueOnce(new AdiantamentosApiError(409, 'x', 'ADIANTAMENTOS_PENDENTES', undefined, undefined, undefined, undefined, {
      erro: 'ADIANTAMENTOS_PENDENTES', total: 116, porStatus: { LIBERADA: 50, EXPORTADA: 66 },
      motoristas: [{ entregadorId: 901, nome: '<b>Fulano</b> de Tal', status: 'LIBERADA' }], motoristasOmitidos: 96,
    }));
    const d = await abrir();
    await waitFor(() => expect(botaoGerar(d)).toBeEnabled());
    fireEvent.click(botaoGerar(d));
    const alerta = await within(d).findByText(/nada foi fechado nem gerado/);
    const bloco = alerta.closest('div') as HTMLElement;
    expect(bloco).toHaveTextContent('Adiantamento liberado: 50');
    expect(bloco).toHaveTextContent('<b>Fulano</b> de Tal — Adiantamento liberado'); // texto literal, nao HTML
    expect(bloco.querySelector('b')).toBeNull();
    expect(bloco).toHaveTextContent('e mais 96');
    expect(bloco.textContent).not.toMatch(/\d{2}\.?\d{3}\.?\d{3}|\(\d{2}\)|R\$/);
  });

  it('revisão (achado 8): APURACAO_COM_PENDENCIAS (corrida com o RPC) mantém a contagem por status', async () => {
    mockGerarMovimentos.mockRejectedValueOnce(new AdiantamentosApiError(409, 'Há solicitações pendentes neste período.', 'APURACAO_COM_PENDENCIAS', { LIBERADA: 2, FALHOU: 1 }));
    const d = await abrir();
    await waitFor(() => expect(botaoGerar(d)).toBeEnabled());
    fireEvent.click(botaoGerar(d));
    const alerta = await within(d).findByText(/nada foi fechado nem gerado/);
    expect(alerta.closest('div')).toHaveTextContent('Adiantamento liberado: 2');
    expect(alerta.closest('div')).toHaveTextContent('Falha no pagamento: 1');
    expect(within(d).queryByText('Quem está travando:')).toBeNull();
  });

  it('revisão (achado 7): trocar a semana no seletor DESMARCA a confirmação do negativo', async () => {
    mockResumoExterno.mockResolvedValue({ qtdDeducao: 0, totalDeducao: 0, qtdCredito: 0, totalCredito: 0, flagDescontoLigada: true, qtdNegativo: 2, totalNegativo: 50 });
    const d = await abrir({});
    const caixa = await within(d).findByRole('checkbox', { name: /não será pago nem transportado/ });
    fireEvent.click(caixa);
    await waitFor(() => expect(botaoGerar(d)).toBeEnabled());
    fireEvent.change(within(d).getByLabelText('Semana de apuração (início)'), { target: { value: '2026-09-01' } });
    await waitFor(() => expect(botaoGerar(d)).toBeDisabled());
  });

  it('4.3.4: PERIODO_EM_ABERTO diz ATÉ QUANDO esperar (não é recusa misteriosa)', async () => {
    mockGerarMovimentos.mockRejectedValueOnce(new AdiantamentosApiError(409, 'genérica', 'PERIODO_EM_ABERTO', undefined, undefined, undefined, undefined, {
      erro: 'PERIODO_EM_ABERTO', liberaApos: { data: '2026-10-27', horario: '23:59:00', timezone: 'America/Sao_Paulo' },
    }));
    const d = await abrir();
    await waitFor(() => expect(botaoGerar(d)).toBeEnabled());
    fireEvent.click(botaoGerar(d));
    expect(await within(d).findByText(/a partir de 27\/10\/2026 às 23:59/)).toBeInTheDocument();
  });

  it('4.3.4: cada código de 409 do fechamento mostra o SEU texto (cadeia real: fetch -> request -> mensagem)', async () => {
    const { gerarMovimentos: real } = await vi.importActual<typeof import('@/lib/hub/adiantamentos-api')>('@/lib/hub/adiantamentos-api');
    for (const [codigo, trecho] of [
      ['APURACAO_FORA_DE_ORDEM', /próxima semana em ordem/],
      ['APURACAO_NAO_CONFIGURADA', /ainda não foi configurada/],
      ['PERIODO_DESALINHADO', /não começa no dia configurado/],
      ['MODELO_MENSAGEM_AUSENTE', /modelo da mensagem ao motorista não está cadastrado/],
    ] as const) {
      mockGerarMovimentos.mockReset();
      mockGerarMovimentos.mockImplementationOnce((p: string) => real(p));
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ erro: codigo }), { status: 409, headers: { 'Content-Type': 'application/json' } })));
      const { unmount } = render(<GerarDoRepasseButton periodo={PERIODO} />);
      fireEvent.click(screen.getByRole('button', { name: 'Gerar do repasse' }));
      const d = await screen.findByRole('alertdialog');
      await waitFor(() => expect(botaoGerar(d)).toBeEnabled());
      fireEvent.click(botaoGerar(d));
      expect(await within(d).findByText(trecho)).toBeInTheDocument();
      unmount();
    }
    vi.unstubAllGlobals();
  });

  it('dec-049: modelo de mensagem AUSENTE na config vigente avisa antes de confirmar (e não bloqueia o botão)', async () => {
    mockObterConfiguracoes.mockResolvedValue({ vigente: { apuracaoDiaInicio: 1, mensagem1Modelo: null }, historico: [] });
    const d = await abrir();
    expect(await within(d).findByText(/modelo da mensagem ao motorista ainda não está cadastrado/)).toBeInTheDocument();
    await waitFor(() => expect(botaoGerar(d)).toBeEnabled());
  });

  it('dec-049 (controle): modelo cadastrado ou config ilegível NÃO mostra o aviso', async () => {
    mockObterConfiguracoes.mockResolvedValue({ vigente: { apuracaoDiaInicio: 1, mensagem1Modelo: 'Ola {nome}' }, historico: [] });
    const d1 = await abrir();
    await waitFor(() => expect(botaoGerar(d1)).toBeEnabled());
    expect(within(d1).queryByText(/modelo da mensagem ao motorista ainda não/)).toBeNull();
  });

  // --- os 5 testes migrados (4.2.3) ----------------------------------------------------------
  it('A2 (rodada 4): com remanescente NEGATIVO a geração é informada e exige confirmação explícita — e NÃO é recusada', async () => {
    mockResumoExterno.mockResolvedValue({ qtdDeducao: 1, totalDeducao: 90, qtdCredito: 0, totalCredito: 0, flagDescontoLigada: true, qtdNegativo: 2, totalNegativo: 102 });
    mockGerarMovimentos.mockResolvedValueOnce(GERADO);
    const dialog = await abrir();
    await within(dialog).findByText(/2 motoristas com pago por fora ficam com remanescente NEGATIVO/);
    const botao = botaoGerar(dialog);
    expect(botao).toBeDisabled();
    fireEvent.click(botao);
    expect(mockGerarMovimentos).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole('checkbox', { name: /não será pago nem transportado/ }));
    await waitFor(() => expect(botaoGerar(dialog)).toBeEnabled());
    fireEvent.click(botaoGerar(dialog));
    await waitFor(() => expect(mockGerarMovimentos).toHaveBeenCalledWith(PERIODO));
  });

  describe('C4 (rodada 5): a confirmação falha FECHADA quando o resumo não é conhecido', () => {
    it('CARREGANDO: botão desabilitado e caixa de confirmação presente', async () => {
      mockResumoExterno.mockReturnValue(new Promise(() => {}));
      const dialog = await abrir();
      expect(botaoGerar(dialog)).toBeDisabled();
      expect(within(dialog).getByRole('checkbox')).toBeInTheDocument();
    });
    it('ERRO na consulta: botão desabilitado até marcar a caixa', async () => {
      mockResumoExterno.mockRejectedValue(new Error('500'));
      const dialog = await abrir();
      await within(dialog).findByRole('checkbox');
      expect(botaoGerar(dialog)).toBeDisabled();
      fireEvent.click(within(dialog).getByRole('checkbox'));
      await waitFor(() => expect(botaoGerar(dialog)).toBeEnabled());
    });
    it('backend SEM o campo qtdNegativo: exige a caixa (não assume 0)', async () => {
      mockResumoExterno.mockResolvedValue(OK);
      const dialog = await abrir();
      await within(dialog).findByRole('checkbox');
      expect(botaoGerar(dialog)).toBeDisabled();
    });
    it('controle: qtdNegativo 0 conhecido NÃO exige a caixa', async () => {
      mockResumoExterno.mockResolvedValue({ ...OK, qtdNegativo: 0, totalNegativo: 0 });
      const dialog = await abrir();
      await waitFor(() => expect(botaoGerar(dialog)).toBeEnabled());
      expect(within(dialog).queryByRole('checkbox')).toBeNull();
    });
  });
});

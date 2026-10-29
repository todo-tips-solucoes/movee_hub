// adiantamento-motorista (FASE 7, tasks.md 7.8, H14): remanescente semanal,
// exportação CSV e fechamento de apuração com a contagem de pendências por
// status quando recusado (7.8.4/D-23). Mesmo molde de `contas/page.test.tsx`.
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AdiantamentosRepassePage from './page';
import { AdiantamentosApiError } from '@/lib/hub/adiantamentos-api';


const mockUseHubAuth = vi.fn();
const mockObterRepasse = vi.fn();
const mockExportarRepasseCsv = vi.fn();
const mockObterConfiguracoes = vi.fn();
const { mockToast } = vi.hoisted(() => ({
  mockToast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('next/navigation', () => ({
  usePathname: () => '/hub/dashboard/adiantamentos/repasse',
}));

vi.mock('sonner', () => ({ toast: mockToast }));

vi.mock('@/contexts/hub-auth-context', () => ({
  useHubAuth: () => mockUseHubAuth(),
}));

const mockResumoExterno = vi.fn();
vi.mock('@/lib/hub/lancamento-externo', async () => {
  const actual = await vi.importActual<typeof import('@/lib/hub/lancamento-externo')>('@/lib/hub/lancamento-externo');
  return { ...actual, obterResumoLancamentosExternos: (...args: unknown[]) => mockResumoExterno(...args) };
});

vi.mock('@/lib/hub/adiantamentos-api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/hub/adiantamentos-api')>('@/lib/hub/adiantamentos-api');
  return {
    ...actual,
    obterRepasse: (...args: unknown[]) => mockObterRepasse(...args),
    exportarRepasseCsv: (...args: unknown[]) => mockExportarRepasseCsv(...args),
    obterConfiguracoes: (...args: unknown[]) => mockObterConfiguracoes(...args),
  };
});

const REPASSE_ABERTO = {
  periodo: { inicio: '2026-09-10', fim: '2026-09-16', dataRepasse: null, situacao: 'aberto' as const },
  totais: { creditos: '1200.00', adiantamentos: '256.00', debitos: '0.00', lancamentosExternos: '0.00', remanescente: '944.00', motoristas: 1 },
  itens: [{ entregadorId: 42, idExterno: 'a1b2c3d4-0000-4000-8000-000000000042', nome: 'Joana Ribeiro', creditos: '1200.00', adiantamentos: '256.00', debitos: '0.00', lancamentosExternos: '0.00', remanescente: '944.00', negativo: false, emProcessamento: false }],
  naoPagosNoPeriodo: 0,
  total: 1,
  page: 1,
  pageSize: 20,
};

describe('AdiantamentosRepassePage', () => {
  beforeEach(() => {
    mockUseHubAuth.mockReset();
    mockObterRepasse.mockReset();
    mockExportarRepasseCsv.mockReset();
    mockObterConfiguracoes.mockReset();
    mockResumoExterno.mockReset();
    mockResumoExterno.mockResolvedValue({ qtdDeducao: 0, totalDeducao: 0, qtdCredito: 0, totalCredito: 0, flagDescontoLigada: true, qtdNegativo: 0, totalNegativo: 0 });
    mockObterConfiguracoes.mockResolvedValue({ vigente: null, historico: [] });
    mockToast.success.mockReset();
    mockToast.error.mockReset();
    mockUseHubAuth.mockReturnValue({
      permissoes: ['adiantamentos.consultar', 'adiantamentos.pagamentos_consultar', 'adiantamentos.pagamento_confirmar'],
    });
  });

  it('mostra loading e depois a lista com os totais', async () => {
    mockObterRepasse.mockResolvedValueOnce(REPASSE_ABERTO);
    render(<AdiantamentosRepassePage />);

    expect(screen.getByText('Carregando repasse...')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('Joana Ribeiro')).toBeInTheDocument());
    expect(screen.getByText('Total (1 motorista(s))')).toBeInTheDocument();
  });

  // F1 (repasse-saldo-minimo, spec.md FR-001/FR-003): mesma coluna
  // "Identificador" com CopyableUuid já usada na tela de Motoristas.
  it('F1: mostra a coluna Identificador com CopyableUuid recebendo o idExterno', async () => {
    mockObterRepasse.mockResolvedValueOnce(REPASSE_ABERTO);
    render(<AdiantamentosRepassePage />);
    await waitFor(() => expect(screen.getByText('Joana Ribeiro')).toBeInTheDocument());

    expect(screen.getByText('Identificador')).toBeInTheDocument();
    expect(screen.getByText('a1b2c3d4-0000-4000-8000-000000000042')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copiar identificador de Joana Ribeiro' })).toBeInTheDocument();
  });

  // F3 (repasse-saldo-minimo, tasks.md 3.5.1/3.5.3): colunas novas e o badge
  // de retenção — só aparece quando `retido=true`, nunca para os demais.
  it('F3: mostra colunas Saldo anterior/A pagar e o badge de retido só quando retido=true', async () => {
    mockObterRepasse.mockResolvedValueOnce({
      ...REPASSE_ABERTO,
      totais: { ...REPASSE_ABERTO.totais, saldoAnterior: '10.00', aPagar: '944.00', transportado: '0.00' },
      itens: [
        { ...REPASSE_ABERTO.itens[0], saldoAnterior: '10.00', aPagar: '944.00', transportado: null, retido: false },
        {
          entregadorId: 43, idExterno: 'a1b2c3d4-0000-4000-8000-000000000043', nome: 'Carlos Souza',
          creditos: '3.00', adiantamentos: '0.00', debitos: '0.00', lancamentosExternos: '0.00', remanescente: '3.00', negativo: false,
          emProcessamento: false, saldoAnterior: '0.00', aPagar: '0.00', transportado: '3.00', retido: true,
        },
      ],
    });
    render(<AdiantamentosRepassePage />);
    await waitFor(() => expect(screen.getByText('Joana Ribeiro')).toBeInTheDocument());

    expect(screen.getByText('Saldo anterior')).toBeInTheDocument();
    expect(screen.getByText('A pagar')).toBeInTheDocument();
    expect(screen.getByText('Passou para a próxima semana')).toBeInTheDocument();
    // Joana (retido=false) não ganha o badge.
    const linhaJoana = screen.getByText('Joana Ribeiro').closest('tr') as HTMLElement;
    expect(linhaJoana).not.toHaveTextContent('Passou para a próxima semana');
  });

  // 0117: a parcela "pago por fora" fecha a conta créditos − adiantamentos − débitos ± lançamentos = remanescente.
  it('0117: coluna "Pago por fora" mostra dedução (−), crédito (+), zero (—) e o total', async () => {
    mockObterRepasse.mockResolvedValueOnce({
      ...REPASSE_ABERTO,
      totais: { ...REPASSE_ABERTO.totais, lancamentosExternos: '-17.00' },
      itens: [
        { ...REPASSE_ABERTO.itens[0], lancamentosExternos: '-30.00' },
        { ...REPASSE_ABERTO.itens[0], entregadorId: 43, nome: 'Carlos Souza', lancamentosExternos: '13.00' },
        { ...REPASSE_ABERTO.itens[0], entregadorId: 44, nome: 'Maria Lima', lancamentosExternos: '0.00' },
      ],
    });
    render(<AdiantamentosRepassePage />);
    await waitFor(() => expect(screen.getByText('Joana Ribeiro')).toBeInTheDocument());
    expect(screen.getByText('Pago por fora')).toBeInTheDocument();
    const norm = (t: string | null) => (t ?? '').replace(/\s/g, ' ');
    expect(norm(screen.getByText('Joana Ribeiro').closest('tr')!.textContent)).toContain('− R$ 30,00');
    expect(norm(screen.getByText('Carlos Souza').closest('tr')!.textContent)).toContain('+ R$ 13,00');
    expect(norm(screen.getByText('Maria Lima').closest('tr')!.textContent)).not.toContain('+ R$');
    expect(norm(screen.getByText(/^Total \(/).closest('tr')!.textContent)).toContain('− R$ 17,00');
  });

  it('lista vazia mostra o empty state', async () => {
    mockObterRepasse.mockResolvedValueOnce({ ...REPASSE_ABERTO, itens: [], total: 0 });
    render(<AdiantamentosRepassePage />);
    await waitFor(() => expect(screen.getByText('Nenhum motorista neste período')).toBeInTheDocument());
  });

  it('7.8.1: exportar CSV chama exportarRepasseCsv com o período', async () => {
    mockObterRepasse.mockResolvedValueOnce(REPASSE_ABERTO);
    render(<AdiantamentosRepassePage />);
    await waitFor(() => expect(screen.getByText('Joana Ribeiro')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Exportar CSV/ }));
    await waitFor(() => expect(mockExportarRepasseCsv).toHaveBeenCalledWith(expect.any(String)));
  });

  it('7.8.3: pills de descontos refletem a configuração vigente', async () => {
    mockObterConfiguracoes.mockResolvedValue({
      vigente: { descontoAdiantamentos: true, descontoDebitos: false },
      historico: [],
    });
    mockObterRepasse.mockResolvedValueOnce(REPASSE_ABERTO);
    render(<AdiantamentosRepassePage />);
    await waitFor(() => expect(screen.getByText('✓ Adiantamentos (bruto)')).toBeInTheDocument());
    expect(screen.getByText('— Débitos EntreGô')).toBeInTheDocument();
  });

  it('a configuração que chega depois não sobrescreve o período que o operador já digitou', async () => {
    let resolverConfig: (v: unknown) => void = () => {};
    mockObterConfiguracoes.mockReturnValue(new Promise((r) => { resolverConfig = r; }));
    mockObterRepasse.mockResolvedValue(REPASSE_ABERTO);
    render(<AdiantamentosRepassePage />);

    const campo = screen.getByLabelText('Período de apuração (início)') as HTMLInputElement;
    fireEvent.change(campo, { target: { value: '2026-09-01' } });
    resolverConfig({ vigente: { apuracaoDiaInicio: 1, descontoAdiantamentos: true, descontoDebitos: false }, historico: [] });

    await waitFor(() => expect(screen.getByText('✓ Adiantamentos (bruto)')).toBeInTheDocument());
    expect(campo.value).toBe('2026-09-01');
  });

  // T22b (repasse-gera-movimento 4.5.4): o passo manual de fechar sumiu e gerar fica sempre disponível.
  it('T22b: não existe "Fechar apuração"; "Gerar do repasse" está habilitado com a semana ABERTA e com a FECHADA', async () => {
    mockObterRepasse.mockResolvedValue(REPASSE_ABERTO);
    const { unmount } = render(<AdiantamentosRepassePage />);
    await waitFor(() => expect(screen.getByText('Joana Ribeiro')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /Fechar apuração/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Gerar do repasse' })).toBeEnabled();
    unmount();
    mockObterRepasse.mockResolvedValue({ ...REPASSE_ABERTO, periodo: { ...REPASSE_ABERTO.periodo, situacao: 'fechado' } });
    render(<AdiantamentosRepassePage />);
    await waitFor(() => expect(screen.getByText('Joana Ribeiro')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Gerar do repasse' })).toBeEnabled();
  });
  // lancamento-externo 6.2.3 — as duas metades de FR-049 no nivel da PAGINA.
  it('lancamento-externo: quem so tem pagamentos_consultar VE o aviso (flag off + deducao) e NAO ve importar/fechar', async () => {
    mockUseHubAuth.mockReturnValue({ permissoes: ['adiantamentos.consultar', 'adiantamentos.pagamentos_consultar'] });
    mockResumoExterno.mockResolvedValue({ qtdDeducao: 2, totalDeducao: 60, qtdCredito: 0, totalCredito: 0, flagDescontoLigada: false });
    mockObterRepasse.mockResolvedValueOnce(REPASSE_ABERTO);
    render(<AdiantamentosRepassePage />);
    await waitFor(() => expect(screen.getByText('Joana Ribeiro')).toBeInTheDocument());
    const aviso = await screen.findByText(/2 valores pagos por fora/);
    expect(aviso.textContent).toContain('NÃO serão descontados');
    expect(screen.queryByRole('button', { name: /Importar pagos por fora/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Fechar apuração/ })).not.toBeInTheDocument();
  });

  it('lancamento-externo: quem tem pagamento_confirmar ve o botao de importar', async () => {
    mockObterRepasse.mockResolvedValueOnce(REPASSE_ABERTO);
    render(<AdiantamentosRepassePage />);
    await waitFor(() => expect(screen.getByText('Joana Ribeiro')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /Importar pagos por fora/ })).toBeInTheDocument();
  });

  it('lancamento-externo: SEM pagamentos_consultar a API recusa (403) e a tela NAO mostra dado nenhum (so o alerta de falha, nunca silencio)', async () => {
    mockUseHubAuth.mockReturnValue({ permissoes: ['adiantamentos.consultar'] });
    mockObterRepasse.mockRejectedValueOnce(new AdiantamentosApiError(403, 'Sem permissão', 'PERMISSAO_NEGADA'));
    mockResumoExterno.mockRejectedValue(new Error('403'));
    render(<AdiantamentosRepassePage />);
    await waitFor(() => expect(mockObterRepasse).toHaveBeenCalled());
    await screen.findByText(/Não foi possível verificar/);
    expect(screen.queryByText('Joana Ribeiro')).not.toBeInTheDocument();
    expect(screen.queryByText(/\d+ valores? pagos? por fora/)).not.toBeInTheDocument();
  });
});

// adiantamento-motorista (FASE 7, tasks.md 7.3.2/7.3.3/7.3.5, H02): estados
// de loading/erro/detalhe da tela de detalhe da solicitação — cálculo, conta
// mascarada, timeline de eventos, histórico de lotes e as ações de
// transição (rejeitar/recalcular/encerrar/atualizar-conta/reprocessar/
// encerrar sem pagamento).
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AdiantamentoDetalhePage from './page';
import { AdiantamentosApiError } from '@/lib/hub/adiantamentos-api';

const mockObterSolicitacao = vi.fn();
const mockRejeitarSolicitacao = vi.fn();
const mockRecalcularSolicitacao = vi.fn();
const mockEncerrarSolicitacao = vi.fn();
const mockAtualizarContaSolicitacao = vi.fn();
const mockReprocessarSolicitacao = vi.fn();
const mockEncerrarSemPagamento = vi.fn();
const mockRouterBack = vi.fn();
const mockRouterPush = vi.fn();
const mockUseHubAuth = vi.fn();

vi.mock('next/navigation', () => ({
  useParams: () => ({ id: '501' }),
  useRouter: () => ({ back: mockRouterBack, push: mockRouterPush }),
}));

vi.mock('@/contexts/hub-auth-context', () => ({
  useHubAuth: () => mockUseHubAuth(),
}));

vi.mock('@/lib/hub/adiantamentos-api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/hub/adiantamentos-api')>('@/lib/hub/adiantamentos-api');
  return {
    ...actual,
    obterSolicitacao: (...args: unknown[]) => mockObterSolicitacao(...args),
    rejeitarSolicitacao: (...args: unknown[]) => mockRejeitarSolicitacao(...args),
    recalcularSolicitacao: (...args: unknown[]) => mockRecalcularSolicitacao(...args),
    encerrarSolicitacao: (...args: unknown[]) => mockEncerrarSolicitacao(...args),
    atualizarContaSolicitacao: (...args: unknown[]) => mockAtualizarContaSolicitacao(...args),
    reprocessarSolicitacao: (...args: unknown[]) => mockReprocessarSolicitacao(...args),
    encerrarSemPagamento: (...args: unknown[]) => mockEncerrarSemPagamento(...args),
  };
});

const DETALHE_BASE = {
  id: 501,
  integrationId: 'ADV-000501',
  motorista: { entregadorId: 42, nome: 'Marta Queiroz' },
  dataSolicitacao: '2026-09-17',
  dataProducao: '2026-09-16',
  status: 'LIBERADA',
  motivoStatus: null,
  valorLiquido: '150.79',
  pendencias: [],
  loteId: null,
  calculo: {
    fonte: 'importacao', categorias: ['corrida'], producao: '251.90', porCategoria: null,
    percentual: 60, bruto: '151.14', taxa: '0.35', liquido: '150.79',
    calculadoEm: '2026-09-16T15:00:41Z', versaoConfiguracao: 3,
  },
  contaMascarada: {
    id: 1, status: 'APROVADA', origem: 'APP', banco: '237 · Bradesco', agencia: '3310',
    contaMascarada: '••••6624-4', tipoConta: 'CORRENTE' as const, titularNome: 'Marta Queiroz',
    documentoMascarado: '***.***.***-90', alertas: [], solicitadaEm: '2026-08-01T10:00:00Z', revisadaEm: null,
  },
  eventos: [
    { statusDe: null, statusPara: 'AGUARDANDO_CORTE', ocorridoEm: '2026-09-16T10:02:00Z', atorTipo: 'motorista', atorUsuarioId: null, motivo: null },
    { statusDe: 'AGUARDANDO_CORTE', statusPara: 'LIBERADA', ocorridoEm: '2026-09-16T15:00:41Z', atorTipo: 'sistema', atorUsuarioId: null, motivo: null },
  ],
  lotes: [],
};

describe('AdiantamentoDetalhePage', () => {
  beforeEach(() => {
    mockObterSolicitacao.mockReset();
    mockRejeitarSolicitacao.mockReset();
    mockRecalcularSolicitacao.mockReset();
    mockEncerrarSolicitacao.mockReset();
    mockAtualizarContaSolicitacao.mockReset();
    mockReprocessarSolicitacao.mockReset();
    mockEncerrarSemPagamento.mockReset();
    mockRouterBack.mockReset();
    mockRouterPush.mockReset();
    mockUseHubAuth.mockReturnValue({ permissoes: ['adiantamentos.consultar', 'adiantamentos.gerenciar', 'adiantamentos.reprocessar'] });
  });

  it('mostra loading e depois o cálculo, a conta mascarada e a timeline', async () => {
    mockObterSolicitacao.mockResolvedValueOnce(DETALHE_BASE);
    render(<AdiantamentoDetalhePage />);

    expect(screen.getByText('Carregando solicitação...')).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByText('ADV-000501').length).toBeGreaterThan(0));

    // Cálculo (produção 251,90 × 60% = 151,14 − 0,35 = 150,79)
    expect(screen.getByText('R$ 251,90')).toBeInTheDocument();
    expect(screen.getByText('60%')).toBeInTheDocument();
    expect(screen.getAllByText('R$ 150,79').length).toBeGreaterThan(0);

    // Conta mascarada
    expect(screen.getByText('237 · Bradesco')).toBeInTheDocument();
    expect(screen.getByText('••••6624-4')).toBeInTheDocument();

    // Timeline com rótulo traduzido (não o código cru)
    expect(screen.getByText('Solicitação recebida')).toBeInTheDocument();
    expect(screen.getAllByText('Adiantamento liberado').length).toBeGreaterThan(0);
  });

  it('solicitação sem cálculo ainda (AGUARDANDO_CORTE) mostra "Ainda não calculado"', async () => {
    mockObterSolicitacao.mockResolvedValueOnce({ ...DETALHE_BASE, status: 'AGUARDANDO_CORTE', calculo: null });
    render(<AdiantamentoDetalhePage />);
    await waitFor(() => expect(screen.getByText('Ainda não calculado.')).toBeInTheDocument());
  });

  it('motivoStatus presente (ex.: rejeitada) aparece em destaque', async () => {
    mockObterSolicitacao.mockResolvedValueOnce({ ...DETALHE_BASE, status: 'REJEITADA', motivoStatus: 'Vínculo com o motorista não confirmado.' });
    render(<AdiantamentoDetalhePage />);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Vínculo com o motorista não confirmado.'));
  });

  it('erro de rede mostra a mensagem e permite tentar novamente', async () => {
    mockObterSolicitacao.mockRejectedValueOnce(new AdiantamentosApiError(404, 'Solicitação não encontrada.'));
    render(<AdiantamentoDetalhePage />);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Solicitação não encontrada.'));
    expect(screen.getByRole('button', { name: /Tentar novamente/ })).toBeInTheDocument();
  });

  // ── 7.3.3/7.3.5 — ações por status (gate igual ao das RPCs hub_adiantamento_*) ──

  it('LIBERADA com "gerenciar" mostra Atualizar conta e Rejeitar, não Recalcular/Encerrar/Reprocessar', async () => {
    mockObterSolicitacao.mockResolvedValueOnce(DETALHE_BASE); // status: LIBERADA
    render(<AdiantamentoDetalhePage />);
    await waitFor(() => expect(screen.getAllByText('ADV-000501').length).toBeGreaterThan(0));

    expect(screen.getByRole('button', { name: /Atualizar conta/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Rejeitar$/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Recalcular$/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Encerrar$/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Reprocessar$/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Encerrar sem pagamento/ })).not.toBeInTheDocument();
  });

  it('AGUARDANDO_PRODUCAO mostra Recalcular e Encerrar (além de Rejeitar), não Atualizar conta', async () => {
    mockObterSolicitacao.mockResolvedValueOnce({ ...DETALHE_BASE, status: 'AGUARDANDO_PRODUCAO' });
    render(<AdiantamentoDetalhePage />);
    await waitFor(() => expect(screen.getAllByText('ADV-000501').length).toBeGreaterThan(0));

    expect(screen.getByRole('button', { name: /^Recalcular$/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Encerrar$/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Rejeitar$/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Atualizar conta/ })).not.toBeInTheDocument();
  });

  it('FALHOU com "reprocessar" mostra Reprocessar e Encerrar sem pagamento, não Rejeitar', async () => {
    mockObterSolicitacao.mockResolvedValueOnce({ ...DETALHE_BASE, status: 'FALHOU' });
    render(<AdiantamentoDetalhePage />);
    await waitFor(() => expect(screen.getAllByText('ADV-000501').length).toBeGreaterThan(0));

    expect(screen.getByRole('button', { name: /^Reprocessar$/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Encerrar sem pagamento/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Rejeitar$/ })).not.toBeInTheDocument();
  });

  it('sem a permissão "gerenciar"/"reprocessar" nenhum botão de ação aparece', async () => {
    mockUseHubAuth.mockReturnValue({ permissoes: ['adiantamentos.consultar'] });
    mockObterSolicitacao.mockResolvedValueOnce(DETALHE_BASE);
    render(<AdiantamentoDetalhePage />);
    await waitFor(() => expect(screen.getAllByText('ADV-000501').length).toBeGreaterThan(0));

    expect(screen.queryByRole('button', { name: /Atualizar conta/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Rejeitar$/ })).not.toBeInTheDocument();
  });

  it('Rejeitar: motivo obrigatório (<3 chars) mantém confirmar desabilitado; com motivo válido chama a API e re-busca o detalhe', async () => {
    mockObterSolicitacao.mockResolvedValueOnce(DETALHE_BASE);
    mockRejeitarSolicitacao.mockResolvedValueOnce({ ...DETALHE_BASE, status: 'REJEITADA' });
    mockObterSolicitacao.mockResolvedValueOnce({ ...DETALHE_BASE, status: 'REJEITADA', motivoStatus: 'Não confere.' });
    render(<AdiantamentoDetalhePage />);
    await waitFor(() => expect(screen.getAllByText('ADV-000501').length).toBeGreaterThan(0));

    fireEvent.click(screen.getByRole('button', { name: /^Rejeitar$/ }));
    const confirmar = await screen.findByRole('button', { name: /Rejeitar solicitação/ });
    expect(confirmar).toBeDisabled();

    const textarea = screen.getByLabelText(/Motivo \(obrigatório\)/);
    fireEvent.change(textarea, { target: { value: 'ok' } }); // 2 chars — ainda < 3
    expect(confirmar).toBeDisabled();

    fireEvent.change(textarea, { target: { value: 'Não confere.' } });
    expect(confirmar).not.toBeDisabled();
    fireEvent.click(confirmar);

    await waitFor(() => expect(mockRejeitarSolicitacao).toHaveBeenCalledWith(501, 'Não confere.'));
    await waitFor(() => expect(mockObterSolicitacao).toHaveBeenCalledTimes(2));
  });

  it('Recalcular: sem motivo, confirmar habilitado de cara e chama a API sem argumento extra', async () => {
    mockObterSolicitacao.mockResolvedValueOnce({ ...DETALHE_BASE, status: 'AGUARDANDO_PRODUCAO' });
    mockRecalcularSolicitacao.mockResolvedValueOnce({ ...DETALHE_BASE, status: 'LIBERADA' });
    mockObterSolicitacao.mockResolvedValueOnce({ ...DETALHE_BASE, status: 'LIBERADA' });
    render(<AdiantamentoDetalhePage />);
    await waitFor(() => expect(screen.getAllByText('ADV-000501').length).toBeGreaterThan(0));

    fireEvent.click(screen.getByRole('button', { name: /^Recalcular$/ }));
    const dialog = await screen.findByRole('dialog');
    // O gatilho do header também se chama "Recalcular" — escopar ao diálogo.
    const botaoConfirmar = within(dialog).getByRole('button', { name: /^Recalcular$/ });
    expect(botaoConfirmar).not.toBeDisabled();
    fireEvent.click(botaoConfirmar);

    await waitFor(() => expect(mockRecalcularSolicitacao).toHaveBeenCalledWith(501));
    await waitFor(() => expect(mockObterSolicitacao).toHaveBeenCalledTimes(2));
  });

  it('Encerrar sem pagamento (D-23): erro da API mantém o diálogo aberto com a mensagem', async () => {
    mockObterSolicitacao.mockResolvedValueOnce({ ...DETALHE_BASE, status: 'FALHOU' });
    mockEncerrarSemPagamento.mockRejectedValueOnce(new AdiantamentosApiError(409, 'Essa ação não é permitida no status atual.'));
    render(<AdiantamentoDetalhePage />);
    await waitFor(() => expect(screen.getAllByText('ADV-000501').length).toBeGreaterThan(0));

    fireEvent.click(screen.getByRole('button', { name: /Encerrar sem pagamento/ }));
    const dialog = await screen.findByRole('dialog');
    const textarea = within(dialog).getByLabelText(/Motivo \(obrigatório\)/);
    fireEvent.change(textarea, { target: { value: 'Cliente cancelou.' } });
    // O gatilho do header também se chama "Encerrar sem pagamento" — escopar ao diálogo.
    fireEvent.click(within(dialog).getByRole('button', { name: /^Encerrar sem pagamento$/ }));

    await waitFor(() => expect(mockEncerrarSemPagamento).toHaveBeenCalledWith(501, 'Cliente cancelou.'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Essa ação não é permitida no status atual.');
    // Diálogo continua aberto (não fechou em erro) — textarea ainda visível.
    expect(screen.getByLabelText(/Motivo \(obrigatório\)/)).toBeInTheDocument();
  });
});

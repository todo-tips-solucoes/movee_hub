// hub-motoristas (S5) FASE 7 task 7.1.1/7.1.2/7.1.4 — renderização da lista
// (tabela + filtros), estados de loading/vazio/erro, paginação, gate de
// permissão da ação de detalhe (motoristas.consultar) e modal de detalhe
// rápido (uiux-hub pós-F4: "Detalhes" abre modal com os campos do legado).
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import MotoristasPage from './page';
import { MotoristaApiError } from '@/lib/hub/motoristas-api';

const mockUseHubAuth = vi.fn();
const mockListarMotoristas = vi.fn();
const mockObterMotorista = vi.fn();
const mockListarAreasMotoristas = vi.fn();
const mockCriarMotorista = vi.fn();

vi.mock('@/contexts/hub-auth-context', () => ({
  useHubAuth: () => mockUseHubAuth(),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('@/lib/hub/motoristas-api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/hub/motoristas-api')>('@/lib/hub/motoristas-api');
  return {
    ...actual,
    listarMotoristas: (...args: unknown[]) => mockListarMotoristas(...args),
    obterMotorista: (...args: unknown[]) => mockObterMotorista(...args),
    listarAreasMotoristas: (...args: unknown[]) => mockListarAreasMotoristas(...args),
    criarMotorista: (...args: unknown[]) => mockCriarMotorista(...args),
  };
});

const ITEM_BASE = {
  id: 1,
  nome: 'Fulano da Silva',
  idExterno: '11111111-1111-1111-1111-111111111111',
  ativo: true,
  comVinculo: true,
  areas: ['Zona Sul', 'Centro'],
};

const DETALHE_BASE = {
  id: 1,
  nome: 'Fulano da Silva',
  idExterno: '11111111-1111-1111-1111-111111111111',
  ativo: true,
  nomeEditadoManualmente: false,
  areas: [],
  resumo: { totalFaturamento: 0, totalPerformance: 0, dataMaisRecente: null },
  vinculo: { contaMotoristaId: 7, nome: 'Fulano Conta', cnpjPrestadorMascarado: '**.***.***/0001-95' },
};

function withPermissoes(permissoes: string[]) {
  mockUseHubAuth.mockReturnValue({ permissoes });
}

describe('MotoristasPage', () => {
  beforeEach(() => {
    mockUseHubAuth.mockReset();
    mockListarMotoristas.mockReset();
    mockObterMotorista.mockReset();
    mockListarAreasMotoristas.mockReset();
    mockCriarMotorista.mockReset();
    mockListarAreasMotoristas.mockResolvedValue(['Centro', 'Zona Sul']);
    withPermissoes(['motoristas.listar', 'motoristas.consultar']);
  });

  it('mostra loading e depois a tabela com os itens da lista', async () => {
    mockListarMotoristas.mockResolvedValueOnce({ items: [ITEM_BASE], total: 1, page: 1, pageSize: 20 });
    render(<MotoristasPage />);

    expect(screen.getByText('Carregando motoristas...')).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByText('Fulano da Silva').length).toBeGreaterThan(0));
  });

  it('estado vazio: nenhum motorista encontrado (FR-002 Edge Case)', async () => {
    mockListarMotoristas.mockResolvedValueOnce({ items: [], total: 0, page: 1, pageSize: 20 });
    render(<MotoristasPage />);
    await waitFor(() => expect(screen.getByText('Nenhum motorista encontrado')).toBeInTheDocument());
  });

  it('estado de erro: mostra mensagem + botão de retry que refaz a busca', async () => {
    mockListarMotoristas.mockRejectedValueOnce(new MotoristaApiError(500, 'Erro no servidor. Tente novamente.'));
    render(<MotoristasPage />);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Erro no servidor'));

    mockListarMotoristas.mockResolvedValueOnce({ items: [ITEM_BASE], total: 1, page: 1, pageSize: 20 });
    fireEvent.click(screen.getByRole('button', { name: 'Tentar novamente' }));
    await waitFor(() => expect(mockListarMotoristas).toHaveBeenCalledTimes(2));
  });

  it('badges de situação e vínculo refletem o item', async () => {
    mockListarMotoristas.mockResolvedValueOnce({
      items: [{ ...ITEM_BASE, ativo: false, comVinculo: false }],
      total: 1,
      page: 1,
      pageSize: 20,
    });
    render(<MotoristasPage />);
    await waitFor(() => expect(screen.getAllByText('Inativo').length).toBeGreaterThan(0));
    expect(screen.getAllByText('Sem vínculo').length).toBeGreaterThan(0);
  });

  it('gate de permissão: sem motoristas.consultar, a ação de detalhe não aparece na tabela desktop', async () => {
    withPermissoes(['motoristas.listar']);
    mockListarMotoristas.mockResolvedValueOnce({ items: [ITEM_BASE], total: 1, page: 1, pageSize: 20 });
    render(<MotoristasPage />);
    await waitFor(() => expect(screen.getAllByText('Fulano da Silva').length).toBeGreaterThan(0));
    expect(screen.queryByRole('button', { name: /Detalhes/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Detalhes/ })).not.toBeInTheDocument();
  });

  it('ação "Detalhes" abre o modal com os campos do legado (nome, CNPJ, cadastro, situação)', async () => {
    mockListarMotoristas.mockResolvedValueOnce({ items: [ITEM_BASE], total: 1, page: 1, pageSize: 20 });
    mockObterMotorista.mockResolvedValueOnce(DETALHE_BASE);
    render(<MotoristasPage />);
    await waitFor(() => expect(screen.getAllByText('Fulano da Silva').length).toBeGreaterThan(0));

    fireEvent.click(screen.getByRole('button', { name: /Detalhes/ }));
    expect(mockObterMotorista).toHaveBeenCalledWith(1);

    await waitFor(() => expect(screen.getByText('Detalhes do motorista')).toBeInTheDocument());
    expect(screen.getByText('**.***.***/0001-95')).toBeInTheDocument();
    expect(screen.getAllByText('Vinculado').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Ativo').length).toBeGreaterThan(0);
    expect(screen.getAllByText(DETALHE_BASE.idExterno).length).toBeGreaterThan(0);
    expect(screen.getByRole('link', { name: /Ver página completa/ })).toHaveAttribute(
      'href',
      '/hub/dashboard/motoristas/1'
    );
  });

  it('modal de detalhe sem vínculo: CNPJ vazio e badge "Sem vínculo"', async () => {
    mockListarMotoristas.mockResolvedValueOnce({ items: [{ ...ITEM_BASE, comVinculo: false }], total: 1, page: 1, pageSize: 20 });
    mockObterMotorista.mockResolvedValueOnce({ ...DETALHE_BASE, vinculo: null });
    render(<MotoristasPage />);
    await waitFor(() => expect(screen.getAllByText('Fulano da Silva').length).toBeGreaterThan(0));

    fireEvent.click(screen.getByRole('button', { name: /Detalhes/ }));
    await waitFor(() => expect(screen.getByText('Detalhes do motorista')).toBeInTheDocument());
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Sem vínculo').length).toBeGreaterThan(0);
  });

  it('modal de detalhe: erro na busca mostra alerta com retry', async () => {
    mockListarMotoristas.mockResolvedValueOnce({ items: [ITEM_BASE], total: 1, page: 1, pageSize: 20 });
    mockObterMotorista.mockRejectedValueOnce(new MotoristaApiError(500, 'Erro no servidor. Tente novamente.'));
    render(<MotoristasPage />);
    await waitFor(() => expect(screen.getAllByText('Fulano da Silva').length).toBeGreaterThan(0));

    fireEvent.click(screen.getByRole('button', { name: /Detalhes/ }));
    await waitFor(() =>
      expect(screen.getAllByRole('alert').some((el) => el.textContent?.includes('Erro no servidor'))).toBe(true)
    );

    mockObterMotorista.mockResolvedValueOnce(DETALHE_BASE);
    fireEvent.click(screen.getByRole('button', { name: 'Tentar novamente' }));
    await waitFor(() => expect(screen.getByText('**.***.***/0001-95')).toBeInTheDocument());
  });

  it('filtro de nome dispara nova busca com o filtro aplicado', async () => {
    mockListarMotoristas.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 });
    render(<MotoristasPage />);
    await waitFor(() => expect(mockListarMotoristas).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByLabelText('Nome'), { target: { value: 'Fulano' } });
    await waitFor(() => expect(mockListarMotoristas).toHaveBeenCalledTimes(2));
    expect(mockListarMotoristas.mock.calls[1][0]).toMatchObject({ nome: 'Fulano' });
  });

  it('filtro de área: combobox lista as subpraças do endpoint e envia area na busca', async () => {
    mockListarMotoristas.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 });
    render(<MotoristasPage />);
    await waitFor(() => expect(mockListarMotoristas).toHaveBeenCalledTimes(1));

    const combo = screen.getByRole('combobox', { name: 'Área (subpraça)' });
    await waitFor(() => expect(combo).toHaveTextContent('Zona Sul'));
    expect(combo).toHaveTextContent('Todas');
    expect(combo).toHaveTextContent('Centro');

    fireEvent.change(combo, { target: { value: 'Zona Sul' } });
    await waitFor(() => expect(mockListarMotoristas).toHaveBeenCalledTimes(2));
    expect(mockListarMotoristas.mock.calls[1][0]).toMatchObject({ area: 'Zona Sul' });
  });

  it('filtro de área: falha ao carregar opções degrada para só "Todas" sem quebrar a lista', async () => {
    mockListarAreasMotoristas.mockReset();
    mockListarAreasMotoristas.mockRejectedValue(new MotoristaApiError(500, 'Erro no servidor.'));
    mockListarMotoristas.mockResolvedValue({ items: [ITEM_BASE], total: 1, page: 1, pageSize: 20 });
    render(<MotoristasPage />);
    await waitFor(() => expect(screen.getAllByText('Fulano da Silva').length).toBeGreaterThan(0));

    const combo = screen.getByRole('combobox', { name: 'Área (subpraça)' });
    expect(combo).toHaveTextContent('Todas');
    expect(combo).not.toHaveTextContent('Zona Sul');
  });

  it('filtro de situação envia ativo como boolean', async () => {
    mockListarMotoristas.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 });
    render(<MotoristasPage />);
    await waitFor(() => expect(mockListarMotoristas).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByRole('combobox', { name: 'Situação' }), { target: { value: 'true' } });
    await waitFor(() => expect(mockListarMotoristas).toHaveBeenCalledTimes(2));
    expect(mockListarMotoristas.mock.calls[1][0]).toMatchObject({ ativo: true });
  });

  it('paginação: botão Próxima/Anterior desabilitados quando há só 1 página', async () => {
    mockListarMotoristas.mockResolvedValueOnce({ items: [ITEM_BASE], total: 1, page: 1, pageSize: 20 });
    render(<MotoristasPage />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Próxima' })).toBeDisabled());
    expect(screen.getByRole('button', { name: 'Anterior' })).toBeDisabled();
  });

  it('identificador (uuid) copiável aparece na listagem (FR-016, task 4.3.2)', async () => {
    mockListarMotoristas.mockResolvedValueOnce({ items: [ITEM_BASE], total: 1, page: 1, pageSize: 20 });
    render(<MotoristasPage />);
    await waitFor(() => expect(screen.getAllByText(ITEM_BASE.idExterno).length).toBeGreaterThan(0));
    expect(
      screen.getAllByRole('button', { name: `Copiar identificador de ${ITEM_BASE.nome}` }).length
    ).toBeGreaterThan(0);
  });

  it('gate de permissão: sem motoristas.editar, o botão "Novo motorista" não aparece', async () => {
    mockListarMotoristas.mockResolvedValueOnce({ items: [], total: 0, page: 1, pageSize: 20 });
    render(<MotoristasPage />);
    await waitFor(() => expect(mockListarMotoristas).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: 'Novo motorista' })).not.toBeInTheDocument();
  });
});

describe('MotoristasPage — CriarMotoristaDialog (FASE 4, task 4.3)', () => {
  beforeEach(() => {
    mockUseHubAuth.mockReset();
    mockListarMotoristas.mockReset();
    mockObterMotorista.mockReset();
    mockListarAreasMotoristas.mockReset();
    mockCriarMotorista.mockReset();
    mockListarAreasMotoristas.mockResolvedValue([]);
    mockListarMotoristas.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 });
    withPermissoes(['motoristas.listar', 'motoristas.consultar', 'motoristas.editar']);
  });

  async function abrirDialog() {
    render(<MotoristasPage />);
    await waitFor(() => expect(mockListarMotoristas).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: 'Novo motorista' }));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Novo motorista' })).toBeInTheDocument());
    return within(screen.getByRole('dialog'));
  }

  it('campo uuid ausente bloqueia o submit no cliente (nunca chama a API)', async () => {
    const dialog = await abrirDialog();
    fireEvent.change(dialog.getByLabelText('Nome'), { target: { value: 'Fulano da Silva' } });
    fireEvent.click(dialog.getByRole('button', { name: 'Cadastrar motorista' }));
    await waitFor(() =>
      expect(dialog.getByText('Informe o identificador (uuid) da planilha de origem.')).toBeInTheDocument()
    );
    expect(mockCriarMotorista).not.toHaveBeenCalled();
  });

  it('uuid em formato inválido exibe erro claro e bloqueia o submit no cliente', async () => {
    const dialog = await abrirDialog();
    fireEvent.change(dialog.getByLabelText('Nome'), { target: { value: 'Fulano da Silva' } });
    fireEvent.change(dialog.getByLabelText('Identificador (uuid)'), { target: { value: 'nao-e-um-uuid' } });
    fireEvent.click(dialog.getByRole('button', { name: 'Cadastrar motorista' }));
    await waitFor(() => expect(dialog.getByText('Formato de identificador (uuid) inválido.')).toBeInTheDocument());
    expect(mockCriarMotorista).not.toHaveBeenCalled();
  });

  it('submissão válida chama a API, fecha o diálogo e atualiza a lista', async () => {
    mockCriarMotorista.mockResolvedValueOnce({
      id: 10,
      idExterno: '11111111-1111-1111-1111-111111111111',
      nome: 'Fulano da Silva',
      ativo: true,
    });
    const dialog = await abrirDialog();
    fireEvent.change(dialog.getByLabelText('Nome'), { target: { value: 'Fulano da Silva' } });
    fireEvent.change(dialog.getByLabelText('Identificador (uuid)'), {
      target: { value: '11111111-1111-1111-1111-111111111111' },
    });
    fireEvent.click(dialog.getByRole('button', { name: 'Cadastrar motorista' }));

    await waitFor(() =>
      expect(mockCriarMotorista).toHaveBeenCalledWith({
        nome: 'Fulano da Silva',
        idExterno: '11111111-1111-1111-1111-111111111111',
      })
    );
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Novo motorista' })).not.toBeInTheDocument());
    // refetch da lista após criar (h.refetch)
    await waitFor(() => expect(mockListarMotoristas).toHaveBeenCalledTimes(2));
  });

  it('uuid duplicado (409) exibe erro claro no campo, sem fechar o diálogo', async () => {
    mockCriarMotorista.mockRejectedValueOnce(
      new MotoristaApiError(409, 'Este identificador (uuid) já pertence a outro motorista desta empresa.', 'uuid_duplicado')
    );
    const dialog = await abrirDialog();
    fireEvent.change(dialog.getByLabelText('Nome'), { target: { value: 'Fulano da Silva' } });
    fireEvent.change(dialog.getByLabelText('Identificador (uuid)'), {
      target: { value: '11111111-1111-1111-1111-111111111111' },
    });
    fireEvent.click(dialog.getByRole('button', { name: 'Cadastrar motorista' }));

    await waitFor(() =>
      expect(dialog.getByText('Este identificador (uuid) já pertence a outro motorista desta empresa.')).toBeInTheDocument()
    );
    expect(screen.getByRole('heading', { name: 'Novo motorista' })).toBeInTheDocument();
  });
});

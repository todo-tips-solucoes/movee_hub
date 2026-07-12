// hub-motoristas (S5) FASE 7 task 7.1.1/7.1.2/7.1.4 — renderização da lista
// (tabela + filtros), estados de loading/vazio/erro, paginação e gate de
// permissão do link de detalhe (motoristas.consultar).
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import MotoristasPage from './page';
import { MotoristaApiError } from '@/lib/hub/motoristas-api';

const mockUseHubAuth = vi.fn();
const mockListarMotoristas = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('@/contexts/hub-auth-context', () => ({
  useHubAuth: () => mockUseHubAuth(),
}));

vi.mock('@/lib/hub/motoristas-api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/hub/motoristas-api')>('@/lib/hub/motoristas-api');
  return {
    ...actual,
    listarMotoristas: (...args: unknown[]) => mockListarMotoristas(...args),
  };
});

const ITEM_BASE = {
  id: 1,
  nome: 'Fulano da Silva',
  ativo: true,
  comVinculo: true,
  areas: ['Zona Sul', 'Centro'],
};

function withPermissoes(permissoes: string[]) {
  mockUseHubAuth.mockReturnValue({ permissoes });
}

describe('MotoristasPage', () => {
  beforeEach(() => {
    mockUseHubAuth.mockReset();
    mockListarMotoristas.mockReset();
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

  it('gate de permissão: sem motoristas.consultar, o link de detalhe não aparece na tabela desktop', async () => {
    withPermissoes(['motoristas.listar']);
    mockListarMotoristas.mockResolvedValueOnce({ items: [ITEM_BASE], total: 1, page: 1, pageSize: 20 });
    render(<MotoristasPage />);
    await waitFor(() => expect(screen.getAllByText('Fulano da Silva').length).toBeGreaterThan(0));
    expect(screen.queryByRole('link', { name: /Detalhes/ })).not.toBeInTheDocument();
  });

  it('filtro de nome dispara nova busca com o filtro aplicado', async () => {
    mockListarMotoristas.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 });
    render(<MotoristasPage />);
    await waitFor(() => expect(mockListarMotoristas).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByLabelText('Nome'), { target: { value: 'Fulano' } });
    await waitFor(() => expect(mockListarMotoristas).toHaveBeenCalledTimes(2));
    expect(mockListarMotoristas.mock.calls[1][0]).toMatchObject({ nome: 'Fulano' });
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
});

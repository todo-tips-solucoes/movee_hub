// hub-avisos (push-motorista, FASE 7 — tasks.md 7.2, complemento do E2E
// deferido à FASE 9 — SC-011 fica coberto ali com o fixture completo):
// estados de loading/vazio/erro da lista, os NÚMEROS da cobertura (7.2.1) e
// o gate de permissão do botão "Novo aviso" (7.2.3).
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AvisosPage from './page';
import { AvisoApiError } from '@/lib/hub/avisos-api';

const mockUseHubAuth = vi.fn();
const mockListarAvisos = vi.fn();
const mockObterCobertura = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
}));

vi.mock('@/contexts/hub-auth-context', () => ({
  useHubAuth: () => mockUseHubAuth(),
}));

vi.mock('@/lib/hub/avisos-api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/hub/avisos-api')>('@/lib/hub/avisos-api');
  return {
    ...actual,
    listarAvisos: (...args: unknown[]) => mockListarAvisos(...args),
    obterCobertura: (...args: unknown[]) => mockObterCobertura(...args),
  };
});

const ITEM_BASE = {
  id: 3,
  titulo: 'Manutenção programada',
  status: 'concluido' as const,
  modoDestinatarios: 'toda_base' as const,
  criadoEm: '2026-09-01T10:00:00Z',
  contagens: { visados: 20, pendentes: 0, aceitos: 18, falhas: 1, mortas: 1 },
};

const COBERTURA_FIXTURE = {
  ativos: { android: 40, ios: 25, desktopOutros: 5 },
  impedidos: { iosSemInstalacao: 3, bloqueadas: 2, semSuporte: 1 },
  naoAtivadas: 7,
};

function withPermissoes(permissoes: string[]) {
  mockUseHubAuth.mockReturnValue({ permissoes });
}

describe('AvisosPage', () => {
  beforeEach(() => {
    mockUseHubAuth.mockReset();
    mockListarAvisos.mockReset();
    mockObterCobertura.mockReset();
    withPermissoes(['avisos.consultar', 'avisos.enviar']);
    mockObterCobertura.mockResolvedValue(COBERTURA_FIXTURE);
  });

  it('mostra loading e depois a tabela com os itens da lista', async () => {
    mockListarAvisos.mockResolvedValueOnce({ itens: [ITEM_BASE], total: 1, page: 1, pageSize: 20 });
    render(<AvisosPage />);

    expect(screen.getByText('Carregando avisos...')).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByText('Manutenção programada').length).toBeGreaterThan(0));
  });

  it('7.2.1 — cobertura mostra as 3 categorias de ativos e as 3 de impedidos com os números do fixture', async () => {
    mockListarAvisos.mockResolvedValueOnce({ itens: [], total: 0, page: 1, pageSize: 20 });
    render(<AvisosPage />);

    await waitFor(() => expect(screen.getByText('40')).toBeInTheDocument()); // android
    expect(screen.getByText('25')).toBeInTheDocument(); // ios
    expect(screen.getByText('5')).toBeInTheDocument(); // desktopOutros
    expect(screen.getByText('3')).toBeInTheDocument(); // iosSemInstalacao
    expect(screen.getByText('2')).toBeInTheDocument(); // bloqueadas
    expect(screen.getByText('1')).toBeInTheDocument(); // semSuporte
    expect(screen.getByText('7')).toBeInTheDocument(); // naoAtivadas
  });

  it('estado vazio: nenhum aviso enviado', async () => {
    mockListarAvisos.mockResolvedValueOnce({ itens: [], total: 0, page: 1, pageSize: 20 });
    render(<AvisosPage />);
    await waitFor(() => expect(screen.getByText('Nenhum aviso enviado')).toBeInTheDocument());
  });

  it('estado de erro: mostra mensagem + botão de retry que refaz a busca', async () => {
    mockListarAvisos.mockRejectedValueOnce(new AvisoApiError(500, 'Erro no servidor. Tente novamente em instantes.'));
    render(<AvisosPage />);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Erro no servidor'));

    mockListarAvisos.mockResolvedValueOnce({ itens: [ITEM_BASE], total: 1, page: 1, pageSize: 20 });
    fireEvent.click(screen.getByRole('button', { name: 'Tentar novamente' }));
    await waitFor(() => expect(mockListarAvisos).toHaveBeenCalledTimes(2));
  });

  it('7.2.3 — botão "Novo aviso" só aparece com avisos.enviar', async () => {
    withPermissoes(['avisos.consultar']);
    mockListarAvisos.mockResolvedValueOnce({ itens: [ITEM_BASE], total: 1, page: 1, pageSize: 20 });
    render(<AvisosPage />);
    await waitFor(() => expect(screen.getAllByText('Manutenção programada').length).toBeGreaterThan(0));
    expect(screen.queryByRole('button', { name: 'Novo aviso' })).not.toBeInTheDocument();
  });
});

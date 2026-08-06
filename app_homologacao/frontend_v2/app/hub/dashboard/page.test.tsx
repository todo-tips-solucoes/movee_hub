// hub-shell (S3) task 5.1.4 — teste unitário dos 2 cenários exigidos:
// N>0 módulos renderiza um card por módulo (levando à rota certa) e N=0
// mostra a mensagem de estado vazio (FR-010), nunca uma tela em branco.
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import DashboardPage from './page';

const mockUseHubAuth = vi.fn();

vi.mock('@/contexts/hub-auth-context', () => ({
  useHubAuth: () => mockUseHubAuth(),
}));

function withModulos(
  modulos: Array<{ codigo: string; nome: string; icone: string | null; ordem: number }>,
  usuario: { id: number; email: string; nome: string } | null = {
    id: 1,
    email: 'pessoa@exemplo.com',
    nome: 'Pessoa Exemplo',
  }
) {
  mockUseHubAuth.mockReturnValue({ modulos, usuario });
}

describe('DashboardPage', () => {
  it('N>0: renderiza um card por módulo, cada um levando a /hub/dashboard/<codigo>', () => {
    withModulos([
      { codigo: 'faturamento', nome: 'Faturamento', icone: 'receipt', ordem: 20 },
      { codigo: 'motoristas', nome: 'Motoristas', icone: 'truck', ordem: 10 },
    ]);

    render(<DashboardPage />);

    const links = screen.getAllByRole('link');
    expect(links.length).toBe(2);
    // ordenado por `ordem` (defensivo, mesmo critério do ModuleNav)
    expect(links[0]).toHaveAttribute('href', '/hub/dashboard/motoristas');
    expect(links[1]).toHaveAttribute('href', '/hub/dashboard/faturamento');
    expect(screen.getByText('Motoristas')).toBeInTheDocument();
    expect(screen.getByText('Faturamento')).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('N=0: mostra mensagem clara de estado vazio, sem tela em branco (FR-010)', () => {
    withModulos([]);

    render(<DashboardPage />);

    expect(screen.queryAllByRole('link').length).toBe(0);
    expect(screen.getByRole('status')).toHaveTextContent('Nenhum módulo disponível');
  });

  it('carregando: mostra skeleton e NUNCA o estado vazio (corrida do /me em voo)', () => {
    // impeccable harden 2026-08-06: com o `/me` em voo, `modulos` ainda é []
    // — sem o guard de `carregando`, o "Nenhum módulo disponível" aparecia
    // por engano na primeira carga pós-login.
    mockUseHubAuth.mockReturnValue({ modulos: [], usuario: null, carregando: true });

    render(<DashboardPage />);

    expect(screen.getByText('Carregando módulos...')).toBeInTheDocument();
    expect(screen.queryByText(/Nenhum módulo disponível/)).not.toBeInTheDocument();
  });

  it('exibe saudação com o nome do usuário da sessão', () => {
    withModulos([{ codigo: 'admin', nome: 'Administração', icone: null, ordem: 1 }]);

    render(<DashboardPage />);

    expect(screen.getByRole('heading', { name: 'Olá, Pessoa Exemplo' })).toBeInTheDocument();
  });
});

// repasse-saldo-minimo F2 (tasks.md 2.4.6, contracts/hub-usuarios-trava.md
// "Tela de Usuários") — o seletor de papel da tela de Usuários esconde os
// papéis restritos (admin_plataforma, financeiro_aprovador) de quem não é
// admin_plataforma. Mesmo molde de
// app/hub/dashboard/adiantamentos/contas/page.test.tsx.
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import UsuariosPage from './page';

const mockUseHubAuth = vi.fn();
const mockListarUsuarios = vi.fn();
const mockListarPapeisMatriz = vi.fn();

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

vi.mock('@/contexts/hub-auth-context', () => ({
  useHubAuth: () => mockUseHubAuth(),
}));

vi.mock('@/lib/hub/usuarios-api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/hub/usuarios-api')>('@/lib/hub/usuarios-api');
  return {
    ...actual,
    listarUsuarios: (...args: unknown[]) => mockListarUsuarios(...args),
  };
});

vi.mock('@/lib/hub/admin-api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/hub/admin-api')>('@/lib/hub/admin-api');
  return {
    ...actual,
    listarPapeisMatriz: (...args: unknown[]) => mockListarPapeisMatriz(...args),
  };
});

// Catálogo com o papel restrito listado ANTES do não-restrito — se o
// componente não filtrar, `papeis[0]` (default do seletor no diálogo "Novo
// usuário") é o restrito e o gatilho do Select exibe seu rótulo.
const PAPEIS_CATALOGO = [
  { id: 2, nome: 'admin_plataforma', escopo: 'plataforma', isSistema: true },
  { id: 1, nome: 'operador', escopo: 'entidade', isSistema: true },
];

describe('UsuariosPage — seletor de papel x papéis restritos', () => {
  beforeEach(() => {
    mockUseHubAuth.mockReset();
    mockListarUsuarios.mockReset();
    mockListarPapeisMatriz.mockReset();
    mockListarUsuarios.mockResolvedValue({ usuarios: [], total: 0, page: 1, pageSize: 20 });
    mockListarPapeisMatriz.mockResolvedValue({
      papeis: PAPEIS_CATALOGO, permissoes: [], matriz: [], podeEditar: false,
    });
  });

  it('admin_entidade (sem admin.gerenciar): o default do seletor pula o papel restrito', async () => {
    mockUseHubAuth.mockReturnValue({ entidadeAtiva: 6, permissoes: ['usuarios.gerenciar'] });
    render(<UsuariosPage />);

    await waitFor(() => expect(screen.getByText('Nenhum usuário encontrado')).toBeInTheDocument());
    screen.getAllByRole('button', { name: /Novo usuário/i })[0].click();

    await waitFor(() => expect(screen.getByText('Operador')).toBeInTheDocument());
    expect(screen.queryByText('Administrador da plataforma')).not.toBeInTheDocument();
  });

  it('admin_plataforma (com admin.gerenciar): o papel restrito continua disponível', async () => {
    mockUseHubAuth.mockReturnValue({ entidadeAtiva: 6, permissoes: ['usuarios.gerenciar', 'admin.gerenciar'] });
    render(<UsuariosPage />);

    await waitFor(() => expect(screen.getByText('Nenhum usuário encontrado')).toBeInTheDocument());
    screen.getAllByRole('button', { name: /Novo usuário/i })[0].click();

    await waitFor(() => expect(screen.getByText('Administrador da plataforma')).toBeInTheDocument());
  });
});

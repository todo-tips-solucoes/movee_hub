// hub-shell (S3) task 4.4.5 — teste unitário: exibição correta dos dados +
// acionamento do fluxo de troca de senha (reuso de recuperarSenha, decisão
// da task 1.2.3) + logout (task 4.5.1).
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import PerfilPage from './page';
import { HubApiError } from '@/contexts/hub-auth-context';

const mockRecuperarSenha = vi.fn();
const mockLogout = vi.fn();
const mockReplace = vi.fn();

vi.mock('@/contexts/hub-auth-context', async () => {
  const actual = await vi.importActual<typeof import('@/contexts/hub-auth-context')>(
    '@/contexts/hub-auth-context'
  );
  return {
    ...actual,
    useHubAuth: () => ({
      usuario: { id: 1, email: 'pessoa@exemplo.com', nome: 'Pessoa Exemplo' },
      recuperarSenha: mockRecuperarSenha,
      logout: mockLogout,
    }),
  };
});

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mockReplace }),
}));

describe('PerfilPage', () => {
  beforeEach(() => {
    mockRecuperarSenha.mockReset();
    mockLogout.mockReset();
    mockReplace.mockClear();
  });

  it('exibe nome e e-mail da sessão (somente leitura, vêm de /me)', () => {
    render(<PerfilPage />);
    expect(screen.getByText('Pessoa Exemplo')).toBeInTheDocument();
    expect(screen.getByText('pessoa@exemplo.com')).toBeInTheDocument();
  });

  it('Trocar senha: chama recuperarSenha(usuario.email) — reuso do fluxo, sem endpoint novo', async () => {
    mockRecuperarSenha.mockResolvedValueOnce({
      ok: true,
      mensagem: 'Se o e-mail existir, um link de redefinição foi enviado.',
    });
    render(<PerfilPage />);

    fireEvent.click(screen.getByRole('button', { name: 'Trocar senha' }));

    await waitFor(() => expect(mockRecuperarSenha).toHaveBeenCalledWith('pessoa@exemplo.com'));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('link de redefinição foi enviado'));
  });

  it('Trocar senha: erro de infraestrutura mostra mensagem sem quebrar a tela', async () => {
    mockRecuperarSenha.mockRejectedValueOnce(new HubApiError(500, 'Erro no servidor.'));
    render(<PerfilPage />);

    fireEvent.click(screen.getByRole('button', { name: 'Trocar senha' }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Erro no servidor.'));
  });

  it('logout sempre visível: aciona logout() e redireciona a /hub/login (task 4.5.1)', async () => {
    mockLogout.mockResolvedValueOnce(undefined);
    render(<PerfilPage />);

    fireEvent.click(screen.getByRole('button', { name: 'Sair' }));

    await waitFor(() => expect(mockLogout).toHaveBeenCalled());
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/hub/login'));
  });
});

// hub-shell (S3) task 4.3.5 — teste unitário dos 3 erros (400 ausentes/
// senha curta client-side, 400 token inválido, 410 token expirado) + fluxo
// de sucesso (mock).
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import RedefinirSenhaPage from './page';
import { HubApiError } from '@/contexts/hub-auth-context';

const mockRedefinirSenha = vi.fn();
let mockSearchParams = new URLSearchParams({ token: 'token-valido-de-teste' });

vi.mock('@/contexts/hub-auth-context', async () => {
  const actual = await vi.importActual<typeof import('@/contexts/hub-auth-context')>(
    '@/contexts/hub-auth-context'
  );
  return {
    ...actual,
    useHubAuth: () => ({ redefinirSenha: mockRedefinirSenha }),
  };
});

vi.mock('next/navigation', () => ({
  useSearchParams: () => mockSearchParams,
}));

function submeter(novaSenha: string) {
  fireEvent.change(screen.getByLabelText('Nova senha'), { target: { value: novaSenha } });
  fireEvent.click(screen.getByRole('button', { name: 'Redefinir senha' }));
}

describe('RedefinirSenhaPage', () => {
  beforeEach(() => {
    mockRedefinirSenha.mockReset();
    mockSearchParams = new URLSearchParams({ token: 'token-valido-de-teste' });
  });

  it('senha curta (<8): validação client-side impede o submit, sem chamar o backend', async () => {
    render(<RedefinirSenhaPage />);
    submeter('curta12');

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('pelo menos 8 caracteres'));
    expect(mockRedefinirSenha).not.toHaveBeenCalled();
  });

  it('400 token inválido: exibe a mensagem distinta do backend', async () => {
    mockRedefinirSenha.mockRejectedValueOnce(new HubApiError(400, 'Token inválido.'));
    render(<RedefinirSenhaPage />);

    submeter('senha-com-8-chars');

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Token inválido.'));
  });

  it('410 token expirado: exibe a mensagem distinta do backend', async () => {
    mockRedefinirSenha.mockRejectedValueOnce(new HubApiError(410, 'Token expirado.'));
    render(<RedefinirSenhaPage />);

    submeter('senha-com-8-chars');

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Token expirado.'));
  });

  it('token ausente na URL: mostra aviso e bloqueia o submit', async () => {
    mockSearchParams = new URLSearchParams();
    render(<RedefinirSenhaPage />);

    expect(screen.getByRole('alert')).toHaveTextContent('token ausente');

    submeter('senha-com-8-chars');
    await waitFor(() => expect(mockRedefinirSenha).not.toHaveBeenCalled());
  });

  it('fluxo de sucesso: chama redefinirSenha(token, novaSenha) e mostra confirmação', async () => {
    mockRedefinirSenha.mockResolvedValueOnce(undefined);
    render(<RedefinirSenhaPage />);

    submeter('senha-nova-valida');

    await waitFor(() =>
      expect(mockRedefinirSenha).toHaveBeenCalledWith('token-valido-de-teste', 'senha-nova-valida')
    );
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Senha redefinida com sucesso'));
  });
});

// hub-shell (S3) task 4.2.5 — teste unitário: resposta de sucesso idêntica
// para e-mail existente/inexistente (mock); tratamento do 429.
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import RecuperarSenhaPage from './page';
import { HubApiError } from '@/contexts/hub-auth-context';

const mockRecuperarSenha = vi.fn();

vi.mock('@/contexts/hub-auth-context', async () => {
  const actual = await vi.importActual<typeof import('@/contexts/hub-auth-context')>(
    '@/contexts/hub-auth-context'
  );
  return {
    ...actual,
    useHubAuth: () => ({ recuperarSenha: mockRecuperarSenha }),
  };
});

const MENSAGEM_PADRAO = 'Se o e-mail existir, um link de redefinição foi enviado.';

function submeter(email: string) {
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: email } });
  fireEvent.click(screen.getByRole('button', { name: 'Enviar link de redefinição' }));
}

describe('RecuperarSenhaPage', () => {
  beforeEach(() => {
    mockRecuperarSenha.mockReset();
  });

  it('e-mail existente: mostra a mensagem padrão do backend', async () => {
    mockRecuperarSenha.mockResolvedValueOnce({ ok: true, mensagem: MENSAGEM_PADRAO });
    render(<RecuperarSenhaPage />);

    submeter('existe@exemplo.com');

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(MENSAGEM_PADRAO));
  });

  it('e-mail inexistente: mostra a MESMA mensagem padrão (FR-012 — nunca revela existência)', async () => {
    mockRecuperarSenha.mockResolvedValueOnce({ ok: true, mensagem: MENSAGEM_PADRAO });
    render(<RecuperarSenhaPage />);

    submeter('nao-existe@exemplo.com');

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(MENSAGEM_PADRAO));
    expect(mockRecuperarSenha).toHaveBeenCalledWith('nao-existe@exemplo.com');
  });

  it('429 rate limit: exibe erro claro, sem quebrar a experiência (task 4.2.3)', async () => {
    mockRecuperarSenha.mockRejectedValueOnce(
      new HubApiError(429, 'Muitas tentativas. Tente novamente mais tarde.')
    );
    render(<RecuperarSenhaPage />);

    submeter('pessoa@exemplo.com');

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Muitas tentativas'));
    // Formulário continua visível (não trava numa tela "enviado" falsa).
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
  });
});

// hub-shell (S3) task 4.1.5 — teste unitário dos 3 erros de login
// (401 credenciais/423 bloqueada/429 rate-limit) + smoke de login válido.
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import HubLoginPage, { classificarErroLogin } from './page';
import { HubApiError } from '@/contexts/hub-auth-context';

const mockLogin = vi.fn();
const mockPush = vi.fn();
const mockReplace = vi.fn();

vi.mock('@/contexts/hub-auth-context', async () => {
  const actual = await vi.importActual<typeof import('@/contexts/hub-auth-context')>(
    '@/contexts/hub-auth-context'
  );
  return {
    ...actual,
    useHubAuth: () => ({
      usuario: null,
      carregando: false,
      login: mockLogin,
    }),
  };
});

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, replace: mockReplace }),
}));

describe('classificarErroLogin', () => {
  it('discrimina os 3 erros reais por status HTTP (nunca por string de código)', () => {
    expect(classificarErroLogin(401)).toBe('credenciais');
    expect(classificarErroLogin(423)).toBe('bloqueada');
    expect(classificarErroLogin(429)).toBe('rate-limit');
    expect(classificarErroLogin(500)).toBe('desconhecido');
  });
});

describe('HubLoginPage', () => {
  beforeEach(() => {
    mockLogin.mockReset();
    mockPush.mockClear();
    mockReplace.mockClear();
  });

  function preencherEEnviar(email: string, senha: string) {
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: email } });
    fireEvent.change(screen.getByLabelText('Senha'), { target: { value: senha } });
    fireEvent.click(screen.getByRole('button', { name: 'Entrar' }));
  }

  it('401 credenciais inválidas: exibe a mensagem do backend, sem navegar', async () => {
    mockLogin.mockRejectedValueOnce(new HubApiError(401, 'E-mail ou senha inválidos.'));
    render(<HubLoginPage />);

    preencherEEnviar('pessoa@exemplo.com', 'senha-errada');

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('E-mail ou senha inválidos.'));
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('423 conta bloqueada: exibe a mensagem do backend, sem navegar', async () => {
    mockLogin.mockRejectedValueOnce(
      new HubApiError(423, 'Conta temporariamente bloqueada por excesso de tentativas. Tente novamente mais tarde.')
    );
    render(<HubLoginPage />);

    preencherEEnviar('pessoa@exemplo.com', 'qualquer');

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('Conta temporariamente bloqueada')
    );
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('429 rate limit: exibe a mensagem do backend, sem navegar', async () => {
    mockLogin.mockRejectedValueOnce(new HubApiError(429, 'Muitas tentativas. Tente novamente mais tarde.'));
    render(<HubLoginPage />);

    preencherEEnviar('pessoa@exemplo.com', 'qualquer');

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Muitas tentativas'));
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('login válido: chama login() e encaminha a /selecionar-entidade (task 4.1.3 delega o branching à Fase 3)', async () => {
    mockLogin.mockResolvedValueOnce(undefined);
    render(<HubLoginPage />);

    preencherEEnviar('pessoa@exemplo.com', 'senha-correta');

    await waitFor(() => expect(mockLogin).toHaveBeenCalledWith('pessoa@exemplo.com', 'senha-correta'));
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/selecionar-entidade'));
  });
});

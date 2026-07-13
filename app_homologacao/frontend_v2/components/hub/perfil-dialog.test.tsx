// hub-motorista-canonico (FASE 1, task 1.3.4, FR-003/FR-004) — teste
// unitário do modal "Meu perfil": abrir, disparar "Trocar senha" (mock
// sucesso/erro) e fechar sem que a página de origem mude (mesmo padrão de
// `motorista-detalhe-dialog.tsx`/`vinculo-motorista-dialog.test.tsx`:
// hook de estado + componente controlado, sem depender da abertura real do
// `DropdownMenu` — Base UI portal/positioner é frágil em jsdom, mesma nota
// de `entity-switcher.test.tsx`).
import { fireEvent, render, renderHook, screen, waitFor, act } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PerfilDialog, usePerfilDialog } from './perfil-dialog';
import { HubApiError } from '@/contexts/hub-auth-context';

const mockRecuperarSenha = vi.fn();

vi.mock('@/contexts/hub-auth-context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/contexts/hub-auth-context')>();
  return {
    ...actual,
    useHubAuth: () => ({
      usuario: { id: 1, email: 'pessoa@exemplo.com', nome: 'Pessoa Exemplo' },
      recuperarSenha: mockRecuperarSenha,
    }),
  };
});

function Harness() {
  const state = usePerfilDialog();
  return (
    <>
      <button onClick={state.abrir}>abrir perfil</button>
      <PerfilDialog state={state} />
    </>
  );
}

describe('usePerfilDialog (lógica isolada)', () => {
  it('inicia fechado; abrir() abre', () => {
    const { result } = renderHook(() => usePerfilDialog());
    expect(result.current.open).toBe(false);

    act(() => result.current.abrir());
    expect(result.current.open).toBe(true);
  });
});

describe('PerfilDialog', () => {
  beforeEach(() => {
    mockRecuperarSenha.mockReset();
  });

  it('abrir modal exibe nome/e-mail sem navegar (FR-003/SC-002) e fechar preserva a página de origem', async () => {
    render(<Harness />);

    expect(screen.queryByText('Pessoa Exemplo')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'abrir perfil' }));

    expect(await screen.findByRole('heading', { name: 'Meu perfil' })).toBeInTheDocument();
    expect(screen.getByText('Pessoa Exemplo')).toBeInTheDocument();
    expect(screen.getByText('pessoa@exemplo.com')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    await waitFor(() => expect(screen.queryByText('pessoa@exemplo.com')).not.toBeInTheDocument());
    // Harness (a "página de origem") continua montado e intacto.
    expect(screen.getByRole('button', { name: 'abrir perfil' })).toBeInTheDocument();
  });

  it('Trocar senha dentro do modal: sucesso mostra confirmação (FR-004)', async () => {
    mockRecuperarSenha.mockResolvedValueOnce({
      ok: true,
      mensagem: 'Se o e-mail existir, um link de redefinição foi enviado.',
    });
    render(<Harness />);

    fireEvent.click(screen.getByRole('button', { name: 'abrir perfil' }));
    await screen.findByText('Pessoa Exemplo');

    fireEvent.click(screen.getByRole('button', { name: 'Trocar senha' }));

    await waitFor(() => expect(mockRecuperarSenha).toHaveBeenCalledWith('pessoa@exemplo.com'));
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('link de redefinição foi enviado')
    );
  });

  it('Trocar senha dentro do modal: erro mostra mensagem clara sem quebrar (FR-004)', async () => {
    mockRecuperarSenha.mockRejectedValueOnce(new HubApiError(500, 'Erro no servidor.'));
    render(<Harness />);

    fireEvent.click(screen.getByRole('button', { name: 'abrir perfil' }));
    await screen.findByText('Pessoa Exemplo');

    fireEvent.click(screen.getByRole('button', { name: 'Trocar senha' }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Erro no servidor.'));
  });
});

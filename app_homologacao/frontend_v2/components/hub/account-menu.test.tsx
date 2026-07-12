// hub-motorista-canonico (FASE 1, task 1.3.2, FR-003) — teste unitário do
// `AccountMenu`: "Meu perfil" deixou de navegar (`<Link href="/hub/dashboard/
// perfil">`) e passou a abrir o `PerfilDialog` em modal. Cobertura fina aqui
// (a interação real de abrir o `DropdownMenu` via Base UI/portal já é
// exercida — o essencial do fluxo modal está em `perfil-dialog.test.tsx`,
// que evita a fragilidade de portal/positioner em jsdom, mesma nota de
// `entity-switcher.test.tsx`): confirma que o componente monta sem navegar
// de imediato e que o gatilho "Meu perfil" não é mais um link para a rota.
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AccountMenu } from './account-menu';

const mockReplace = vi.fn();

vi.mock('@/contexts/hub-auth-context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/contexts/hub-auth-context')>();
  return {
    ...actual,
    useHubAuth: () => ({
      usuario: { id: 1, email: 'pessoa@exemplo.com', nome: 'Pessoa Exemplo' },
      logout: vi.fn(),
      recuperarSenha: vi.fn(),
    }),
  };
});

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mockReplace }),
}));

describe('AccountMenu', () => {
  it('renderiza o gatilho com o nome do usuário, sem navegar de imediato', () => {
    render(<AccountMenu />);
    expect(screen.getByRole('button', { name: 'Menu da conta' })).toBeInTheDocument();
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('"Meu perfil" não é mais um link para /hub/dashboard/perfil (FR-003: virou modal, task 1.3.2)', () => {
    render(<AccountMenu />);
    expect(screen.queryByRole('link', { name: /Meu perfil/i })).not.toBeInTheDocument();
  });
});

// adiantamento-motorista — components/hub/adiantamentos-abas.test.tsx
// (tasks.md 7.2.4): usuário sem uma permissão não vê a aba correspondente.
//
// Mesmo padrão de mock de `components/hub/module-nav.test.tsx`
// (useHubAuth/usePathname isolados via vi.mock).
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AdiantamentosAbas } from './adiantamentos-abas';

const mockUseHubAuth = vi.fn();
const mockUsePathname = vi.fn(() => '/hub/dashboard/adiantamentos');

vi.mock('@/contexts/hub-auth-context', () => ({
  useHubAuth: () => mockUseHubAuth(),
}));

vi.mock('next/navigation', () => ({
  usePathname: () => mockUsePathname(),
}));

function comPermissoes(permissoes: string[] | undefined) {
  mockUseHubAuth.mockReturnValue({ permissoes });
}

describe('AdiantamentosAbas — visibilidade por permissão (tasks.md 7.2.4)', () => {
  it('com todas as 4 permissões distintas, mostra as 5 abas', () => {
    comPermissoes([
      'adiantamentos.consultar',
      'adiantamentos.pagamentos_consultar',
      'adiantamentos.contas_consultar',
    ]);
    render(<AdiantamentosAbas />);
    expect(screen.getByRole('link', { name: 'Solicitações' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Pagamentos' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Contas bancárias' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Repasse' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Configurações' })).toBeInTheDocument();
  });

  it('sem adiantamentos.contas_consultar, a aba Contas some (as demais continuam)', () => {
    comPermissoes(['adiantamentos.consultar', 'adiantamentos.pagamentos_consultar']);
    render(<AdiantamentosAbas />);
    expect(screen.queryByRole('link', { name: 'Contas bancárias' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Solicitações' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Pagamentos' })).toBeInTheDocument();
  });

  it('sem adiantamentos.pagamentos_consultar, Pagamentos E Repasse somem juntas (mesma permissão de leitura no backend)', () => {
    comPermissoes(['adiantamentos.consultar', 'adiantamentos.contas_consultar']);
    render(<AdiantamentosAbas />);
    expect(screen.queryByRole('link', { name: 'Pagamentos' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Repasse' })).not.toBeInTheDocument();
  });

  it('só 1 aba visível -> nada a navegar, componente não renderiza nada', () => {
    // adiantamentos.consultar sozinha já libera 2 abas (Solicitações E
    // Configurações — GET /configuracoes só exige consultar, ver cabeçalho
    // do componente); contas_consultar é a única permissão que gate SÓ uma
    // aba (Contas).
    comPermissoes(['adiantamentos.contas_consultar']);
    const { container } = render(<AdiantamentosAbas />);
    expect(container).toBeEmptyDOMElement();
  });

  it('contexto sem permissoes não quebra — some, não explode', () => {
    comPermissoes(undefined);
    expect(() => render(<AdiantamentosAbas />)).not.toThrow();
  });

  it('marca a aba ativa via aria-current, pelo pathname corrente', () => {
    comPermissoes(['adiantamentos.consultar', 'adiantamentos.pagamentos_consultar']);
    mockUsePathname.mockReturnValue('/hub/dashboard/adiantamentos/pagamentos');
    render(<AdiantamentosAbas />);
    expect(screen.getByRole('link', { name: 'Pagamentos' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Solicitações' })).not.toHaveAttribute('aria-current');
  });
});

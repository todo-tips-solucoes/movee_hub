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
  it('com todas as permissões distintas, mostra as 6 abas', () => {
    comPermissoes([
      'adiantamentos.consultar',
      'adiantamentos.pagamentos_consultar',
      'adiantamentos.contas_consultar',
    ]);
    render(<AdiantamentosAbas />);
    expect(screen.getByRole('link', { name: 'Solicitações' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Aguardando lote' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Lotes' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Contas bancárias' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Repasse' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Configurações' })).toBeInTheDocument();
  });

  it('sem adiantamentos.contas_consultar, a aba Contas some (as demais continuam)', () => {
    comPermissoes(['adiantamentos.consultar', 'adiantamentos.pagamentos_consultar']);
    render(<AdiantamentosAbas />);
    expect(screen.queryByRole('link', { name: 'Contas bancárias' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Solicitações' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Aguardando lote' })).toBeInTheDocument();
  });

  it('sem adiantamentos.pagamentos_consultar, Aguardando lote, Lotes E Repasse somem juntas (mesma permissão de leitura no backend)', () => {
    comPermissoes(['adiantamentos.consultar', 'adiantamentos.contas_consultar']);
    render(<AdiantamentosAbas />);
    expect(screen.queryByRole('link', { name: 'Aguardando lote' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Repasse' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Lotes' })).not.toBeInTheDocument();
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
    expect(screen.getByRole('link', { name: 'Aguardando lote' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Solicitações' })).not.toHaveAttribute('aria-current');
  });

  // 2026-09-30: a tela `/lotes` existia sem aba nenhuma. O operador gerou o
  // lote, saiu da tela e não achou mais o caminho — nem em "Pagamentos", que
  // por definição só lista o que ainda NÃO entrou em lote. Estes dois casos
  // existem para que a entrada não se perca de novo.
  it('a aba Lotes aponta para /adiantamentos/lotes', () => {
    comPermissoes(['adiantamentos.consultar', 'adiantamentos.pagamentos_consultar']);
    render(<AdiantamentosAbas />);
    expect(screen.getByRole('link', { name: 'Lotes' })).toHaveAttribute(
      'href',
      '/hub/dashboard/adiantamentos/lotes'
    );
  });

  it('no DETALHE de um lote a aba Lotes fica ativa, e Pagamentos não', () => {
    comPermissoes(['adiantamentos.consultar', 'adiantamentos.pagamentos_consultar']);
    mockUsePathname.mockReturnValue('/hub/dashboard/adiantamentos/lotes/1');
    render(<AdiantamentosAbas />);
    expect(screen.getByRole('link', { name: 'Lotes' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Aguardando lote' })).not.toHaveAttribute('aria-current');
  });

  // A ordem É a informação: as quatro primeiras abas contam o caminho do
  // dinheiro (pede -> a pagar -> lote -> repasse da semana), e o cadastro de
  // apoio vem depois. Sem este caso, uma reordenação acidental passa batida.
  // "A pagar" foi descartado como rótulo desta aba: já é a coluna do extrato
  // em repasse/page.tsx (quanto o motorista recebe na semana). Duas contas
  // diferentes com o mesmo nome, no mesmo módulo.
  it('as abas seguem a ordem do fluxo, com o cadastro de apoio no fim', () => {
    comPermissoes([
      'adiantamentos.consultar',
      'adiantamentos.pagamentos_consultar',
      'adiantamentos.contas_consultar',
    ]);
    render(<AdiantamentosAbas />);
    expect(screen.getAllByRole('link').map((l) => l.textContent)).toEqual([
      'Solicitações', 'Aguardando lote', 'Lotes', 'Repasse', 'Contas bancárias', 'Configurações',
    ]);
  });
});

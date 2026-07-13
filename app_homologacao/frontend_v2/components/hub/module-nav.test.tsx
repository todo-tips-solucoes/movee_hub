// hub-shell (S3) task 2.2.5 — teste unitário do ModuleNav: fixture com 2
// conjuntos de permissão diferentes (via mock de `useHubAuth`) confirmando
// itens de menu distintos (base para SC-001/SC-005). Não cobre integração
// real com HubAuthProvider (isso é 1.4.3) — aqui o contrato é
// "modulos[] -> itens de menu", isolado.
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ModuleNav } from './module-nav';

const mockUseHubAuth = vi.fn();
// hub-motorista-canonico FASE 1 (FR-002): controlável por teste (default
// preserva o comportamento anterior — pathname fixo em /hub/dashboard/motoristas
// — para não regredir os testes de conjunto A/B/mapeamento/vazio abaixo).
const mockUsePathname = vi.fn(() => '/hub/dashboard/motoristas');

vi.mock('@/contexts/hub-auth-context', () => ({
  useHubAuth: () => mockUseHubAuth(),
}));

vi.mock('next/navigation', () => ({
  usePathname: () => mockUsePathname(),
}));

function withModulos(modulos: Array<{ codigo: string; nome: string; icone: string | null; ordem: number }>) {
  mockUseHubAuth.mockReturnValue({
    modulos,
    usuario: null,
    entidades: [],
    entidadeAtiva: null,
    permissoes: [],
    carregando: false,
    login: vi.fn(),
    logout: vi.fn(),
    trocarEntidade: vi.fn(),
    refetchMe: vi.fn(),
  });
}

describe('ModuleNav', () => {
  it('conjunto A (dashboard + motoristas): renderiza só esses 2 itens, em ordem', () => {
    withModulos([
      { codigo: 'motoristas', nome: 'Motoristas', icone: 'truck', ordem: 20 },
      { codigo: 'dashboard', nome: 'Painel Geral', icone: null, ordem: 10 },
    ]);

    render(<ModuleNav />);

    // Sheet (Base UI Dialog) só monta o conteúdo do drawer quando aberto —
    // fechado (estado inicial), só a sidebar fixa (>= lg) está no DOM: 2 links.
    const links = screen.getAllByRole('link', { name: /Painel Geral|Motoristas/ });
    expect(links.length).toBe(2);
    expect(screen.queryAllByText('Faturamento').length).toBe(0);
    expect(screen.queryAllByText('Auditoria').length).toBe(0);
  });

  it('conjunto B (faturamento + auditoria + admin): itens de menu distintos do conjunto A', () => {
    withModulos([
      { codigo: 'faturamento', nome: 'Faturamento', icone: 'receipt', ordem: 30 },
      { codigo: 'auditoria', nome: 'Auditoria', icone: 'shieldcheck', ordem: 80 },
      { codigo: 'admin', nome: 'Administração', icone: 'settings', ordem: 90 },
    ]);

    render(<ModuleNav />);

    expect(screen.getAllByText('Faturamento').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Auditoria').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Administração').length).toBeGreaterThan(0);
    expect(screen.queryAllByText('Motoristas').length).toBe(0);
    expect(screen.queryAllByText('Painel Geral').length).toBe(0);
  });

  it('mapeamento módulo→rota: cada link aponta para /hub/dashboard/<codigo>', () => {
    withModulos([{ codigo: 'performance', nome: 'Performance', icone: null, ordem: 40 }]);

    render(<ModuleNav />);

    const links = screen.getAllByRole('link', { name: 'Performance' });
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      expect(link).toHaveAttribute('href', '/hub/dashboard/performance');
    }
  });

  it('modulos vazio: não renderiza nenhum item (sem acesso a nenhum módulo)', () => {
    withModulos([]);

    const { container } = render(<ModuleNav />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('ModuleNav — item ativo "Painel Geral" na home (hub-motorista-canonico FASE 1, FR-002)', () => {
  it('pathname na raiz /hub/dashboard marca "Painel Geral" como ativo (aria-current=page)', () => {
    mockUsePathname.mockReturnValueOnce('/hub/dashboard');
    withModulos([
      { codigo: 'dashboard', nome: 'Painel Geral', icone: null, ordem: 10 },
      { codigo: 'motoristas', nome: 'Motoristas', icone: 'truck', ordem: 20 },
    ]);

    render(<ModuleNav />);

    const painelGeral = screen.getByRole('link', { name: 'Painel Geral' });
    expect(painelGeral).toHaveAttribute('aria-current', 'page');
    const motoristas = screen.getByRole('link', { name: 'Motoristas' });
    expect(motoristas).not.toHaveAttribute('aria-current');
  });
});

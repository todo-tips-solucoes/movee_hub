// repasse-gera-movimento 4.6.4 (C13): o layout LEGADO monta o HubAuthProvider SEM o HubSessionGuard.
// Sessão só-legado (o hub responde 401): o botão não renderiza e NINGUÉM é redirecionado ao login do hub.
// Sessão de hub com a permissão: o mesmo botão aparece. (O "nenhum Set-Cookie" do 4.6.4 vive no proxy Next,
// que o jsdom não exercita - fica declarado no evidencias.md, não afirmado aqui.)
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import DashboardLayout from './layout';
import { GerarDoRepasseButton } from '@/components/hub/gerar-do-repasse-button';

const replace = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace }), usePathname: () => '/dashboard' }));
vi.mock('@/contexts/auth-context', () => ({ useAuth: () => ({ user: { id: 1 }, loading: false }) }));
vi.mock('@/components/header', () => ({ Header: () => null }));
vi.mock('@/components/page-breadcrumb', () => ({ PageBreadcrumb: () => null }));

const ME = {
  usuario: { id: 1, email: 'a@b.c', nome: 'A' },
  entidades: [{ id: 6, nome: 'Movee' }],
  entidade_ativa: 6,
  modulos: [],
  permissoes: ['adiantamentos.pagamento_confirmar'],
};

afterEach(() => { vi.unstubAllGlobals(); replace.mockReset(); });

describe('app/dashboard/layout (legado) com HubAuthProvider sem guard', () => {
  it('sessão só-legado: /me do hub = 401 -> sem botão, sem redirect, conteúdo da página intacto', async () => {
    const f = vi.fn().mockResolvedValue(new Response(JSON.stringify({ erro: 'NAO_AUTENTICADO' }), { status: 401, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', f);
    render(<DashboardLayout><p>conteudo legado</p><GerarDoRepasseButton /></DashboardLayout>);
    await waitFor(() => expect(f).toHaveBeenCalled());
    expect(screen.getByText('conteudo legado')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Gerar do repasse' })).toBeNull();
    expect(replace).not.toHaveBeenCalled();
  });

  it('sessão de hub com a permissão: o botão aparece', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(ME), { status: 200, headers: { 'Content-Type': 'application/json' } })));
    render(<DashboardLayout><GerarDoRepasseButton /></DashboardLayout>);
    expect(await screen.findByRole('button', { name: 'Gerar do repasse' })).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
  });
});

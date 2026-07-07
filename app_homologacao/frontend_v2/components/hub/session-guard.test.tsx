// hub-shell (S3) task 4.5.4 — teste unitário/integração do HubSessionGuard:
// guard dispara refetch a cada navegação (mock); simular perda de vínculo
// (`usuario: null`) reflete na navegação (redireciona a /hub/login em rota
// protegida); rotas públicas do fluxo de auth não exigem sessão.
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HubSessionGuard, rotaEhPublica } from './session-guard';

const mockUseHubAuth = vi.fn();
const mockReplace = vi.fn();
let mockPathname = '/hub/dashboard';

vi.mock('@/contexts/hub-auth-context', () => ({
  useHubAuth: () => mockUseHubAuth(),
}));

vi.mock('next/navigation', () => ({
  usePathname: () => mockPathname,
  useRouter: () => ({ replace: mockReplace }),
}));

function withHubAuth(overrides: Partial<ReturnType<typeof mockUseHubAuth>> = {}) {
  const base = {
    usuario: { id: 1, email: 'pessoa@exemplo.com', nome: 'Pessoa' },
    carregando: false,
    refetchMe: vi.fn(),
  };
  mockUseHubAuth.mockReturnValue({ ...base, ...overrides });
}

describe('rotaEhPublica', () => {
  it('reconhece as 3 rotas públicas do fluxo de auth e suas subrotas', () => {
    expect(rotaEhPublica('/hub/login')).toBe(true);
    expect(rotaEhPublica('/hub/recuperar-senha')).toBe(true);
    expect(rotaEhPublica('/hub/redefinir-senha')).toBe(true);
    expect(rotaEhPublica('/hub/redefinir-senha/qualquer')).toBe(true);
  });

  it('rotas protegidas do shell não são públicas', () => {
    expect(rotaEhPublica('/hub/dashboard')).toBe(false);
    expect(rotaEhPublica('/hub/dashboard/perfil')).toBe(false);
  });
});

describe('HubSessionGuard', () => {
  beforeEach(() => {
    mockReplace.mockClear();
    mockPathname = '/hub/dashboard';
  });

  it('com sessão: renderiza children normalmente, sem redirecionar', () => {
    withHubAuth();
    render(
      <HubSessionGuard>
        <div>conteudo-protegido</div>
      </HubSessionGuard>
    );
    expect(screen.getByText('conteudo-protegido')).toBeInTheDocument();
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('sem sessão em rota protegida: NÃO renderiza children e redireciona a /hub/login (FR-013/CHK017)', async () => {
    withHubAuth({ usuario: null, carregando: false });
    render(
      <HubSessionGuard>
        <div>conteudo-protegido</div>
      </HubSessionGuard>
    );
    expect(screen.queryByText('conteudo-protegido')).not.toBeInTheDocument();
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/hub/login'));
  });

  it('sem sessão em rota pública (ex.: /hub/login): renderiza children, sem redirecionar', () => {
    mockPathname = '/hub/login';
    withHubAuth({ usuario: null, carregando: false });
    render(
      <HubSessionGuard>
        <div>tela-de-login</div>
      </HubSessionGuard>
    );
    expect(screen.getByText('tela-de-login')).toBeInTheDocument();
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('ainda carregando (refetch inicial em andamento): não redireciona mesmo sem usuario', () => {
    withHubAuth({ usuario: null, carregando: true });
    render(
      <HubSessionGuard>
        <div>conteudo</div>
      </HubSessionGuard>
    );
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('navegação (pathname muda): dispara refetchMe() a partir da 2a renderização, não na montagem inicial', () => {
    const refetchMe = vi.fn();
    withHubAuth({ refetchMe });
    const { rerender } = render(
      <HubSessionGuard>
        <div>conteudo</div>
      </HubSessionGuard>
    );
    expect(refetchMe).not.toHaveBeenCalled();

    mockPathname = '/hub/dashboard/perfil';
    rerender(
      <HubSessionGuard>
        <div>conteudo</div>
      </HubSessionGuard>
    );
    expect(refetchMe).toHaveBeenCalledTimes(1);
  });
});

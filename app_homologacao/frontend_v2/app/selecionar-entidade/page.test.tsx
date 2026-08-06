// hub-shell (S3) task 3.2.5 — teste unitário dos 3 ramos de
// /selecionar-entidade (entidades.length > 1 / === 1 / === 0), mais o
// estado de carregamento inicial. useHubAuth e next/navigation são
// mockados — isola a lógica de roteamento/troca de entidade sem depender
// de rede real (essa parte já é coberta por contexts/hub-auth-context.test.tsx
// e components/hub/entity-switcher.test.tsx).
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import SelecionarEntidadePage from './page';
import { HubApiError } from '@/contexts/hub-auth-context';
import type { HubVinculo } from '@/lib/hub/me-dto';

const mockUseHubAuth = vi.fn();
const mockPush = vi.fn();
const mockReplace = vi.fn();

vi.mock('@/contexts/hub-auth-context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/contexts/hub-auth-context')>();
  return { ...actual, useHubAuth: () => mockUseHubAuth() };
});

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, replace: mockReplace }),
}));

const VINCULO_A: HubVinculo = { empresaId: 10, papel: 'admin', ativo: true };
const VINCULO_B: HubVinculo = { empresaId: 20, papel: 'operador', ativo: true };

function withHubAuth(overrides: {
  entidades: HubVinculo[];
  entidadeAtiva?: number | null;
  carregando?: boolean;
  trocarEntidade?: ReturnType<typeof vi.fn>;
  logout?: ReturnType<typeof vi.fn>;
}) {
  mockUseHubAuth.mockReturnValue({
    entidades: overrides.entidades,
    entidadeAtiva: overrides.entidadeAtiva ?? null,
    carregando: overrides.carregando ?? false,
    trocarEntidade: overrides.trocarEntidade ?? vi.fn().mockResolvedValue(undefined),
    logout: overrides.logout ?? vi.fn().mockResolvedValue(undefined),
    usuario: null,
    modulos: [],
    permissoes: [],
    login: vi.fn(),
    refetchMe: vi.fn(),
  });
}

describe('/selecionar-entidade', () => {
  beforeEach(() => {
    mockPush.mockClear();
    mockReplace.mockClear();
    mockUseHubAuth.mockReset();
  });

  it('carregando: mostra estado de loading, sem decidir ramo ainda', () => {
    withHubAuth({ entidades: [], carregando: true });
    render(<SelecionarEntidadePage />);
    expect(screen.getByRole('status')).toHaveTextContent('Carregando');
  });

  it('0 entidades: tela "sem acesso" (FR-016), com saída via logout', async () => {
    const logout = vi.fn().mockResolvedValue(undefined);
    withHubAuth({ entidades: [], logout });
    render(<SelecionarEntidadePage />);

    expect(screen.getByRole('heading', { name: 'Sem acesso a nenhuma entidade' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Sair/ }));
    await waitFor(() => expect(logout).toHaveBeenCalled());
    expect(mockReplace).toHaveBeenCalledWith('/hub/login');
  });

  it('1 entidade: seleciona automaticamente e redireciona a /dashboard, sem exigir escolha manual', async () => {
    const trocarEntidade = vi.fn().mockResolvedValue(undefined);
    withHubAuth({ entidades: [VINCULO_A], entidadeAtiva: null, trocarEntidade });

    render(<SelecionarEntidadePage />);

    expect(screen.getByRole('status')).toHaveTextContent('Selecionando');
    await waitFor(() => expect(trocarEntidade).toHaveBeenCalledWith(10));
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/hub/dashboard'));
  });

  it('1 entidade já ativa: não repete o POST (idempotente), só redireciona', async () => {
    const trocarEntidade = vi.fn().mockResolvedValue(undefined);
    withHubAuth({ entidades: [VINCULO_A], entidadeAtiva: 10, trocarEntidade });

    render(<SelecionarEntidadePage />);

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/hub/dashboard'));
    expect(trocarEntidade).not.toHaveBeenCalled();
  });

  it('>1 entidades: mostra tela de escolha com um botão por vínculo', () => {
    withHubAuth({ entidades: [VINCULO_A, VINCULO_B], entidadeAtiva: 10 });
    render(<SelecionarEntidadePage />);

    expect(screen.getByRole('heading', { name: 'Selecionar entidade' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Empresa #10 — Admin/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Empresa #20 — Operador/ })).toBeInTheDocument();
  });

  it('>1 entidades: selecionar uma entidade troca e redireciona a /dashboard', async () => {
    const trocarEntidade = vi.fn().mockResolvedValue(undefined);
    withHubAuth({ entidades: [VINCULO_A, VINCULO_B], entidadeAtiva: 10, trocarEntidade });
    render(<SelecionarEntidadePage />);

    fireEvent.click(screen.getByRole('button', { name: /Empresa #20 — Operador/ }));

    await waitFor(() => expect(trocarEntidade).toHaveBeenCalledWith(20));
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/hub/dashboard'));
  });

  it('>1 entidades: recusa (403 SEM_VINCULO) mantém a tela de escolha com erro visível, sem navegar', async () => {
    const trocarEntidade = vi.fn().mockRejectedValue(new HubApiError(403, 'Sem vínculo com essa entidade.'));
    withHubAuth({ entidades: [VINCULO_A, VINCULO_B], entidadeAtiva: 10, trocarEntidade });
    render(<SelecionarEntidadePage />);

    fireEvent.click(screen.getByRole('button', { name: /Empresa #20 — Operador/ }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Sem vínculo com essa entidade.'));
    expect(mockReplace).not.toHaveBeenCalled();
  });
});

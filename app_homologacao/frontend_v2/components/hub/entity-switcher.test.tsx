// hub-shell (S3) task 3.1.6 — teste unitário do EntitySwitcher.
//
// A lógica de troca (useEntitySwitcher) é testada isolada via renderHook —
// evita simular a interação real do Select (Base UI, portal/positioner) em
// jsdom, que é frágil/não suportada sem @testing-library/user-event. O
// componente visual é testado por render() + smoke (0/1/N vínculos, rótulo
// exibido no trigger).
import { render, renderHook, screen, waitFor, act } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { EntitySwitcher, useEntitySwitcher, labelVinculo } from './entity-switcher';
import { HubApiError } from '@/contexts/hub-auth-context';
import type { HubVinculo } from '@/lib/hub/me-dto';

const mockUseHubAuth = vi.fn();

vi.mock('@/contexts/hub-auth-context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/contexts/hub-auth-context')>();
  return { ...actual, useHubAuth: () => mockUseHubAuth() };
});

const VINCULO_A: HubVinculo = { empresaId: 10, nome: null, papel: 'admin', ativo: true };
const VINCULO_B: HubVinculo = { empresaId: 20, nome: null, papel: null, ativo: true };

function withEntidades(
  entidades: HubVinculo[],
  entidadeAtiva: number | null,
  trocarEntidade = vi.fn().mockResolvedValue(undefined)
) {
  mockUseHubAuth.mockReturnValue({
    entidades,
    entidadeAtiva,
    trocarEntidade,
    usuario: null,
    modulos: [],
    permissoes: [],
    carregando: false,
    login: vi.fn(),
    logout: vi.fn(),
    refetchMe: vi.fn(),
  });
  return trocarEntidade;
}

describe('labelVinculo', () => {
  it('inclui o papel quando presente (prettifier para papéis fora do seed)', () => {
    // 'admin' não está em PAPEL_LABELS — o prettifier capitaliza o slug.
    expect(labelVinculo(VINCULO_A)).toBe('Empresa #10 — Admin');
  });

  it('humaniza os papéis semeados', () => {
    expect(labelVinculo({ ...VINCULO_A, papel: 'admin_entidade' })).toBe(
      'Empresa #10 — Administrador da entidade'
    );
  });

  it('usa o nome da entidade quando o /me o devolve (impeccable rodada 2)', () => {
    expect(labelVinculo({ ...VINCULO_A, nome: 'Movee Matriz' })).toBe('Movee Matriz — Admin');
    expect(labelVinculo({ ...VINCULO_B, nome: 'Filial Sul' })).toBe('Filial Sul');
  });

  it('cai para "Empresa #<id>" quando papel é null', () => {
    expect(labelVinculo(VINCULO_B)).toBe('Empresa #20');
  });
});

describe('useEntitySwitcher (lógica isolada)', () => {
  it('troca válida: chama trocarEntidade e não seta erro', async () => {
    const trocarEntidade = withEntidades([VINCULO_A, VINCULO_B], 10);
    const { result } = renderHook(() => useEntitySwitcher());

    await act(async () => {
      await result.current.handleChange('20');
    });

    expect(trocarEntidade).toHaveBeenCalledWith(20);
    expect(result.current.erro).toBeNull();
    expect(result.current.liveMessage).toContain('Empresa #20');
  });

  it('troca para entidade sem vínculo (403 SEM_VINCULO): mantém a anterior e registra erro, sem navegar', async () => {
    const trocarEntidade = withEntidades(
      [VINCULO_A, VINCULO_B],
      10,
      vi.fn().mockRejectedValue(new HubApiError(403, 'Sem vínculo com essa entidade.'))
    );
    const { result } = renderHook(() => useEntitySwitcher());

    await act(async () => {
      await result.current.handleChange('20');
    });

    expect(trocarEntidade).toHaveBeenCalledWith(20);
    expect(result.current.erro).toBe('Sem vínculo com essa entidade.');
    // entidadeAtiva é derivado do mock (useHubAuth) — o hook não o sobrescreve
    // manualmente; permanece 10 (a "anterior"), refletindo FR-006.
    expect(result.current.value).toBe('10');
  });

  it('erro genérico (não-HubApiError): usa mensagem de fallback', async () => {
    withEntidades([VINCULO_A, VINCULO_B], 10, vi.fn().mockRejectedValue(new Error('boom')));
    const { result } = renderHook(() => useEntitySwitcher());

    await act(async () => {
      await result.current.handleChange('20');
    });

    expect(result.current.erro).toBe('Não foi possível trocar de entidade. Tente novamente.');
  });

  it('valor igual ao atual: não invoca trocarEntidade (no-op)', async () => {
    const trocarEntidade = withEntidades([VINCULO_A, VINCULO_B], 10);
    const { result } = renderHook(() => useEntitySwitcher());

    await act(async () => {
      await result.current.handleChange('10');
    });

    expect(trocarEntidade).not.toHaveBeenCalled();
  });
});

describe('EntitySwitcher (componente)', () => {
  it('0 vínculos: não renderiza nada', () => {
    withEntidades([], null);
    const { container } = render(<EntitySwitcher />);
    expect(container).toBeEmptyDOMElement();
  });

  it('1 vínculo: não renderiza nada (nada para trocar)', () => {
    withEntidades([VINCULO_A], 10);
    const { container } = render(<EntitySwitcher />);
    expect(container).toBeEmptyDOMElement();
  });

  it('2+ vínculos: renderiza o seletor com o rótulo da entidade ativa', async () => {
    withEntidades([VINCULO_A, VINCULO_B], 10);
    render(<EntitySwitcher />);

    await waitFor(() => {
      expect(screen.getByRole('combobox', { name: 'Trocar entidade de trabalho' })).toBeTruthy();
    });
    expect(screen.getByText('Empresa #10 — Admin')).toBeInTheDocument();
  });
});

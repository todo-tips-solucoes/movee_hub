// impeccable rodada 14 (h3) — o hook que faz filtro e página sobreviverem à
// ida ao detalhe. Três coisas precisam ser verdade ao mesmo tempo, e cada uma
// falha de um jeito diferente:
//   1. ler da URL na montagem (senão voltar não restaura nada);
//   2. NÃO reescrever a URL na montagem (senão a entrada do histórico é
//      trocada por uma idêntica e o "voltar" gasta um passo à toa);
//   3. espelhar depois, com atraso (senão é uma navegação por tecla digitada).
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useFiltrosUrl } from './use-filtros-url';

const replace = vi.fn();
let params = new URLSearchParams();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace, push: vi.fn(), back: vi.fn() }),
  usePathname: () => '/hub/dashboard/motoristas',
  useSearchParams: () => params,
}));

const INICIAIS = { nome: '', ativo: '' as '' | 'true' | 'false' };

describe('useFiltrosUrl', () => {
  beforeEach(() => {
    replace.mockClear();
    params = new URLSearchParams();
  });

  it('nasce com o que está na URL — é isso que "voltar" devolve', () => {
    params = new URLSearchParams('nome=silva&ativo=true&pagina=3');
    const { result } = renderHook(() => useFiltrosUrl(INICIAIS));

    expect(result.current.filtros).toEqual({ nome: 'silva', ativo: 'true' });
    expect(result.current.page).toBe(3);
  });

  it('ignora parâmetro desconhecido na URL', () => {
    params = new URLSearchParams('nome=silva&injetado=x');
    const { result } = renderHook(() => useFiltrosUrl(INICIAIS));
    expect(result.current.filtros).toEqual({ nome: 'silva', ativo: '' });
  });

  it('página inválida cai em 1 em vez de propagar lixo para a API', () => {
    params = new URLSearchParams('pagina=-2');
    const { result } = renderHook(() => useFiltrosUrl(INICIAIS));
    expect(result.current.page).toBe(1);
  });

  it('não toca na URL enquanto nada mudou', async () => {
    params = new URLSearchParams('nome=silva');
    renderHook(() => useFiltrosUrl(INICIAIS));
    await new Promise((r) => setTimeout(r, 400));
    expect(replace).not.toHaveBeenCalled();
  });

  it('espelha a mudança na URL, com replace (não empilha histórico por tecla)', async () => {
    const { result } = renderHook(() => useFiltrosUrl(INICIAIS));
    act(() => result.current.setFiltros({ nome: 'silva' }));

    await waitFor(() => expect(replace).toHaveBeenCalled(), { timeout: 1500 });
    expect(replace).toHaveBeenLastCalledWith('/hub/dashboard/motoristas?nome=silva', {
      scroll: false,
    });
  });

  it('filtro novo volta para a página 1 — senão a lista abre vazia', async () => {
    params = new URLSearchParams('pagina=4');
    const { result } = renderHook(() => useFiltrosUrl(INICIAIS));
    expect(result.current.page).toBe(4);

    act(() => result.current.setFiltros({ nome: 'silva' }));
    expect(result.current.page).toBe(1);
  });

  it('limpar zera filtros e página, e a URL volta a não ter query', async () => {
    params = new URLSearchParams('nome=silva&pagina=2');
    const { result } = renderHook(() => useFiltrosUrl(INICIAIS));

    act(() => result.current.limpar());
    await waitFor(() => expect(replace).toHaveBeenCalled(), { timeout: 1500 });
    expect(replace).toHaveBeenLastCalledWith('/hub/dashboard/motoristas', { scroll: false });
  });
});

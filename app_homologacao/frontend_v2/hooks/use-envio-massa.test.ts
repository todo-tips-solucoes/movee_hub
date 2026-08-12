// impeccable rodada 20 (P1) — o recibo carrega os números do movimento que
// acabou de ser fechado.
//
// Nota de honestidade: eu escrevi este arquivo achando que ele provaria que a
// captura precisa acontecer ANTES do `fetchData` (que devolve a lista vazia do
// movimento novo). Testei movendo a captura para depois — e os quatro casos
// continuaram passando, porque `stats` é a variável do closure e não muda
// durante a execução da função. O teste NÃO discrimina essa ordem, e dizer o
// contrário no commit seria vender proteção que ele não dá.
//
// O que ele protege, e é o que importa: os números exibidos são os do ciclo
// encerrado, um POST que falha não deixa recibo, e dispensar limpa.
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useEnvioMassa } from './use-envio-massa';

const mockGet = vi.fn();
const mockPost = vi.fn();

vi.mock('@/lib/api-client', () => ({
  api: {
    get: (...args: unknown[]) => mockGet(...args),
    post: (...args: unknown[]) => mockPost(...args),
  },
}));

const LINHAS = Array.from({ length: 10 }, (_, i) => ({
  id: i + 1,
  number: String(i + 1),
  nome: `Motorista ${i + 1}`,
  valor: 100,
  enviado: i < 7 ? 'ok' : i < 9 ? 'erro' : 'off',
  data_emissao: null,
  numnota: null,
  nota_ok: null,
  erro_validacao: null,
}));

/**
 * O hook NÃO busca sozinho: quem dispara `fetchData` é a tela, num efeito.
 * Montar e esperar dados aparecerem sem chamar nada deixaria todo caso deste
 * arquivo verde por vacuidade, com `stats` zerado.
 */
async function montarComDados() {
  const hook = renderHook(() => useEnvioMassa());
  await act(async () => {
    await hook.result.current.fetchData();
  });
  await waitFor(() => expect(hook.result.current.data.length).toBe(10));
  return hook;
}

describe('useEnvioMassa — recibo de fechamento', () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockPost.mockReset();
    mockGet.mockResolvedValue(LINHAS);
    mockPost.mockResolvedValue({});
  });

  it('nasce sem recibo', async () => {
    const { result } = await montarComDados();
    expect(result.current.movimentoFechado).toBeNull();
  });

  it('guarda os números do movimento que existia, não os do movimento novo', async () => {
    const { result } = await montarComDados();

    // Depois do fechamento o backend devolve a lista vazia — é o cenário real.
    mockGet.mockResolvedValue([]);
    await act(async () => {
      await result.current.closeMovement('01/08/2026 a 07/08/2026');
    });

    await waitFor(() => expect(result.current.data.length).toBe(0));
    expect(result.current.movimentoFechado).not.toBeNull();
    expect(result.current.movimentoFechado?.stats.total).toBe(10);
    expect(result.current.movimentoFechado?.stats.msgEnviada).toBe(7);
    expect(result.current.movimentoFechado?.stats.msgErro).toBe(2);
    expect(result.current.movimentoFechado?.periodo).toBe('01/08/2026 a 07/08/2026');
  });

  it('POST que falha NÃO deixa recibo — não se anuncia o que não aconteceu', async () => {
    const { result } = await montarComDados();

    mockPost.mockRejectedValueOnce(new Error('backend fora'));
    await act(async () => {
      await expect(result.current.closeMovement('01/08 a 07/08')).rejects.toThrow('backend fora');
    });
    expect(result.current.movimentoFechado).toBeNull();
  });

  it('dispensar limpa o recibo', async () => {
    const { result } = await montarComDados();

    await act(async () => {
      await result.current.closeMovement(null);
    });
    expect(result.current.movimentoFechado).not.toBeNull();

    act(() => result.current.dispensarFechamento());
    expect(result.current.movimentoFechado).toBeNull();
  });
});

// Os três diálogos de lote são do adiantamento e foram parametrizados para o
// repasse. Dois riscos: (1) o repasse chamar o endpoint do adiantamento;
// (2) o adiantamento, em produção, deixar de usar o seu — o default tem de
// continuar sendo o endpoint antigo.
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useCancelarLoteDialog } from './adiantamento-cancelar-lote-dialog';
import { useConfirmarLoteDialog } from './adiantamento-confirmar-lote-dialog';
import { rotularIgnoradas, useImportarRetornoDialog } from './adiantamento-importar-retorno-dialog';

const padrao = vi.hoisted(() => ({ cancelar: vi.fn(), confirmar: vi.fn(), importar: vi.fn() }));

vi.mock('@/lib/hub/adiantamentos-api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/hub/adiantamentos-api')>('@/lib/hub/adiantamentos-api');
  return {
    ...actual,
    cancelarLote: padrao.cancelar,
    confirmarLote: padrao.confirmar,
    importarRetornoLote: padrao.importar,
  };
});

const lote = { id: 5 } as never;
const item = { id: 11, situacao: 'incluido', integrationId: 'REP-000011', nome: 'Fulano' } as never;

beforeEach(() => vi.clearAllMocks());

describe('cancelar', () => {
  it('com `cancelar` do repasse chama o do repasse e não o do adiantamento', async () => {
    const meu = vi.fn().mockResolvedValue(lote);
    const { result } = renderHook(() => useCancelarLoteDialog({ loteId: 5, status: 'GERADO', onSucesso: vi.fn(), cancelar: meu }));
    act(() => result.current.setMotivo('erro no arquivo'));
    await act(() => result.current.confirmar());
    expect(meu).toHaveBeenCalledWith(5, 'erro no arquivo', false);
    expect(padrao.cancelar).not.toHaveBeenCalled();
  });
  it('sem `cancelar` mantém o endpoint do adiantamento', async () => {
    padrao.cancelar.mockResolvedValue(lote);
    const { result } = renderHook(() => useCancelarLoteDialog({ loteId: 5, status: 'GERADO', onSucesso: vi.fn() }));
    act(() => result.current.setMotivo('erro no arquivo'));
    await act(() => result.current.confirmar());
    expect(padrao.cancelar).toHaveBeenCalledWith(5, 'erro no arquivo', false);
  });
});

describe('confirmar na mão', () => {
  it('com `confirmarFn` do repasse manda as falhas por ele', async () => {
    const meu = vi.fn().mockResolvedValue(lote);
    const { result } = renderHook(() => useConfirmarLoteDialog({ loteId: 5, itens: [item], onSucesso: vi.fn(), confirmarFn: meu }));
    act(() => result.current.abrir());
    act(() => result.current.marcarFalha(11, true));
    act(() => result.current.setMotivo(11, 'conta encerrada'));
    await act(() => result.current.confirmar());
    expect(meu).toHaveBeenCalledWith(5, { falhas: [{ id: 11, motivo: 'conta encerrada' }] });
    expect(padrao.confirmar).not.toHaveBeenCalled();
  });
  it('sem `confirmarFn` mantém o endpoint do adiantamento', async () => {
    padrao.confirmar.mockResolvedValue(lote);
    const { result } = renderHook(() => useConfirmarLoteDialog({ loteId: 5, itens: [item], onSucesso: vi.fn() }));
    act(() => result.current.abrir());
    await act(() => result.current.confirmar());
    expect(padrao.confirmar).toHaveBeenCalledWith(5, { falhas: [] });
  });
});

describe('importar retorno', () => {
  const arquivo = new File(['a;b'], 'r.csv', { type: 'text/csv' });
  const resp = { aplicadas: 1, ignoradas: 0, ignoradasPorMotivo: [] };
  it('com `importar` do repasse envia o CSV por ele', async () => {
    const meu = vi.fn().mockResolvedValue(resp);
    const { result } = renderHook(() => useImportarRetornoDialog({ loteId: 5, onSucesso: vi.fn(), importar: meu }));
    act(() => result.current.escolher(arquivo));
    await act(() => result.current.enviar());
    expect(meu).toHaveBeenCalledWith(5, 'a;b');
    expect(padrao.importar).not.toHaveBeenCalled();
  });
  it('sem `importar` mantém o endpoint do adiantamento', async () => {
    padrao.importar.mockResolvedValue(resp);
    const { result } = renderHook(() => useImportarRetornoDialog({ loteId: 5, onSucesso: vi.fn() }));
    act(() => result.current.escolher(arquivo));
    await act(() => result.current.enviar());
    expect(padrao.importar).toHaveBeenCalledWith(5, 'a;b');
  });
});

describe('frases do dialog de retorno que citam o produto', () => {
  const lista = [{ motivo: 'VALOR_DIVERGENTE', total: 2 }];
  it('default continua sendo o texto do adiantamento', () => {
    expect(rotularIgnoradas(lista)[0].rotulo).toBe('Valor do arquivo diferente do valor do adiantamento');
  });
  it('com `produto` do repasse a frase fala de repasse', () => {
    expect(rotularIgnoradas(lista, 'repasse')[0].rotulo).toBe('Valor do arquivo diferente do valor do repasse');
  });
  it('o hook leva `produto` até o resultado mostrado', async () => {
    const importar = vi.fn().mockResolvedValue({ aplicadas: 1, ignoradas: 2, ignoradasPorMotivo: lista });
    const { result } = renderHook(() => useImportarRetornoDialog({ loteId: 5, onSucesso: vi.fn(), importar, produto: 'repasse' }));
    act(() => result.current.escolher(new File(['a;b'], 'r.csv', { type: 'text/csv' })));
    await act(() => result.current.enviar());
    expect(result.current.resultado?.grupos[0].rotulo).toBe('Valor do arquivo diferente do valor do repasse');
  });
});

// lancamento-externo — listagem + exclusão (emenda da FR-040, rodada 3) e o texto do excedente (ALTO 2).
import { render, renderHook, screen, waitFor, act, fireEvent } from '@testing-library/react';

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LancamentoExternoListaDialog, useLancamentoExternoListaDialog } from './lancamento-externo-lista-dialog';
import { useLancamentoExternoDialog } from './lancamento-externo-dialog';
import { LancamentoExternoApiError, textoExcedente } from '@/lib/hub/lancamento-externo';

const mockListar = vi.fn();
const mockExcluir = vi.fn();
const mockImportar = vi.fn();
vi.mock('@/lib/hub/lancamento-externo', async () => {
  const actual = await vi.importActual<typeof import('@/lib/hub/lancamento-externo')>('@/lib/hub/lancamento-externo');
  return {
    ...actual,
    listarLancamentosExternos: (...a: unknown[]) => mockListar(...a),
    excluirLancamentoExterno: (...a: unknown[]) => mockExcluir(...a),
    importarLancamentosExternos: (...a: unknown[]) => mockImportar(...a),
  };
});

const item = (o = {}) => ({
  id: 7, motorista: 'Motorista Teste 01', tipo: 'ADIANTAMENTO', sinal: -1, dataPagamento: '2026-09-17', valor: '30.00',
  observacao: 'pix', criadoEm: '2026-09-18T10:00:00Z', criadoPor: 'Fin', excluivel: true, semanaFechada: true, ...o,
});

function Tela({ onMudou = () => {} }: { onMudou?: () => void }) {
  const d = useLancamentoExternoListaDialog({ periodo: '2026-09-14', onMudou });
  return (
    <>
      <button type="button" onClick={d.abrir}>abrir</button>
      <LancamentoExternoListaDialog d={d} />
    </>
  );
}
beforeEach(() => { mockListar.mockReset(); mockExcluir.mockReset(); mockImportar.mockReset(); });

describe('listagem + exclusão', () => {
  it('lista os lançamentos da semana (nome, tipo, valor) e NÃO mostra CNPJ', async () => {
    mockListar.mockResolvedValue({ itens: [item()], total: 1 });
    render(<Tela />);
    fireEvent.click(screen.getByText('abrir'));
    expect(await screen.findByText('Motorista Teste 01')).toBeTruthy();
    expect(screen.getByText('Adiantamento')).toBeTruthy();
    expect(mockListar).toHaveBeenCalledWith('2026-09-14', { offset: 0, limite: 50 });
  });

  it('M2 (rodada 4): a tela TEM a busca por nome — digitar e enviar relista com `busca` e volta ao início', async () => {
    mockListar.mockResolvedValue({ itens: [item()], total: 1 });
    render(<Tela />);
    fireEvent.click(screen.getByText('abrir'));
    await screen.findByText('Motorista Teste 01');
    fireEvent.change(screen.getByRole('textbox', { name: 'Buscar por nome do motorista' }), { target: { value: ' teste 01 ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Buscar' }));
    await waitFor(() => expect(mockListar).toHaveBeenLastCalledWith('2026-09-14', { offset: 0, limite: 50, busca: 'teste 01' }));
  });

  it('M3 (rodada 4): sem permissão NÃO é rotulado "Semana fechada"', async () => {
    mockListar.mockResolvedValue({ itens: [item({ excluivel: false, semanaFechada: false })], total: 1 });
    render(<Tela />);
    fireEvent.click(screen.getByText('abrir'));
    await screen.findByText('Motorista Teste 01');
    expect(screen.getByText('Sem permissão')).toBeTruthy();
    expect(screen.queryByText('Semana fechada')).toBeNull();
  });

  it('M13 (rodada 4): página fora de faixa com total > 0 vai à última página, em vez de "nenhum lançamento"', async () => {
    mockListar
      .mockResolvedValueOnce({ itens: [item()], total: 120 })
      .mockResolvedValueOnce({ itens: [], total: 120 })
      .mockResolvedValue({ itens: [item({ id: 9, motorista: 'Motorista Teste 09' })], total: 120 });
    render(<Tela />);
    fireEvent.click(screen.getByText('abrir'));
    await screen.findByText('Motorista Teste 01');
    fireEvent.click(screen.getByRole('button', { name: 'Próxima' }));
    await screen.findByText('Motorista Teste 09');
    expect(screen.queryByText(/Nenhum lançamento/)).toBeNull();
    expect(mockListar).toHaveBeenLastCalledWith('2026-09-14', { offset: 100, limite: 50 });
  });

  it('semana fechada: SEM botão de excluir (mostra o motivo); semana aberta: com botão', async () => {
    mockListar.mockResolvedValue({ itens: [item({ id: 1, excluivel: false }), item({ id: 2, motorista: 'Motorista Teste 02' })], total: 2 });
    render(<Tela />);
    fireEvent.click(screen.getByText('abrir'));
    await screen.findByText('Motorista Teste 02');
    expect(screen.getByText('Semana fechada')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /Excluir lançamento/ })).toHaveLength(1);
  });

  it('um clique NÃO exclui: pede confirmação; confirmar chama a API, avisa quem depende (onMudou) e recarrega', async () => {
    mockListar.mockResolvedValueOnce({ itens: [item()], total: 1 }).mockResolvedValueOnce({ itens: [], total: 0 });
    mockExcluir.mockResolvedValue(undefined);
    const onMudou = vi.fn();
    render(<Tela onMudou={onMudou} />);
    fireEvent.click(screen.getByText('abrir'));
    fireEvent.click(await screen.findByRole('button', { name: /Excluir lançamento de Motorista Teste 01/ }));
    expect(mockExcluir).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar exclusão' }));
    await waitFor(() => expect(mockExcluir).toHaveBeenCalledWith(7));
    await waitFor(() => expect(onMudou).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/Nenhum lançamento pago por fora/)).toBeTruthy();
  });

  it('semana fechou enquanto a lista estava aberta: o 409 aparece em português e a lista é recarregada', async () => {
    mockListar.mockResolvedValue({ itens: [item()], total: 1 });
    mockExcluir.mockRejectedValue(new LancamentoExternoApiError(409, 'A semana deste lançamento já foi fechada: o valor está congelado.', 'SEMANA_JA_FECHADA'));
    const onMudou = vi.fn();
    render(<Tela onMudou={onMudou} />);
    fireEvent.click(screen.getByText('abrir'));
    fireEvent.click(await screen.findByRole('button', { name: /Excluir lançamento/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar exclusão' }));
    expect((await screen.findByRole('alert')).textContent).toContain('já foi fechada');
    expect(onMudou).not.toHaveBeenCalled();
    await waitFor(() => expect(mockListar).toHaveBeenCalledTimes(2));
  });
});

describe('ALTO 2 — excedente do líquido', () => {
  it('R5: servidor trunca em 50 -> o total verdadeiro (da contagem por motivo) aparece, não "50"', async () => {
    mockImportar.mockResolvedValue({
      aplicadas: 0, ignoradas: 300, ignoradasPorMotivo: [{ motivo: 'VALOR_EXCEDE_LIQUIDO', total: 300 }],
      excedentes: Array.from({ length: 50 }, (_, i) => ({ linha: i + 2, valor: '100.00', liquido: '30.00' })),
    });
    const { result } = renderHook(() => useLancamentoExternoDialog({ onSucesso: () => {} }));
    act(() => result.current.escolher(new File([new Uint8Array([1])], 'a.xlsx')));
    await act(async () => { await result.current.enviar(); });
    expect([result.current.resultado?.excedentes.length, result.current.resultado?.excedentesTotal]).toEqual([50, 300]);
  });
  it('o texto nomeia o valor da linha e o líquido disponível', () => {
    expect(textoExcedente({ linha: 7, valor: '100.00', liquido: '30.00' })).toMatch(/Linha 7: .*100,00 excede o líquido disponível de .*30,00/);
  });
  it('o diálogo de importação mostra uma linha por excedente', async () => {
    mockImportar.mockResolvedValue({
      aplicadas: 0, ignoradas: 1, ignoradasPorMotivo: [{ motivo: 'VALOR_EXCEDE_LIQUIDO', total: 1 }],
      excedentes: [{ linha: 3, valor: '100.00', liquido: '30.00' }],
    });
    const { result } = renderHook(() => useLancamentoExternoDialog({ onSucesso: () => {} }));
    act(() => result.current.escolher(new File([new Uint8Array([1])], 'a.xlsx')));
    await act(async () => { await result.current.enviar(); });
    expect(result.current.resultado?.excedentes[0]).toMatch(/Linha 3: .*100,00 excede o líquido disponível de .*30,00/);
    expect(result.current.resultado?.grupos[0].rotulo).toContain('Dedução maior que o líquido');
  });
});

// lancamento-externo — aviso FR-049 (as duas metades + falha NÃO engolida) e o
// diálogo de importação (tipo na querystring/arg, resultado só com contagens).
import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AvisoLancamentoExterno } from './lancamento-externo-aviso';
import { LancamentoExternoDialog, useLancamentoExternoDialog } from './lancamento-externo-dialog';
import { LancamentoExternoApiError, rotuloMotivoLinha, mensagemErroArquivo, formatarParcelaExterna, UM_POR_DIA } from '@/lib/hub/lancamento-externo';

const mockResumo = vi.fn();
const mockImportar = vi.fn();
vi.mock('@/lib/hub/lancamento-externo', async () => {
  const actual = await vi.importActual<typeof import('@/lib/hub/lancamento-externo')>('@/lib/hub/lancamento-externo');
  return {
    ...actual,
    obterResumoLancamentosExternos: (...a: unknown[]) => mockResumo(...a),
    importarLancamentosExternos: (...a: unknown[]) => mockImportar(...a),
  };
});

const resumo = (o = {}) => ({ qtdDeducao: 2, totalDeducao: 60, qtdCredito: 0, totalCredito: 0, flagDescontoLigada: false, qtdNegativo: 0, totalNegativo: 0, ...o });
beforeEach(() => { mockResumo.mockReset(); mockImportar.mockReset(); });

describe('AvisoLancamentoExterno (FR-049)', () => {
  it('A2 (rodada 4): o aviso de remanescente NEGATIVO aparece COM a flag ligada (é quando ela passa a importar)', async () => {
    mockResumo.mockResolvedValue(resumo({ flagDescontoLigada: true, qtdNegativo: 1, totalNegativo: 12 }));
    render(<AvisoLancamentoExterno periodo="2026-09-14" />);
    const aviso = await screen.findByText(/1 motorista com pago por fora fica com remanescente NEGATIVO/);
    expect(aviso.textContent).toContain('12,00');
    expect(screen.queryByText(/NÃO serão descontados/)).not.toBeInTheDocument();
  });

  it('flag desligada + dedução > 0: AVISA, com a quantidade e sem nada identificável', async () => {
    mockResumo.mockResolvedValue(resumo());
    render(<AvisoLancamentoExterno periodo="2026-09-14" />);
    const aviso = await screen.findByRole('alert');
    expect(aviso.textContent).toContain('2 valores pagos por fora');
    expect(aviso.textContent).toContain('NÃO serão descontados');
  });
  it('flag ligada, ou sem dedução: nenhum aviso', async () => {
    mockResumo.mockResolvedValue(resumo({ flagDescontoLigada: true }));
    const { rerender } = render(<AvisoLancamentoExterno periodo="2026-09-14" />);
    await waitFor(() => expect(mockResumo).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('alert')).toBeNull();
    mockResumo.mockResolvedValue(resumo({ qtdDeducao: 0 }));
    rerender(<AvisoLancamentoExterno periodo="2026-09-21" />);
    await waitFor(() => expect(mockResumo).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('alert')).toBeNull();
  });
  it('depois de importar (versao nova) o aviso RECONSULTA — não fica velho até recarregar a página', async () => {
    mockResumo.mockResolvedValueOnce(resumo({ qtdDeducao: 0 }));
    const { rerender } = render(<AvisoLancamentoExterno periodo="2026-09-14" versao={0} />);
    await waitFor(() => expect(mockResumo).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('alert')).toBeNull();
    mockResumo.mockResolvedValueOnce(resumo());
    rerender(<AvisoLancamentoExterno periodo="2026-09-14" versao={1} />);
    await waitFor(() => expect(mockResumo).toHaveBeenCalledTimes(2));
    expect((await screen.findByRole('alert')).textContent).toContain('2 valores pagos por fora');
  });
  it('CHK008: falha na consulta NÃO é engolida — vira alerta', async () => {
    mockResumo.mockRejectedValue(new LancamentoExternoApiError(403, 'x', 'PERMISSAO_NEGADA'));
    render(<AvisoLancamentoExterno periodo="2026-09-14" />);
    expect((await screen.findByRole('alert')).textContent).toContain('Não foi possível verificar');
  });
});

describe('diálogo de importação', () => {
  it('envia o tipo escolhido + o arquivo como ArrayBuffer e mostra só contagens por motivo', async () => {
    mockImportar.mockResolvedValue({ aplicadas: 3, ignoradas: 2, ignoradasPorMotivo: [{ motivo: 'CNPJ_SEM_MOTORISTA', total: 2 }] });
    const onSucesso = vi.fn();
    const { result } = renderHook(() => useLancamentoExternoDialog({ onSucesso }));
    const arq = new File([new Uint8Array([80, 75, 3, 4])], 'pagos.xlsx');
    act(() => { result.current.setTipo('AJUSTE_CREDITO'); result.current.escolher(arq); });
    await act(async () => { await result.current.enviar(); });
    expect(mockImportar).toHaveBeenCalledWith('AJUSTE_CREDITO', expect.any(ArrayBuffer));
    expect(result.current.resultado).toEqual({ aplicadas: 3, ignoradas: 2, excedentes: [], excedentesTotal: 0, grupos: [{ rotulo: 'CNPJ sem motorista cadastrado', total: 2 }] });
    expect(onSucesso).toHaveBeenCalled();
  });
  it('erro de arquivo mostra instrução (cabeçalho) e NÃO chama onSucesso', async () => {
    mockImportar.mockRejectedValue(new LancamentoExternoApiError(400, 'x', 'ARQUIVO_INVALIDO', 'CABECALHO_INVALIDO'));
    const onSucesso = vi.fn();
    const { result } = renderHook(() => useLancamentoExternoDialog({ onSucesso }));
    act(() => { result.current.escolher(new File([new Uint8Array([1])], 'a.xlsx')); });
    await act(async () => { await result.current.enviar(); });
    expect(result.current.erro).toContain('CNPJ, Data do pagamento, Valor, Nome, Observação');
    expect(onSucesso).not.toHaveBeenCalled();
  });
  it('renderiza o seletor de tipo com o RÓTULO (Base UI exige items no Root)', () => {
    const { result } = renderHook(() => useLancamentoExternoDialog({ onSucesso: vi.fn() }));
    act(() => result.current.abrir());
    render(<LancamentoExternoDialog d={result.current} />);
    expect(screen.getByText('Adiantamento (deduz do repasse)')).toBeTruthy();
  });
  it('5b: servidor antigo (sem `excedentes`) NÃO imprime "Mostrando 0 de N"; com a lista, imprime', async () => {
    mockImportar.mockResolvedValue({ aplicadas: 0, ignoradas: 7, ignoradasPorMotivo: [{ motivo: 'VALOR_EXCEDE_LIQUIDO', total: 7 }] });
    const { result } = renderHook(() => useLancamentoExternoDialog({ onSucesso: vi.fn() }));
    act(() => { result.current.abrir(); result.current.escolher(new File([new Uint8Array([80, 75, 3, 4])], 'p.xlsx')); });
    await act(async () => { await result.current.enviar(); });
    expect(result.current.resultado?.excedentesTotal).toBe(7);
    const { container, rerender } = render(<LancamentoExternoDialog d={result.current} />);
    expect(container.ownerDocument.body.textContent).not.toMatch(/Mostrando/);
    const ex = { id_lancamento: 1, linha: 2, liquido: 1, valor: 2 } as never;
    mockImportar.mockResolvedValue({ aplicadas: 0, ignoradas: 7, ignoradasPorMotivo: [{ motivo: 'VALOR_EXCEDE_LIQUIDO', total: 7 }], excedentes: [ex] });
    await act(async () => { await result.current.enviar(); });
    rerender(<LancamentoExternoDialog d={result.current} />);
    expect(container.ownerDocument.body.textContent).toMatch(/Mostrando 1 de 7/);
  });
  it('P7: o tipo NÃO é grudento — reabrir o diálogo volta a ADIANTAMENTO (sinal invertido soma em vez de corrigir)', () => {
    const { result } = renderHook(() => useLancamentoExternoDialog({ onSucesso: vi.fn() }));
    act(() => { result.current.abrir(); result.current.setTipo('AJUSTE_CREDITO'); });
    expect(result.current.tipo).toBe('AJUSTE_CREDITO');
    act(() => result.current.abrir());
    expect(result.current.tipo).toBe('ADIANTAMENTO');
  });
  it('P3: a recusa de semana anterior à apuração tem rótulo em português', () => {
    expect(rotuloMotivoLinha('SEMANA_ANTERIOR_A_APURACAO')).toContain('anterior');
  });
  it('motivo desconhecido aparece cru (sem texto inventado)', () => {
    expect(rotuloMotivoLinha('MOTIVO_NOVO')).toBe('MOTIVO_NOVO');
    expect(mensagemErroArquivo(new LancamentoExternoApiError(400, 'msg', 'ARQUIVO_INVALIDO', 'DESCONHECIDO'))).toBe('msg');
  });
});

describe('H4: a chave única (um por motorista, por dia, por tipo) é explicada nos DOIS motivos', () => {
  it.each(['VALOR_DIVERGENTE', 'DUPLICADA_NO_ARQUIVO'])('%s diz a consequência e o que fazer', (m) => {
    const t = rotuloMotivoLinha(m);
    expect(t).toContain(UM_POR_DIA);
    expect(t).toContain('por motorista, por dia e por tipo');
    expect(t).toContain('ANTES de enviar');
    expect(t).toContain('NÃO deduz');
  });
});

describe('formatarParcelaExterna (sinal explícito; zero/ausente/ilegível = travessão)', () => {
  it.each([
    ['0.00', '—'], ['0', '—'], [null, '—'], [undefined, '—'], ['', '—'], ['abc', '—'],
  ])('%j -> %s', (v, esperado) => {
    expect(formatarParcelaExterna(v as string | null | undefined)).toBe(esperado);
  });
  it('dedução leva − e crédito leva +, ambos com o valor absoluto formatado', () => {
    expect(formatarParcelaExterna('-30.00')).toMatch(/^−\s.*30,00/);
    expect(formatarParcelaExterna('13.00')).toMatch(/^\+\s.*13,00/);
  });
});

// hub-motoristas (S5) FASE 7 task 7.2 — sugestões (FR-007), busca manual
// (FR-009) e confirmação humana explícita OBRIGATÓRIA (FR-008) antes de
// `POST .../vinculo`; aviso quando a conta já está vinculada a outra
// pessoa (task 7.2.3, SC-003).
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useVinculoMotoristaDialog, VinculoMotoristaDialog } from './vinculo-motorista-dialog';
import { MotoristaApiError } from '@/lib/hub/motoristas-api';
import type { ContaCandidata } from '@/lib/hub/motoristas-dto';

const mockBuscarContasElegiveis = vi.fn();
const mockVincularMotorista = vi.fn();

vi.mock('@/lib/hub/motoristas-api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/hub/motoristas-api')>('@/lib/hub/motoristas-api');
  return {
    ...actual,
    buscarContasElegiveis: (...args: unknown[]) => mockBuscarContasElegiveis(...args),
    vincularMotorista: (...args: unknown[]) => mockVincularMotorista(...args),
  };
});

const SUGESTAO_BASE: ContaCandidata = {
  contaMotoristaId: 7,
  nome: 'Fulano da Silva',
  cnpjPrestadorMascarado: '12.***.***/0001-**',
  similaridade: 0.87,
  jaVinculadoA: null,
};

function Harness({ sugestoesIniciais = [SUGESTAO_BASE], entidadeElegivel = true, onVinculado = vi.fn() }: Partial<{
  sugestoesIniciais: ContaCandidata[];
  entidadeElegivel: boolean;
  onVinculado: (v: unknown) => void;
}> = {}) {
  const state = useVinculoMotoristaDialog({
    entregadorId: 1,
    sugestoesIniciais,
    entidadeElegivel,
    onVinculado,
  });
  return (
    <>
      <button onClick={() => state.setOpen(true)}>abrir</button>
      <VinculoMotoristaDialog state={state} />
    </>
  );
}

describe('VinculoMotoristaDialog', () => {
  beforeEach(() => {
    vi.useRealTimers();
    mockBuscarContasElegiveis.mockReset();
    mockVincularMotorista.mockReset();
  });

  it('exibe sugestões automáticas pré-carregadas ao abrir', async () => {
    render(<Harness />);
    fireEvent.click(screen.getByText('abrir'));

    await waitFor(() => expect(screen.getByText('Vincular conta de acesso')).toBeInTheDocument());
    expect(screen.getByText('Fulano da Silva')).toBeInTheDocument();
    expect(screen.getByText('87% similar')).toBeInTheDocument();
  });

  it('entidade não elegível: mensagem sem erro, sem sugestões (FR-011)', async () => {
    render(<Harness entidadeElegivel={false} sugestoesIniciais={[]} />);
    fireEvent.click(screen.getByText('abrir'));

    await waitFor(() =>
      expect(screen.getByText(/Nenhuma conta elegível neste contexto/)).toBeInTheDocument()
    );
  });

  it('aviso quando a conta sugerida já está vinculada a outra pessoa (SC-003, não bloqueia listagem)', async () => {
    render(
      <Harness
        sugestoesIniciais={[{ ...SUGESTAO_BASE, jaVinculadoA: { entregadorId: 9, nome: 'Outra Pessoa' } }]}
      />
    );
    fireEvent.click(screen.getByText('abrir'));

    await waitFor(() => expect(screen.getByText(/Já vinculada a Outra Pessoa/)).toBeInTheDocument());
  });

  it('busca manual: debounce dispara buscarContasElegiveis com o termo', async () => {
    vi.useFakeTimers();
    mockBuscarContasElegiveis.mockResolvedValueOnce({
      items: [{ ...SUGESTAO_BASE, contaMotoristaId: 8, similaridade: undefined }],
      total: 1,
      page: 1,
      pageSize: 20,
      entidadeElegivel: true,
    });
    render(<Harness />);
    fireEvent.click(screen.getByText('abrir'));
    await vi.waitFor(() => expect(screen.getByLabelText('Busca manual')).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText('Busca manual'), { target: { value: 'ful' } });
    await vi.advanceTimersByTimeAsync(350);

    expect(mockBuscarContasElegiveis).toHaveBeenCalledWith({ entregadorId: 1, q: 'ful' });
    vi.useRealTimers();
  });

  it('termo com menos de 2 caracteres não dispara busca', async () => {
    vi.useFakeTimers();
    render(<Harness />);
    fireEvent.click(screen.getByText('abrir'));
    await vi.waitFor(() => expect(screen.getByLabelText('Busca manual')).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText('Busca manual'), { target: { value: 'f' } });
    await vi.advanceTimersByTimeAsync(350);

    expect(mockBuscarContasElegiveis).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('fluxo completo: escolher sugestão -> passo de confirmação -> confirmar chama vincularMotorista', async () => {
    const onVinculado = vi.fn();
    mockVincularMotorista.mockResolvedValueOnce({
      id: 1,
      vinculo: { contaMotoristaId: 7, nome: 'Fulano da Silva', cnpjPrestadorMascarado: '12.***.***/0001-**' },
    });
    render(<Harness onVinculado={onVinculado} />);
    fireEvent.click(screen.getByText('abrir'));

    await waitFor(() => expect(screen.getByText('Fulano da Silva')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Fulano da Silva').closest('button')!);

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Confirmar vínculo' })).toBeInTheDocument());
    // NENHUMA chamada disparada só ao escolher — exige confirmação humana explícita (FR-008).
    expect(mockVincularMotorista).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /Confirmar vínculo/ }));

    await waitFor(() => expect(mockVincularMotorista).toHaveBeenCalledWith(1, 7, 'sugestao'));
    await waitFor(() => expect(onVinculado).toHaveBeenCalled());
  });

  it('conflito 409 no confirmar: mostra mensagem, permanece no diálogo (não fecha)', async () => {
    mockVincularMotorista.mockRejectedValueOnce(
      new MotoristaApiError(409, 'Esta conta já está vinculada a outra pessoa entregadora.', 'CONFLITO', 'conta_ja_vinculada')
    );
    render(<Harness />);
    fireEvent.click(screen.getByText('abrir'));

    await waitFor(() => expect(screen.getByText('Fulano da Silva')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Fulano da Silva').closest('button')!);
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Confirmar vínculo' })).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Confirmar vínculo/ }));

    await waitFor(() =>
      expect(screen.getByText('Esta conta já está vinculada a outra pessoa entregadora.')).toBeInTheDocument()
    );
    expect(screen.getByRole('heading', { name: 'Confirmar vínculo' })).toBeInTheDocument();
  });

  it('botão Voltar retorna ao passo de busca sem confirmar', async () => {
    render(<Harness />);
    fireEvent.click(screen.getByText('abrir'));

    await waitFor(() => expect(screen.getByText('Fulano da Silva')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Fulano da Silva').closest('button')!);
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Confirmar vínculo' })).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Voltar' }));

    await waitFor(() => expect(screen.getByText('Vincular conta de acesso')).toBeInTheDocument());
    expect(mockVincularMotorista).not.toHaveBeenCalled();
  });
});

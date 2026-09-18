// hub-avisos (push-motorista, FASE 7 — tasks.md 7.3.5, complemento do E2E
// deferido à FASE 9.4 — ver block-009/dec-107): cobre em RTL o que NÃO
// depende de Playwright/multi-página — os 3 modos, contador de caracteres,
// prévia de alcance atualizando ao trocar seleção, disparo bloqueado com
// público total vazio (D-15/5.3.2 — SEM_DESTINATARIOS, adiantamento-motorista
// FASE 5), e clique duplo gerando exatamente 1 requisição de rede
// (CHK011 — invariante central de 7.3.4/7.3.5).
//
// Timers REAIS (não `vi.useFakeTimers()`) — mesmo motivo de
// entregador-combobox.test.tsx: o Popover (Base UI) usa
// ResizeObserver/rAF, que trava com fake timers em jsdom.

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AvisoDialog } from './aviso-dialog';
import { AvisoApiError } from '@/lib/hub/avisos-api';
import type { AvisoAlcance, EmpresaDestino, MotoristaDestino } from '@/lib/hub/avisos-dto';

const mockDispararAviso = vi.fn();
const mockObterAlcance = vi.fn();
const mockListarEmpresasDestino = vi.fn();
const mockBuscarMotoristasDestino = vi.fn();

vi.mock('@/lib/hub/avisos-api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/hub/avisos-api')>('@/lib/hub/avisos-api');
  return {
    ...actual,
    dispararAviso: (...args: unknown[]) => mockDispararAviso(...args),
    obterAlcance: (...args: unknown[]) => mockObterAlcance(...args),
    listarEmpresasDestino: (...args: unknown[]) => mockListarEmpresasDestino(...args),
    buscarMotoristasDestino: (...args: unknown[]) => mockBuscarMotoristasDestino(...args),
  };
});

const ALCANCE_OK: AvisoAlcance = { motoristas: 12, comPush: 9, inscricoes: 20 };
// D-15 (5.3.2): público total vazio (SEM_DESTINATARIOS) — não mais "0 inscrições".
const ALCANCE_SEM_DESTINATARIOS: AvisoAlcance = { motoristas: 0, comPush: 0, inscricoes: 0 };
// D-15: público existe mas ninguém tem push — disparo passa a ser PERMITIDO
// (o histórico é gravado para todos mesmo assim).
const ALCANCE_SEM_PUSH: AvisoAlcance = { motoristas: 5, comPush: 0, inscricoes: 0 };
const MOTORISTA: MotoristaDestino = { id: 5, nome: 'Joao Motorista' };
const EMPRESA: EmpresaDestino = { id: 9, nome: 'Filial Sul' };

function abrirDialog() {
  fireEvent.click(screen.getByRole('button', { name: 'Novo aviso' }));
}

function preencherTituloECorpo() {
  fireEvent.change(screen.getByLabelText('Título'), { target: { value: 'Manutenção programada' } });
  fireEvent.change(screen.getByLabelText('Mensagem'), { target: { value: 'O sistema ficará indisponível às 22h.' } });
}

describe('AvisoDialog', () => {
  beforeEach(() => {
    mockDispararAviso.mockReset();
    mockObterAlcance.mockReset();
    mockListarEmpresasDestino.mockReset();
    mockBuscarMotoristasDestino.mockReset();
    mockObterAlcance.mockResolvedValue(ALCANCE_OK);
  });

  it('não renderiza nada sem permissão avisos.enviar', () => {
    render(<AvisoDialog podeCriar={false} />);
    expect(screen.queryByRole('button', { name: 'Novo aviso' })).not.toBeInTheDocument();
  });

  it('contador de caracteres (60/180) e maxLength nativo nos campos', async () => {
    render(<AvisoDialog />);
    abrirDialog();

    expect(screen.getByText('0/60')).toBeInTheDocument();
    expect(screen.getByText('0/180')).toBeInTheDocument();
    expect(screen.getByLabelText('Título')).toHaveAttribute('maxLength', '60');
    expect(screen.getByLabelText('Mensagem')).toHaveAttribute('maxLength', '180');

    fireEvent.change(screen.getByLabelText('Título'), { target: { value: 'Aviso' } });
    expect(screen.getByText('5/60')).toBeInTheDocument();
  });

  it('modo toda_base (default): calcula alcance sem ids e habilita Disparar com público > 0', async () => {
    render(<AvisoDialog />);
    abrirDialog();
    preencherTituloECorpo();

    await waitFor(() => expect(mockObterAlcance).toHaveBeenCalledWith({ modo: 'toda_base', ids: [] }));
    await waitFor(() => expect(screen.getByRole('button', { name: /Disparar/ })).toBeEnabled());
    expect(screen.getByText(/12/)).toBeInTheDocument();
    expect(screen.getByText(/9/)).toBeInTheDocument();
  });

  it('D-15/5.3.2: SEM_DESTINATARIOS (público total vazio) mantém Disparar desabilitado e avisa o operador', async () => {
    mockObterAlcance.mockResolvedValue(ALCANCE_SEM_DESTINATARIOS);
    render(<AvisoDialog />);
    abrirDialog();
    preencherTituloECorpo();

    await waitFor(() => expect(mockObterAlcance).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText(/nenhum motorista corresponde aos destinatários selecionados/)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /Disparar/ })).toBeDisabled();
  });

  it('D-15/5.3.2: público existe mas ninguém tem push — Disparar fica HABILITADO (histórico vai para todos mesmo assim)', async () => {
    mockObterAlcance.mockResolvedValue(ALCANCE_SEM_PUSH);
    render(<AvisoDialog />);
    abrirDialog();
    preencherTituloECorpo();

    await waitFor(() => expect(mockObterAlcance).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText(/ninguém tem push ativo/)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /Disparar/ })).toBeEnabled();
  });

  it('modo individual: exige ao menos 1 selecionado e recalcula alcance com os ids escolhidos', async () => {
    mockBuscarMotoristasDestino.mockResolvedValue([MOTORISTA]);
    render(<AvisoDialog />);
    abrirDialog();
    preencherTituloECorpo();
    await waitFor(() => expect(mockObterAlcance).toHaveBeenCalledWith({ modo: 'toda_base', ids: [] }));

    fireEvent.click(screen.getByRole('radio', { name: /Motoristas específicos/ }));
    // Sem seleção ainda — Disparar continua desabilitado, sem nova chamada de alcance.
    expect(screen.getByRole('button', { name: /Disparar/ })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Buscar motorista...' }));
    const busca = await screen.findByPlaceholderText('Digite ao menos 3 letras do nome...');
    fireEvent.change(busca, { target: { value: 'joa' } });
    const item = await screen.findByText('Joao Motorista');
    fireEvent.click(item);

    await waitFor(() => expect(mockObterAlcance).toHaveBeenCalledWith({ modo: 'individual', ids: [5] }));
    await waitFor(() => expect(screen.getByRole('button', { name: /Disparar/ })).toBeEnabled());
  });

  it('modo empresa: lista as empresas do grupo Movee e recalcula alcance ao marcar uma', async () => {
    mockListarEmpresasDestino.mockResolvedValue([EMPRESA]);
    render(<AvisoDialog />);
    abrirDialog();
    preencherTituloECorpo();
    await waitFor(() => expect(mockObterAlcance).toHaveBeenCalledWith({ modo: 'toda_base', ids: [] }));

    fireEvent.click(screen.getByRole('radio', { name: /Empresa \/ filial/ }));
    const checkbox = await screen.findByText('Filial Sul');
    fireEvent.click(checkbox);

    await waitFor(() => expect(mockObterAlcance).toHaveBeenCalledWith({ modo: 'empresa', ids: [9] }));
  });

  it('CHK011 — clique duplo no Disparar gera exatamente 1 requisição de rede', async () => {
    let resolver: (v: { id: number; status: 'na_fila'; visados: number }) => void = () => {};
    mockDispararAviso.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolver = resolve;
        })
    );
    render(<AvisoDialog />);
    abrirDialog();
    preencherTituloECorpo();
    await waitFor(() => expect(screen.getByRole('button', { name: /Disparar/ })).toBeEnabled());

    const botao = screen.getByRole('button', { name: /Disparar/ });
    fireEvent.click(botao);
    fireEvent.click(botao);

    resolver({ id: 1, status: 'na_fila', visados: 20 });
    await waitFor(() => expect(mockDispararAviso).toHaveBeenCalledTimes(1));
  });

  it('erro do disparo (AvisoApiError) exibe a mensagem e não fecha o diálogo', async () => {
    mockDispararAviso.mockRejectedValue(new AvisoApiError(422, 'Nenhum motorista corresponde aos destinatários selecionados.', 'SEM_DESTINATARIOS'));
    render(<AvisoDialog />);
    abrirDialog();
    preencherTituloECorpo();
    await waitFor(() => expect(screen.getByRole('button', { name: /Disparar/ })).toBeEnabled());

    fireEvent.click(screen.getByRole('button', { name: /Disparar/ }));

    await waitFor(() => expect(screen.getByText('Nenhum motorista corresponde aos destinatários selecionados.')).toBeInTheDocument());
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('disparo bem-sucedido: chama onEnviado(id) com o id retornado', async () => {
    mockDispararAviso.mockResolvedValue({ id: 77, status: 'na_fila', visados: 20 });
    const onEnviado = vi.fn();
    render(<AvisoDialog onEnviado={onEnviado} />);
    abrirDialog();
    preencherTituloECorpo();
    await waitFor(() => expect(screen.getByRole('button', { name: /Disparar/ })).toBeEnabled());

    fireEvent.click(screen.getByRole('button', { name: /Disparar/ }));

    await waitFor(() => expect(onEnviado).toHaveBeenCalledWith(77));
  });
});

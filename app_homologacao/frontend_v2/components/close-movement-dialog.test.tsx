// impeccable rodada 5 (P1) — o "Fechar movimento" seguia clicável durante um
// disparo em andamento: um clique fora de hora lacrava o movimento com parte
// dos motoristas notificados e parte não. Este teste é a trava disso.
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CloseMovementDialog } from './close-movement-dialog';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const STATS = { total: 340, msgEnviada: 12, msgNaoEnviada: 328, notaOk: 0, notaErro: 0 };

function gatilho() {
  return screen.getByRole('button', { name: /Fechar movimento/ });
}

describe('CloseMovementDialog', () => {
  it('durante um disparo ativo, o gatilho fica desabilitado e diz por quê', () => {
    render(<CloseMovementDialog onConfirm={vi.fn()} stats={STATS} isActive />);

    expect(gatilho()).toBeDisabled();
    expect(gatilho()).toHaveAttribute(
      'title',
      expect.stringContaining('disparo em andamento') as unknown as string
    );
  });

  it('sem disparo ativo, o gatilho é utilizável', () => {
    render(<CloseMovementDialog onConfirm={vi.fn()} stats={STATS} isActive={false} />);
    expect(gatilho()).toBeEnabled();
  });

  it('isActive omitido não bloqueia — callers legados seguem funcionando', () => {
    render(<CloseMovementDialog onConfirm={vi.fn()} stats={STATS} />);
    expect(gatilho()).toBeEnabled();
  });

  // O contraste era 1,54:1 porque a cor de assinatura da marca (`text-warm-2`)
  // estava aplicada à ação de encerramento. Este teste impede o retorno.
  it('não usa a cor de marca warm-* no gatilho da ação irreversível', () => {
    render(<CloseMovementDialog onConfirm={vi.fn()} stats={STATS} />);

    const classe = gatilho().className;
    expect(classe).not.toMatch(/warm-/);
    expect(classe).toMatch(/text-destructive/);
  });
});

// impeccable rodada 7 (P1) — dois defeitos no mesmo diálogo.
describe('CloseMovementDialog — rodada 7', () => {
  it('nomeia QUAL movimento está sendo lacrado', async () => {
    render(
      <CloseMovementDialog onConfirm={vi.fn()} stats={STATS} periodo="01/08/2026 a 07/08/2026" />
    );
    fireEvent.click(gatilho());
    // Antes, a pergunta "Fechar o movimento?" era feita sem nunca dizer qual —
    // quem roda um ciclo semanal em duas abas não tinha como conferir.
    expect(await screen.findByText(/01\/08\/2026 a 07\/08\/2026/)).toBeInTheDocument();
  });

  it('lista que não carregou bloqueia a confirmação em vez de fingir movimento vazio', async () => {
    const onConfirm = vi.fn();
    render(
      <CloseMovementDialog
        onConfirm={onConfirm}
        stats={{ total: 0, msgEnviada: 0, msgNaoEnviada: 0, notaOk: 0, notaErro: 0 }}
        dadosIndisponiveis
      />
    );
    fireEvent.click(gatilho());

    expect(await screen.findByText(/não puderam ser carregados/)).toBeInTheDocument();
    const confirmar = screen.getAllByRole('button', { name: /Fechar movimento/ }).at(-1)!;
    expect(confirmar).toBeDisabled();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('movimento legitimamente vazio continua podendo ser fechado', async () => {
    render(
      <CloseMovementDialog
        onConfirm={vi.fn()}
        stats={{ total: 0, msgEnviada: 0, msgNaoEnviada: 0, notaOk: 0, notaErro: 0 }}
      />
    );
    fireEvent.click(gatilho());
    // A trava é para falha de carga, não para movimento sem linhas.
    await screen.findByText(/Esta ação é permanente/);
    const confirmar = screen.getAllByRole('button', { name: /Fechar movimento/ }).at(-1)!;
    expect(confirmar).not.toBeDisabled();
  });
});

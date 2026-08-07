// impeccable rodada 5 (P1) — o "Fechar movimento" seguia clicável durante um
// disparo em andamento: um clique fora de hora lacrava o movimento com parte
// dos motoristas notificados e parte não. Este teste é a trava disso.
import { render, screen } from '@testing-library/react';
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

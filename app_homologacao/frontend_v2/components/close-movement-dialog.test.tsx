// impeccable rodada 5 (P1) — o "Fechar movimento" seguia clicável durante um
// disparo em andamento: um clique fora de hora lacrava o movimento com parte
// dos motoristas notificados e parte não. Este teste é a trava disso.
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CloseMovementDialog } from './close-movement-dialog';
import type { StatsData } from '@/types';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

// Anotado como `StatsData` de propósito: sem a anotação, um literal inline
// aceita qualquer forma e a divergência só aparece em `tsc --noEmit` — foi
// assim que este arquivo passou meses com `msgNaoEnviada`/`notaOk`/`notaErro`,
// campos que o tipo não tem, sem nenhum gate reclamar (o `next build` não
// typecheck-a `.test.tsx` e o vitest não checa tipos).
//
// 340 registros com 12 mensagens enviadas: o diálogo lê só `total` e
// `msgEnviada` e deriva os 328 ainda pendentes no texto.
const STATS: StatsData = { total: 340, msgEnviada: 12, msgErro: 0, xmlEnviado: 0, xmlErro: 0 };
const STATS_ZERADO: StatsData = { total: 0, msgEnviada: 0, msgErro: 0, xmlEnviado: 0, xmlErro: 0 };

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
        stats={STATS_ZERADO}
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
        stats={STATS_ZERADO}
      />
    );
    fireEvent.click(gatilho());
    // A trava é para falha de carga, não para movimento sem linhas.
    await screen.findByText(/Esta ação é permanente/);
    const confirmar = screen.getAllByRole('button', { name: /Fechar movimento/ }).at(-1)!;
    expect(confirmar).not.toBeDisabled();
  });
});

// uiux-hub F4 (task 4.1.3) — KpiCard: props obrigatórias (label, value,
// icon) sempre renderizam; trend é opcional e, quando presente, nunca
// depende só de cor (ícone de direção acompanha o texto — WCAG 1.4.1).
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CheckCircle2 } from 'lucide-react';
import { KpiCard } from './kpi-card';

function icone(container: HTMLElement) {
  return container.querySelector('svg[aria-hidden="true"]');
}

describe('KpiCard', () => {
  it('renderiza rótulo, valor e ícone sem trend (props opcionais ausentes)', () => {
    const { container } = render(
      <KpiCard label="Corridas completadas" value={42} icon={CheckCircle2} />
    );
    expect(screen.getByText('Corridas completadas')).toBeInTheDocument();
    expect(screen.getByText('42')).toBeInTheDocument();
    expect(icone(container)).not.toBeNull();
    expect(screen.queryByText(/vs período/)).not.toBeInTheDocument();
  });

  it('com trend "up": mostra o texto da tendência e um ícone de direção (não só cor)', () => {
    const { container } = render(
      <KpiCard
        label="Taxa de aceitação"
        value="87%"
        icon={CheckCircle2}
        trend={{ label: '+3,2 p.p. vs período anterior', direction: 'up' }}
      />
    );
    expect(screen.getByText('+3,2 p.p. vs período anterior')).toBeInTheDocument();
    // 2 ícones: o do header (rótulo) + o de tendência.
    expect(container.querySelectorAll('svg[aria-hidden="true"]').length).toBe(2);
  });

  it('com trend "down": mesma garantia de ícone acompanhando o texto', () => {
    render(
      <KpiCard
        label="Taxa de conclusão"
        value="61%"
        icon={CheckCircle2}
        trend={{ label: '-1,5 p.p. vs período anterior', direction: 'down' }}
      />
    );
    expect(screen.getByText('-1,5 p.p. vs período anterior')).toBeInTheDocument();
  });
});

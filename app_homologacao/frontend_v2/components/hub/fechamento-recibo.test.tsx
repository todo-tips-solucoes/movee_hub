// impeccable rodada 20 (P1) — o recibo do fim do ciclo.
//
// Os números aqui descrevem um movimento que NÃO EXISTE MAIS: depois do
// fechamento a lista volta vazia. Se este componente mostrar o número errado,
// não há para onde a pessoa ir conferir — daí os casos cobrirem a aritmética e
// não só a renderização.
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { FechamentoRecibo, type MovimentoFechado } from './fechamento-recibo';
import type { StatsData } from '@/types';

const stats = (over: Partial<StatsData> = {}): StatsData =>
  ({ total: 100, msgEnviada: 80, msgErro: 5, xmlEnviado: 0, xmlPendente: 0, ...over }) as StatsData;

const movimento = (over: Partial<MovimentoFechado> = {}): MovimentoFechado => ({
  stats: stats(),
  periodo: '01/08/2026 a 07/08/2026',
  fechadoEm: '2026-08-08T10:00:00.000Z',
  ...over,
});

describe('FechamentoRecibo', () => {
  it('mostra os quatro números do movimento encerrado', () => {
    render(<FechamentoRecibo movimento={movimento()} onDispensar={vi.fn()} />);
    const texto = screen.getByRole('status').textContent ?? '';
    expect(texto).toContain('100');
    expect(texto).toContain('80');
    expect(texto).toContain('5');
    expect(texto).toContain('15'); // sem envio = 100 - 80 - 5
  });

  it('mostra o período quando as linhas o declaram', () => {
    render(<FechamentoRecibo movimento={movimento()} onDispensar={vi.fn()} />);
    expect(screen.getByText(/01\/08\/2026 a 07\/08\/2026/)).toBeInTheDocument();
  });

  it('sem período, não inventa um', () => {
    render(<FechamentoRecibo movimento={movimento({ periodo: null })} onDispensar={vi.fn()} />);
    expect(screen.getByRole('status').textContent).toContain('Movimento fechado');
    expect(screen.getByRole('status').textContent).not.toMatch(/\d{2}\/\d{2}\/\d{4}/);
  });

  it('nunca mostra "sem envio" negativo', () => {
    // `stats` vem de uma lista só, mas total menor que a soma não pode virar
    // "-3 sem envio" no único registro que sobra do ciclo.
    render(
      <FechamentoRecibo movimento={movimento({ stats: stats({ total: 10, msgEnviada: 8, msgErro: 5 }) })} onDispensar={vi.fn()} />
    );
    expect(screen.getByRole('status').textContent).not.toContain('-3');
    expect(screen.getByRole('status').textContent).toContain('0 sem envio');
  });

  it('diz que as linhas saíram da tela — a pessoa não vai procurá-las', () => {
    render(<FechamentoRecibo movimento={movimento()} onDispensar={vi.fn()} />);
    expect(screen.getByText(/saíram desta tela/i)).toBeInTheDocument();
  });

  it('NÃO é região viva: quem anuncia o marco é o toast (lição da r17)', () => {
    render(<FechamentoRecibo movimento={movimento()} onDispensar={vi.fn()} />);
    // `role="status"` fica como âncora de navegação; `aria-live="off"`
    // sobrepõe o `polite` implícito para não interromper a leitura.
    expect(screen.getByRole('status')).toHaveAttribute('aria-live', 'off');
  });

  it('dispensar avisa quem controla o estado', () => {
    const onDispensar = vi.fn();
    render(<FechamentoRecibo movimento={movimento()} onDispensar={onDispensar} />);
    fireEvent.click(screen.getByRole('button', { name: /dispensar/i }));
    expect(onDispensar).toHaveBeenCalledTimes(1);
  });
});

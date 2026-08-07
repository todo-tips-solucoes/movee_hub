// impeccable rodada 6 (P1-2) — recibo do disparo.
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DisparoRecibo, calcularPendentes } from './disparo-recibo';
import type { StatsData } from '@/types';

const STATS: StatsData = {
  total: 340,
  msgEnviada: 320,
  msgErro: 8,
  xmlEnviado: 0,
  xmlErro: 0,
};

describe('calcularPendentes', () => {
  it('é o que não foi enviado nem falhou', () => {
    expect(calcularPendentes(STATS)).toBe(12);
  });

  it('nunca é negativo', () => {
    expect(calcularPendentes({ ...STATS, total: 5 })).toBe(0);
  });
});

describe('DisparoRecibo', () => {
  it('mostra os três números do disparo', () => {
    render(<DisparoRecibo stats={STATS} onVerErros={vi.fn()} onDispensar={vi.fn()} />);
    const resumo = screen.getByRole('status').textContent ?? '';
    expect(resumo).toContain('320');
    expect(resumo).toContain('enviadas');
    expect(resumo).toContain('8');
    expect(resumo).toContain('com erro');
    expect(resumo).toContain('12');
    expect(resumo).toContain('sem envio');
  });

  it('sem erros não oferece o atalho de filtrar — não manda para uma lista vazia', () => {
    render(
      <DisparoRecibo
        stats={{ ...STATS, msgErro: 0 }}
        onVerErros={vi.fn()}
        onDispensar={vi.fn()}
      />
    );
    expect(screen.queryByRole('button', { name: /com erro/i })).toBeNull();
  });

  it('o atalho de erro chama onVerErros', () => {
    const onVerErros = vi.fn();
    render(<DisparoRecibo stats={STATS} onVerErros={onVerErros} onDispensar={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /8 linhas com erro/i }));
    expect(onVerErros).toHaveBeenCalledTimes(1);
  });

  it('dispensar tem nome acessível e chama onDispensar', () => {
    const onDispensar = vi.fn();
    render(<DisparoRecibo stats={STATS} onVerErros={vi.fn()} onDispensar={onDispensar} />);
    fireEvent.click(screen.getByRole('button', { name: /dispensar/i }));
    expect(onDispensar).toHaveBeenCalledTimes(1);
  });
});

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

// impeccable rodada 7 (P1) — o recibo de um disparo por seleção anunciava os
// números do movimento inteiro: dispare para 12 e leia "320 enviadas".
describe('DisparoRecibo — escopo do disparo', () => {
  const ESCOPO: StatsData = { total: 12, msgEnviada: 11, msgErro: 1, xmlEnviado: 0, xmlErro: 0 };

  it('sem escopo, o título não fala de seleção e o atalho traz o número', () => {
    render(<DisparoRecibo stats={STATS} onVerErros={vi.fn()} onDispensar={vi.fn()} />);
    expect(screen.getByText(/Disparo concluído/)).toBeInTheDocument();
    expect(screen.queryByText(/selecionado/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /as 8 linhas com erro/ })).toBeInTheDocument();
  });

  it('com escopo, diz quantos foram e conta apenas eles', () => {
    render(<DisparoRecibo stats={ESCOPO} escopo={12} onVerErros={vi.fn()} onDispensar={vi.fn()} />);
    expect(screen.getByText(/12 selecionados/)).toBeInTheDocument();
    // Os números são os do escopo — nada do movimento inteiro vaza para cá.
    const recibo = screen.getByRole('status');
    expect(recibo).toHaveTextContent('11 enviadas');
    expect(recibo).toHaveTextContent('1 com erro');
    expect(recibo).not.toHaveTextContent('320');
  });

  it('com escopo, o atalho não promete um número que o filtro não vai mostrar', () => {
    render(<DisparoRecibo stats={ESCOPO} escopo={12} onVerErros={vi.fn()} onDispensar={vi.fn()} />);
    // O filtro aplicado é "Com Erro" no movimento inteiro: dizer "a 1 linha"
    // e revelar 15 seria trocar uma mentira por outra.
    expect(screen.getByRole('button', { name: 'Ver as linhas com erro' })).toBeInTheDocument();
  });

  it('escopo de 1 concorda em número', () => {
    render(
      <DisparoRecibo
        stats={{ total: 1, msgEnviada: 1, msgErro: 0, xmlEnviado: 0, xmlErro: 0 }}
        escopo={1}
        onVerErros={vi.fn()}
        onDispensar={vi.fn()}
      />
    );
    expect(screen.getByText(/1 selecionado(?!s)/)).toBeInTheDocument();
  });
});

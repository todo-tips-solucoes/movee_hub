// impeccable r23 — a faixa de cobertura existe para tornar VISÍVEL o dia que
// não entrou na importação. O que precisa de teste é exatamente isso: que o
// dia ausente seja desenhado como lacuna em vez de sumir da faixa, e que a
// aritmética de datas não perca o primeiro dia por causa de fuso.
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CoberturaPeriodo, diasDoIntervalo, type DiaCobertura } from './cobertura-periodo';

const dia = (chave: string, total: string, quantidade = 3): DiaCobertura => ({
  chave,
  total,
  totalFormatado: `R$ ${total}`,
  quantidade,
});

describe('diasDoIntervalo', () => {
  it('inclui as duas pontas', () => {
    expect(diasDoIntervalo('2026-07-01', '2026-07-03')).toEqual([
      '2026-07-01',
      '2026-07-02',
      '2026-07-03',
    ]);
  });

  it('um dia só: intervalo degenerado continua válido', () => {
    expect(diasDoIntervalo('2026-07-01', '2026-07-01')).toEqual(['2026-07-01']);
  });

  it('atravessa a virada de mês e de ano', () => {
    expect(diasDoIntervalo('2026-12-30', '2027-01-02')).toEqual([
      '2026-12-30',
      '2026-12-31',
      '2027-01-01',
      '2027-01-02',
    ]);
  });

  it('intervalo invertido ou inválido devolve vazio, nunca lista infinita', () => {
    expect(diasDoIntervalo('2026-07-10', '2026-07-01')).toEqual([]);
    expect(diasDoIntervalo('', '2026-07-01')).toEqual([]);
    expect(diasDoIntervalo('2026-07-01', 'nao-e-data')).toEqual([]);
  });

  it('intervalo absurdo (data digitada errada) não gera dezenas de milhares de nós', () => {
    expect(diasDoIntervalo('2026-07-01', '2206-07-01')).toEqual([]);
  });
});

describe('CoberturaPeriodo', () => {
  it('o dia sem lançamento aparece na faixa, não some', () => {
    render(
      <CoberturaPeriodo
        de="2026-07-01"
        ate="2026-07-04"
        dias={[dia('2026-07-01', '100.00'), dia('2026-07-04', '250.00')]}
      />
    );
    // 4 dias no intervalo, 2 com lançamento: os 4 continuam na faixa.
    expect(screen.getAllByRole('listitem')).toHaveLength(4);
    expect(screen.getByText('02/07: sem lançamento.')).toBeInTheDocument();
    expect(screen.getByText('03/07: sem lançamento.')).toBeInTheDocument();
  });

  it('conta as lacunas em texto, não só na cor', () => {
    render(
      <CoberturaPeriodo
        de="2026-07-01"
        ate="2026-07-04"
        dias={[dia('2026-07-01', '100.00'), dia('2026-07-04', '250.00')]}
      />
    );
    expect(
      screen.getByText('2 de 4 dias sem nenhum lançamento no período filtrado.')
    ).toBeInTheDocument();
  });

  it('período completo: a frase afirma a completude em vez de calar', () => {
    render(
      <CoberturaPeriodo
        de="2026-07-01"
        ate="2026-07-02"
        dias={[dia('2026-07-01', '100.00'), dia('2026-07-02', '250.00')]}
      />
    );
    expect(screen.getByText('2 dias no período, todos com lançamento.')).toBeInTheDocument();
  });

  it('o primeiro dia do intervalo não se perde por fuso', () => {
    render(<CoberturaPeriodo de="2026-07-01" ate="2026-07-02" dias={[dia('2026-07-01', '10.00')]} />);
    expect(screen.getByText(/^01\/07: R\$ 10\.00/)).toBeInTheDocument();
  });

  it('intervalo derivado do dado avisa que as bordas não são afirmáveis', () => {
    render(
      <CoberturaPeriodo
        de="2026-07-01"
        ate="2026-07-02"
        dias={[dia('2026-07-01', '10.00'), dia('2026-07-02', '20.00')]}
        intervaloDerivado
      />
    );
    expect(screen.getByText(/Intervalo derivado dos lançamentos carregados/)).toBeInTheDocument();
  });

  // Achado da verificação com dado REAL: a base de QA tem competência em 1900
  // ao lado de 2026, e a faixa sumia em silêncio — some justamente quando há
  // algo estranho no dado, que é o oposto do que a tela existe para fazer.
  it('intervalo largo demais explica em vez de sumir', () => {
    render(<CoberturaPeriodo de="1900-03-03" ate="2026-11-02" dias={[dia('1900-03-03', '84.00')]} />);
    expect(screen.getByText(/mais de 400 dias/)).toBeInTheDocument();
    expect(screen.getByText(/data de competência incorreta na planilha/)).toBeInTheDocument();
    expect(screen.queryAllByRole('listitem')).toHaveLength(0);
  });

  it('intervalo inválido não renderiza nada (nem faixa vazia enganosa)', () => {
    const { container } = render(<CoberturaPeriodo de="2026-07-10" ate="2026-07-01" dias={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});

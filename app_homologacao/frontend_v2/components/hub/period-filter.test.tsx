// impeccable r23 — o `PeriodFilter` não tinha teste de componente (só a lógica
// de presets em `lib/hub/periodo.test.ts`). O que se testa aqui é o ECO: a
// frase que o operador lê sobre QUAL período está na tela.
//
// Por que isso ganhou teste agora: a tela afirmava "Exibindo todo o período
// disponível" enquanto o backend aplicava `JANELA_PADRAO_DIAS = 30`. Pego em
// tela real — a base de QA tem R$ 21.159,34 em 220 lançamentos e o total
// aparecia como R$ 0,00, porque nada caía nos últimos 30 dias. Numa tela usada
// para conferir antes de pagar, acreditar que se está vendo tudo é o defeito
// mais caro que existe.
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PeriodFilter } from './period-filter';

describe('PeriodFilter — eco do período', () => {
  it('sem período e com janela padrão: diz os 30 dias, não "todo o período"', () => {
    render(<PeriodFilter idPrefix="t" de="" ate="" onChange={() => {}} janelaPadraoDias={30} />);
    // `getByText('30 dias')` casaria também com o CHIP de preset de mesmo
    // nome — a asserção precisa ser sobre a frase do eco, não sobre o texto
    // solto (dois elementos, teste ambíguo).
    const eco = screen.getByText(/Exibindo os últimos/);
    expect(eco).toHaveTextContent('Exibindo os últimos 30 dias — informe um período para ver além disso.');
    expect(screen.queryByText(/todo o período disponível/)).not.toBeInTheDocument();
  });

  it('sem janela declarada, a rota devolve tudo e a frase antiga continua certa', () => {
    render(<PeriodFilter idPrefix="t" de="" ate="" onChange={() => {}} />);
    expect(screen.getByText(/todo o período disponível/)).toBeInTheDocument();
  });

  it('com período informado, a janela padrão não se aplica e some da frase', () => {
    render(
      <PeriodFilter
        idPrefix="t"
        de="2026-06-30"
        ate="2026-07-08"
        onChange={() => {}}
        janelaPadraoDias={30}
      />
    );
    expect(screen.getByText(/Exibindo de/)).toBeInTheDocument();
    expect(screen.queryByText(/Exibindo os últimos/)).not.toBeInTheDocument();
  });

  it('intervalo invertido é dito na hora, e não vira consulta vazia silenciosa', () => {
    render(
      <PeriodFilter idPrefix="t" de="2026-07-10" ate="2026-07-01" onChange={() => {}} janelaPadraoDias={30} />
    );
    expect(screen.getByRole('alert')).toHaveTextContent(/é posterior à final/);
  });
});

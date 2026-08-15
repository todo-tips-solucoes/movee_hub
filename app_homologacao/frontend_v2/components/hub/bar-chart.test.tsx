// uiux-hub F4 — HorizontalBarChart: contrato de acessibilidade (rótulo e
// valor sempre em TEXTO, cor nunca é o único sinal) e corte nunca silencioso.
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { HorizontalBarChart, type BarraDado } from './bar-chart';

const DADOS: BarraDado[] = [
  { chave: 'entrega', rotulo: 'Entrega', valor: 1200.5, valorFormatado: 'R$ 1.200,50' },
  { chave: 'bonus', rotulo: 'Bônus', valor: 300, valorFormatado: 'R$ 300,00' },
];

describe('HorizontalBarChart', () => {
  it('renderiza rótulo e valor em texto para cada barra', () => {
    render(<HorizontalBarChart titulo="Faturamento por categoria" dados={DADOS} />);
    expect(screen.getByRole('figure', { name: 'Faturamento por categoria' })).toBeInTheDocument();
    expect(screen.getByText('Entrega')).toBeInTheDocument();
    expect(screen.getByText('R$ 1.200,50')).toBeInTheDocument();
    expect(screen.getByText('Bônus')).toBeInTheDocument();
    expect(screen.getByText('R$ 300,00')).toBeInTheDocument();
  });

  it('sem dados: empty state com role=status, nunca um eixo vazio', () => {
    render(<HorizontalBarChart titulo="Vazio" dados={[]} />);
    expect(screen.getByRole('status')).toHaveTextContent('Sem dados para os filtros atuais.');
  });

  it('corte por maxBarras nunca é silencioso: mostra nota "N maiores de M"', () => {
    const muitos: BarraDado[] = Array.from({ length: 12 }, (_, i) => ({
      chave: `g${i}`,
      rotulo: `Grupo ${i}`,
      valor: 12 - i,
      valorFormatado: String(12 - i),
    }));
    render(<HorizontalBarChart titulo="Muitos" dados={muitos} maxBarras={10} />);
    expect(screen.getAllByRole('listitem')).toHaveLength(10);
    expect(screen.getByText(/Mostrando os 10 maiores de 12 grupos/)).toBeInTheDocument();
  });

  // impeccable r22 (P3): o aviso de corte agora traz o controle junto — antes
  // mandava "refine os filtros" e não oferecia saída nenhuma ali.
  it('"Ver todos" expande o corte e volta atrás', () => {
    const muitos: BarraDado[] = Array.from({ length: 12 }, (_, i) => ({
      chave: `g${i}`,
      rotulo: `Grupo ${i}`,
      valor: 12 - i,
      valorFormatado: String(12 - i),
    }));
    render(<HorizontalBarChart titulo="Muitos" dados={muitos} maxBarras={10} />);

    fireEvent.click(screen.getByRole('button', { name: 'Ver todos os 12' }));
    expect(screen.getAllByRole('listitem')).toHaveLength(12);
    expect(screen.getByText(/Mostrando os 12 grupos/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Mostrar só os maiores' }));
    expect(screen.getAllByRole('listitem')).toHaveLength(10);
  });

  // impeccable r22 (P3): gráfico e lista diziam o mesmo vazio de dois jeitos,
  // lado a lado na mesma tela.
  it('mensagemVazia: a tela dita a frase do vazio', () => {
    render(
      <HorizontalBarChart
        titulo="Vazio"
        dados={[]}
        mensagemVazia="Nenhum lançamento no período selecionado."
      />
    );
    expect(screen.getByRole('status')).toHaveTextContent(
      'Nenhum lançamento no período selecionado.'
    );
  });
});

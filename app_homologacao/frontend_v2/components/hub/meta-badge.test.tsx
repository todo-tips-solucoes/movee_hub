// impeccable r24 — o badge é onde a tela EMITE JULGAMENTO, e a revisão
// adversarial achou três frases erradas aqui. Cada uma virou teste.
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MetaBadge } from './meta-badge';

describe('MetaBadge', () => {
  it('sem meta configurada: silêncio total (a tela não inventa patamar)', () => {
    const { container } = render(<MetaBadge valor={0.5} meta={undefined} rotulo="Taxa" />);
    expect(container).toBeEmptyDOMElement();
  });

  // Antes calava também aqui — e a ausência era indistinguível de aprovação,
  // justamente nos turnos piores (sem aceites não há taxa de conclusão).
  it('meta existe e leitura não: diz "sem leitura", em vez de calar', () => {
    render(<MetaBadge valor={null} meta={0.9} rotulo="Taxa de conclusão" />);
    expect(screen.getByText(/sem leitura neste turno/)).toBeInTheDocument();
    expect(screen.getByText(/meta de 90%/)).toBeInTheDocument();
  });

  // `toHaveTextContent` no container: a frase é montada em <span> aninhados
  // (para dar peso diferente ao valor e à referência), então um matcher de
  // texto por nó não a encontra inteira.
  it('abaixo da meta', () => {
    const { container } = render(<MetaBadge valor={0.6} meta={0.7} rotulo="Taxa" />);
    expect(container).toHaveTextContent('Taxa: 60% abaixo da meta de 70%');
  });

  it('exatamente na meta', () => {
    const { container } = render(<MetaBadge valor={0.7} meta={0.7} rotulo="Taxa" />);
    expect(container).toHaveTextContent('Taxa: 70% na meta de 70%');
  });

  // "na meta" em português operacional é EXATAMENTE no patamar; dizê-lo para
  // quem entregou 95% contra 70% subdeclara quem foi bem.
  it('acima da meta não é dito como "na meta"', () => {
    const { container } = render(<MetaBadge valor={0.95} meta={0.7} rotulo="Taxa" />);
    expect(container).toHaveTextContent('Taxa: 95% acima da meta de 70%');
    expect(container).not.toHaveTextContent('na meta');
  });

  // Comparava em precisão total e exibia arredondado: 89,96% contra meta de
  // 90% imprimia "90% abaixo da meta de 90%" — contradição na mesma frase.
  it('não se contradiz por arredondamento', () => {
    const { container } = render(<MetaBadge valor={0.8996} meta={0.9} rotulo="Tempo disponível" />);
    expect(container).toHaveTextContent('Tempo disponível: 90% na meta de 90%');
    expect(container).not.toHaveTextContent('abaixo');
  });
});

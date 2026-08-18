// `IndicadorMeta` é onde a tela de Performance EMITE JULGAMENTO no grão do
// turno. Os casos abaixo são os mesmos que a revisão adversarial da rodada 24
// achou no `MetaBadge`: este arquivo HERDA a cobertura dele, que foi removido
// junto com o componente nesta entrega. A novidade é a distância em pontos
// percentuais, que pode contradizer os números ao lado se for calculada noutra
// precisão.
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { IndicadorMeta } from './indicador-meta';

describe('IndicadorMeta', () => {
  it('sem meta configurada: mostra o número e NENHUM julgamento', () => {
    const { container } = render(<IndicadorMeta valor={0.5} meta={undefined} rotulo="Taxa de aceitação" />);
    expect(container).toHaveTextContent('50%');
    expect(container).not.toHaveTextContent('meta');
    expect(container).not.toHaveTextContent('pp');
  });

  it('sem leitura: "—", nunca 0% — e diz que falta leitura', () => {
    render(<IndicadorMeta valor={null} meta={0.9} rotulo="Taxa de conclusão" />);
    expect(screen.getByText(/sem leitura neste turno/)).toBeInTheDocument();
    expect(screen.getByText(/meta de 90%/)).toBeInTheDocument();
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('abaixo da meta: distância NEGATIVA em pontos percentuais', () => {
    const { container } = render(<IndicadorMeta valor={0.75} meta={0.9} rotulo="Taxa de aceitação" />);
    expect(container).toHaveTextContent('75%');
    expect(container).toHaveTextContent('−15pp');
    expect(container).toHaveTextContent('Taxa de aceitação: 75%, abaixo da meta de 90%.');
  });

  it('acima da meta: distância POSITIVA, e não é dito como "na meta"', () => {
    const { container } = render(<IndicadorMeta valor={0.95} meta={0.7} rotulo="Taxa" />);
    expect(container).toHaveTextContent('+25pp');
    expect(container).toHaveTextContent('Taxa: 95%, acima da meta de 70%.');
    expect(container).not.toHaveTextContent('na meta');
  });

  it('exatamente na meta é um TERCEIRO estado, não "acima"', () => {
    const { container } = render(<IndicadorMeta valor={0.7} meta={0.7} rotulo="Taxa" />);
    expect(container).toHaveTextContent('na meta');
    expect(container).not.toHaveTextContent('pp');
  });

  // O achado da r24, reproduzido aqui: comparando em precisão total e exibindo
  // arredondado, a célula se contradizia na própria frase — imprimia "90%,
  // abaixo da meta de 90%". Alcançável com dado real (o tempo chega com 2
  // casas), então tem de ser teste, não comentário.
  it('compara na MESMA precisão em que exibe (89,96% contra meta de 90%)', () => {
    const { container } = render(<IndicadorMeta valor={0.8996} meta={0.9} rotulo="Tempo disponível" />);
    expect(container).toHaveTextContent('Tempo disponível: 90%, na meta de 90%.');
    expect(container).not.toHaveTextContent('abaixo');
  });

  it('a distância não contradiz os dois números exibidos', () => {
    // 66,66…% exibido como 66,7%; contra 90% a distância exibida tem de ser
    // −23,3pp, e não −23,34pp calculado na precisão cheia.
    const { container } = render(<IndicadorMeta valor={2 / 3} meta={0.9} rotulo="Taxa" />);
    expect(container).toHaveTextContent('66,7%');
    expect(container).toHaveTextContent('−23,3pp');
  });

  it('a cor não é o único sinal: a frase inteira existe em texto', () => {
    render(
      <IndicadorMeta
        valor={0.5}
        meta={0.9}
        rotulo="Taxa de aceitação"
        detalhe="6 aceitas e 6 rejeitadas de 12 ofertadas"
      />
    );
    expect(
      screen.getByText(
        'Taxa de aceitação: 50%, abaixo da meta de 90%. (6 aceitas e 6 rejeitadas de 12 ofertadas)'
      )
    ).toBeInTheDocument();
  });
});

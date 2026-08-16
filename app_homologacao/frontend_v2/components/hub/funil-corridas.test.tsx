// impeccable r24 — o que precisa de teste no funil é a aritmética que a tela
// passou a fazer: razão sem denominador não pode virar 0%, e os contadores de
// origem têm de continuar legíveis (é o que permite conferir a derivação).
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { FunilCorridas, razao } from './funil-corridas';

describe('razao', () => {
  it('calcula a fração quando há denominador', () => {
    expect(razao(100, 120)).toBeCloseTo(0.8333, 4);
  });

  it('sem denominador não inventa 0% — devolve null', () => {
    expect(razao(10, 0)).toBeNull();
    expect(razao(10, null)).toBeNull();
    expect(razao(null, 100)).toBeNull();
  });

  it('denominador negativo é dado corrompido, não zero', () => {
    expect(razao(5, -3)).toBeNull();
  });
});

describe('FunilCorridas', () => {
  it('mostra o caminho ofertadas → aceitas → completadas com as duas razões', () => {
    render(
      <FunilCorridas
        dados={{ ofertadas: 120, aceitas: 100, rejeitadas: 20, completadas: 95, canceladas: 5 }}
      />
    );
    // `.closest('p')`: o texto "120 of." vive num <span> próprio, e é a
    // linha inteira que se quer asseverar.
    const linha = screen.getByText(/120 of\./).closest('p');
    expect(linha).toHaveTextContent('120 of. → 100 ac. (83%) → 95 compl. (95%)');
  });

  it('as perdas ficam visíveis, não escondidas em title', () => {
    render(
      <FunilCorridas
        dados={{ ofertadas: 120, aceitas: 100, rejeitadas: 20, completadas: 95, canceladas: 5 }}
      />
    );
    expect(screen.getByText('20 rejeitadas · 5 canceladas')).toBeInTheDocument();
  });

  it('concordância no singular: "1 cancelada", não "1 canceladas"', () => {
    render(
      <FunilCorridas
        dados={{ ofertadas: 30, aceitas: 25, rejeitadas: 4, completadas: 20, canceladas: 1 }}
      />
    );
    expect(screen.getByText('4 rejeitadas · 1 cancelada')).toBeInTheDocument();
  });

  it('só a perda que existe: zero não ocupa a linha', () => {
    render(
      <FunilCorridas
        dados={{ ofertadas: 50, aceitas: 45, rejeitadas: 5, completadas: 40, canceladas: 0 }}
      />
    );
    expect(screen.getByText('5 rejeitadas')).toBeInTheDocument();
    expect(screen.queryByText(/0 cancelada/)).not.toBeInTheDocument();
  });

  it('sem perdas, a linha de perdas some em vez de dizer "0 e 0"', () => {
    render(
      <FunilCorridas
        dados={{ ofertadas: 10, aceitas: 10, rejeitadas: 0, completadas: 10, canceladas: 0 }}
      />
    );
    expect(screen.queryByText(/rejeitadas ·/)).not.toBeInTheDocument();
  });

  it('dado ausente vira — e não 0, inclusive nas razões', () => {
    render(
      <FunilCorridas
        dados={{ ofertadas: null, aceitas: null, rejeitadas: null, completadas: null, canceladas: null }}
      />
    );
    const linha = screen.getByText(/— of\./).closest('p');
    expect(linha).toHaveTextContent('— of. → — ac. (—) → — compl. (—)');
  });

  it('zero ofertadas não desenha barra (barra vazia leria como "tudo zero")', () => {
    const { container } = render(
      <FunilCorridas
        dados={{ ofertadas: 0, aceitas: 0, rejeitadas: 0, completadas: 0, canceladas: 0 }}
      />
    );
    expect(container.querySelector('[title]')).toBeNull();
  });
});

// Seletor de categorias extraído das Configurações do adiantamento (e usado no
// extrato das campanhas): busca, família dobrada, marcar visíveis, contador.

import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { SeletorCategorias } from './seletor-categorias';
import type { CategoriaProducao } from '@/lib/hub/adiantamentos-api';

const CATS: CategoriaProducao[] = [
  { descricao: 'Corridas concluidas', lancamentos: 41462, semMotoristaIdentificado: false, familia: null },
  { descricao: 'Promocao entregador', lancamentos: 11885, semMotoristaIdentificado: false, familia: 'familia:promocao' },
  { descricao: 'Promocao jantar', lancamentos: 100, semMotoristaIdentificado: false, familia: 'familia:promocao' },
];

function Host({ inicial = [] as string[], disponiveis = CATS }) {
  const [sel, setSel] = useState(inicial);
  return (
    <SeletorCategorias
      titulo="Categorias do faturamento"
      textoVazio="Sem categorias."
      disponiveis={disponiveis}
      selecionadas={sel}
      onChange={setSel}
      aviso="Nenhuma marcada."
    />
  );
}

describe('SeletorCategorias', () => {
  it('nenhuma marcada por padrão: contador e aviso; dobra a família num item só', () => {
    render(<Host />);
    expect(screen.getByText('0 de 2 selecionadas')).toBeInTheDocument();
    expect(screen.getByText('Nenhuma marcada.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Promoção/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Promocao jantar/ })).not.toBeInTheDocument();
  });

  it('marcar a família grava o TOKEN, não os nomes; busca filtra por membro, sem acento', () => {
    render(<Host />);
    fireEvent.click(screen.getByRole('button', { name: /Promoção/ }));
    expect(screen.getByText('1 de 2 selecionadas')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Promoção/ })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.change(screen.getByLabelText('Buscar categoria'), { target: { value: 'JANTAR' } });
    expect(screen.getByRole('button', { name: /Promoção/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Corridas/ })).not.toBeInTheDocument();
  });

  it('"Marcar visíveis" marca só o que a busca deixa, e "Desmarcar visíveis" desfaz', () => {
    render(<Host />);
    fireEvent.change(screen.getByLabelText('Buscar categoria'), { target: { value: 'corridas' } });
    fireEvent.click(screen.getByRole('button', { name: 'Marcar visíveis' }));
    expect(screen.getByText('1 de 2 selecionadas')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Desmarcar visíveis' }));
    expect(screen.getByText('0 de 2 selecionadas')).toBeInTheDocument();
  });

  it('valor salvo que não existe mais na lista continua visível (dá para desmarcar)', () => {
    render(<Host inicial={['Categoria extinta']} />);
    expect(screen.getByRole('button', { name: /Categoria extinta/ })).toHaveAttribute('aria-pressed', 'true');
  });

  it('sem categorias: mostra o texto vazio', () => {
    render(<Host disponiveis={[]} />);
    expect(screen.getByText('Sem categorias.')).toBeInTheDocument();
  });
});

describe('SeletorCategorias com modo', () => {
  const CATS_M: CategoriaProducao[] = [
    { descricao: 'Corridas concluidas', lancamentos: 10, semMotoristaIdentificado: false, familia: null, primeira: '2026-01-01' },
    { descricao: 'Gorjeta', lancamentos: 5, semMotoristaIdentificado: false, familia: null, primeira: '2026-11-20' },
    { descricao: 'Percentual atingido de rotas', lancamentos: 3, semMotoristaIdentificado: false, familia: 'familia:indicador', primeira: '2026-01-01' },
  ];
  function HostM({ inicial = [] as string[] }) {
    const [sel, setSel] = useState(inicial);
    return (
      <>
        <SeletorCategorias
          titulo="Lista" textoVazio="x" disponiveis={CATS_M} selecionadas={sel} onChange={setSel}
          modo={{ valor: sel.includes('modo:todas') ? 'todas' : 'marcadas' }} revisadoEm="2026-11-10" destino="do repasse"
        />
        <span data-testid="lista">{JSON.stringify(sel)}</span>
      </>
    );
  }
  const lista = () => JSON.parse(screen.getByTestId('lista').textContent ?? '[]');

  it('trocar para todas insere o token e pré-marca Indicadores; contagem e chip sem token', () => {
    render(<HostM />);
    fireEvent.click(screen.getByRole('radio', { name: 'Todas, exceto as marcadas' }));
    expect(lista()).toEqual(['modo:todas', 'familia:indicador']);
    expect(screen.getByText('1 exceção · 2 de 3 categorias entram')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /modo:todas/ })).not.toBeInTheDocument();
    const ind = screen.getByRole('button', { name: /Indicadores/ });
    expect(ind).toHaveAttribute('aria-pressed', 'true');
    expect(ind).toHaveTextContent('fora');
  });

  it('marcar exceção grava mantendo o token; trocar para marcadas limpa', () => {
    render(<HostM inicial={['modo:todas']} />);
    fireEvent.click(screen.getByRole('button', { name: /Gorjeta/ }));
    expect(lista()).toEqual(['modo:todas', 'Gorjeta']);
    fireEvent.click(screen.getByRole('radio', { name: 'Só as marcadas' }));
    expect(lista()).toEqual([]);
  });

  it('aviso azul no modo todas: novas já entram', () => {
    render(<HostM inicial={['modo:todas']} />);
    const a = screen.getByRole('status');
    expect(a).toHaveTextContent('1 categoria nova desde a última revisão (10/11) — já estão entrando: Gorjeta.');
  });

  it('aviso âmbar no modo marcadas: novas estão FORA do destino; some se marcada', () => {
    render(<HostM inicial={['Corridas concluidas']} />);
    expect(screen.getByRole('status')).toHaveTextContent('estão FORA do repasse: Gorjeta.');
    fireEvent.click(screen.getByRole('button', { name: /Gorjeta/ }));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('revisadoEm ISO às 22h de SP: categoria do dia seguinte (UTC) ainda é nova e o aviso mostra o dia local', () => {
    const cats = [{ descricao: 'Nova 24', lancamentos: 1, semMotoristaIdentificado: false, familia: null, primeira: '2026-11-24' }];
    render(<SeletorCategorias titulo="L" textoVazio="x" disponiveis={cats} selecionadas={['modo:todas']} onChange={() => {}}
      modo={{ valor: 'todas' }} revisadoEm="2026-11-24T01:00:00Z" />);
    expect(screen.getByRole('status')).toHaveTextContent('desde a última revisão (23/11) — já estão entrando: Nova 24');
  });

  it('sem modo: sem radios, sem aviso, contador antigo', () => {
    render(<Host inicial={[]} />);
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.getByText('0 de 2 selecionadas')).toBeInTheDocument();
  });
});

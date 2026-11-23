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

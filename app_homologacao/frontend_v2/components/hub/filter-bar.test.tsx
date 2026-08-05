// uiux-hub F4 (task 4.2.3) — FilterBar: renderiza os campos passados,
// omite o botão de limpar quando `onClear` não é informado, e dispara
// `onClear` ao clicar quando informado.
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { FilterBar } from './filter-bar';

describe('FilterBar', () => {
  it('renderiza os campos filhos dentro do cartão destacado', () => {
    render(
      <FilterBar>
        <input aria-label="Nome" />
      </FilterBar>
    );
    expect(screen.getByLabelText('Nome')).toBeInTheDocument();
  });

  it('sem onClear: nenhum botão de limpar é renderizado (ex.: busca única)', () => {
    render(
      <FilterBar>
        <input aria-label="Buscar" />
      </FilterBar>
    );
    expect(screen.queryByRole('button', { name: /limpar/i })).not.toBeInTheDocument();
  });

  it('com onClear: renderiza o botão e dispara o callback ao clicar', () => {
    const onClear = vi.fn();
    render(
      <FilterBar onClear={onClear}>
        <input aria-label="Nome" />
      </FilterBar>
    );
    fireEvent.click(screen.getByRole('button', { name: 'Limpar filtros' }));
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it('aceita rótulo customizado para o botão de limpar', () => {
    render(
      <FilterBar onClear={() => {}} clearLabel="Resetar">
        <input aria-label="Nome" />
      </FilterBar>
    );
    expect(screen.getByRole('button', { name: 'Resetar' })).toBeInTheDocument();
  });
});

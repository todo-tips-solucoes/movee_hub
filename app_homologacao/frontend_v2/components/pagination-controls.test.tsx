// impeccable rodada 4 — a janela de páginas passou a servir 9 telas (2 do
// painel legado + 7 do hub), então ganhou teste próprio. Os casos são as
// bordas: é lá que uma janela deslizante ingênua encolhe sem querer.
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PaginationControls, janelaDePaginas } from './pagination-controls';

describe('janelaDePaginas', () => {
  it('no meio: centra a janela na página atual', () => {
    expect(janelaDePaginas(10, 20)).toEqual([8, 9, 10, 11, 12]);
  });

  it('na primeira página: mostra 5 à frente, não 3 (não encolhe na borda)', () => {
    expect(janelaDePaginas(1, 20)).toEqual([1, 2, 3, 4, 5]);
  });

  it('na última página: recua para manter 5 visíveis', () => {
    expect(janelaDePaginas(20, 20)).toEqual([16, 17, 18, 19, 20]);
  });

  it('menos páginas que a janela: mostra só o que existe, sem inventar', () => {
    expect(janelaDePaginas(2, 3)).toEqual([1, 2, 3]);
  });

  it('página única', () => {
    expect(janelaDePaginas(1, 1)).toEqual([1]);
  });

  it('zero páginas devolve lista vazia, sem laço infinito', () => {
    expect(janelaDePaginas(1, 0)).toEqual([]);
  });
});

describe('PaginationControls', () => {
  const base = {
    currentPage: 2,
    totalPages: 8,
    recordsPerPage: 20,
    totalRecords: 156,
    onPageChange: () => {},
  };

  it('informa o intervalo exibido e o total', () => {
    render(<PaginationControls {...base} />);
    expect(screen.getByText('Mostrando 21-40 de 156')).toBeInTheDocument();
  });

  it('a última página mostra o fim real, não o múltiplo do tamanho', () => {
    render(<PaginationControls {...base} currentPage={8} />);
    expect(screen.getByText('Mostrando 141-156 de 156')).toBeInTheDocument();
  });

  it('sem registros: diz isso em vez de "Mostrando 1-0 de 0"', () => {
    render(<PaginationControls {...base} totalRecords={0} totalPages={1} currentPage={1} />);
    expect(screen.getByText('Nenhum registro')).toBeInTheDocument();
  });

  // impeccable rodada 4: é esta prop opcional que permite as telas do hub
  // (paginação server-side com PAGE_SIZE fixo) usarem o MESMO componente do
  // painel legado, em vez de cada uma reimplementar um rodapé próprio.
  it('sem onRecordsPerPageChange: não renderiza o seletor de tamanho', () => {
    render(<PaginationControls {...base} />);
    expect(screen.queryByText(/por página/)).not.toBeInTheDocument();
  });

  it('com onRecordsPerPageChange: renderiza o seletor', () => {
    render(<PaginationControls {...base} onRecordsPerPageChange={vi.fn()} />);
    expect(screen.getByText('20 por página')).toBeInTheDocument();
  });

  it('desabilita anterior na primeira página e próxima na última', () => {
    const { unmount } = render(<PaginationControls {...base} currentPage={1} />);
    expect(screen.getByRole('button', { name: 'Página anterior' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Próxima página' })).toBeEnabled();
    unmount();

    render(<PaginationControls {...base} currentPage={8} />);
    expect(screen.getByRole('button', { name: 'Página anterior' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Próxima página' })).toBeDisabled();
  });

  it('marca a página atual com aria-current para leitor de tela', () => {
    render(<PaginationControls {...base} />);
    expect(screen.getByRole('button', { name: 'Página 2' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('button', { name: 'Página 3' })).not.toHaveAttribute('aria-current');
  });
});

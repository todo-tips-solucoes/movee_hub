// impeccable rodada 15 (h7=2) — cabeçalhos que ordenam.
//
// O risco desta mudança não está na tela do hub, e sim no PAINEL LEGADO: ele
// renderiza o mesmo `DataTable` e não passa `onOrdenar`. Se os cabeçalhos
// virassem botão lá também, o legado ganharia controles que não fazem nada —
// pior que não ter ordenação. O primeiro caso abaixo é essa trava.
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DataTable } from './data-table';
import type { EnvioMassa } from '@/types';

const LINHAS = [
  { id: 1, number: '001', nome: 'Ana', valor: 30 },
  { id: 2, number: '002', nome: 'Bruno', valor: 10 },
].map(
  (base) =>
    ({
      ...base,
      enviado: 'off',
      data_emissao: '2026-01-01',
      numnota: null,
      nota_ok: null,
      erro_validacao: null,
    }) as EnvioMassa
);

function renderTabela(props: Partial<React.ComponentProps<typeof DataTable>> = {}) {
  return render(
    <DataTable
      data={LINHAS}
      selectedIds={new Set()}
      onToggleSelectAll={vi.fn()}
      onToggleSelect={vi.fn()}
      onDelete={vi.fn()}
      onUpdate={vi.fn()}
      {...props}
    />
  );
}

describe('DataTable — cabeçalhos ordenáveis', () => {
  it('sem onOrdenar (painel legado), o cabeçalho é texto e não botão', () => {
    renderTabela();
    const cabecalho = screen.getAllByRole('columnheader', { name: 'Valor' })[0];
    expect(within(cabecalho).queryByRole('button')).toBeNull();
  });

  it('com onOrdenar, clicar no cabeçalho pede a ordenação daquela coluna', () => {
    const onOrdenar = vi.fn();
    renderTabela({ onOrdenar });

    fireEvent.click(screen.getByRole('button', { name: /Valor/ }));
    expect(onOrdenar).toHaveBeenCalledWith('valor');
  });

  it('aria-sort declara a ordem vigente — não só o ícone', () => {
    renderTabela({ onOrdenar: vi.fn(), ordem: { coluna: 'valor', direcao: 'desc' } });

    const valor = screen.getAllByRole('columnheader', { name: /Valor/ })[0];
    expect(valor).toHaveAttribute('aria-sort', 'descending');
    // As outras colunas precisam declarar 'none' — um leitor de tela que ouve
    // "sem ordenação" sabe que só uma coluna manda.
    const nome = screen.getAllByRole('columnheader', { name: /Nome/ })[0];
    expect(nome).toHaveAttribute('aria-sort', 'none');
  });

  it('o título do botão diz o que o próximo clique faz', () => {
    renderTabela({ onOrdenar: vi.fn(), ordem: { coluna: 'valor', direcao: 'desc' } });
    expect(screen.getByRole('button', { name: /Valor/ })).toHaveAttribute(
      'title',
      expect.stringContaining('remover a ordenação')
    );
  });
});

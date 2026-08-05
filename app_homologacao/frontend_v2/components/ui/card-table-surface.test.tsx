// hub-uiux-refresh FASE 1 (task 1.1.4) — FR-011/FR-012/FR-013: card se destaca
// por sombra sutil (não ring/contorno forte); tabela usa separação discreta
// entre linhas (não borda pesada). Este teste é a rede de segurança contra
// regressão desses tokens compartilhados.
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { Card } from './card';
import { Table, TableBody, TableCell, TableHeader, TableRow } from './table';

describe('Card — superfície por sombra, sem contorno forte (FR-012)', () => {
  it('não usa ring nem contorno pesado; usa shadow-sm', () => {
    const { container } = render(<Card data-testid="card" />);
    const card = container.querySelector('[data-slot="card"]')!;
    expect(card.className).toMatch(/shadow-sm/);
    expect(card.className).not.toMatch(/\bring-\d/);
  });
});

describe('Table — separação discreta entre linhas (FR-011)', () => {
  it('header e linhas usam border-border/60 (não border-b puro/pesado)', () => {
    const { container } = render(
      <Table>
        <TableHeader>
          <TableRow>
            <TableCell>Coluna</TableCell>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow>
            <TableCell>Valor</TableCell>
          </TableRow>
        </TableBody>
      </Table>
    );
    const header = container.querySelector('[data-slot="table-header"]')!;
    expect(header.className).toMatch(/bg-muted\/40/);
    const rows = container.querySelectorAll('[data-slot="table-row"]');
    rows.forEach((row) => {
      expect(row.className).toMatch(/border-border\/60/);
    });
  });
});

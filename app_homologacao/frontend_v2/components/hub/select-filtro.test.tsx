// impeccable rodada 19 (h4) — o select único das telas do hub.
//
// O caso do rótulo existe por um gotcha específico do Base UI (não é Radix):
// sem a lista `items` no Root, o trigger mostra o VALUE cru em vez do label —
// "true" no lugar de "Ativo". É um erro invisível em code review e óbvio na
// tela; o teste o trava no componente que centraliza os 8 usos.
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SelectFiltro } from './select-filtro';
import { escolherNoSelect, rotuloSelecionado } from '@/lib/test-helpers/select';

const OPCOES = [
  { value: '', label: 'Todas' },
  { value: 'true', label: 'Ativo' },
  { value: 'false', label: 'Inativo' },
];

describe('SelectFiltro', () => {
  it('exibe o RÓTULO do valor selecionado, não o value cru', () => {
    render(<SelectFiltro ariaLabel="Situação" value="true" onChange={vi.fn()} opcoes={OPCOES} />);
    expect(rotuloSelecionado('Situação')).toBe('Ativo');
  });

  it('escolher uma opção devolve o value correspondente', async () => {
    const onChange = vi.fn();
    render(<SelectFiltro ariaLabel="Situação" value="" onChange={onChange} opcoes={OPCOES} />);
    await escolherNoSelect('Situação', 'Inativo');
    expect(onChange).toHaveBeenCalledWith('false');
  });

  it('mantém o alvo de toque de 44px no mobile (convenção das r9/r12)', () => {
    render(<SelectFiltro ariaLabel="Situação" value="" onChange={vi.fn()} opcoes={OPCOES} />);
    expect(screen.getByRole('combobox', { name: 'Situação' }).className).toMatch(/min-h-11/);
  });
});

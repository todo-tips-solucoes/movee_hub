// hub-uiux-refresh FASE 2 (task 2.2.2) — teste de interação (vitest/RTL) do
// botão de colapso da topbar: alterna estado via `useSidebarCollapse().alternar`
// e reflete `aria-expanded`/`aria-label` corretamente nos dois estados.
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SidebarCollapseToggle } from './sidebar-collapse-toggle';

const mockUseSidebarCollapse = vi.fn();

vi.mock('@/contexts/sidebar-collapse-context', () => ({
  useSidebarCollapse: () => mockUseSidebarCollapse(),
}));

describe('SidebarCollapseToggle', () => {
  it('expandido: aria-expanded=true, aria-label "Colapsar navegação", clique chama alternar()', () => {
    const alternar = vi.fn();
    mockUseSidebarCollapse.mockReturnValue({ colapsada: false, alternar });

    render(<SidebarCollapseToggle />);

    const botao = screen.getByRole('button', { name: 'Colapsar navegação' });
    expect(botao).toHaveAttribute('aria-expanded', 'true');

    fireEvent.click(botao);
    expect(alternar).toHaveBeenCalledTimes(1);
  });

  it('colapsado: aria-expanded=false, aria-label "Expandir navegação"', () => {
    mockUseSidebarCollapse.mockReturnValue({ colapsada: true, alternar: vi.fn() });

    render(<SidebarCollapseToggle />);

    const botao = screen.getByRole('button', { name: 'Expandir navegação' });
    expect(botao).toHaveAttribute('aria-expanded', 'false');
  });
});

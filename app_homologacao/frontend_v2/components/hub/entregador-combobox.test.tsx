// hub-motorista-canonico FASE 2 / WS-B (tasks.md 2.3.7) — testes do
// `EntregadorCombobox`: os 4 estados (<3 chars, carregando, vazio, erro com
// degradação), seleção, "limpar", e exclusão mútua com "sem vinculado"
// (via `disabled`).
//
// `buscar` é injetado como prop (vi.fn()) — não precisamos mockar módulo de
// API nenhum, mesmo padrão de componente "burro"/testável de
// `vinculo-motorista-dialog.test.tsx`.
//
// Timers REAIS (não `vi.useFakeTimers()`): o Popover (Base UI) usa
// `ResizeObserver`/`requestAnimationFrame` internamente para posicionamento,
// que trava com fake timers em jsdom. O debounce real é só 300ms — usamos
// `findBy`/`waitFor` (timeout default 1000ms) para aguardá-lo sem mockar o
// relógio.

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { EntregadorCombobox } from './entregador-combobox';
import type { EntregadorBuscaItem } from '@/lib/hub/entregador-busca-dto';

async function abrirEDigitar(termo: string) {
  const trigger = screen.getByRole('combobox');
  fireEvent.click(trigger);
  const input = await screen.findByPlaceholderText('Digite ao menos 3 letras do nome...');
  fireEvent.change(input, { target: { value: termo } });
  return input;
}

describe('EntregadorCombobox', () => {
  it('estado inicial (sem digitar): pede >= 3 caracteres, não chama buscar', async () => {
    const buscar = vi.fn();
    render(
      <EntregadorCombobox value={null} nomeSelecionado={null} onSelecionar={vi.fn()} buscar={buscar} />
    );

    fireEvent.click(screen.getByRole('combobox'));
    expect(await screen.findByText('Digite ao menos 3 caracteres para buscar.')).toBeInTheDocument();
    expect(buscar).not.toHaveBeenCalled();
  });

  it('< 3 caracteres não dispara busca (mesmo após o tempo do debounce)', async () => {
    const buscar = vi.fn();
    render(
      <EntregadorCombobox value={null} nomeSelecionado={null} onSelecionar={vi.fn()} buscar={buscar} />
    );

    await abrirEDigitar('jo');
    expect(await screen.findByText('Faltam 1 caractere(s) para buscar.')).toBeInTheDocument();

    await new Promise((r) => setTimeout(r, 400));
    expect(buscar).not.toHaveBeenCalled();
  });

  it('>= 3 caracteres: mostra "carregando" imediatamente e chama buscar (após o debounce) com o termo', async () => {
    const buscar = vi.fn(() => new Promise<EntregadorBuscaItem[]>(() => {})); // nunca resolve — só observamos o estado carregando
    render(
      <EntregadorCombobox value={null} nomeSelecionado={null} onSelecionar={vi.fn()} buscar={buscar} />
    );

    await abrirEDigitar('joa');
    expect(screen.getByRole('status')).toHaveTextContent('Buscando...');

    await waitFor(() => expect(buscar).toHaveBeenCalledWith('joa'));
  });

  it('resultado vazio: "Nenhum entregador encontrado"', async () => {
    const buscar = vi.fn().mockResolvedValue([]);
    render(
      <EntregadorCombobox value={null} nomeSelecionado={null} onSelecionar={vi.fn()} buscar={buscar} />
    );

    await abrirEDigitar('xyz');

    await waitFor(() => expect(screen.getByText('Nenhum entregador encontrado.')).toBeInTheDocument());
  });

  it('erro na busca: mostra mensagem de erro e chama onIndisponivel (degradação FR-010/D-B1)', async () => {
    const buscar = vi.fn().mockRejectedValue(new Error('falhou'));
    const onIndisponivel = vi.fn();
    render(
      <EntregadorCombobox
        value={null}
        nomeSelecionado={null}
        onSelecionar={vi.fn()}
        buscar={buscar}
        onIndisponivel={onIndisponivel}
      />
    );

    await abrirEDigitar('joa');

    await waitFor(() => expect(onIndisponivel).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('alert')).toHaveTextContent('Não foi possível buscar entregadores. Tente novamente.');
  });

  it('seleção: clicar em um item chama onSelecionar(id, nome) e fecha o popover', async () => {
    const items: EntregadorBuscaItem[] = [{ id: 42, nome: 'Joao Faturamento' }];
    const buscar = vi.fn().mockResolvedValue(items);
    const onSelecionar = vi.fn();
    render(
      <EntregadorCombobox value={null} nomeSelecionado={null} onSelecionar={onSelecionar} buscar={buscar} />
    );

    await abrirEDigitar('joa');

    const item = await screen.findByText('Joao Faturamento');
    fireEvent.click(item);

    expect(onSelecionar).toHaveBeenCalledWith(42, 'Joao Faturamento');
  });

  it('trigger exibe o nome selecionado (nunca o id) quando value != null', () => {
    render(
      <EntregadorCombobox
        value={42}
        nomeSelecionado="Joao Faturamento"
        onSelecionar={vi.fn()}
        buscar={vi.fn()}
      />
    );
    expect(screen.getByRole('combobox')).toHaveTextContent('Joao Faturamento');
  });

  it('"limpar": clicar no X remove a seleção — onSelecionar(null, null)', () => {
    const onSelecionar = vi.fn();
    render(
      <EntregadorCombobox
        value={42}
        nomeSelecionado="Joao Faturamento"
        onSelecionar={onSelecionar}
        buscar={vi.fn()}
      />
    );

    fireEvent.click(screen.getByLabelText('Limpar filtro de entregador'));
    expect(onSelecionar).toHaveBeenCalledWith(null, null);
  });

  it('exclusão mútua com "sem entregador vinculado" (FR-009): disabled=true desabilita o trigger e some com o botão limpar', () => {
    render(
      <EntregadorCombobox
        value={null}
        nomeSelecionado={null}
        onSelecionar={vi.fn()}
        buscar={vi.fn()}
        disabled
      />
    );
    expect(screen.getByRole('combobox')).toBeDisabled();
    expect(screen.queryByLabelText('Limpar filtro de entregador')).not.toBeInTheDocument();
  });
});

// impeccable rodada 7 (P1) — o botão de disparo dizia um número e o diálogo de
// confirmação dizia outro.
//
// A rodada 6 passava `selecionados.length` (o total marcado) para a toolbar e
// `selecionadosPendentes` (o que realmente sai) para o confirm. Marcar 12
// linhas das quais 5 já receberam produzia "Disparar para 12" na barra e
// "Disparar para 5" no diálogo — dois números para a mesma ação, na mesma
// interação. Era a affordance da ação de maior consequência do produto mentindo
// sobre o próprio alcance, que é exatamente o defeito que a rodada 6 existia
// para corrigir.
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ProcessControls } from './process-controls';

function renderizar(props: Partial<React.ComponentProps<typeof ProcessControls>> = {}) {
  return render(
    <ProcessControls
      isActive={false}
      isLoading={false}
      onStart={vi.fn()}
      onStop={vi.fn()}
      {...props}
    />
  );
}

describe('ProcessControls — escopo declarado no botão', () => {
  it('sem seleção, o botão fala do movimento inteiro', () => {
    renderizar();
    expect(screen.getByRole('button', { name: /^Iniciar$/ })).toBeInTheDocument();
  });

  it('o número do botão é o que SAI, não o que está marcado', () => {
    renderizar({ selecionados: 5, selecionadosMarcados: 12 });
    expect(screen.getByRole('button', { name: 'Disparar para 5' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Disparar para 12' })).not.toBeInTheDocument();
  });

  it('seleção inteiramente já enviada não volta a prometer o movimento inteiro', () => {
    // `selecionados` é 0 aqui. Se o rótulo dependesse dele, o botão diria
    // "Iniciar" — prometendo disparar para todo o movimento com 12 linhas
    // marcadas na tela.
    renderizar({ selecionados: 0, selecionadosMarcados: 12 });
    expect(screen.getByRole('button', { name: 'Disparar para 0' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Iniciar$/ })).not.toBeInTheDocument();
  });

  it('sem ninguém já enviado, os dois números coincidem e nada precisa ser explicado', () => {
    renderizar({ selecionados: 3, selecionadosMarcados: 3 });
    expect(screen.getByRole('button', { name: 'Disparar para 3' })).toBeInTheDocument();
  });
});

// impeccable rodada 8 (P2) — a seleção não tinha como ser desfeita nem vista
// fora da página atual: marque 12, filtre por "Com Erro", e a tabela mostra 3
// sem nenhuma marcada, enquanto os 12 seguem no escopo do disparo.
describe('ProcessControls — limpar seleção', () => {
  it('sem seleção, não há o que limpar', () => {
    renderizar({ onLimparSelecao: vi.fn() });
    expect(screen.queryByRole('button', { name: /Limpar seleção/ })).not.toBeInTheDocument();
  });

  it('com seleção, o botão declara quantas linhas estão marcadas ao todo', () => {
    const onLimparSelecao = vi.fn();
    renderizar({ selecionados: 5, selecionadosMarcados: 12, onLimparSelecao });

    // 12, não 5: aqui o número é o da seleção — é ela que está sendo desfeita.
    const limpar = screen.getByRole('button', { name: 'Limpar seleção (12)' });
    fireEvent.click(limpar);
    expect(onLimparSelecao).toHaveBeenCalledTimes(1);
  });

  it('sem o callback, o botão não aparece (callers legados seguem iguais)', () => {
    renderizar({ selecionados: 3, selecionadosMarcados: 3 });
    expect(screen.queryByRole('button', { name: /Limpar seleção/ })).not.toBeInTheDocument();
  });
});

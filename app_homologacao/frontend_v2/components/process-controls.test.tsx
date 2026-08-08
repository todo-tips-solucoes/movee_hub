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
import { render, screen } from '@testing-library/react';
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

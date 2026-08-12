// impeccable rodada 19 — interagir com o `Select` do design system em jsdom.
//
// O `<select>` nativo aceitava `fireEvent.change(el, { target: { value } })`.
// O Base UI não: o trigger é um botão e as opções vivem num popup. As duas
// tentativas óbvias FALHAM em jsdom e não vale a pena redescobrir isso a cada
// teste — `fireEvent.click` na opção não seleciona, e `pointerDown/Up`
// também não. O caminho que funciona é o de TECLADO, que é justamente o que
// uma pessoa usando teclado faria: abrir, andar até a opção, confirmar.
//
// Não há `@testing-library/user-event` neste projeto (conferido no
// package.json) — daí o helper à mão em vez da dependência nova.

import { fireEvent, screen, waitFor } from '@testing-library/react';
import { expect } from 'vitest';

/**
 * Escolhe `rotuloOpcao` no select identificado por `nomeAcessivel`.
 *
 * A navegação por setas para quando a opção alvo fica com `data-highlighted`,
 * em vez de contar teclas — assim o helper não quebra quando a lista muda de
 * tamanho ou de ordem.
 */
export async function escolherNoSelect(nomeAcessivel: string | RegExp, rotuloOpcao: string | RegExp) {
  const trigger = screen.getByRole('combobox', { name: nomeAcessivel });
  // Foco explícito e clique só se ainda não houver popup: rodando na suíte
  // inteira, um caso anterior pode deixar o Base UI com scroll travado e o
  // foco em elemento desmontado — o helper precisa funcionar em qualquer
  // ordem, não só isolado.
  trigger.focus();
  if (screen.queryAllByRole('option').length === 0) fireEvent.click(trigger);
  // O `await` NÃO é cerimônia: sem esperar o popup assentar, as setas não
  // movem coisa nenhuma e o Enter escolhe a opção já selecionada. Foi o que
  // separou a sonda que funcionou da que não funcionou.
  await waitFor(() => expect(trigger.getAttribute('aria-expanded')).toBe('true'));
  await waitFor(() => expect(screen.getAllByRole('option').length).toBeGreaterThan(0));

  const opcoes = screen.getAllByRole('option');
  const indiceAlvo = opcoes.findIndex((o) => {
    const texto = (o.textContent ?? '').trim();
    return typeof rotuloOpcao === 'string' ? texto === rotuloOpcao : rotuloOpcao.test(texto);
  });
  if (indiceAlvo < 0) {
    throw new Error(`opção ${String(rotuloOpcao)} não existe em ${String(nomeAcessivel)}`);
  }
  // O destaque do Base UI é estado interno: em jsdom o `data-highlighted` NÃO
  // acompanha as setas (verificado imprimindo os atributos a cada passo), então
  // observá-lo daria um laço infinito. Conta-se a distância a partir da opção
  // selecionada, que é a posição de onde o destaque parte ao abrir.
  const indiceAtual = Math.max(
    0,
    opcoes.findIndex((o) => o.getAttribute('data-selected') !== null)
  );
  const passos = indiceAlvo - indiceAtual;
  const tecla = passos >= 0 ? 'ArrowDown' : 'ArrowUp';
  for (let i = 0; i < Math.abs(passos); i++) {
    fireEvent.keyDown(document.activeElement ?? trigger, { key: tecla });
  }
  fireEvent.keyDown(document.activeElement ?? trigger, { key: 'Enter' });
  // Confirma que fechou: se o Enter não pegou, o caso seguinte herdaria um
  // popup aberto e falharia por um motivo que não é dele.
  await waitFor(() => expect(trigger.getAttribute('aria-expanded')).toBe('false'));
}

/**
 * Rótulo exibido pelo trigger — é o que o gotcha do `items` quebra.
 * Lê o `[data-slot="select-value"]`: o trigger tem outros filhos (o ícone e o
 * proxy invisível do Base UI), e pegar "o texto do trigger" acha vários.
 */
export function rotuloSelecionado(nomeAcessivel: string | RegExp): string {
  const trigger = screen.getByRole('combobox', { name: nomeAcessivel });
  const valor = trigger.querySelector('[data-slot="select-value"]');
  return (valor?.textContent ?? '').trim();
}

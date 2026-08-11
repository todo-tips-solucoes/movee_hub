// impeccable rodada 12 (P1) — a área tocável do checkbox vem do pseudo-elemento
// `after:` do Root, não do `<span>` que o embrulha (span sem handler não recebe
// toque; foi o defeito da r9).
//
// Este teste existe por um motivo estreito e verificado: no CSS gerado, as
// classes `after:-inset-x-3`/`after:-inset-y-2` do padrão aparecem DEPOIS de
// `after:-inset-[15px]`. Se o `cn` (tailwind-merge) não as removesse da string
// final, a cascata devolveria 40x32 e o alvo continuaria pequeno — com o
// componente parecendo corrigido no código-fonte. É a classe RESULTANTE que
// decide, e é ela que este teste lê.
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { Checkbox, CHECKBOX_ALVO_44 } from './checkbox';

const classes = (container: HTMLElement) =>
  container.querySelector('[data-slot="checkbox"]')!.className;

describe('Checkbox — alvo de toque de 44px (CHECKBOX_ALVO_44)', () => {
  it('o padrão mantém a área tocável reduzida das listas densas', () => {
    const { container } = render(<Checkbox />);
    expect(classes(container)).toMatch(/after:-inset-x-3/);
  });

  it('com CHECKBOX_ALVO_44 o inset de 44px substitui o padrão, sem sobrar resíduo', () => {
    const { container } = render(<Checkbox className={CHECKBOX_ALVO_44} />);
    const c = classes(container);

    expect(c).toMatch(/after:-inset-\[15px\]/);
    // Sem o `md:` na frente: as versões responsivas devem SOBREVIVER (é assim
    // que o desktop volta a 40x32), as incondicionais não.
    expect(c).not.toMatch(/(^|\s)after:-inset-x-3(\s|$)/);
    expect(c).not.toMatch(/(^|\s)after:-inset-y-2(\s|$)/);
    expect(c).toMatch(/md:after:-inset-x-3/);
    expect(c).toMatch(/md:after:-inset-y-2/);
  });

  it('a caixa visível continua com 16px — quem cresce é só o alvo', () => {
    const { container } = render(<Checkbox className={CHECKBOX_ALVO_44} />);
    expect(classes(container)).toMatch(/size-4/);
  });
});

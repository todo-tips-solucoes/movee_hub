"use client"

import { Checkbox as CheckboxPrimitive } from "@base-ui/react/checkbox"

import { cn } from "@/lib/utils"
import { CheckIcon } from "lucide-react"

/**
 * Alvo de toque de 44x44 no mobile para checkbox dentro de tabela/matriz.
 *
 * impeccable rodada 12 (P1): as rodadas 8 e 9 embrulharam essas caixas num
 * `<span className="h-11 w-11">` — que RESERVA o espaço mas não é clicável
 * (span sem handler não recebe ativação). Quem estende a área tocável é o
 * pseudo-elemento `after:` do próprio Root, e o padrão (`-inset-x-3
 * -inset-y-2` sobre `size-4`) dá 40x32, abaixo de 44 nas duas dimensões.
 * O valor é 15px, não 14: o `inset` de um filho absoluto é relativo ao
 * PADDING BOX do containing block, e a borda de 1px do checkbox fica de fora
 * dele — sobre `size-4` o padding box mede 14px, então `-inset-3.5` (14px)
 * entrega 42, não 44. Medido no browser a 390px: 42,9x42,9 com 14px,
 * 44,9x44,9 com 15px. A partir de `md` volta ao padrão: no desktop o ponteiro
 * é preciso e a matriz é densa, e um alvo de 44 ali passaria por cima da
 * coluna do papel ao lado.
 */
const CHECKBOX_ALVO_44 = "after:-inset-[15px] md:after:-inset-x-3 md:after:-inset-y-2"

function Checkbox({ className, ...props }: CheckboxPrimitive.Root.Props) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        "peer relative flex size-4 shrink-0 items-center justify-center rounded-[4px] border border-input transition-colors outline-none group-has-disabled/field:opacity-50 after:absolute after:-inset-x-3 after:-inset-y-2 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 aria-invalid:aria-checked:border-primary dark:bg-input/30 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 data-checked:border-primary data-checked:bg-primary data-checked:text-primary-foreground dark:data-checked:bg-primary",
        className
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator
        data-slot="checkbox-indicator"
        className="grid place-content-center text-current transition-none [&>svg]:size-3.5"
      >
        <CheckIcon
        />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  )
}

export { Checkbox, CHECKBOX_ALVO_44 }

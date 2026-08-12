'use client';

// impeccable rodada 19 (h4=2) — um só idioma de select nas telas do hub.
//
// Havia 13 `<select>` nativos convivendo com o `Select` do design system, com
// a MESMA string de classes copiada em 5 arquivos. A direção já estava
// decidida desde o uiux-hub F3 (`PapelSelect` em `usuarios/page.tsx`
// "substitui os <select> nativos"); esta rodada termina a migração e coloca o
// padrão num lugar só, em vez de repetir cinco componentes Base UI por
// filtro — são 13 usos.
//
// ⚠️ Gotcha do Base UI (não é Radix): o `Root` precisa da lista `items` para
// exibir o RÓTULO do valor selecionado. Sem ela o trigger mostra o value cru
// ("true" em vez de "Ativos"). É o erro que este componente existe para não
// deixar ninguém repetir.

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

export interface OpcaoFiltro {
  value: string;
  label: string;
}

interface SelectFiltroProps {
  id?: string;
  /** Rótulo acessível — as telas usam `<Label htmlFor>` ou este. */
  ariaLabel?: string;
  value: string;
  onChange: (valor: string) => void;
  opcoes: OpcaoFiltro[];
  placeholder?: string;
  disabled?: boolean;
  className?: string;
}

export function SelectFiltro({
  id,
  ariaLabel,
  value,
  onChange,
  opcoes,
  placeholder,
  disabled,
  className,
}: SelectFiltroProps) {
  return (
    <Select
      items={opcoes}
      value={value}
      onValueChange={(v: string | null) => onChange(v ?? '')}
      disabled={disabled}
    >
      {/* `min-h-11` no mobile: mesma convenção de alvo de toque das rodadas 9
          e 12 — o trigger do design system nasce em 36px. */}
      <SelectTrigger
        id={id}
        aria-label={ariaLabel}
        className={className ?? 'min-h-11 w-full sm:min-h-9'}
      >
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {opcoes.map((opcao) => (
          <SelectItem key={opcao.value} value={opcao.value}>
            {opcao.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

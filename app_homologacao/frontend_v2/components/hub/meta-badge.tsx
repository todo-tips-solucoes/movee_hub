// impeccable r24 parte 2 — o sinal de "abaixo da meta" num registro de turno.
//
// Regras que este componente existe para garantir:
//
// 1. SEM META, SEM JULGAMENTO. Quem nunca configurou não vê nada — a tela não
//    inventa patamar nem sugere que 83% seja ruim por conta própria.
// 2. SEM LEITURA, SEM JULGAMENTO. Um turno sem corridas ofertadas não tem taxa
//    de aceitação; marcar isso como "abaixo" seria reprovar a ausência de dado.
// 3. A COR NUNCA É O ÚNICO SINAL. O badge diz "abaixo da meta" em texto e traz
//    os dois números; quem não distingue as cores lê a mesma coisa.

import { cn } from '@/lib/utils';

interface MetaBadgeProps {
  /** Leitura do indicador, já em fração 0..1. `null` = sem leitura. */
  valor: number | null;
  /** Meta do cruzamento, fração 0..1. `undefined` = não configurada. */
  meta: number | undefined;
  /** Rótulo humano do indicador, para o texto acessível. */
  rotulo: string;
  className?: string;
}

const pct = (v: number) => `${(Math.round(v * 1000) / 10).toLocaleString('pt-BR')}%`;

export function MetaBadge({ valor, meta, rotulo, className }: MetaBadgeProps) {
  if (valor === null || meta === undefined) return null;

  const abaixo = valor < meta;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[0.6875rem] font-medium',
        abaixo
          ? 'border-destructive/40 bg-destructive/10 text-destructive'
          : 'border-success/30 bg-success/10 text-success',
        className
      )}
    >
      <span aria-hidden="true">{abaixo ? '▼' : '▲'}</span>
      <span>
        {rotulo}: {pct(valor)}
        <span className="font-normal"> {abaixo ? 'abaixo da' : 'na'} meta de {pct(meta)}</span>
      </span>
    </span>
  );
}

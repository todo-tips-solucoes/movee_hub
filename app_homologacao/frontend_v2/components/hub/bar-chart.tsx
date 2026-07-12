// uiux-hub F4 — gráfico de barras horizontais do hub, sem dependência de
// biblioteca: divs + tokens --chart-* do design system. Acessível por
// construção: cada barra é um item de lista com rótulo e valor em TEXTO
// (leitor de tela lê a série inteira; a cor nunca é o único sinal) e o
// <figure> carrega um resumo para navegação rápida.
//
// Honestidade dos dados: os valores vêm dos endpoints /resumo?groupBy=*
// (agregação 100% no backend). O parseFloat aqui é SÓ para calcular a
// LARGURA proporcional da barra (apresentação) — o valor exibido é sempre
// a string formatada que veio do backend, nunca uma soma do cliente.

import { cn } from '@/lib/utils';

export interface BarraDado {
  chave: string;
  rotulo: string;
  /** Grandeza numérica usada SÓ para a proporção visual da barra. */
  valor: number;
  /** Texto exibido/lido (ex.: "R$ 1.234,56" ou "12.345"). */
  valorFormatado: string;
}

interface HorizontalBarChartProps {
  /** Título curto da série (vira o rótulo acessível da figura). */
  titulo: string;
  dados: BarraDado[];
  /** Variável CSS de cor da barra (paleta --chart-1..5). */
  corVar?: string;
  /** Limite de barras exibidas — o corte NUNCA é silencioso (nota "N de M"). */
  maxBarras?: number;
  className?: string;
}

export function HorizontalBarChart({
  titulo,
  dados,
  corVar = '--chart-1',
  maxBarras = 10,
  className,
}: HorizontalBarChartProps) {
  if (dados.length === 0) {
    return (
      <p role="status" className="py-6 text-center text-sm text-muted-foreground">
        Sem dados para os filtros atuais.
      </p>
    );
  }

  const visiveis = dados.slice(0, maxBarras);
  const max = Math.max(...visiveis.map((d) => d.valor), 0);

  return (
    <figure aria-label={titulo} className={cn('flex flex-col gap-1', className)}>
      <figcaption className="sr-only">
        {titulo}: {dados.length} grupo{dados.length === 1 ? '' : 's'}.
      </figcaption>
      <ul className="flex flex-col gap-1.5">
        {visiveis.map((d) => {
          const pct = max > 0 ? Math.max((d.valor / max) * 100, 2) : 2;
          return (
            <li key={d.chave} className="grid grid-cols-[minmax(72px,1fr)_minmax(0,2fr)_auto] items-center gap-2 text-sm">
              <span className="truncate text-muted-foreground" title={d.rotulo}>
                {d.rotulo}
              </span>
              <span className="h-4 overflow-hidden rounded-sm bg-muted/60" aria-hidden="true">
                <span
                  className="block h-full rounded-sm transition-[width] duration-300 motion-reduce:transition-none"
                  style={{ width: `${pct}%`, backgroundColor: `var(${corVar})` }}
                />
              </span>
              <span className="font-mono text-xs text-foreground tabular-nums">{d.valorFormatado}</span>
            </li>
          );
        })}
      </ul>
      {dados.length > visiveis.length && (
        <p className="mt-1 text-xs text-muted-foreground">
          Mostrando os {visiveis.length} maiores de {dados.length} grupos — refine os filtros para
          detalhar o restante.
        </p>
      )}
    </figure>
  );
}

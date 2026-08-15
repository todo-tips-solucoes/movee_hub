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

'use client';

import { useState } from 'react';
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
  /** impeccable r22 (P3): o gráfico dizia "Sem dados para os filtros atuais."
   * enquanto a lista logo abaixo, com a mesma base vazia, dizia "Nenhum
   * lançamento no período selecionado" — duas frases para o mesmo fato, lado a
   * lado na mesma tela. Quem monta a tela passa a frase dela; o padrão fica
   * para quem não passar. */
  mensagemVazia?: string;
  className?: string;
}

export function HorizontalBarChart({
  titulo,
  dados,
  corVar = '--chart-1',
  maxBarras = 10,
  mensagemVazia = 'Sem dados para os filtros atuais.',
  className,
}: HorizontalBarChartProps) {
  // Antes do early return: hook depois de `return` condicional muda a ordem
  // dos hooks entre renders.
  const [expandido, setExpandido] = useState(false);

  if (dados.length === 0) {
    return (
      <p role="status" className="py-6 text-center text-sm text-muted-foreground">
        {mensagemVazia}
      </p>
    );
  }

  // impeccable r22 (P3): o aviso de corte mandava "refine os filtros" e não
  // oferecia nenhum controle ali — a única saída para ver o resto era sair da
  // pergunta que a pessoa estava fazendo. Ver tudo é uma decisão da leitura,
  // não do filtro, então mora aqui e não na URL.
  const visiveis = expandido ? dados : dados.slice(0, maxBarras);
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
      {dados.length > maxBarras && (
        <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          {expandido
            ? `Mostrando os ${dados.length} grupos.`
            : `Mostrando os ${visiveis.length} maiores de ${dados.length} grupos.`}
          <button
            type="button"
            className="min-h-11 rounded-sm font-medium text-primary underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring sm:min-h-0"
            onClick={() => setExpandido((v) => !v)}
          >
            {expandido ? 'Mostrar só os maiores' : `Ver todos os ${dados.length}`}
          </button>
        </p>
      )}
    </figure>
  );
}

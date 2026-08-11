'use client';

// impeccable rodada 15/16 (h7=2) — cabeçalho de tabela que ordena.
//
// Nasceu dentro do `data-table` (r15, envio em massa) e foi extraído na r16
// para servir também às listas do hub, cuja ordenação é server-side. O tipo da
// coluna é genérico porque cada tabela tem o seu conjunto — o componente não
// precisa conhecê-los, só devolver qual foi clicada.
//
// Sem `onOrdenar` ele renderiza texto puro: o painel legado usa a mesma tabela
// e não ordena, e um cabeçalho-botão que não faz nada é pior que nenhum.

import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import { TableHead } from '@/components/ui/table';

export interface OrdemTabela<C extends string> {
  coluna: C;
  direcao: 'asc' | 'desc';
}

interface CabecalhoOrdenavelProps<C extends string> {
  coluna: C;
  rotulo: string;
  ordem?: OrdemTabela<C> | null;
  onOrdenar?: (coluna: C) => void;
  className?: string;
}

export function CabecalhoOrdenavel<C extends string>({
  coluna,
  rotulo,
  ordem,
  onOrdenar,
  className,
}: CabecalhoOrdenavelProps<C>) {
  if (!onOrdenar) return <TableHead className={className}>{rotulo}</TableHead>;

  const ativa = ordem?.coluna === coluna ? ordem.direcao : null;
  // `aria-sort` é o que um leitor de tela anuncia; o ícone é a mesma
  // informação para quem enxerga. Sem os dois, a ordem fica sabida só por um
  // dos dois públicos.
  return (
    <TableHead
      className={className}
      aria-sort={ativa === 'asc' ? 'ascending' : ativa === 'desc' ? 'descending' : 'none'}
    >
      <button
        type="button"
        onClick={() => onOrdenar(coluna)}
        className="inline-flex items-center gap-1 rounded-sm font-medium hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        title={
          ativa === 'asc'
            ? `Ordenado por ${rotulo}, crescente. Clique para inverter.`
            : ativa === 'desc'
              ? `Ordenado por ${rotulo}, decrescente. Clique para remover a ordenação.`
              : `Ordenar por ${rotulo}`
        }
      >
        {rotulo}
        {ativa === 'asc' ? (
          <ArrowUp className="h-3.5 w-3.5" aria-hidden="true" />
        ) : ativa === 'desc' ? (
          <ArrowDown className="h-3.5 w-3.5" aria-hidden="true" />
        ) : (
          <ArrowUpDown className="h-3.5 w-3.5 opacity-40" aria-hidden="true" />
        )}
      </button>
    </TableHead>
  );
}

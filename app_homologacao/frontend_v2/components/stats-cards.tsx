'use client';

import { FileText, CheckCircle, XCircle, FileCheck, FileX } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { StatsData, FilterState } from '@/types';
import { initialFilters } from '@/lib/utils';
import { motion, useReducedMotion } from 'framer-motion';

interface StatsCardsProps {
  stats: StatsData;
  /**
   * Aplica o filtro equivalente ao card (impeccable rodada 8, P2). Omitido, os
   * cards seguem estáticos — o painel legado não passa nada e não muda.
   */
  onFiltrar?: (filtros: FilterState) => void;
}

// Identidade Movee — status mapeados a tokens semânticos (primary/success/
// destructive). A distinção entre cards positivos/negativos vem do ícone + label.
//
// `filtro` (rodada 8): só existe nos cards em que o filtro reproduz EXATAMENTE
// a contagem exibida. "Mensagens com Erro: 12" era o gatilho diário de
// diagnóstico e um beco sem saída — o operador lia 12, descia até os filtros e
// remontava a consulta na mão, enquanto o recibo do disparo já oferecia esse
// mesmo atalho uma vez por disparo.
//
// Os dois cards de XML ficam de fora DE PROPÓSITO: `computeStats` conta
// `numnota && nota_ok && data_emissao && (!)erro_validacao`, enquanto os
// filtros `enviouNota`/`validacao` olham um campo só. Clicar em "XMLs
// Enviados: 40" e ver 55 linhas seria repetir, com outra roupa, o defeito que
// esta rodada corrige.
const cards = [
  {
    key: 'total' as const,
    label: 'Total de Registros',
    icon: FileText,
    color: 'text-primary',
    bg: 'bg-primary/10',
    filtro: initialFilters,
  },
  {
    key: 'msgEnviada' as const,
    label: 'Mensagens Enviadas',
    icon: CheckCircle,
    color: 'text-success',
    bg: 'bg-success/10',
    filtro: { ...initialFilters, enviado: 'yes' },
  },
  {
    key: 'msgErro' as const,
    label: 'Mensagens com Erro',
    icon: XCircle,
    color: 'text-destructive',
    bg: 'bg-destructive/10',
    filtro: { ...initialFilters, sucesso: 'yes' },
  },
  { key: 'xmlEnviado' as const, label: 'XMLs Enviados', icon: FileCheck, color: 'text-success', bg: 'bg-success/10', filtro: null },
  { key: 'xmlErro' as const, label: 'XMLs com Erro', icon: FileX, color: 'text-destructive', bg: 'bg-destructive/10', filtro: null },
];

export function StatsCards({ stats, onFiltrar }: StatsCardsProps) {
  // impeccable rodada 8 (P3): a regra CSS de `prefers-reduced-motion` em
  // globals.css não alcança o framer-motion, que escreve estilo inline via JS —
  // quem pediu menos movimento via os cinco cards saltarem em cascata.
  const reduzirMovimento = useReducedMotion();

  // R006: md:grid-cols-4 suaviza o salto 3→5 (menos espaço morto 768–1024px). R012: gap fluido
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 md:gap-4 lg:grid-cols-5">
      {cards.map((card, i) => {
        const Icon = card.icon;
        const percentage = card.key !== 'total' && stats.total > 0
          ? Math.round((stats[card.key] / stats.total) * 100)
          : null;
        const filtravel = card.filtro !== null && onFiltrar !== undefined;

        const conteudo = (
          <CardContent className="flex items-center gap-3 p-4">
            <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${card.bg}`}>
              <Icon className={`h-5 w-5 ${card.color}`} />
            </div>
            <div className="min-w-0 text-left">
              <div className="flex items-baseline gap-1.5">
                <p className="tabular text-2xl font-bold">{stats[card.key]}</p>
                {percentage !== null && (
                  <span className="text-xs text-muted-foreground">({percentage}%)</span>
                )}
              </div>
              <p className="text-xs text-muted-foreground truncate">{card.label}</p>
            </div>
          </CardContent>
        );

        return (
          <motion.div
            key={card.key}
            initial={reduzirMovimento ? false : { opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: reduzirMovimento ? 0 : i * 0.06 }}
          >
            {filtravel ? (
              <Card className="overflow-hidden transition-colors hover:border-primary/50">
                <button
                  type="button"
                  onClick={() => onFiltrar!(card.filtro as FilterState)}
                  aria-label={`Filtrar a tabela por ${card.label}`}
                  className="w-full rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {conteudo}
                </button>
              </Card>
            ) : (
              <Card className="overflow-hidden">{conteudo}</Card>
            )}
          </motion.div>
        );
      })}
    </div>
  );
}

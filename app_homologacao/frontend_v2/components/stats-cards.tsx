'use client';

import { FileText, CheckCircle, XCircle, FileCheck, FileX } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { StatsData } from '@/types';
import { motion } from 'framer-motion';

interface StatsCardsProps {
  stats: StatsData;
}

// Identidade Movee — status mapeados a tokens semânticos (primary/success/
// destructive). A distinção entre cards positivos/negativos vem do ícone + label.
const cards = [
  { key: 'total' as const, label: 'Total de Registros', icon: FileText, color: 'text-primary', bg: 'bg-primary/10' },
  { key: 'msgEnviada' as const, label: 'Mensagens Enviadas', icon: CheckCircle, color: 'text-success', bg: 'bg-success/10' },
  { key: 'msgErro' as const, label: 'Mensagens com Erro', icon: XCircle, color: 'text-destructive', bg: 'bg-destructive/10' },
  { key: 'xmlEnviado' as const, label: 'XMLs Enviados', icon: FileCheck, color: 'text-success', bg: 'bg-success/10' },
  { key: 'xmlErro' as const, label: 'XMLs com Erro', icon: FileX, color: 'text-destructive', bg: 'bg-destructive/10' },
];

export function StatsCards({ stats }: StatsCardsProps) {
  return (
    {/* R006: md:grid-cols-4 suaviza o salto 3→5 (menos espaço morto 768–1024px). R012: gap fluido */}
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 md:gap-4 lg:grid-cols-5">
      {cards.map((card, i) => {
        const Icon = card.icon;
        const percentage = card.key !== 'total' && stats.total > 0
          ? Math.round((stats[card.key] / stats.total) * 100)
          : null;
        return (
          <motion.div
            key={card.key}
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.06 }}
          >
            <Card className="overflow-hidden">
              <CardContent className="flex items-center gap-3 p-4">
                <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${card.bg}`}>
                  <Icon className={`h-5 w-5 ${card.color}`} />
                </div>
                <div className="min-w-0">
                  <div className="flex items-baseline gap-1.5">
                    <p className="tabular text-2xl font-bold">{stats[card.key]}</p>
                    {percentage !== null && (
                      <span className="text-xs text-muted-foreground">({percentage}%)</span>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground truncate">{card.label}</p>
                </div>
              </CardContent>
            </Card>
          </motion.div>
        );
      })}
    </div>
  );
}

'use client';

import { FileText, CheckCircle, XCircle, FileCheck, FileX } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { StatsData } from '@/types';
import { motion } from 'framer-motion';

interface StatsCardsProps {
  stats: StatsData;
}

const cards = [
  { key: 'total' as const, label: 'Total de Registros', icon: FileText, color: 'text-blue-500', bg: 'bg-blue-500/10' },
  { key: 'msgEnviada' as const, label: 'Mensagens Enviadas', icon: CheckCircle, color: 'text-green-500', bg: 'bg-green-500/10' },
  { key: 'msgErro' as const, label: 'Mensagens com Erro', icon: XCircle, color: 'text-red-500', bg: 'bg-red-500/10' },
  { key: 'xmlEnviado' as const, label: 'XMLs Enviados', icon: FileCheck, color: 'text-emerald-500', bg: 'bg-emerald-500/10' },
  { key: 'xmlErro' as const, label: 'XMLs com Erro', icon: FileX, color: 'text-rose-500', bg: 'bg-rose-500/10' },
];

export function StatsCards({ stats }: StatsCardsProps) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
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
                    <p className="text-2xl font-bold tabular-nums">{stats[card.key]}</p>
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

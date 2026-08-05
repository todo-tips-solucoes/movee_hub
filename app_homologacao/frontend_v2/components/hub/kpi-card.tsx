// uiux-hub F4 (task 4.1) — padrão único de indicador (FR-014): rótulo,
// valor em destaque, ícone e tendência opcional. Extrai o card
// `CardHeader(ícone+rótulo) + CardContent(valor)` que hoje se repete,
// duplicado, em `performance/page.tsx` (`CardsResumo`) e
// `faturamento/page.tsx` (`CardsResumo`) — mesmo padrão visual, cada tela
// reimplementando o JSX.
import type { LucideIcon } from 'lucide-react';
import { TrendingDown, TrendingUp } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';

export interface KpiCardTrend {
  /** Texto já formatado (ex.: "+3,2 p.p. vs período anterior"). */
  label: string;
  direction: 'up' | 'down';
}

export interface KpiCardProps {
  label: string;
  value: React.ReactNode;
  icon: LucideIcon;
  trend?: KpiCardTrend;
  className?: string;
}

const TREND_ICON: Record<KpiCardTrend['direction'], LucideIcon> = {
  up: TrendingUp,
  down: TrendingDown,
};

// Só cor não é sinal suficiente (WCAG 1.4.1, mesmo critério de status-badge.tsx)
// — por isso o ícone de tendência acompanha sempre a cor.
const TREND_COLOR: Record<KpiCardTrend['direction'], string> = {
  up: 'text-emerald-600 dark:text-emerald-400',
  down: 'text-destructive',
};

export function KpiCard({ label, value, icon: Icon, trend, className }: KpiCardProps) {
  const TrendIcon = trend ? TREND_ICON[trend.direction] : null;
  return (
    <Card size="sm" className={className}>
      <CardHeader className="flex flex-row items-center gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Icon className="size-4" aria-hidden="true" />
        </span>
        <CardTitle className="text-sm text-muted-foreground">{label}</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="truncate font-heading text-xl font-semibold text-foreground">{value}</p>
        {trend && TrendIcon && (
          <p className={cn('mt-1 flex items-center gap-1 text-xs', TREND_COLOR[trend.direction])}>
            <TrendIcon className="size-3.5" aria-hidden="true" />
            {trend.label}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

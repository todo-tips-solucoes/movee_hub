// uiux-hub F2 (P1 — WCAG 1.4.1) — badge de status compartilhado: SEMPRE
// cor + ícone + texto, nunca só cor. Centraliza os mapas que antes viviam
// duplicados em importacoes/page.tsx (StatusBadge local) e
// motoristas/page.tsx (AtivoBadge/VinculoBadge).

import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  CircleOff,
  Clock,
  Link2,
  Link2Off,
  RotateCw,
  XCircle,
  type LucideIcon,
} from 'lucide-react';
import { Badge, type badgeVariants } from '@/components/ui/badge';
import type { VariantProps } from 'class-variance-authority';
import { STATUS_LABELS, type StatusImportacao } from '@/lib/hub/importacoes-dto';
import { cn } from '@/lib/utils';

type BadgeVariant = NonNullable<VariantProps<typeof badgeVariants>['variant']>;

interface StatusBadgeProps {
  variant: BadgeVariant;
  icon: LucideIcon;
  /** Gira o ícone (estados "em processamento"); respeita reduced-motion. */
  spin?: boolean;
  children: React.ReactNode;
}

/** Base: Badge com ícone à esquerda. O ícone é decorativo (aria-hidden) —
 * o significado está no texto; o ícone reforça sem depender de cor. */
export function StatusBadge({ variant, icon: Icon, spin = false, children }: StatusBadgeProps) {
  return (
    <Badge variant={variant}>
      <Icon
        data-icon="inline-start"
        aria-hidden="true"
        className={cn('shrink-0', spin && 'motion-safe:animate-spin')}
      />
      {children}
    </Badge>
  );
}

const IMPORTACAO_STATUS_BADGE: Record<
  StatusImportacao,
  { variant: BadgeVariant; icon: LucideIcon; spin?: boolean }
> = {
  completed: { variant: 'success', icon: CheckCircle2 },
  completed_with_errors: { variant: 'warning', icon: AlertTriangle },
  failed: { variant: 'destructive', icon: XCircle },
  cancelled: { variant: 'secondary', icon: Ban },
  pending: { variant: 'outline', icon: Clock },
  validating: { variant: 'outline', icon: RotateCw, spin: true },
  processing: { variant: 'outline', icon: RotateCw, spin: true },
};

/** Status de importação (lista e detalhe). Fail-safe: status desconhecido
 * cai em outline+Clock com o próprio código como rótulo. */
export function ImportacaoStatusBadge({ status }: { status: StatusImportacao }) {
  const cfg = IMPORTACAO_STATUS_BADGE[status] ?? { variant: 'outline' as const, icon: Clock };
  return (
    <StatusBadge variant={cfg.variant} icon={cfg.icon} spin={cfg.spin}>
      {STATUS_LABELS[status] ?? status}
    </StatusBadge>
  );
}

/** Ativo/Inativo (motoristas, usuários). */
export function AtivoBadge({ ativo }: { ativo: boolean }) {
  return ativo ? (
    <StatusBadge variant="success" icon={CheckCircle2}>
      Ativo
    </StatusBadge>
  ) : (
    <StatusBadge variant="secondary" icon={CircleOff}>
      Inativo
    </StatusBadge>
  );
}

/** Vinculado/Sem vínculo (motoristas ↔ conta de acesso). */
export function VinculoBadge({ vinculado }: { vinculado: boolean }) {
  return vinculado ? (
    <StatusBadge variant="default" icon={Link2}>
      Vinculado
    </StatusBadge>
  ) : (
    <StatusBadge variant="outline" icon={Link2Off}>
      Sem vínculo
    </StatusBadge>
  );
}

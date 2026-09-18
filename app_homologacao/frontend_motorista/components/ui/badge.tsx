import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const badgeVariants = cva(
  'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 font-display text-xs font-semibold',
  {
    variants: {
      variant: {
        // tasks.md 6.8.3: `text-success`/`text-muted-foreground` puros sobre
        // o tint do próprio badge mediam < 4.5:1 (axe color-contrast) nas
        // telas novas de adiantamento — escurece o texto em direção a
        // `--foreground` sem perder o matiz semântico (verde/neutro).
        success: 'bg-success/12 text-[color-mix(in_oklab,var(--success)_55%,var(--foreground)_45%)]',
        warning: 'bg-warm-2/15 text-[color-mix(in_oklab,var(--warm-3)_55%,var(--foreground)_45%)]',
        info: 'bg-primary/12 text-[color-mix(in_oklab,var(--primary)_70%,var(--foreground)_30%)]',
        muted: 'bg-muted text-[color-mix(in_oklab,var(--muted-foreground)_55%,var(--foreground)_45%)]',
      },
    },
    defaultVariants: { variant: 'info' },
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

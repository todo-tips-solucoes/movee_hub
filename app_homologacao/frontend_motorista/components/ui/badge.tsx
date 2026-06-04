import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const badgeVariants = cva(
  'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 font-display text-xs font-semibold',
  {
    variants: {
      variant: {
        success: 'bg-success/12 text-success',
        warning: 'bg-warm-2/15 text-warm-3',
        info: 'bg-primary/12 text-primary',
        muted: 'bg-muted text-muted-foreground',
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

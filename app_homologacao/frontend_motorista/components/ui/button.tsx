import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

/**
 * Botão do design system Movee. `buttonVariants` é exportado para aplicar o
 * mesmo estilo em <Link>/<a> (sem depender de @radix-ui/react-slot).
 */
export const buttonVariants = cva(
  "relative inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg font-display text-sm font-semibold transition-[transform,box-shadow,opacity,background-color,color] duration-200 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50 disabled:hover:translate-y-0 active:scale-[.97] active:translate-y-0 [&_svg]:size-[1.1em] [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default:
          'bg-primary text-primary-foreground shadow-[0_8px_20px_-10px_var(--primary)] hover:-translate-y-0.5 hover:bg-primary/95 hover:shadow-[0_14px_28px_-12px_var(--primary)]',
        warm:
          'bg-gradient-warm-rich animate-gradient text-white shadow-[0_10px_26px_-10px_color-mix(in_oklab,var(--warm-3)_70%,transparent)] hover:-translate-y-0.5 hover:shadow-[0_16px_34px_-12px_color-mix(in_oklab,var(--warm-3)_75%,transparent)]',
        success:
          'bg-success text-success-foreground shadow-[0_8px_20px_-10px_var(--success)] hover:-translate-y-0.5 hover:bg-success/95',
        secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/80',
        outline:
          'border border-input bg-card/60 backdrop-blur-sm hover:-translate-y-0.5 hover:border-primary/40 hover:bg-muted hover:text-foreground',
        ghost: 'text-muted-foreground hover:bg-muted hover:text-foreground',
        link: 'text-primary underline-offset-4 hover:underline',
        destructive: 'bg-destructive text-destructive-foreground shadow-sm hover:bg-destructive/90',
      },
      size: {
        default: 'h-11 px-5 py-2',
        sm: 'h-9 rounded-md px-3',
        lg: 'h-12 rounded-xl px-6 text-base',
        icon: 'h-10 w-10',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => (
    <button ref={ref} className={cn(buttonVariants({ variant, size }), className)} {...props} />
  )
);
Button.displayName = 'Button';

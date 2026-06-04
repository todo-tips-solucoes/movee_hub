import * as React from 'react';
import { cn } from '@/lib/utils';

/** Campo de entrada — altura confortável p/ toque (mobile-first). */
export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, type, ...props }, ref) => (
    <input
      ref={ref}
      type={type}
      className={cn(
        'flex h-12 w-full rounded-lg border border-input bg-background px-3.5 text-base text-foreground shadow-sm transition-colors',
        'placeholder:text-muted-foreground/70',
        'focus-visible:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30',
        'disabled:cursor-not-allowed disabled:opacity-50',
        'aria-[invalid=true]:border-destructive aria-[invalid=true]:ring-destructive/25',
        className
      )}
      {...props}
    />
  )
);
Input.displayName = 'Input';

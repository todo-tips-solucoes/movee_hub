import { cn } from '@/lib/utils';

/** Bloco de skeleton (shadcn) — placeholder pulsante com shape estável
 * (uiux-hub F2, P3: substitui os spinners `RotateCw` de loading; CLS ~0). */
function Skeleton({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="skeleton"
      className={cn('motion-safe:animate-pulse rounded-md bg-muted', className)}
      {...props}
    />
  );
}

export { Skeleton };

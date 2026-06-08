import { cn } from '@/lib/utils';

/** Wordmark "EntreGô" com o gradiente assinatura (azul→menta) do EntreGô. */
export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn('font-display font-extrabold tracking-tight text-gradient-warm', className)}>
      EntreGô
    </span>
  );
}

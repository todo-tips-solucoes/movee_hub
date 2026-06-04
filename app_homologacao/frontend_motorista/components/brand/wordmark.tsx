import { cn } from '@/lib/utils';

/** Wordmark "Movee" com o gradiente quente assinatura da marca. */
export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn('font-display font-extrabold italic tracking-tight text-gradient-warm', className)}>
      Movee
    </span>
  );
}

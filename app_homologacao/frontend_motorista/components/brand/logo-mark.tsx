import { cn } from '@/lib/utils';

/**
 * Monograma da marca Movee — quadrado arredondado com gradiente azul e "M"
 * branco. Usado em cabeçalhos (login, app bar) como âncora visual consistente.
 * Tamanho via className (h/w + text-*).
 */
export function LogoMark({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        'bg-gradient-blue inline-flex h-12 w-12 items-center justify-center rounded-2xl font-display text-2xl font-extrabold italic text-white shadow-[0_10px_24px_-10px_var(--primary)] ring-1 ring-white/15',
        className
      )}
      aria-hidden="true"
    >
      M
    </span>
  );
}

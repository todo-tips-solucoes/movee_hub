import { cn } from '@/lib/utils';

/**
 * Símbolo oficial da marca EntreGô (monograma "Gô" — asset da marca). Colorido
 * em fundos claros; branco no dark (dark:invert). Tamanho via altura (h-*).
 */
export function LogoMark({ className }: { className?: string }) {
  return (
    <img
      src="/brand/go-256.png"
      srcSet="/brand/go-128.png 1x, /brand/go-256.png 2x, /brand/go-512.png 3x"
      alt="EntreGô"
      draggable={false}
      className={cn('h-12 w-auto select-none object-contain dark:brightness-0 dark:invert', className)}
    />
  );
}

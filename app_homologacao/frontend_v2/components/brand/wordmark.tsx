import { cn } from '@/lib/utils';

/**
 * Wordmark oficial EntreGô (logo completo, asset da marca). Colorido em fundos
 * claros; vira branco no dark (dark:invert). Em fundos azuis/escuros fixos
 * (ex.: splash), passe `brightness-0 invert` no className p/ forçar a versão
 * branca. Tamanho via altura (h-*); largura automática.
 */
export function Wordmark({ className }: { className?: string }) {
  return (
    <img
      src="/brand/logo-entrego-192h.png"
      srcSet="/brand/logo-entrego-96h.png 1x, /brand/logo-entrego-192h.png 2x, /brand/logo-entrego-384h.png 3x"
      alt="EntreGô"
      draggable={false}
      className={cn('h-8 w-auto select-none object-contain dark:brightness-0 dark:invert', className)}
    />
  );
}

'use client';

import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';

/**
 * Alternador de tema (claro/escuro). Persiste em localStorage('theme') e
 * aplica a classe `.dark` no <html>. O flash inicial é evitado pelo script
 * inline no layout (theme-script).
 */
export function ThemeToggle({ className }: { className?: string }) {
  const [mounted, setMounted] = useState(false);
  const [dark, setDark] = useState(false);

  useEffect(() => {
    setMounted(true);
    setDark(document.documentElement.classList.contains('dark'));
  }, []);

  function toggle() {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle('dark', next);
    try {
      localStorage.setItem('theme', next ? 'dark' : 'light');
    } catch {
      /* localStorage indisponível — ignora */
    }
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={dark ? 'Ativar tema claro' : 'Ativar tema escuro'}
      className={cn(
        'inline-flex h-9 w-9 items-center justify-center rounded-full text-current/90 transition-colors hover:bg-white/15',
        className
      )}
    >
      {/* placeholder até montar para evitar mismatch de hidratação */}
      {!mounted ? (
        <span className="h-[1.15rem] w-[1.15rem]" />
      ) : dark ? (
        /* sol */
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-[1.15rem] w-[1.15rem]">
          <circle cx="12" cy="12" r="4" />
          <path strokeLinecap="round" d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
        </svg>
      ) : (
        /* lua */
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-[1.15rem] w-[1.15rem]">
          <path strokeLinecap="round" strokeLinejoin="round" d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z" />
        </svg>
      )}
    </button>
  );
}

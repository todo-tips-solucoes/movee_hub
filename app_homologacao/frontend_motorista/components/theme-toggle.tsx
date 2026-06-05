'use client';

import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';
import { Sun, Moon } from '@/components/ui/icons';

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
        <Sun className="h-[1.15rem] w-[1.15rem]" />
      ) : (
        <Moon className="h-[1.15rem] w-[1.15rem]" />
      )}
    </button>
  );
}

// uiux-hub F3 — moldura visual única das telas de autenticação do hub
// (login/recuperar-senha/redefinir-senha): aurora-orbs + ThemeToggle +
// container centralizado. Antes só o login tinha esse tratamento; as outras
// duas eram um Card liso — a marca sumia no meio do fluxo de recuperação.

import type { ReactNode } from 'react';
import { ThemeToggle } from '@/components/theme-toggle';

export function AuthShell({ children }: { children: ReactNode }) {
  return (
    // `<main>` — landmark único da página (axe `landmark-one-main`/`region`).
    <main className="relative flex min-h-dvh items-center justify-center overflow-hidden px-4 py-10 sm:px-6">
      <div className="pointer-events-none absolute inset-0 -z-10 bg-background" />
      <div className="aurora-orb bg-gradient-warm -left-24 -top-24 h-72 w-72 animate-float" aria-hidden />
      <div
        className="aurora-orb bg-gradient-blue -bottom-32 -right-24 h-80 w-80 animate-float-soft"
        aria-hidden
      />
      <div className="absolute top-4 right-4 z-10">
        <ThemeToggle />
      </div>
      <div className="w-full max-w-[95vw] sm:max-w-sm">{children}</div>
    </main>
  );
}

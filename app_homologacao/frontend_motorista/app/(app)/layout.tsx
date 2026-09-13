'use client';

/**
 * Layout das rotas autenticadas.
 * Redireciona para /login se não autenticado.
 * Ref: tarefa 5.1.3 / spec FR-001
 */

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/auth-context';

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const router = useRouter();

  // push-motorista (tasks.md 3.3) — preserva o destino (ex.: /avisos/123, link
  // de um aviso) para o login redirecionar de volta após autenticar. O
  // caminho é lido de `window.location` (client-only, roda dentro do efeito)
  // e revalidado no login via lib/next-seguro.ts — nunca confiado aqui.
  useEffect(() => {
    if (!loading && !user) {
      const destino = `${window.location.pathname}${window.location.search}`;
      const next = destino && destino !== '/login' ? `?next=${encodeURIComponent(destino)}` : '';
      router.replace(`/login${next}`);
    }
  }, [user, loading, router]);

  if (loading) {
    return (
      <div className="flex min-h-dvh items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    );
  }

  if (!user) return null;

  return <>{children}</>;
}

'use client';

/**
 * Rota raiz — redireciona para /movimento (autenticado) ou /login.
 * Ref: tarefa 5.1.3 / spec FR-001
 */

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/auth-context';

export default function RootPage() {
  const { user, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (loading) return;
    if (user) {
      router.replace('/movimento');
    } else {
      router.replace('/login');
    }
  }, [user, loading, router]);

  return (
    <div className="flex min-h-dvh items-center justify-center">
      <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
    </div>
  );
}

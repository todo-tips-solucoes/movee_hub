'use client';

/**
 * Rota raiz — redireciona para /movimento (autenticado) ou /login.
 * Ref: tarefa 5.1.3 / spec FR-001
 */

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/auth-context';
import { Wordmark } from '@/components/brand/wordmark';

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
    <div className="bg-gradient-blue flex min-h-dvh flex-col items-center justify-center gap-6 text-white">
      <Wordmark className="text-5xl" />
      <div className="h-7 w-7 animate-spin rounded-full border-4 border-white/40 border-t-white" />
    </div>
  );
}

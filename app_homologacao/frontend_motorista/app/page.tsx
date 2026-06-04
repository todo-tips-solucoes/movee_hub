'use client';

/**
 * Rota raiz — redireciona para /movimento (autenticado) ou /login.
 * Ref: tarefa 5.1.3 / spec FR-001
 */

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/auth-context';
import { Wordmark } from '@/components/brand/wordmark';
import { Aurora } from '@/components/brand/aurora';

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
    <div className="bg-gradient-blue relative flex min-h-dvh flex-col items-center justify-center gap-7 overflow-hidden text-white">
      <Aurora />
      <span className="animate-float-soft relative z-10">
        <Wordmark className="text-6xl drop-shadow-[0_8px_24px_rgba(0,0,0,0.25)]" />
      </span>
      <div className="spinner relative z-10 h-7 w-7 rounded-full border-4 border-white/30 border-t-white" />
    </div>
  );
}

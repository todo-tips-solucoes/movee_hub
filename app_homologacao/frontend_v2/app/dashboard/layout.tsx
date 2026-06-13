'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/auth-context';
import { Header } from '@/components/header';

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!loading && !user) {
      router.replace('/login');
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

  return (
    <div className="flex min-h-dvh md:h-screen flex-col md:overflow-hidden bg-background">
      <Header />
      {/* md:overflow-y-auto (não -hidden): páginas altas (Grupo, Motoristas) rolam
          dentro do app-shell de altura fixa; a Envio preenche exato (md:h-full) e
          mantém o scroll interno da tabela, sem scrollbar extra. */}
      {/* R009: em telas wide (≥xl/2xl) sobe o teto e os gutters p/ não desperdiçar >35% em ultrawide */}
      <main className="flex-1 overflow-auto md:overflow-y-auto mx-auto w-full max-w-7xl px-3 py-4 sm:px-4 md:px-6 xl:max-w-[96rem] xl:px-8 2xl:max-w-[110rem]">{children}</main>
    </div>
  );
}

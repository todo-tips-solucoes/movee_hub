'use client';

// campanhas do motorista (W3a) — nova campanha (rascunho).

import { useState } from 'react';
import Link from 'next/link';
import { Lock } from 'lucide-react';
import { CampanhaFormulario } from '@/components/hub/campanha-formulario';
import { PageHeader } from '@/components/hub/page-header';
import { useHubAuth } from '@/contexts/hub-auth-context';
import { LARGURA_LISTA } from '@/lib/hub/larguras';
import { formularioVazio } from '@/lib/hub/campanhas-form';

export default function NovaCampanhaPage() {
  const { permissoes } = useHubAuth();
  const [inicial] = useState(formularioVazio);
  if (!permissoes.includes('campanhas.gerir')) {
    return (
      <div className={`mx-auto flex w-full ${LARGURA_LISTA} flex-col gap-4 p-4 sm:p-6 lg:p-8`}>
        <p role="alert" className="text-sm font-medium text-destructive">Você não tem permissão para criar campanhas.</p>
      </div>
    );
  }
  return (
    <div className={`mx-auto flex w-full ${LARGURA_LISTA} flex-col gap-4 p-4 sm:p-6 lg:p-8`}>
      <nav aria-label="Trilha" className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
        <Link href="/hub/dashboard/campanhas" className="font-medium text-primary hover:underline">Campanhas</Link>
        <span aria-hidden="true">/</span>
        <span>Nova campanha</span>
        <span className="ml-auto inline-flex items-center gap-1.5 rounded-full bg-muted px-3 py-1 text-xs font-medium text-foreground">
          <Lock className="size-3.5" aria-hidden="true" />
          Rascunho · editável até lançar
        </span>
      </nav>
      <PageHeader titulo="Nova campanha" />
      <CampanhaFormulario campanhaId={null} inicial={inicial} />
    </div>
  );
}

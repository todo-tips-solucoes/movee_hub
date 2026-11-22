'use client';

// campanhas do motorista (W3a) — editar RASCUNHO (mesmo formulário da criação).
// Campanha já lançada é imutável: manda para o detalhe.

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { AlertCircle } from 'lucide-react';
import { CampanhaFormulario } from '@/components/hub/campanha-formulario';
import { PageHeader } from '@/components/hub/page-header';
import { ListSkeleton } from '@/components/hub/table-skeleton';
import { useHubAuth } from '@/contexts/hub-auth-context';
import { LARGURA_LISTA } from '@/lib/hub/larguras';
import { CampanhaApiError, obterCampanha } from '@/lib/hub/campanhas-api';
import { formularioDeDetalhe, type FormularioCampanha } from '@/lib/hub/campanhas-form';

export default function EditarCampanhaPage() {
  const params = useParams<{ id: string }>();
  const id = Number(params.id);
  const router = useRouter();
  const { permissoes } = useHubAuth();
  const podeGerir = permissoes.includes('campanhas.gerir');
  const [inicial, setInicial] = useState<FormularioCampanha | null>(null);
  const [erro, setErro] = useState<string | null>(null);

  useEffect(() => {
    let vivo = true;
    obterCampanha(id)
      .then((d) => {
        if (!vivo) return;
        if (d.situacao !== 'rascunho') router.replace(`/hub/dashboard/campanhas/${id}`);
        else setInicial(formularioDeDetalhe(d));
      })
      .catch((e) => {
        if (vivo) setErro(e instanceof CampanhaApiError ? e.message : 'Não foi possível carregar a campanha.');
      });
    return () => {
      vivo = false;
    };
  }, [id, router]);

  return (
    <div className={`mx-auto flex w-full ${LARGURA_LISTA} flex-col gap-4 p-4 sm:p-6 lg:p-8`}>
      <nav aria-label="Trilha" className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
        <Link href="/hub/dashboard/campanhas" className="font-medium text-primary hover:underline">Campanhas</Link>
        <span aria-hidden="true">/</span>
        <span>Editar rascunho</span>
      </nav>
      <PageHeader titulo="Editar rascunho" />
      {!podeGerir ? (
        <p role="alert" className="text-sm font-medium text-destructive">Você não tem permissão para editar campanhas.</p>
      ) : erro ? (
        <p role="alert" className="flex items-center gap-2 text-sm font-medium text-destructive">
          <AlertCircle className="size-4" aria-hidden="true" />
          {erro}
        </p>
      ) : inicial === null ? (
        <ListSkeleton label="Carregando rascunho..." />
      ) : (
        <CampanhaFormulario campanhaId={id} inicial={inicial} />
      )}
    </div>
  );
}

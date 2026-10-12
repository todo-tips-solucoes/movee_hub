'use client';

/**
 * Card da home que leva às notas pendentes. Busca própria e NÃO bloqueante
 * (mesma técnica do card de adiantamento): sem pendência, ou se a chamada
 * falhar, não renderiza nada e a home segue como sempre.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowUpRight, FileText } from '@/components/ui/icons';
import { listarNotasPendentes, mostrarCardPendentes, textoContagem } from '@/lib/notas-pendentes-api';

export function CardNotasPendentes() {
  const [contagem, setContagem] = useState<number | null>(null);

  useEffect(() => {
    listarNotasPendentes()
      .then((notas) => setContagem(notas.length))
      .catch((e) => console.error('[notas-pendentes] card da home: falha ao listar:', e));
  }, []);

  if (!mostrarCardPendentes(contagem)) return null;

  return (
    <Link
      href="/notas-pendentes"
      className="bg-gradient-warm-rich shine shine-sweep animate-fade-up relative mb-4 block overflow-hidden rounded-3xl p-5 text-white shadow-[0_20px_44px_-24px_color-mix(in_oklab,var(--warm-3)_70%,transparent)]"
    >
      <span className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-white/85">
        <FileText className="h-3.5 w-3.5" />
        Notas pendentes
      </span>
      <p className="tabular mt-3 text-2xl font-bold leading-none">{textoContagem(contagem as number)}</p>
      <p className="mt-2 text-sm text-white/85">O pagamento depende do envio da nota.</p>
      <span className="mt-4 inline-flex min-h-11 items-center gap-1 text-sm font-semibold">
        Enviar notas
        <ArrowUpRight className="h-4 w-4" />
      </span>
    </Link>
  );
}

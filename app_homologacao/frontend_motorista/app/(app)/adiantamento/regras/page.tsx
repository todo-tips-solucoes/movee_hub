'use client';

/**
 * adiantamento-motorista — app/(app)/adiantamento/regras/page.tsx (tasks.md 6.3.4)
 *
 * Texto vigente das regras do adiantamento (protótipo M15) — os `itens`
 * (título + descrição) vêm inteiramente de `GET /motorista/adiantamento/regras`
 * (`lib/adiantamento-regras.js#textoRegras` no backend); nenhum número desta
 * tela existe no código do app (mesma nota do protótipo).
 *
 * Ref: prototipo M15; Spec §FR-… (regras/configuração vigente).
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ThemeToggle } from '@/components/theme-toggle';
import { buscarRegras, type Regras } from '@/lib/adiantamento-api';
import { AlertCircle, ArrowLeft } from '@/components/ui/icons';

export default function RegrasAdiantamentoPage() {
  const [regras, setRegras] = useState<Regras | null | undefined>(undefined);

  const carregar = useCallback(() => {
    setRegras(undefined);
    buscarRegras().then(setRegras).catch(() => setRegras(null));
  }, []);

  useEffect(() => { carregar(); }, [carregar]);

  return (
    <main className="relative flex min-h-dvh flex-col bg-muted/40">
      <header className="glass sticky top-0 z-20 flex items-center justify-between rounded-none border-x-0 border-t-0 px-3 pb-3 pt-[max(0.85rem,env(safe-area-inset-top))]">
        <div className="flex items-center gap-1">
          <Link
            href="/adiantamento"
            aria-label="Voltar"
            className="inline-flex h-11 w-11 items-center justify-center rounded-full text-foreground transition-colors hover:bg-muted active:scale-90"
          >
            <ArrowLeft className="h-5 w-5" />
          </Link>
          <h1 className="font-display text-base font-semibold">Como funciona</h1>
        </div>
        <ThemeToggle />
      </header>

      <div className="mx-auto w-full max-w-md flex-1 space-y-4 px-4 pb-10 pt-5">
        {regras === undefined ? (
          <Skeleton className="h-96 rounded-2xl" />
        ) : regras === null ? (
          <div className="animate-fade-up flex flex-col items-center gap-3 py-16 text-center">
            <AlertCircle className="h-10 w-10 text-muted-foreground" />
            <p className="font-display text-lg font-bold">Não foi possível carregar as regras</p>
            <Button variant="outline" onClick={carregar}>Tentar de novo</Button>
          </div>
        ) : (
          <>
            <div className="space-y-4 rounded-2xl border border-border bg-card p-5">
              {regras.itens.map((item) => (
                <div key={item.titulo}>
                  <p className="text-[0.7rem] font-semibold uppercase tracking-wide text-muted-foreground">
                    {item.titulo}
                  </p>
                  <p className="mt-1 text-sm leading-relaxed">{item.descricao}</p>
                </div>
              ))}
            </div>
            <p className="text-center text-xs text-muted-foreground">
              Regras vigentes — versão {regras.configVersion}.
            </p>
          </>
        )}
      </div>
    </main>
  );
}

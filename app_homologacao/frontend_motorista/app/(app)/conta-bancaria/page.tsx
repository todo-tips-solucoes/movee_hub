'use client';

/**
 * adiantamento-motorista — app/(app)/conta-bancaria/page.tsx (tasks.md 6.4.1, 6.4.2)
 *
 * Unifica os estados do protótipo M12 (aprovada), M14 (rejeitada) e "sem
 * conta ainda" numa única tela orientada por `GET /motorista/conta-bancaria`
 * (mesmo critério de 6.3.1: dado real decide qual bloco aparece — os três
 * campos do resumo não são mutuamente exclusivos: pode haver uma aprovada
 * EM USO e uma pendente em análise ao mesmo tempo).
 *
 * Ref: prototipo M12, M14; Spec US2, §FR-015..§FR-017.
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { BottomNav } from '@/components/bottom-nav';
import { ThemeToggle } from '@/components/theme-toggle';
import { cn } from '@/lib/utils';
import { buscarContaBancaria, type ContaBancariaItem, type ContaBancariaResumo } from '@/lib/adiantamento-api';
import { AlertCircle, AlertTriangle, Block, Edit, EventRepeat, Rule as RuleIcon, ShieldCheck } from '@/components/ui/icons';

function CartaoConta({ item, pillVariant, pillLabel, nota }: {
  item: ContaBancariaItem;
  pillVariant: 'success' | 'warning' | 'info';
  pillLabel: string;
  nota?: string;
}) {
  return (
    <div className="space-y-3 rounded-3xl border border-border bg-card p-5 shadow-sm">
      <div className="flex items-center justify-between">
        <p className="text-[0.7rem] font-semibold uppercase tracking-wide text-muted-foreground">
          Conta para pagamentos
        </p>
        <Badge variant={pillVariant}>{pillLabel}</Badge>
      </div>
      <p className="text-sm font-medium">{item.banco} · Ag. {item.agencia} · {item.contaMascarada}</p>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-sm">
        <div>
          <dt className="text-xs text-muted-foreground">Titular</dt>
          <dd>{item.titularNome}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Documento</dt>
          <dd className="tabular">{item.documentoMascarado}</dd>
        </div>
        {item.chavePixTipo && (
          <div>
            <dt className="text-xs text-muted-foreground">Chave PIX</dt>
            <dd>{item.chavePixTipo}</dd>
          </div>
        )}
        {item.emailComprovante && (
          <div>
            <dt className="text-xs text-muted-foreground">Comprovante</dt>
            <dd>{item.emailComprovante}</dd>
          </div>
        )}
      </dl>
      {nota && <p className="text-xs text-muted-foreground">{nota}</p>}
    </div>
  );
}

export default function ContaBancariaPage() {
  const [resumo, setResumo] = useState<ContaBancariaResumo | null | undefined>(undefined);

  const carregar = useCallback(() => {
    setResumo(undefined);
    buscarContaBancaria().then(setResumo).catch(() => setResumo(null));
  }, []);

  useEffect(() => { carregar(); }, [carregar]);

  const semNadaCadastrado = resumo != null && !resumo.aprovada && !resumo.pendente && !resumo.ultimaRejeicao;

  return (
    <main className="relative flex min-h-dvh flex-col bg-muted/40">
      <header className="glass sticky top-0 z-20 flex items-center justify-between rounded-none border-x-0 border-t-0 px-4 pb-3 pt-[max(0.85rem,env(safe-area-inset-top))]">
        <h1 className="font-display text-lg font-bold">Conta</h1>
        <ThemeToggle />
      </header>

      <div className="mx-auto w-full max-w-md flex-1 space-y-4 px-4 pb-24 pt-5">
        {resumo === undefined ? (
          <div className="space-y-4">
            <Skeleton className="h-48 rounded-3xl" />
            <Skeleton className="h-24 rounded-2xl" />
          </div>
        ) : resumo === null ? (
          <div className="animate-fade-up flex flex-col items-center gap-3 py-16 text-center">
            <AlertTriangle className="h-10 w-10 text-muted-foreground" />
            <p className="font-display text-lg font-bold">Não foi possível carregar</p>
            <Button variant="outline" onClick={carregar}>Tentar de novo</Button>
          </div>
        ) : (
          <>
            {resumo.ultimaRejeicao && (
              <div className="flex items-start gap-2 rounded-2xl border border-destructive/30 bg-destructive/10 p-4 text-sm">
                <Block className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                <p>
                  <strong className="block text-destructive">Alteração não aprovada</strong>
                  {resumo.ultimaRejeicao.motivoRejeicao || 'Fale com o suporte se tiver dúvida.'}
                </p>
              </div>
            )}

            {resumo.aprovada && (
              <CartaoConta
                item={resumo.aprovada}
                pillVariant="success"
                pillLabel="Aprovada"
                nota={resumo.pendente ? 'Enquanto a alteração é analisada, seus pagamentos continuam indo para esta conta.' : undefined}
              />
            )}

            {resumo.pendente && (
              <CartaoConta item={resumo.pendente} pillVariant="info" pillLabel="Em análise" />
            )}

            {semNadaCadastrado && (
              <div className="animate-fade-up flex flex-col items-center gap-3 py-16 text-center">
                <AlertCircle className="h-10 w-10 text-muted-foreground" />
                <p className="font-display text-lg font-bold">Nenhuma conta cadastrada</p>
                <p className="max-w-xs text-sm text-muted-foreground">
                  Cadastre seus dados bancários para poder solicitar adiantamento.
                </p>
              </div>
            )}

            <Link href="/conta-bancaria/alterar" className={cn(buttonVariants({ size: 'lg' }), 'w-full')}>
              <Edit className="h-4 w-4" />
              {resumo.aprovada || resumo.pendente || resumo.ultimaRejeicao ? 'Alterar dados bancários' : 'Cadastrar dados bancários'}
            </Link>

            {(resumo.aprovada || resumo.pendente) && (
              <div className="flex items-start gap-2 rounded-xl bg-primary/5 p-3 text-xs text-foreground/80">
                <RuleIcon className="mt-0.5 h-4 w-4 shrink-0 text-[color-mix(in_oklab,var(--primary)_70%,var(--foreground)_30%)]" />
                <p>Toda alteração passa pela análise do financeiro. Enquanto isso, seus pagamentos continuam indo para a conta atual.</p>
              </div>
            )}

            <p className="m-1 text-[0.7rem] font-semibold uppercase tracking-wide text-muted-foreground">Mais</p>
            <div className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-card">
              <Link href="/adiantamento/regras" className="flex items-center gap-3 p-4 text-sm font-medium">
                <RuleIcon className="h-4 w-4 text-muted-foreground" />
                Regras do adiantamento
              </Link>
              <Link href="/repasse" className="flex items-center gap-3 p-4 text-sm font-medium">
                <EventRepeat className="h-4 w-4 text-muted-foreground" />
                Previsão do repasse
              </Link>
            </div>
          </>
        )}
      </div>

      <BottomNav />
    </main>
  );
}

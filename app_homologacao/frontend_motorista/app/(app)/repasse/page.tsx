'use client';

/**
 * adiantamento-motorista — app/(app)/repasse/page.tsx (tasks.md 6.6.1, 6.6.2)
 *
 * Previsão do remanescente do repasse (protótipo M16) — só existe quando
 * `repasseVisivelApp = true` na configuração; caso contrário
 * `GET /motorista/repasse` devolve 404 `NAO_DISPONIVEL` e a tela não
 * renderiza conteúdo algum (FR-039), distinto de um erro de carregamento
 * (que mostra "tentar de novo").
 *
 * Ref: prototipo M16; Spec US6, §FR-039/FR-040.
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ThemeToggle } from '@/components/theme-toggle';
import { formatCurrency, formatDate } from '@/lib/utils';
import { buscarExtrato, buscarRepasse, type Extrato, type Repasse } from '@/lib/adiantamento-api';
import { classificarErroRepasse } from '@/lib/repasse-estado';
import { AlertCircle, AlertTriangle, ArrowLeft, EventRepeat, Info } from '@/components/ui/icons';

type Estado = Repasse | null | undefined | 'indisponivel';

export default function RepassePage() {
  const [repasse, setRepasse] = useState<Estado>(undefined);
  // F2: informação ADICIONAL. Se falhar, a tela do repasse continua inteira —
  // mesmo princípio do `ultimoFechado` na rota.
  const [extrato, setExtrato] = useState<Extrato | null>(null);

  const carregar = useCallback(() => {
    setRepasse(undefined);
    setExtrato(null);
    buscarExtrato().then(setExtrato).catch(() => setExtrato(null));
    buscarRepasse()
      .then(setRepasse)
      .catch((err: unknown) => {
        // 404 NAO_DISPONIVEL (config. desligada, FR-039) vs infra —
        // lógica pura testada em lib/repasse-estado.test.ts (6.6.3).
        setRepasse(classificarErroRepasse(err) === 'indisponivel' ? 'indisponivel' : null);
      });
  }, []);

  useEffect(() => { carregar(); }, [carregar]);

  return (
    <main className="relative flex min-h-dvh flex-col bg-muted/40">
      <header className="glass sticky top-0 z-20 flex items-center justify-between rounded-none border-x-0 border-t-0 px-3 pb-3 pt-[max(0.85rem,env(safe-area-inset-top))]">
        <div className="flex items-center gap-1">
          <Link
            href="/conta-bancaria"
            aria-label="Voltar"
            className="inline-flex h-11 w-11 items-center justify-center rounded-full text-foreground transition-colors hover:bg-muted active:scale-90"
          >
            <ArrowLeft className="h-5 w-5" />
          </Link>
          <h1 className="font-display text-base font-semibold">Previsão do repasse</h1>
        </div>
        <ThemeToggle />
      </header>

      <div className="mx-auto w-full max-w-md flex-1 space-y-4 px-4 pb-10 pt-5">
        {repasse === undefined ? (
          <Skeleton className="h-56 rounded-3xl" />
        ) : repasse === null ? (
          <div className="animate-fade-up flex flex-col items-center gap-3 py-16 text-center">
            <AlertTriangle className="h-10 w-10 text-muted-foreground" />
            <p className="font-display text-lg font-bold">Não foi possível carregar</p>
            <Button variant="outline" onClick={carregar}>Tentar de novo</Button>
          </div>
        ) : repasse === 'indisponivel' ? (
          <div className="animate-fade-up flex flex-col items-center gap-3 py-16 text-center">
            <AlertCircle className="h-10 w-10 text-muted-foreground" />
            <p className="font-display text-lg font-bold">Previsão indisponível</p>
            <p className="max-w-xs text-sm text-muted-foreground">
              A previsão do repasse não está disponível no momento.
            </p>
          </div>
        ) : (
          <div className="space-y-3 rounded-3xl border border-border bg-card p-5 shadow-sm">
            <div className="flex items-center justify-between">
              <span className="text-[0.7rem] font-semibold uppercase tracking-wide text-muted-foreground">
                Repasse de {formatDate(repasse.dataRepasse)}
              </span>
              <span className="rounded-full bg-primary/10 px-2.5 py-1 text-xs font-semibold text-[color-mix(in_oklab,var(--primary)_70%,var(--foreground)_30%)]">
                {repasse.situacao === 'EM_APURACAO' ? 'Em apuração' : 'Fechada'}
              </span>
            </div>
            <p className="tabular text-xs text-muted-foreground">
              Produção de {formatDate(repasse.periodoInicio)} a {formatDate(repasse.periodoFim)}
            </p>

            <dl className="space-y-1.5 text-sm">
              <div className="flex items-center justify-between">
                <dt className="text-muted-foreground">Produção do período</dt>
                <dd className="tabular font-medium">{formatCurrency(repasse.creditos)}</dd>
              </div>
              {repasse.adiantamentos.map((a) => (
                <div key={a.id} className="flex items-center justify-between">
                  <dt className="text-muted-foreground">
                    Adiantamento de {formatDate(a.dataProducao)} (bruto){a.emProcessamento ? ' · em processamento' : ''}
                  </dt>
                  <dd className="tabular font-medium">− {formatCurrency(a.valorBruto)}</dd>
                </div>
              ))}
              {/* Débitos (FR-039): o backend sempre mandou este campo e a tela
                  nunca o exibia — a conta mostrada não fechava quando havia
                  débito. Some quando é zero, como a lista de adiantamentos
                  vazia: linha de R$ 0,00 é ruído, e a soma continua correta. */}
              {Number(repasse.debitos) > 0 && (
                <div className="flex items-center justify-between">
                  <dt className="text-muted-foreground">Outros débitos</dt>
                  <dd className="tabular font-medium">− {formatCurrency(repasse.debitos)}</dd>
                </div>
              )}
              <div className="flex items-center justify-between border-t border-border/60 pt-1.5 font-semibold">
                <dt>Previsão a receber</dt>
                <dd className={`tabular ${repasse.negativo ? 'text-destructive' : ''}`}>
                  {formatCurrency(repasse.remanescente)}
                </dd>
              </div>
            </dl>

            {extrato && extrato.dias.length > 0 && (
              <details className="rounded-xl border border-border/60">
                <summary className="flex min-h-11 cursor-pointer items-center justify-between px-3 py-2 text-sm font-medium">
                  <span>Extrato da produção</span>
                  <span className="tabular text-muted-foreground">{formatCurrency(extrato.total)}</span>
                </summary>
                <div className="space-y-3 border-t border-border/60 px-3 py-3">
                  {/* `!= null` cobre o backend antigo, que nem manda o campo:
                       entre o deploy do app e a migration a seção some inteira
                       em vez de mostrar "—". */}
                  {extrato.totalNota != null && (
                    <dl className="space-y-1 rounded-lg bg-muted/60 px-2.5 py-2 text-xs">
                      <div className="flex items-baseline justify-between gap-3">
                        <dt>Entra na nota</dt>
                        <dd className="tabular font-medium">{formatCurrency(extrato.totalNota)}</dd>
                      </div>
                      <div className="flex items-baseline justify-between gap-3 text-muted-foreground">
                        <dt>Fora da nota</dt>
                        <dd className="tabular">{formatCurrency(extrato.totalOutros)}</dd>
                      </div>
                    </dl>
                  )}
                  {extrato.dias.map((dia) => (
                    <div key={dia.data} className="space-y-1">
                      <div className="flex items-baseline justify-between text-sm font-medium">
                        <span>{formatDate(dia.data)}</span>
                        <span className="tabular">{formatCurrency(dia.total)}</span>
                      </div>
                      <dl className="space-y-0.5 text-xs text-muted-foreground">
                        {dia.itens.map((item) => (
                          <div key={item.descricao} className="flex items-baseline justify-between gap-3">
                            <dt className="min-w-0 truncate">
                              {item.descricao}
                              {item.quantidade > 1 && <span className="tabular"> ×{item.quantidade}</span>}
                            </dt>
                            <dd className="tabular shrink-0">{formatCurrency(item.valor)}</dd>
                          </div>
                        ))}
                      </dl>
                    </div>
                  ))}
                </div>
              </details>
            )}

            {repasse.negativo && (
              <div className="flex items-start gap-2 rounded-xl bg-destructive/10 p-3 text-xs text-destructive">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <p>O valor previsto está negativo. Ele não é transportado automaticamente para a semana seguinte.</p>
              </div>
            )}

            <div className="flex items-start gap-2 rounded-xl bg-primary/5 p-3 text-xs text-foreground/80">
              <Info className="mt-0.5 h-4 w-4 shrink-0 text-[color-mix(in_oklab,var(--primary)_70%,var(--foreground)_30%)]" />
              <p>A taxa de cada adiantamento já foi descontada no ato e não é cobrada de novo. Valores podem mudar até o fechamento.</p>
            </div>
            {repasse.situacao === 'FECHADA' && (
              <div className="flex items-start gap-2 rounded-xl bg-muted p-3 text-xs text-muted-foreground">
                <EventRepeat className="mt-0.5 h-4 w-4 shrink-0" />
                <p>Este período já foi fechado — o retrato acima é definitivo.</p>
              </div>
            )}
          </div>
        )}

        {/* Última semana FECHADA — o valor definitivo, já congelado na
            apuração. O bloco acima é a semana CORRENTE, que ainda muda; este
            é o que o motorista vai de fato receber. Antes ele nunca via isso:
            a semana só fecha depois de terminar, e aí a tela já mostra a
            seguinte. */}
        {repasse && typeof repasse === 'object' && repasse.ultimoFechado && (
          <div className="animate-fade-up space-y-3 rounded-3xl border border-border bg-card p-5 shadow-sm">
            <div className="flex items-center justify-between">
              <span className="text-[0.7rem] font-semibold uppercase tracking-wide text-muted-foreground">
                Semana fechada
              </span>
              <span className="rounded-full bg-muted px-2.5 py-1 text-xs font-semibold text-muted-foreground">
                Definitivo
              </span>
            </div>
            <p className="tabular text-xs text-muted-foreground">
              Produção de {formatDate(repasse.ultimoFechado.periodoInicio)} a{' '}
              {formatDate(repasse.ultimoFechado.periodoFim)} · repasse em{' '}
              {formatDate(repasse.ultimoFechado.dataRepasse)}
            </p>

            <dl className="space-y-1.5 text-sm">
              <div className="flex items-center justify-between">
                <dt className="text-muted-foreground">Produção do período</dt>
                <dd className="tabular font-medium">{formatCurrency(repasse.ultimoFechado.creditos)}</dd>
              </div>
              {Number(repasse.ultimoFechado.adiantamentos) > 0 && (
                <div className="flex items-center justify-between">
                  <dt className="text-muted-foreground">Adiantamentos (bruto)</dt>
                  <dd className="tabular font-medium">− {formatCurrency(repasse.ultimoFechado.adiantamentos)}</dd>
                </div>
              )}
              {Number(repasse.ultimoFechado.debitos) > 0 && (
                <div className="flex items-center justify-between">
                  <dt className="text-muted-foreground">Outros débitos</dt>
                  <dd className="tabular font-medium">− {formatCurrency(repasse.ultimoFechado.debitos)}</dd>
                </div>
              )}
              <div className="flex items-center justify-between border-t border-border/60 pt-1.5 font-semibold">
                <dt>Valor a receber</dt>
                <dd className={`tabular ${repasse.ultimoFechado.negativo ? 'text-destructive' : ''}`}>
                  {formatCurrency(repasse.ultimoFechado.remanescente)}
                </dd>
              </div>
            </dl>

            <div className="flex items-start gap-2 rounded-xl bg-muted p-3 text-xs text-muted-foreground">
              <EventRepeat className="mt-0.5 h-4 w-4 shrink-0" />
              <p>Fechado em {formatDate(repasse.ultimoFechado.fechadoEm)} — este valor não muda mais.</p>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}

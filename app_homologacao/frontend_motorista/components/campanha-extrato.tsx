'use client';

/**
 * Tela da campanha tipo "Melhor extrato" (plano PLANO-MELHOR-EXTRATO, X2/E4/E7).
 * O ranking mostra só posição e nome abreviado; o único valor em R$ é o do próprio
 * motorista. Os textos vêm de lib/campanhas.ts (funções puras testadas).
 */

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { AlertCircle, ArrowDown, ArrowUp, Gift, RefreshCw, Trophy } from '@/components/ui/icons';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn, formatDate } from '@/lib/utils';
import { buscarTurnos, type ExtratoTela, type TurnoExtrato } from '@/lib/campanhas-api';
import {
  fmtReais,
  iniciais,
  linhaTurno,
  ordinal,
  rankingExtrato,
  textoStatusPremio,
  textoTurnoValido,
  textoVariacao,
  variacaoPosicao,
} from '@/lib/campanhas';

const cartao = 'rounded-3xl bg-card p-5 text-card-foreground';
const sombra = 'shadow-[0_24px_48px_-28px_color-mix(in_oklab,var(--foreground)_55%,transparent)]';

const ESTILO_PODIO: Record<number, { avatar: string; bloco: string; altura: string }> = {
  1: { avatar: 'bg-warning text-warning-foreground ring-4 ring-warning/30', bloco: 'bg-warning text-warning-foreground', altura: 'h-[116px]' },
  2: { avatar: 'bg-secondary text-secondary-foreground', bloco: 'bg-secondary text-secondary-foreground', altura: 'h-[84px]' },
  3: { avatar: 'bg-accent text-accent-foreground', bloco: 'bg-accent text-accent-foreground', altura: 'h-16' },
};

export function TelaExtrato({ t, hero }: { t: ExtratoTela; hero: ReactNode }) {
  const { campanha: c, eu } = t;
  const r = rankingExtrato(t.top10, eu?.posicao ?? null);
  const nValidos = eu?.turnosValidos ?? 0;
  const nNaoValeram = Math.max(0, (eu?.turnos ?? 0) - nValidos);
  const base = c.minTurnosBase === 'validos' ? 'válidos' : 'trabalhados';

  return (
    <main className="flex min-h-dvh flex-col bg-muted/40 pb-10">
      {hero}
      <div className="relative mx-auto -mt-12 flex w-full max-w-md flex-col gap-4 px-4">
        {eu && eu.situacao === 'classificado' && eu.posicao != null ? (
          <section aria-label="Meu extrato" className={cn(cartao, 'flex flex-col gap-3.5', sombra)}>
            <PosicaoEExtrato t={t} />
            <p className="text-[13px] font-semibold">
              <span className="tabular font-extrabold">{nValidos}</span> {nValidos === 1 ? 'turno válido' : 'turnos válidos'}
              {' · '}
              <span className="tabular font-extrabold">{nNaoValeram}</span> não {nNaoValeram === 1 ? 'valeu' : 'valeram'}
            </p>
            <div className={cn('flex items-start gap-2.5 rounded-2xl p-3 text-[13px] leading-snug', eu.premio ? 'bg-accent text-accent-foreground' : 'bg-muted text-foreground')}>
              {eu.premio ? <Gift className="h-5 w-5 shrink-0" /> : <Trophy className="h-5 w-5 shrink-0" />}
              <p>
                {eu.premio && (
                  <>
                    <strong>Na zona de prêmio: {eu.premio.descricao}.</strong>{' '}
                    {textoStatusPremio(
                      { tipo: eu.premio.tipo, entregueEm: eu.entregueEm, dataPremio: c.dataPremio ?? null, dataPagamento: eu.dataPagamento ?? null },
                      formatDate
                    )}.{' '}
                  </>
                )}
                Cada turno válido a mais soma o valor dele no seu extrato.
              </p>
            </div>
          </section>
        ) : (
          <section aria-label="Sua situação" className={cn(cartao, 'flex flex-col gap-1.5', sombra)}>
            <h2 className="text-[17px] font-extrabold leading-tight">Você ainda não está no ranking</h2>
            <p className="text-[13px] text-muted-foreground">
              {eu
                ? `Você tem ${nValidos} ${nValidos === 1 ? 'turno válido' : 'turnos válidos'} de ${eu.turnos} rodados. Mínimo de ${c.minTurnos} turnos ${base} para entrar${nValidos === 0 ? ', com pelo menos 1 turno válido' : ''}.`
                : 'Rode nos turnos da campanha para entrar no ranking.'}
            </p>
            {eu && eu.valorCentavos > 0 && (
              <p className="text-[13px] font-semibold">
                Seu extrato na campanha: <span className="tabular font-extrabold">{fmtReais(eu.valorCentavos)}</span>
              </p>
            )}
          </section>
        )}

        <PodioExtrato podio={r.podio} />
        <TopExtrato resto={r.resto} />
        <Turnos campanhaId={c.id} />

        <section aria-labelledby="rg" className={cn(cartao, 'mb-2 flex flex-col gap-2 px-4')}>
          <h2 id="rg" className="text-base font-extrabold">
            Regras
          </h2>
          {c.descricao && <p className="whitespace-pre-line break-words text-[13px] leading-relaxed">{c.descricao}</p>}
          <p className="text-[13px] leading-relaxed">{textoTurnoValido(c.cortes)}</p>
          <p className="text-xs leading-relaxed text-muted-foreground">
            Mínimo de {c.minTurnos} turnos {base}
            {eu ? `: você tem ${base === 'válidos' ? nValidos : eu.turnos}` : ''}. Empate: vence quem tiver mais turnos válidos. As regras não mudam
            depois que a campanha começa.
          </p>
        </section>
      </div>
    </main>
  );
}

function PosicaoEExtrato({ t }: { t: ExtratoTela }) {
  const eu = t.eu!;
  const pos = eu.posicao as number;
  const v = variacaoPosicao(eu.posicaoAnterior, pos);
  const Icone = v.tipo === 'subiu' ? ArrowUp : v.tipo === 'desceu' ? ArrowDown : null;
  return (
    <div className="flex items-center gap-4">
      <div className="flex h-[84px] w-[84px] shrink-0 flex-col items-center justify-center rounded-full bg-muted">
        <span className="tabular text-[32px] font-extrabold leading-none">{ordinal(pos)}</span>
      </div>
      <div className="flex min-w-0 flex-col gap-1">
        <span className="text-xs font-bold text-muted-foreground">Seu extrato na campanha</span>
        <span className="tabular text-3xl font-extrabold leading-none">{fmtReais(eu.valorCentavos)}</span>
        <span className={cn('inline-flex items-center gap-1 text-xs font-bold', v.tipo === 'subiu' ? 'text-accent-foreground dark:text-success' : 'text-muted-foreground')}>
          {Icone && <Icone className="h-3.5 w-3.5" />}
          {textoVariacao(v)}
        </span>
      </div>
    </div>
  );
}

type Linha = { posicao: number; nome: string; souEu: boolean };

function PodioExtrato({ podio }: { podio: Linha[] }) {
  if (!podio.length) return null;
  return (
    <section aria-labelledby="pd" data-testid="podio" className={cn(cartao, 'overflow-hidden px-4 pb-0')}>
      <h2 id="pd" className="text-center text-base font-extrabold">
        Pódio
      </h2>
      <ol className="mt-3 grid grid-cols-3 items-end gap-2">
        {podio.map((l) => {
          const e = ESTILO_PODIO[l.posicao];
          const nome = l.souEu ? 'Você' : l.nome;
          return (
            <li key={l.posicao} className="flex min-w-0 flex-col items-center gap-1.5">
              <span className={cn('flex h-[52px] w-[52px] items-center justify-center rounded-full text-base font-extrabold', e.avatar)} aria-hidden="true">
                {iniciais(nome)}
              </span>
              <span className="max-w-full break-words text-center text-[13px] font-bold">{nome}</span>
              <div className={cn('flex w-full items-start justify-center rounded-t-2xl pt-2.5 text-[22px] font-extrabold', e.bloco, e.altura)}>
                <span className="sr-only">{ordinal(l.posicao)} lugar</span>
                <span aria-hidden="true">{l.posicao}</span>
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function TopExtrato({ resto }: { resto: Linha[] }) {
  if (!resto.length) return null;
  return (
    <section aria-labelledby="tp" data-testid="top10" className="overflow-hidden rounded-3xl bg-card py-2 text-card-foreground">
      <h2 id="tp" className="px-4 pb-1 pt-3 text-base font-extrabold">
        Top 10
      </h2>
      <p className="px-4 pb-2 text-xs text-muted-foreground">O valor de cada motorista é só dele: aqui aparecem só nome e posição.</p>
      <ol>
        {resto.map((l) => (
          <li key={l.posicao} aria-current={l.souEu ? 'true' : undefined} className={cn('flex items-center gap-2 border-t px-4 py-3', l.souEu ? 'border-warning bg-warning/20' : 'border-border')}>
            <span className="tabular w-10 shrink-0 text-sm font-extrabold text-muted-foreground">{ordinal(l.posicao)}</span>
            <span className="min-w-0 flex-1 break-words text-sm font-bold">{l.souEu ? 'Você' : l.nome}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

type CargaTurnos = { tipo: 'carregando' } | { tipo: 'erro' } | { tipo: 'ok'; turnos: TurnoExtrato[] };

const SELO = {
  valido: { ic: '✓', cls: 'bg-accent text-accent-foreground', nome: 'Turno válido' },
  invalido: { ic: '✕', cls: 'bg-destructive/15 text-destructive', nome: 'Turno que não valeu' },
  aguardando: { ic: '…', cls: 'bg-muted text-muted-foreground', nome: 'Aguardando faturamento' },
} as const;

function Turnos({ campanhaId }: { campanhaId: number }) {
  const [carga, setCarga] = useState<CargaTurnos>({ tipo: 'carregando' });
  const carregar = useCallback(() => {
    setCarga({ tipo: 'carregando' });
    buscarTurnos(campanhaId)
      .then((turnos) => setCarga({ tipo: 'ok', turnos }))
      .catch((e) => {
        console.error('[campanhas] falha ao carregar os turnos:', e);
        setCarga({ tipo: 'erro' });
      });
  }, [campanhaId]);
  useEffect(() => {
    carregar();
  }, [carregar]);

  return (
    <section aria-labelledby="tn" className="overflow-hidden rounded-3xl bg-card py-2 text-card-foreground">
      <h2 id="tn" className="px-4 pb-2 pt-3 text-base font-extrabold">
        Seus turnos
      </h2>
      {carga.tipo === 'carregando' && (
        <div className="space-y-2 px-4 pb-3" aria-busy="true" aria-label="Carregando turnos">
          <Skeleton className="h-12 rounded-2xl" />
          <Skeleton className="h-12 rounded-2xl" />
          <Skeleton className="h-12 rounded-2xl" />
        </div>
      )}
      {carga.tipo === 'erro' && (
        <div role="alert" className="flex flex-col items-center gap-2 px-4 pb-4 text-center">
          <AlertCircle className="h-6 w-6 text-destructive" />
          <p className="text-sm font-bold">Não foi possível carregar seus turnos</p>
          <Button variant="outline" onClick={carregar} className="min-h-11">
            <RefreshCw className="h-4 w-4" />
            Tentar novamente
          </Button>
        </div>
      )}
      {carga.tipo === 'ok' && carga.turnos.length === 0 && (
        <p className="px-4 pb-4 text-sm text-muted-foreground">Você ainda não tem turnos nesta campanha.</p>
      )}
      {carga.tipo === 'ok' && carga.turnos.length > 0 && (
        <ul>
          {carga.turnos.map((x) => {
            const l = linhaTurno(x);
            const s = SELO[l.estado];
            return (
              <li key={`${x.data}|${x.turno}`} className="flex items-center gap-3 border-t border-border px-4 py-3">
                <span className={cn('flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-sm font-extrabold', s.cls)} role="img" aria-label={s.nome}>
                  {s.ic}
                </span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="break-words text-[13px] font-bold">{l.quando}</span>
                  <span className={cn('break-words text-xs', l.estado === 'invalido' ? 'font-semibold text-destructive' : 'text-muted-foreground')}>{l.detalhe}</span>
                </span>
                <span className={cn('tabular shrink-0 text-sm font-extrabold', l.estado === 'valido' ? '' : 'text-muted-foreground', l.estado === 'invalido' && 'line-through')}>
                  {l.valor}
                  {l.estado === 'invalido' && <span className="sr-only"> não somou</span>}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

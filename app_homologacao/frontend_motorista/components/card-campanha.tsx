'use client';

/**
 * Card da Início com a campanha em andamento mais relevante. Busca própria e NÃO
 * bloqueante (mesma técnica de CardNotasPendentes): sem campanha, ou se a chamada
 * falhar, não renderiza nada e a Início segue como sempre.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowUpRight, Trophy } from '@/components/ui/icons';
import { cn } from '@/lib/utils';
import { buscarCampanha, listarCampanhas, type CampanhaItem, type CampanhaTela } from '@/lib/campanhas-api';
import {
  escolherCampanha,
  modoCard,
  textoComeca,
  estadoDoItem,
  faltamPontos,
  ordinal,
  pontosTexto,
  textoTermino,
  turnosFaltantes,
} from '@/lib/campanhas';

/** Selo "Na zona de prêmio" — menta com texto legível nos dois temas. */
export const seloZonaClasse =
  'rounded-full bg-warm-2 px-2.5 py-1 text-[11px] font-extrabold text-accent-foreground dark:text-success-foreground';

export function CardCampanha() {
  const [item, setItem] = useState<CampanhaItem | null>(null);
  const [detalhe, setDetalhe] = useState<CampanhaTela | null>(null);

  useEffect(() => {
    let vivo = true;
    listarCampanhas()
      .then((itens) => {
        const c = escolherCampanha(itens);
        if (!vivo || !c) return;
        setItem(c);
        const e = estadoDoItem(c);
        const m = modoCard(c);
        // O detalhe só serve para "pontos para subir" / "turnos que faltam";
        // falha = card sem essa linha.
        if (m === 'andamento' && (e === 'classificado' || e === 'sem_minimo')) {
          buscarCampanha(c.id)
            .then((d) => vivo && setDetalhe(d))
            .catch(() => {});
        }
      })
      .catch((e) => console.error('[campanhas] card da home: falha ao listar:', e));
    return () => {
      vivo = false;
    };
  }, []);

  if (!item) return null;

  const estado = estadoDoItem(item);
  const modo = modoCard(item);
  const falta = detalhe?.eu ? faltamPontos(detalhe.eu) : null;
  const faltamTurnos = detalhe?.eu ? turnosFaltantes(detalhe.campanha.minTurnos, detalhe.eu.turnos) : null;
  const sub = 'text-sm text-background/80 dark:text-muted-foreground';

  return (
    <Link
      href={`/campanhas/${item.id}`}
      className="animate-fade-up relative mb-4 block overflow-hidden rounded-3xl bg-foreground p-5 text-background shadow-[0_20px_44px_-24px_color-mix(in_oklab,var(--foreground)_80%,transparent)] dark:border dark:border-border dark:bg-card dark:text-card-foreground"
    >
      <span
        aria-hidden="true"
        className="pointer-events-none absolute -right-10 -top-10 h-40 w-40 rounded-full bg-[radial-gradient(circle,color-mix(in_oklab,var(--warning)_45%,transparent),transparent_70%)]"
      />
      <div className="relative flex items-center justify-between gap-2">
        <span className="text-[11px] font-bold uppercase tracking-wider text-warning">
          {modo === 'resultado'
            ? 'Resultado final'
            : modo === 'apurando'
              ? 'Campanha · apuração'
              : modo === 'agendada'
                ? 'Campanha · em breve'
                : `Campanha · ${textoTermino(item.dataFim)}`}
        </span>
        <Trophy className="h-5 w-5 text-warning" />
      </div>
      <p className="relative mt-3 break-words text-lg font-extrabold leading-tight">{item.nome}</p>

      <div className="relative mt-3">
        {modo === 'resultado' && (
          <>
            <p className="flex flex-wrap items-baseline gap-x-2">
              <span className="tabular text-lg font-extrabold">
                Você ficou em <span className="text-warning">{ordinal(item.minhaPosicao as number)}</span> de {item.total}
              </span>
            </p>
            {item.naZonaPremio && <span className={cn(seloZonaClasse, 'mt-3 inline-block')}>Ganhou prêmio</span>}
          </>
        )}
        {modo === 'agendada' && (
          <p className="text-[15px] font-bold">{textoComeca(item.dataInicio)}</p>
        )}
        {modo === 'apurando' && (
          <p className="text-[15px] font-bold">Resultado saindo: a apuração fecha com os dados do último dia</p>
        )}
        {modo === 'andamento' && estado === 'classificado' && (
          <>
            <p className="flex flex-wrap items-baseline gap-x-2">
              <span className="tabular text-5xl font-extrabold leading-none text-warning">{ordinal(item.minhaPosicao as number)}</span>
              <span className={cn(sub, 'font-semibold')}>de {item.total} motoristas</span>
            </p>
            <p className="mt-3 flex flex-wrap items-center gap-2 text-[13px] font-semibold">
              {item.naZonaPremio && <span className={seloZonaClasse}>Na zona de prêmio</span>}
              {(item.minhaPosicao as number) === 1 ? (
                <span>Você lidera o ranking</span>
              ) : falta != null ? (
                <span>
                  {pontosTexto(falta)} para subir ao {ordinal((item.minhaPosicao as number) - 1)}
                </span>
              ) : null}
            </p>
          </>
        )}
        {modo === 'andamento' && estado === 'abaixo_corte' && <p className="text-[15px] font-bold">Fora do ranking por enquanto — veja o que falta</p>}
        {modo === 'andamento' && estado === 'sem_minimo' && (
          <p className="text-[15px] font-bold">
            {faltamTurnos
              ? `Participe: faltam ${faltamTurnos} ${faltamTurnos === 1 ? 'turno' : 'turnos'}`
              : 'Participe: complete o mínimo de turnos'}
          </p>
        )}
        {modo === 'andamento' && estado === 'sem_modal' && <p className="text-[15px] font-bold">Seu cadastro não tem o modal desta campanha</p>}
        {modo === 'andamento' && estado === 'sem_linha' && <p className="text-[15px] font-bold">Comece a rodar nos turnos da campanha</p>}
      </div>

      <span className="relative mt-3 inline-flex min-h-11 items-center gap-1 text-sm font-bold">
        {modo === 'resultado'
          ? 'Ver resultado'
          : modo === 'andamento' && estado === 'abaixo_corte'
            ? 'Ver o que falta'
            : modo === 'andamento' && estado === 'classificado'
              ? 'Ver ranking'
              : 'Ver campanha'}
        <ArrowUpRight className="h-4 w-4" />
      </span>
    </Link>
  );
}

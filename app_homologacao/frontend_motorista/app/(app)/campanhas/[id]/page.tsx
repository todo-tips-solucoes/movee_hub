'use client';

/**
 * Tela da campanha (ranking). Consome `GET /motorista/campanhas/:id` — o servidor
 * entrega os números; textos derivados vêm de lib/campanhas.ts (funções puras testadas).
 * Estados: carregando · erro · 404/SEM_VINCULO · classificado · abaixo do corte ·
 * sem mínimo/sem linha · encerrada (resultado final).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ThemeToggle } from '@/components/theme-toggle';
import { TelaExtrato } from '@/components/campanha-extrato';
import {
  AlertCircle,
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Check,
  Gift,
  Lightbulb,
  Paid,
  RefreshCw,
  Trophy,
} from '@/components/ui/icons';
import { ApiError } from '@/lib/api-client';
import { cn, formatDate } from '@/lib/utils';
import {
  buscarCampanha,
  ehExtrato,
  urlFotoPremio,
  type CampanhaDados,
  type CampanhaTela,
  type ExtratoTela,
  type Indicador,
  type LinhaTop,
  type MinhaLinha,
  type PremioFaixa,
} from '@/lib/campanhas-api';
import {
  contagemRegressiva,
  estadoTela,
  faixaRotulo,
  faltamPontos,
  fmt1,
  fmtCortePct,
  fmtPct,
  foraDoTop10,
  iniciais,
  ondeGanharMais,
  ordinal,
  paraVoltar,
  pontosTexto,
  resumoPublico,
  ROTULO_INDICADOR,
  textoCortes,
  textoDadosAte,
  textoOndeGanhar,
  textoVariacao,
  turnosFaltantes,
  variacaoPosicao,
  textoStatusPremio,
  textoRodapePremio,
} from '@/lib/campanhas';

type Carga =
  | { tipo: 'carregando' }
  | { tipo: 'ok'; dados: CampanhaTela | ExtratoTela }
  | { tipo: 'erro' }
  | { tipo: 'nao-encontrada'; semVinculo: boolean };

const cartao = 'rounded-3xl bg-card p-5 text-card-foreground';
const titulo2 = 'px-1 text-xs font-bold uppercase tracking-wider text-muted-foreground';

export default function CampanhaPage() {
  const params = useParams<{ id: string }>();
  const [carga, setCarga] = useState<Carga>({ tipo: 'carregando' });

  const carregar = useCallback(() => {
    setCarga({ tipo: 'carregando' });
    buscarCampanha(params.id)
      .then((dados) => setCarga({ tipo: 'ok', dados }))
      .catch((e) => {
        if (e instanceof ApiError && e.status === 404) {
          setCarga({ tipo: 'nao-encontrada', semVinculo: e.code === 'SEM_VINCULO' });
        } else {
          console.error('[campanhas] falha ao carregar a campanha:', e);
          setCarga({ tipo: 'erro' });
        }
      });
  }, [params.id]);

  useEffect(() => {
    carregar();
  }, [carregar]);

  if (carga.tipo === 'ok') {
    if (ehExtrato(carga.dados))
      return <TelaExtrato t={carga.dados} hero={<Hero c={carga.dados.campanha} />} />;
    return carga.dados.campanha.situacao === 'encerrada' ? (
      <Encerrada t={carga.dados} />
    ) : (
      <EmAndamento t={carga.dados} />
    );
  }

  return (
    <main className="flex min-h-dvh flex-col bg-muted/40">
      <BarraSimples />
      <div className="mx-auto w-full max-w-md flex-1 px-4 pb-10 pt-6">
        {carga.tipo === 'carregando' && <Esqueleto />}
        {carga.tipo === 'erro' && (
          <div role="alert" className="flex flex-col items-center gap-3 py-12 text-center">
            <AlertCircle className="h-8 w-8 text-destructive" />
            <p className="font-display font-bold">Não foi possível carregar a campanha</p>
            <Button variant="outline" onClick={carregar} className="min-h-11">
              <RefreshCw className="h-4 w-4" />
              Tentar novamente
            </Button>
          </div>
        )}
        {carga.tipo === 'nao-encontrada' && (
          <div role="alert" className="flex flex-col items-center gap-3 py-12 text-center">
            <Trophy className="h-8 w-8 text-muted-foreground" />
            <p className="font-display font-bold">
              {carga.semVinculo ? 'Seu cadastro ainda não está vinculado' : 'Campanha não encontrada'}
            </p>
            <p className="text-sm text-muted-foreground">
              {carga.semVinculo
                ? 'Fale com a equipe Movee para liberar o acesso às campanhas.'
                : 'Ela pode ter terminado há mais de 30 dias ou não estar disponível para você.'}
            </p>
            <Link href="/movimento" className="inline-flex min-h-11 items-center text-sm font-semibold text-primary underline">
              Voltar ao início
            </Link>
          </div>
        )}
      </div>
    </main>
  );
}

function VoltarLink({ className }: { className?: string }) {
  return (
    <Link
      href="/movimento"
      aria-label="Voltar"
      className={cn('inline-flex h-11 w-11 items-center justify-center rounded-full transition-colors hover:bg-white/15 active:scale-90', className)}
    >
      <ArrowLeft className="h-5 w-5" />
    </Link>
  );
}

function BarraSimples() {
  return (
    <header className="glass sticky top-0 z-20 flex items-center justify-between rounded-none border-x-0 border-t-0 px-3 pb-3 pt-[max(0.85rem,env(safe-area-inset-top))]">
      <div className="flex items-center gap-1">
        <VoltarLink className="text-foreground hover:bg-muted" />
        <h1 className="font-display text-base font-semibold">Campanha</h1>
      </div>
      <ThemeToggle />
    </header>
  );
}

function Esqueleto() {
  return (
    <div className="space-y-4" aria-busy="true" aria-label="Carregando campanha">
      <Skeleton className="h-40 rounded-3xl" />
      <Skeleton className="h-44 rounded-3xl" />
      <Skeleton className="h-32 rounded-3xl" />
      <Skeleton className="h-56 rounded-3xl" />
    </div>
  );
}

// ── Em andamento / apurando ──────────────────────────────────────────────

function EmAndamento({ t }: { t: CampanhaTela }) {
  const { campanha: c, eu } = t;
  const estado = estadoTela(t);
  const lider = t.lider;

  return (
    <main className="flex min-h-dvh flex-col bg-muted/40 pb-10">
      <Hero c={t.campanha} />
      <div className="relative mx-auto -mt-12 flex w-full max-w-md flex-col gap-4 px-4">
        {estado === 'classificado' && eu && <MinhaPosicao t={t} eu={eu} />}
        {estado === 'abaixo_corte' && eu && <ForaDoRanking t={t} eu={eu} />}
        {(estado === 'sem_minimo' || estado === 'sem_linha' || estado === 'sem_modal') && <SemLinha t={t} estado={estado} />}

        {t.premios.length > 0 && <Premios campanhaId={c.id} premios={t.premios} />}
        <Podio top={t.top10} />
        <Top10 t={t} />
        {eu && <Indicadores t={t} eu={eu} lider={lider} />}
        <Regras t={t} />
      </div>
    </main>
  );
}

function Hero({ c }: { c: CampanhaDados }) {
  const [agora, setAgora] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setAgora(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  const r = contagemRegressiva(c.dataFim, agora);
  const caixas = [
    { v: String(r.dias).padStart(2, '0'), l: 'dias' },
    { v: String(r.horas).padStart(2, '0'), l: 'horas' },
    { v: String(r.minutos).padStart(2, '0'), l: 'min' },
  ];

  return (
    <header className="relative overflow-hidden bg-foreground px-4 pb-20 pt-[max(1rem,env(safe-area-inset-top))] text-background dark:bg-card dark:text-card-foreground">
      <span
        aria-hidden="true"
        className="pointer-events-none absolute left-1/2 top-10 h-[420px] w-[420px] -translate-x-1/2 rounded-full bg-[radial-gradient(circle,color-mix(in_oklab,var(--warning)_32%,transparent),transparent_65%)]"
      />
      <div className="relative mx-auto flex max-w-md items-center justify-between">
        <div className="-ml-2.5 flex items-center gap-2">
          <VoltarLink />
          <span className="text-sm font-bold opacity-80">Campanha</span>
        </div>
        <ThemeToggle />
      </div>
      <div className="relative mx-auto max-w-md pt-2 text-center">
        <h1 className="break-words font-display text-2xl font-extrabold leading-tight">{c.nome}</h1>
        <p className="mt-1.5 break-words text-[13px] opacity-80">{resumoPublico(c)}</p>
        {r.encerrou ? (
          <p className="mt-4 text-sm font-bold text-warning">Campanha encerrada — apurando o resultado final</p>
        ) : (
          <div className="mt-4 flex justify-center gap-2" role="timer" aria-label="Tempo restante da campanha">
            {caixas.map((b) => (
              <div key={b.l} className="min-w-14 rounded-2xl border border-current/15 bg-current/10 px-3.5 py-2">
                <div className="tabular text-[22px] font-extrabold leading-tight">{b.v}</div>
                <div className="text-[10px] font-bold uppercase tracking-wider opacity-80">{b.l}</div>
              </div>
            ))}
          </div>
        )}
        <p className="mt-3 text-[11px] opacity-75">{textoDadosAte(c.dadosAte)}</p>
      </div>
    </header>
  );
}

function MinhaPosicao({ t, eu }: { t: CampanhaTela; eu: MinhaLinha }) {
  const pos = eu.posicao as number;
  const nota = eu.nota ?? 0;
  const v = variacaoPosicao(eu.posicaoAnterior, pos);
  const falta = faltamPontos(eu);
  const onde = ondeGanharMais(t.campanha.pesos, eu.notas, t.lider);
  const IconeVar = v.tipo === 'subiu' ? ArrowUp : v.tipo === 'desceu' ? ArrowDown : null;

  return (
    <section aria-label="Minha posição" className={cn(cartao, 'flex flex-col gap-3.5 shadow-[0_24px_48px_-28px_color-mix(in_oklab,var(--foreground)_55%,transparent)]')}>
      <div className="flex items-center gap-4">
        <div
          className="flex h-[84px] w-[84px] shrink-0 items-center justify-center rounded-full"
          style={{ background: `conic-gradient(var(--warning) 0 ${Math.min(100, nota)}%, var(--muted) ${Math.min(100, nota)}% 100%)` }}
        >
          <div className="flex h-[70px] w-[70px] flex-col items-center justify-center rounded-full bg-card">
            <span className="tabular text-[32px] font-extrabold leading-none">{ordinal(pos)}</span>
          </div>
        </div>
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-xs font-bold text-muted-foreground">Sua nota</span>
          <span className="tabular text-3xl font-extrabold leading-none">{fmt1(nota)}</span>
          <span
            className={cn(
              'inline-flex items-center gap-1 text-xs font-bold',
              v.tipo === 'subiu' ? 'text-accent-foreground dark:text-success' : 'text-muted-foreground',
            )}
          >
            {IconeVar && <IconeVar className="h-3.5 w-3.5" />}
            {textoVariacao(v)}
          </span>
        </div>
      </div>

      <div
        className={cn(
          'flex items-start gap-2.5 rounded-2xl p-3 text-[13px] leading-snug',
          eu.premio ? 'bg-accent text-accent-foreground' : 'bg-muted text-foreground',
        )}
      >
        {eu.premio ? <Gift className="h-5 w-5 shrink-0" /> : <Trophy className="h-5 w-5 shrink-0" />}
        <p>
          {eu.premio && (
            <>
              <strong>Na zona de prêmio: {eu.premio.descricao}.</strong>{' '}
            </>
          )}
          {pos === 1
            ? 'Você está na liderança.'
            : falta != null && eu.acima
              ? `Faltam ${pontosTexto(falta)} para passar ${eu.acima.nome} (${ordinal(pos - 1)}).`
              : null}
        </p>
      </div>

      {onde && (
        <p className="flex items-start gap-2.5 text-[13px] leading-snug">
          <Lightbulb className="h-[18px] w-[18px] shrink-0 text-primary" />
          <span>
            <strong>Onde você ganha mais pontos:</strong> {textoOndeGanhar(onde)}
          </span>
        </p>
      )}
    </section>
  );
}

function ForaDoRanking({ t, eu }: { t: CampanhaTela; eu: MinhaLinha }) {
  const passos = paraVoltar(eu, t.campanha.cortes);
  const dias = contagemRegressiva(t.campanha.dataFim).dias;
  const nomesCorte = passos.map((p) => ROTULO_INDICADOR[p.indicador].toLowerCase());
  const motivo =
    passos.length === 0
      ? 'Um dos indicadores está abaixo do corte da campanha.'
      : `${passos.length === 1 ? 'Sua' : 'Suas'} ${nomesCorte.join(' e ')} ${passos.length === 1 ? 'está' : 'estão'} abaixo do corte de ${passos
          .map((p) => (p.indicador === 'pedidos' ? `${p.corte} pedidos` : fmtCortePct(p.corte)))
          .join(' e ')}.`;

  return (
    <section aria-label="Sua situação" className={cn(cartao, 'flex flex-col gap-3.5 shadow-[0_24px_48px_-28px_color-mix(in_oklab,var(--foreground)_55%,transparent)]')}>
      <div className="flex items-center gap-3">
        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-warning text-warning-foreground">
          <AlertCircle className="h-6 w-6" />
        </div>
        <div className="min-w-0">
          <h2 className="text-[17px] font-extrabold leading-tight">Você está fora do ranking por enquanto</h2>
          <p className="mt-0.5 text-[13px] text-muted-foreground">{motivo}</p>
        </div>
      </div>

      {eu.notaHipotetica != null && eu.posicaoHipotetica != null && (
        <div className="grid grid-cols-2 gap-3 rounded-2xl bg-muted p-3.5">
          <div>
            <div className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">Sua nota seria</div>
            <div className="tabular text-[26px] font-extrabold leading-tight">{fmt1(eu.notaHipotetica)}</div>
          </div>
          <div>
            <div className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">Daria o</div>
            <div className="tabular text-[26px] font-extrabold leading-tight">{ordinal(eu.posicaoHipotetica)} lugar</div>
          </div>
        </div>
      )}

      {passos.map((p) => (
        <div key={p.indicador} className="rounded-2xl bg-accent p-3.5 text-sm leading-snug text-accent-foreground">
          <strong>Para voltar ao ranking: </strong>
          {p.corridas != null && p.indicador === 'aceitacao' && (
            <>
              aceite as próximas <strong>{p.corridas} corridas</strong> ofertadas seguidas. Até agora você aceitou {eu.aceitas} de {eu.ofertadas}
              {eu.leituras.aceitacao != null && ` (${fmtPct(eu.leituras.aceitacao)})`}.
            </>
          )}
          {p.corridas != null && p.indicador === 'conclusao' && (
            <>
              conclua as próximas <strong>{p.corridas} corridas</strong> aceitas seguidas. Até agora você concluiu {eu.completadas} de {eu.aceitas}
              {eu.leituras.conclusao != null && ` (${fmtPct(eu.leituras.conclusao)})`}.
            </>
          )}
          {p.corridas == null && p.indicador === 'tempo' && (
            <>falta{p.falta != null ? ` ${fmt1(p.falta)} p.p.` : ''} de tempo disponível para chegar ao corte de {fmtCortePct(p.corte)}.</>
          )}
          {p.corridas == null && p.indicador === 'pedidos' && (
            <>
              {p.falta != null ? `faltam ${p.falta} pedidos concluídos` : 'conclua mais pedidos'} para chegar ao mínimo de {p.corte}.
            </>
          )}
          {p.corridas == null && (p.indicador === 'aceitacao' || p.indicador === 'conclusao') && (
            <>{ROTULO_INDICADOR[p.indicador].toLowerCase()} precisa chegar a {fmtCortePct(p.corte)}.</>
          )}
        </div>
      ))}

      <p className="text-xs text-muted-foreground">
        A conta é feita de novo a cada atualização diária.
        {dias > 0 && ` Ainda dá tempo: ${dias === 1 ? 'falta 1 dia' : `faltam ${dias} dias`}.`}
      </p>
    </section>
  );
}

function SemLinha({ t, estado }: { t: CampanhaTela; estado: 'sem_minimo' | 'sem_linha' | 'sem_modal' }) {
  const min = t.campanha.minTurnos;
  const turnos = t.eu?.turnos ?? 0;
  const falta = turnosFaltantes(min, turnos);
  const [tit, sub] =
    estado === 'sem_modal'
      ? ['Seu cadastro não tem o modal desta campanha', 'Fale com a equipe Movee para atualizar o seu modal.']
      : estado === 'sem_minimo'
        ? [`Faltam ${falta} ${falta === 1 ? 'turno' : 'turnos'} para você entrar no ranking`, `Você rodou ${turnos} dos ${min} turnos exigidos.`]
        : ['Você ainda não rodou nos turnos desta campanha', `Complete ${min} ${min === 1 ? 'turno' : 'turnos'} para entrar no ranking.`];
  return (
    <section aria-label="Sua situação" className={cn(cartao, 'flex flex-col gap-1.5 shadow-[0_24px_48px_-28px_color-mix(in_oklab,var(--foreground)_55%,transparent)]')}>
      <h2 className="text-[17px] font-extrabold leading-tight">{tit}</h2>
      <p className="text-[13px] text-muted-foreground">{sub}</p>
    </section>
  );
}

function FotoOuIcone({ campanhaId, p }: { campanhaId: number; p: PremioFaixa }) {
  const ref = useRef<HTMLImageElement>(null);
  const [falhou, setFalhou] = useState(false);
  // onError não dispara se a falha ocorreu antes da hidratação.
  useEffect(() => {
    const el = ref.current;
    if (el && el.complete && el.naturalWidth === 0) setFalhou(true);
  }, []);
  if (p.temFoto && !falhou) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        ref={ref}
        src={urlFotoPremio(campanhaId, p.id)}
        alt={`Foto do prêmio: ${p.descricao}`}
        width={96}
        height={64}
        loading="lazy"
        onError={() => setFalhou(true)}
        className="h-16 w-full rounded-xl object-cover"
      />
    );
  }
  const Icone = p.tipo === 'dinheiro' ? Paid : Gift;
  return (
    <div className="flex h-16 items-center justify-center rounded-xl bg-muted text-foreground">
      <Icone className="h-8 w-8" />
    </div>
  );
}

function Premios({ campanhaId, premios }: { campanhaId: number; premios: PremioFaixa[] }) {
  return (
    <section aria-labelledby="pr" className="flex flex-col gap-2.5">
      <h2 id="pr" className={titulo2}>
        Prêmios
      </h2>
      <ul className="grid grid-cols-2 gap-2.5 min-[380px]:grid-cols-3">
        {premios.map((p, i) => (
          <li key={p.id} className="flex min-w-0 flex-col gap-2 rounded-2xl border border-border bg-card p-2.5 text-card-foreground">
            <FotoOuIcone campanhaId={campanhaId} p={p} />
            <span
              className={cn(
                'self-start rounded-full px-2 py-0.5 text-[11px] font-extrabold',
                i === 0 ? 'bg-warning text-warning-foreground' : 'bg-secondary text-secondary-foreground',
              )}
            >
              {faixaRotulo(p.posicaoDe, p.posicaoAte)}
            </span>
            <span className="break-words text-xs font-bold leading-snug">{p.descricao}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

const ESTILO_PODIO: Record<number, { avatar: string; bloco: string; altura: string }> = {
  1: { avatar: 'bg-warning text-warning-foreground ring-4 ring-warning/30', bloco: 'bg-warning text-warning-foreground', altura: 'h-[116px]' },
  2: { avatar: 'bg-secondary text-secondary-foreground', bloco: 'bg-secondary text-secondary-foreground', altura: 'h-[84px]' },
  3: { avatar: 'bg-accent text-accent-foreground', bloco: 'bg-accent text-accent-foreground', altura: 'h-16' },
};

function Podio({ top }: { top: LinhaTop[] }) {
  const tres = [2, 1, 3].map((p) => top.find((l) => l.posicao === p)).filter((l): l is LinhaTop => !!l);
  if (!tres.length) return null;
  return (
    <section aria-labelledby="pd" className={cn(cartao, 'overflow-hidden px-4 pb-0')}>
      <h2 id="pd" className="text-center text-base font-extrabold">
        Pódio
      </h2>
      <ol className="mt-3 grid grid-cols-3 items-end gap-2">
        {tres.map((l) => {
          const e = ESTILO_PODIO[l.posicao];
          return (
            <li key={l.posicao} className="flex min-w-0 flex-col items-center gap-1.5">
              <span className={cn('flex h-[52px] w-[52px] items-center justify-center rounded-full text-base font-extrabold', e.avatar)} aria-hidden="true">
                {iniciais(l.souEu ? 'Você' : l.nome)}
              </span>
              <span className="max-w-full break-words text-center text-[13px] font-bold">{l.souEu ? 'Você' : l.nome}</span>
              <span className="tabular text-xs font-semibold text-muted-foreground">{fmt1(l.nota)}</span>
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

function LinhaRanking({ pos, nome, nota, destaque }: { pos: string; nome: string; nota: number; destaque?: boolean }) {
  return (
    <li
      aria-current={destaque ? 'true' : undefined}
      className={cn(
        'flex items-center gap-2 border-t px-4 py-3',
        destaque ? 'border-warning bg-warning/20' : 'border-border',
      )}
    >
      <span className="tabular w-10 shrink-0 text-sm font-extrabold text-muted-foreground">{pos}</span>
      <span className="min-w-0 flex-1 break-words text-sm font-bold">{nome}</span>
      <span className="tabular text-sm font-extrabold">{fmt1(nota)}</span>
    </li>
  );
}

function Top10({ t }: { t: CampanhaTela }) {
  // O pódio já mostra 1º–3º; a lista segue do 4º ao 10º (protótipo AppCampanha).
  const resto = t.top10.filter((l) => l.posicao > 3);
  const fora = foraDoTop10(t);
  if (!resto.length && !fora) return null;
  return (
    <section aria-labelledby="tp" className="overflow-hidden rounded-3xl bg-card py-2 text-card-foreground">
      <h2 id="tp" className="px-4 pb-2 pt-3 text-base font-extrabold">
        Top 10
      </h2>
      <ol>
        {resto.map((l) => (
          <LinhaRanking key={l.posicao} pos={ordinal(l.posicao)} nome={l.souEu ? 'Você' : l.nome} nota={l.nota} destaque={l.souEu} />
        ))}
        {fora && t.eu && (
          <li aria-hidden="true" className="border-t border-dashed border-border px-4 py-1 text-center text-xs text-muted-foreground">
            ···
          </li>
        )}
        {fora && t.eu && <LinhaRanking pos={ordinal(t.eu.posicao as number)} nome={`Você · ${ordinal(t.eu.posicao as number)}`} nota={t.eu.nota ?? 0} destaque />}
      </ol>
    </section>
  );
}

function Indicadores({ t, eu, lider }: { t: CampanhaTela; eu: MinhaLinha; lider: CampanhaTela['lider'] }) {
  const { pesos, cortes } = t.campanha;
  const lista = (['aceitacao', 'conclusao', 'tempo', 'pedidos'] as Indicador[]).filter((i) => pesos[i] > 0);
  return (
    <section aria-labelledby="mi" className={cn(cartao, 'flex flex-col gap-4 px-4')}>
      <h2 id="mi" className="text-base font-extrabold">
        Seus indicadores
      </h2>
      {lista.map((i) => {
        const leitura = eu.leituras[i];
        const nota = eu.notas[i];
        const corte = cortes[i];
        const falhou = eu.motivoCorte.includes(i);
        const pedidos = i === 'pedidos';
        const pct = pedidos ? (nota ?? 0) : (leitura ?? 0) * 100;
        const marca = corte == null ? null : pedidos ? (lider && lider.pedidos > 0 ? (corte / lider.pedidos) * 100 : null) : corte * 100;
        const valor = leitura == null ? '—' : pedidos ? String(leitura) : fmtPct(leitura);
        const partes: string[] = [];
        if (nota != null) partes.push(`Nota ${fmt1(nota)}`);
        if (corte != null) {
          const txt = pedidos ? `${corte} pedidos` : fmtCortePct(corte);
          partes.push(`${falhou ? 'Abaixo' : 'Acima'} do corte de ${txt}`);
        }
        if (pedidos && lider) partes.push(`o líder fez ${lider.pedidos}`);
        return (
          <div key={i} className="flex flex-col gap-1.5">
            <div className="flex items-baseline justify-between gap-2">
              <span className="min-w-0 text-sm font-bold">
                {ROTULO_INDICADOR[i]} <span className="text-xs font-semibold text-muted-foreground">· peso {pesos[i]}%</span>
              </span>
              <span className="tabular text-base font-extrabold">{valor}</span>
            </div>
            <div
              role="meter"
              aria-label={ROTULO_INDICADOR[i]}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(Math.min(100, pct))}
              aria-valuetext={`${valor}${corte != null ? `, corte ${pedidos ? corte : fmtCortePct(corte)}` : ''}`}
              className="relative h-2.5 rounded-full bg-muted"
            >
              <div
                className={cn('absolute inset-y-0 left-0 rounded-full', falhou ? 'bg-warning' : 'bg-linear-to-r from-warm-1 to-warm-2')}
                style={{ width: `${Math.max(0, Math.min(100, pct))}%` }}
              />
              {marca != null && <div className="absolute -inset-y-1 w-0.5 rounded-sm bg-foreground" style={{ left: `${Math.min(100, marca)}%` }} />}
            </div>
            <span className={cn('text-xs', falhou ? 'font-bold text-foreground' : 'font-semibold text-muted-foreground')}>{partes.join(' · ')}</span>
          </div>
        );
      })}
    </section>
  );
}

function Regras({ t }: { t: CampanhaTela }) {
  const { campanha: c, eu } = t;
  return (
    <section aria-labelledby="rg" className={cn(cartao, 'mb-2 flex flex-col gap-2 px-4')}>
      <h2 id="rg" className="text-base font-extrabold">
        Regras
      </h2>
      {c.descricao && <p className="whitespace-pre-line break-words text-[13px] leading-relaxed">{c.descricao}</p>}
      {textoCortes(c.cortes).map((x) => (
        <p key={x} className="text-[13px] leading-relaxed">
          {x}
        </p>
      ))}
      <p className="text-xs leading-relaxed text-muted-foreground">
        Mínimo de {c.minTurnos} turnos{eu ? `: você já tem ${eu.turnos}` : ''}. Empate: vence quem tiver mais pedidos concluídos, depois mais tempo
        disponível. As regras não mudam depois que a campanha começa.
      </p>
    </section>
  );
}

// ── Encerrada (resultado final) ──────────────────────────────────────────

const CONFETE = ['bg-warning', 'bg-warm-2', 'bg-primary', 'bg-background', 'bg-warning'];

function Confete() {
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 h-80 overflow-hidden">
      {Array.from({ length: 14 }, (_, k) => (
        <span
          key={k}
          className={cn('confete', CONFETE[k % 5])}
          style={{
            left: `${((k * 53 + 17) % 370) / 3.9}%`,
            top: `${(k * 37 + 20) % 300}px`,
            width: k % 3 === 0 ? 10 : 6,
            height: k % 2 ? 14 : 6,
            ['--r' as string]: `${(k * 47) % 90}deg`,
          }}
        />
      ))}
    </div>
  );
}

function statusPremio(eu: MinhaLinha, dataPremio: string | null): string {
  if (!eu.premio) return '';
  return textoStatusPremio(eu.premio.tipo, eu.entregueEm, dataPremio, formatDate);
}

function Encerrada({ t }: { t: CampanhaTela }) {
  const { campanha: c, eu } = t;
  const classificado = !!eu && eu.situacao === 'classificado' && eu.posicao != null;
  const premio = classificado ? eu.premio : null;
  const premioFaixa = premio && eu ? t.premios.find((p) => eu.posicao! >= p.posicaoDe && eu.posicao! <= p.posicaoAte) : undefined;
  const lista = t.top10.slice(0, 5);
  const euForaLista = classificado && !lista.some((l) => l.souEu);

  return (
    <main className="relative flex min-h-dvh flex-col overflow-hidden bg-foreground text-background dark:bg-background dark:text-foreground">
      <span
        aria-hidden="true"
        className="pointer-events-none absolute left-1/2 top-14 h-[520px] w-[520px] -translate-x-1/2 rounded-full bg-[radial-gradient(circle,color-mix(in_oklab,var(--warning)_42%,transparent),transparent_62%)]"
      />
      {premio && <Confete />}
      <div className="relative mx-auto flex w-full max-w-md items-center justify-between px-4 pt-[max(1rem,env(safe-area-inset-top))]">
        <div className="-ml-2.5 flex min-w-0 items-center gap-2">
          <VoltarLink />
          <span className="truncate text-sm font-bold opacity-80">{c.nome} · encerrada</span>
        </div>
        <ThemeToggle />
      </div>

      <div className="relative mx-auto flex w-full max-w-md flex-1 flex-col items-center gap-3.5 px-6 pb-10 pt-6 text-center">
        <div
          className={cn(
            'flex items-center justify-center rounded-full',
            premio
              ? 'h-32 w-32 bg-warning text-warning-foreground shadow-[0_0_0_10px_color-mix(in_oklab,var(--warning)_18%,transparent)]'
              : 'h-20 w-20 bg-current/10',
          )}
        >
          <Trophy className={premio ? 'h-16 w-16' : 'h-10 w-10'} />
        </div>
        <p className="text-[13px] font-bold uppercase tracking-widest text-warning">Resultado final</p>
        {classificado && eu ? (
          <>
            <h1 className="font-display text-3xl font-extrabold leading-tight">
              Você ficou em {ordinal(eu.posicao as number)} lugar{premio ? '!' : ''}
            </h1>
            <p className="text-[15px] leading-relaxed opacity-85">
              Nota {fmt1(eu.nota ?? 0)}.
              {!premio && ' Obrigado por rodar com a gente nesta campanha.'}
            </p>
          </>
        ) : (
          <>
            <h1 className="font-display text-3xl font-extrabold leading-tight">Esta campanha terminou</h1>
            <p className="text-[15px] leading-relaxed opacity-85">
              {eu ? 'Você não chegou a entrar no ranking final.' : 'Você não participou do ranking.'} Obrigado por rodar com a gente.
            </p>
          </>
        )}

        {premio && eu && (
          <div className="mt-1.5 flex w-full items-center gap-3.5 rounded-3xl border border-current/15 bg-current/10 p-4 text-left">
            <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-2xl bg-card text-card-foreground">
              {premioFaixa?.temFoto ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={urlFotoPremio(c.id, premioFaixa.id)}
                  alt={`Foto do prêmio: ${premio.descricao}`}
                  width={64}
                  height={64}
                  className="h-16 w-16 object-cover"
                />
              ) : premio.tipo === 'dinheiro' ? (
                <Paid className="h-9 w-9" />
              ) : (
                <Gift className="h-9 w-9" />
              )}
            </div>
            <div className="flex min-w-0 flex-col gap-1">
              <span className="text-xs font-bold uppercase tracking-wider text-warning">Seu prêmio</span>
              <span className="break-words text-lg font-extrabold leading-tight">{premio.descricao}</span>
              <span className="inline-flex items-center gap-1.5 text-[13px] font-bold text-warm-2">
                {premio.tipo === 'objeto' && eu.entregueEm && <Check className="h-3.5 w-3.5" />}
                {statusPremio(eu, c.dataPremio ?? null)}
              </span>
            </div>
          </div>
        )}

        {lista.length > 0 && (
          <ol className="w-full overflow-hidden rounded-3xl bg-card py-1.5 text-left text-card-foreground" aria-label="Classificação final">
            {lista.map((l) => (
              <li key={l.posicao} className={cn('flex items-center gap-2.5 px-4 py-2.5', l.souEu && 'bg-warning/20')}>
                <span className="tabular flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-secondary text-xs font-extrabold text-secondary-foreground">{l.posicao}</span>
                <span className="min-w-0 flex-1 break-words text-sm font-bold">{l.souEu ? 'Você' : l.nome}</span>
                <span className="tabular text-sm font-extrabold">{fmt1(l.nota)}</span>
              </li>
            ))}
            {euForaLista && eu && (
              <li className="flex items-center gap-2.5 border-t border-dashed border-border bg-warning/20 px-4 py-2.5">
                <span className="tabular flex h-7 min-w-7 shrink-0 items-center justify-center rounded-full bg-secondary px-1 text-xs font-extrabold text-secondary-foreground">{eu.posicao}</span>
                <span className="min-w-0 flex-1 text-sm font-bold">Você · {ordinal(eu.posicao as number)}</span>
                <span className="tabular text-sm font-extrabold">{fmt1(eu.nota ?? 0)}</span>
              </li>
            )}
          </ol>
        )}
        {premio && (
          <p className="text-xs opacity-75">
            {textoRodapePremio(c.dataPremio ?? null)}
          </p>
        )}
      </div>
    </main>
  );
}

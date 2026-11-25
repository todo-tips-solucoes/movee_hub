'use client';

// campanhas do motorista (W3a) — detalhe ("HubDetalhe"/"HubEncerrada" do
// protótipo aprovado). Em andamento/apurando: KPIs + ranking paginado em abas
// + "Regras travadas". Encerrada: vencedores com entrega de objeto e planilha
// de prêmios em dinheiro. Rascunho vai para o formulário.

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { AlertCircle, Download, FileSpreadsheet, Gift, Lock, Trophy, Users, Wallet, Percent } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { PaginationControls } from '@/components/pagination-controls';
import { CampanhaCancelarDialog } from '@/components/hub/campanha-cancelar-dialog';
import { CampanhaEntregaDialog } from '@/components/hub/campanha-entrega-dialog';
import { CampanhaVisibilidade } from '@/components/hub/campanha-visibilidade';
import { CampanhaSituacaoBadge, CampanhaTipoBadge, CampanhaVisibilidadeBadge } from '@/components/hub/status-badge';
import { EmptyState } from '@/components/hub/empty-state';
import { KpiCard } from '@/components/hub/kpi-card';
import { ListSkeleton } from '@/components/hub/table-skeleton';
import { useHubAuth } from '@/contexts/hub-auth-context';
import { LARGURA_LISTA } from '@/lib/hub/larguras';
import {
  CampanhaApiError,
  baixarPlanilhaPremios,
  baixarRankingCsv,
  cancelarCampanha,
  fecharCampanha,
  mensagemAdiados,
  obterCampanha,
  obterRanking,
  obterVencedores,
  registrarEntrega,
  atualizarVisibilidadeCampanha,
} from '@/lib/hub/campanhas-api';
import { ROTULO_FAMILIA } from '@/lib/hub/adiantamento-categorias';
import {
  diasAte,
  type CampanhaDetalhe,
  type LinhaRanking,
  type SituacaoRanking,
  type Vencedor,
} from '@/lib/hub/campanhas-dto';
import {
  MOTIVO_CORTE_LABEL,
  formatCentavos,
  formatDataHora,
  formatDiaMes,
  formatFracao,
  formatNota,
  fechamentoExtrato,
  hojeSP,
  podeFecharAntecipado,
  resumoCriterios,
  resumoPesos,
  rotuloFaixa,
} from '@/lib/hub/campanhas-form';
import { cn } from '@/lib/utils';

const POR_PAGINA = 50;

const ABAS_RANKING: { id: SituacaoRanking; rotulo: string; chave: 'classificado' | 'abaixoCorte' | 'semMinimo' | 'semModal' }[] = [
  { id: 'classificado', rotulo: 'Classificados', chave: 'classificado' },
  { id: 'abaixo_corte', rotulo: 'Abaixo do corte', chave: 'abaixoCorte' },
  { id: 'sem_minimo', rotulo: 'Sem mínimo', chave: 'semMinimo' },
  { id: 'sem_modal', rotulo: 'Sem modal', chave: 'semModal' },
];

// Extrato: sem "Abaixo do corte" (não há corte de nota) — o que sobra é "Sem o mínimo" de turnos.
const ABAS_EXTRATO = ABAS_RANKING.filter((a) => a.id !== 'abaixo_corte').map((a) =>
  a.id === 'sem_minimo' ? { ...a, rotulo: 'Sem o mínimo' } : a
);

const MEDALHA = [
  'bg-warning/25 text-foreground', // ouro
  'bg-muted text-foreground', // prata
  'bg-orange-200 text-orange-950 dark:bg-orange-900/40 dark:text-orange-100', // bronze
];

function Posicao({ n }: { n: number | null }) {
  if (n === null) return <span aria-label="sem posição">—</span>;
  return (
    <span
      className={cn(
        'inline-flex size-7 items-center justify-center rounded-full text-xs font-bold',
        n <= 3 ? MEDALHA[n - 1] : 'bg-primary/10 text-foreground'
      )}
    >
      {n}
    </span>
  );
}

function Variacao({ atual, anterior, vazio = null }: { atual: number | null; anterior: number | null; vazio?: React.ReactNode }) {
  if (atual === null || anterior === null || atual === anterior) return <>{vazio}</>;
  const subiu = atual < anterior;
  return (
    <span className={cn('ml-1 text-xs', subiu ? 'text-success' : 'text-destructive')}>
      <span aria-hidden="true">{subiu ? '▲' : '▼'}</span>
      <span className="sr-only">{subiu ? 'subiu' : 'caiu'} </span>
      {Math.abs(anterior - atual)}
    </span>
  );
}

function Pendente() {
  return <div className="rounded-lg border p-8 text-center text-sm text-muted-foreground" role="status">Carregando…</div>;
}

function KpisExtrato({ c }: { c: CampanhaDetalhe }) {
  const { classificado, semMinimo, semModal, turnos, turnosValidos, valorCentavos } = c.contagem;
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <KpiCard label="Participantes" value={classificado + semMinimo + semModal} icon={Users} />
      <KpiCard label="Classificados" value={classificado} icon={Trophy} />
      <KpiCard
        label="Turnos válidos"
        value={turnos > 0 ? formatFracao(turnosValidos / turnos) : '—'}
        icon={Percent}
      />
      <KpiCard label="Valor somado" value={formatCentavos(valorCentavos)} icon={Wallet} />
    </div>
  );
}

function RankingSecao({ campanha }: { campanha: CampanhaDetalhe }) {
  const [aba, setAba] = useState<SituacaoRanking>('classificado');
  const [pagina, setPagina] = useState(1);
  const [linhas, setLinhas] = useState<LinhaRanking[]>([]);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const extrato = campanha.tipo === 'extrato';
  const abas = extrato ? ABAS_EXTRATO : ABAS_RANKING;
  const total = campanha.contagem[abas.find((a) => a.id === aba)!.chave];

  useEffect(() => {
    let vivo = true;
    obterRanking(campanha.id, aba, pagina)
      .then((r) => {
        if (!vivo) return;
        setLinhas(r.itens);
        setErro(null);
      })
      .catch((e) => {
        if (vivo) setErro(e instanceof CampanhaApiError ? e.message : 'Não foi possível carregar o ranking.');
      })
      .finally(() => {
        if (vivo) setCarregando(false);
      });
    return () => {
      vivo = false;
    };
  }, [campanha.id, aba, pagina]);

  const classificados = aba === 'classificado';
  return (
    <section aria-labelledby="rk" className="flex min-w-0 flex-col gap-3 rounded-lg border bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="rk" className="font-heading text-base font-semibold">Ranking</h2>
        <div role="tablist" aria-label="Lista" className="flex flex-wrap gap-2">
          {abas.map((a) => (
            <button
              key={a.id}
              type="button"
              role="tab"
              aria-selected={aba === a.id}
              onClick={() => {
                setAba(a.id);
                setPagina(1);
                setCarregando(true);
              }}
              className={cn(
                'min-h-11 rounded-full border px-3 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-9',
                aba === a.id ? 'border-primary bg-primary/10 text-foreground' : 'text-muted-foreground hover:bg-muted/50'
              )}
            >
              {a.rotulo}
              {a.id !== 'classificado' && ` · ${campanha.contagem[a.chave]}`}
            </button>
          ))}
        </div>
      </div>

      {carregando ? (
        <ListSkeleton label="Carregando ranking..." linhas={5} />
      ) : erro ? (
        <p role="alert" className="flex items-center gap-2 text-sm font-medium text-destructive">
          <AlertCircle className="size-4 shrink-0" aria-hidden="true" />
          {erro}
        </p>
      ) : linhas.length === 0 ? (
        <EmptyState icone={Trophy} titulo="Ninguém nesta lista" dica="O ranking é atualizado a cada importação de dados." />
      ) : (
        <>
          <Table>
            <TableHeader>
              {extrato ? (
                <TableRow>
                  <TableHead scope="col">Pos.</TableHead>
                  <TableHead scope="col">Motorista</TableHead>
                  <TableHead scope="col" className="text-right">Turnos válidos</TableHead>
                  <TableHead scope="col" className="text-right">Trabalhados</TableHead>
                  <TableHead scope="col" className="text-right">Valor somado</TableHead>
                  <TableHead scope="col">Variação</TableHead>
                </TableRow>
              ) : (
              <TableRow>
                <TableHead scope="col">{classificados ? '#' : 'Pos.'}</TableHead>
                <TableHead scope="col">Motorista</TableHead>
                <TableHead scope="col" className="text-right">Aceitação</TableHead>
                <TableHead scope="col" className="text-right">Conclusão</TableHead>
                <TableHead scope="col" className="text-right">Tempo</TableHead>
                <TableHead scope="col" className="text-right">Pedidos</TableHead>
                <TableHead scope="col" className="text-right">Turnos</TableHead>
                <TableHead scope="col" className="text-right">{aba === 'abaixo_corte' ? 'Nota se passasse' : 'Nota'}</TableHead>
                {aba === 'abaixo_corte' && <TableHead scope="col">Motivo</TableHead>}
              </TableRow>
              )}
            </TableHeader>
            <TableBody>
              {linhas.map((l) => extrato ? (
                <TableRow key={l.entregadorId}>
                  <TableCell className="whitespace-nowrap"><Posicao n={l.posicao} /></TableCell>
                  <TableCell className="whitespace-nowrap font-medium">
                    {l.nome}
                    {l.modal && <span className="ml-2 text-xs font-normal text-muted-foreground">{l.modal}</span>}
                  </TableCell>
                  <TableCell className="text-right font-mono">{l.turnosValidos ?? '—'}</TableCell>
                  <TableCell className="text-right font-mono">{l.turnos}</TableCell>
                  <TableCell className="text-right font-mono font-semibold">{formatCentavos(l.valorCentavos)}</TableCell>
                  <TableCell className="whitespace-nowrap">
                    <Variacao atual={classificados ? l.posicao : null} anterior={l.posicaoAnterior} vazio="—" />
                  </TableCell>
                </TableRow>
              ) : (
                <TableRow key={l.entregadorId}>
                  <TableCell className="whitespace-nowrap">
                    <Posicao n={classificados ? l.posicao : null} />
                    {classificados && <Variacao atual={l.posicao} anterior={l.posicaoAnterior} />}
                  </TableCell>
                  <TableCell className="whitespace-nowrap font-medium">
                    {l.nome}
                    {l.modal && <span className="ml-2 text-xs font-normal text-muted-foreground">{l.modal}</span>}
                  </TableCell>
                  <TableCell className="text-right font-mono">{formatFracao(l.aceitacao)}</TableCell>
                  <TableCell className="text-right font-mono">{formatFracao(l.conclusao)}</TableCell>
                  <TableCell className="text-right font-mono">{formatFracao(l.tempo)}</TableCell>
                  <TableCell className="text-right font-mono">{l.pedidos ?? '—'}</TableCell>
                  <TableCell className="text-right font-mono">{l.turnos}</TableCell>
                  <TableCell className="text-right font-mono font-semibold">
                    {aba === 'abaixo_corte'
                      ? `${formatNota(l.notaHipotetica)}${l.posicaoHipotetica ? ` (${l.posicaoHipotetica}º)` : ''}`
                      : formatNota(l.nota)}
                  </TableCell>
                  {aba === 'abaixo_corte' && (
                    <TableCell className="min-w-48 whitespace-normal text-xs">
                      {l.motivoCorte.map((m) => MOTIVO_CORTE_LABEL[m] ?? m).join('; ') || '—'}
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <p className="text-xs text-muted-foreground">O hub vê o nome completo; o app mostra só nome e inicial.</p>
          <PaginationControls
            currentPage={pagina}
            totalPages={Math.max(1, Math.ceil(total / POR_PAGINA))}
            recordsPerPage={POR_PAGINA}
            totalRecords={total}
            onPageChange={(p) => {
              setCarregando(true);
              setPagina(p);
            }}
          />
        </>
      )}
    </section>
  );
}

function VencedoresSecao({
  campanha,
  podeEntregar,
  onMudou,
}: {
  campanha: CampanhaDetalhe;
  podeEntregar: boolean;
  onMudou: () => void;
}) {
  const [itens, setItens] = useState<Vencedor[] | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [entregando, setEntregando] = useState<Vencedor | null>(null);

  const carregar = useCallback(() => {
    obterVencedores(campanha.id)
      .then((v) => {
        setItens(v);
        setErro(null);
      })
      .catch((e) => setErro(e instanceof CampanhaApiError ? e.message : 'Não foi possível carregar os vencedores.'));
  }, [campanha.id]);

  useEffect(() => {
    carregar();
  }, [carregar]);

  function statusDe(v: Vencedor): string {
    if (v.premio.tipo === 'objeto') {
      return v.entregueEm ? `Entregue ${formatDiaMes(v.entregueEm)}${v.entreguePor ? ` · ${v.entreguePor}` : ''}` : 'Pendente';
    }
    if (v.semCnpj) return 'Sem CNPJ: fora da planilha';
    return v.exportadoEm ? `Na planilha de ${formatDiaMes(v.exportadoEm)}` : 'Aguardando a planilha';
  }
  const ok = (v: Vencedor) => (v.premio.tipo === 'objeto' ? !!v.entregueEm : !v.semCnpj && !!v.exportadoEm);

  return (
    <section aria-labelledby="vc" className="flex min-w-0 flex-col gap-3 rounded-lg border bg-card p-4">
      <h2 id="vc" className="font-heading text-base font-semibold">Vencedores</h2>
      {erro ? (
        <p role="alert" className="flex items-center gap-2 text-sm font-medium text-destructive">
          <AlertCircle className="size-4 shrink-0" aria-hidden="true" />
          {erro}
        </p>
      ) : itens === null ? (
        <Pendente />
      ) : itens.length === 0 ? (
        <EmptyState icone={Trophy} titulo="Nenhum vencedor" dica="Nenhum motorista classificado caiu numa faixa de prêmio." />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">#</TableHead>
              <TableHead scope="col">Motorista</TableHead>
              {campanha.tipo === 'nota' && <TableHead scope="col" className="text-right">Nota</TableHead>}
              <TableHead scope="col">Prêmio</TableHead>
              <TableHead scope="col">Entrega</TableHead>
              <TableHead scope="col"><span className="sr-only">Ação</span></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {itens.map((v) => (
              <TableRow key={v.posicao}>
                <TableCell><Posicao n={v.posicao} /></TableCell>
                <TableCell className="whitespace-nowrap font-medium">{v.nome}</TableCell>
                {campanha.tipo === 'nota' && <TableCell className="text-right font-mono">{formatNota(v.nota)}</TableCell>}
                <TableCell className="whitespace-normal">
                  {v.premio.descricao}
                  {v.premio.tipo === 'dinheiro' && <span className="text-xs text-muted-foreground"> · {formatCentavos(v.premio.valorCentavos)}</span>}
                </TableCell>
                <TableCell className="whitespace-normal">
                  <span className={cn('text-sm font-medium', ok(v) ? 'text-success' : 'text-warning-strong')}>{statusDe(v)}</span>
                  {v.observacao && <span className="block text-xs text-muted-foreground">{v.observacao}</span>}
                </TableCell>
                <TableCell className="text-right">
                  {podeEntregar && v.premio.tipo === 'objeto' && !v.entregueEm && (
                    <Button size="sm" variant="outline" className="min-h-11 sm:min-h-8" onClick={() => setEntregando(v)}>
                      Marcar como entregue
                      <span className="sr-only"> — {v.nome}</span>
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <CampanhaEntregaDialog
        open={entregando !== null}
        onOpenChange={(o) => !o && setEntregando(null)}
        descricao={entregando ? `${entregando.nome} — ${entregando.premio.descricao}` : ''}
        onRegistrar={async (obs) => {
          if (!entregando) return;
          await registrarEntrega(campanha.id, entregando.posicao, obs || undefined);
          toast.success('Entrega registrada.');
          setEntregando(null);
          carregar();
          onMudou();
        }}
      />
    </section>
  );
}

function RegrasTravadas({ c }: { c: CampanhaDetalhe }) {
  const publico = [
    c.pracas === null ? 'Todas as praças' : c.pracas.join(', '),
    c.turnos === null ? 'todos os turnos' : `${c.turnos.join(', ')}`,
    c.modais === null ? 'todos os modais' : c.modais.join(', '),
    `mín. ${c.minTurnos} turnos${c.tipo === 'extrato' ? (c.minTurnosBase === 'validos' ? ' válidos' : ' trabalhados') : ''}`,
  ].join(' · ');
  const extrato = c.tipo === 'extrato';
  return (
    <aside aria-labelledby="cfg" className="flex flex-col gap-3 rounded-lg border bg-card p-4 lg:w-80 lg:shrink-0">
      <div className="flex items-center gap-2">
        <Lock className="size-4 text-muted-foreground" aria-hidden="true" />
        <h2 id="cfg" className="font-heading text-base font-semibold">Regras travadas</h2>
      </div>
      {c.lancadaEm && (
        <p className="text-xs text-muted-foreground">
          Lançada em {formatDataHora(c.lancadaEm)}
          {c.lancadaPor ? ` por ${c.lancadaPor}` : ''}. Imutável desde então.
        </p>
      )}
      <dl className="flex flex-col gap-2 text-sm">
        <div><dt className="text-xs font-medium text-muted-foreground">Público</dt><dd>{publico}</dd></div>
        {extrato ? (
          <>
            <div><dt className="text-xs font-medium text-muted-foreground">Critério do turno</dt><dd>{resumoCriterios(c.cortes)}</dd></div>
            <div>
              <dt className="text-xs font-medium text-muted-foreground">Valor do turno</dt>
              <dd>{(c.categorias ?? []).map((x) => ROTULO_FAMILIA[x] ?? x).join(', ') || '—'}</dd>
            </div>
            <div><dt className="text-xs font-medium text-muted-foreground">Desempate</dt><dd>Maior valor somado, depois mais turnos válidos</dd></div>
          </>
        ) : (
          <>
            <div><dt className="text-xs font-medium text-muted-foreground">Nota</dt><dd>{resumoPesos(c.pesos, c.cortes)}</dd></div>
            <div><dt className="text-xs font-medium text-muted-foreground">Desempate</dt><dd>Pedidos concluídos, depois tempo disponível</dd></div>
          </>
        )}
        <div>
          <dt className="text-xs font-medium text-muted-foreground">Prêmios</dt>
          <dd>{c.premios.map((p) => `${rotuloFaixa(p.posicaoDe, p.posicaoAte)} ${p.descricao}`).join(' · ') || '—'}</dd>
        </div>
        <div><dt className="text-xs font-medium text-muted-foreground">Aviso aos motoristas</dt><dd>{c.avisar ? 'Ligado (início e resultado)' : 'Desligado'}</dd></div>
      </dl>
    </aside>
  );
}

export default function CampanhaDetalhePage() {
  const params = useParams<{ id: string }>();
  const id = Number(params.id);
  const router = useRouter();
  const { permissoes } = useHubAuth();
  const podeGerir = permissoes.includes('campanhas.gerir');
  const podeEntregar = permissoes.includes('campanhas.entregar');
  const [c, setC] = useState<CampanhaDetalhe | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [acaoErro, setAcaoErro] = useState<string | null>(null);
  const [cancelando, setCancelando] = useState(false);
  const [salvandoVis, setSalvandoVis] = useState(false);
  // Gerar a planilha carimba `exportado_em`; a seção de vencedores busca a própria lista e só
  // reagia ao id da campanha (achado do E2E W4). Mudar a key a remonta e recarrega.
  const [versaoVencedores, setVersaoVencedores] = useState(0);
  const hoje = hojeSP();

  const carregar = useCallback(() => {
    obterCampanha(id)
      .then((d) => {
        if (d.situacao === 'rascunho') router.replace(`/hub/dashboard/campanhas/${id}/editar`);
        else setC(d);
        setErro(null);
      })
      .catch((e) => setErro(e instanceof CampanhaApiError ? e.message : 'Não foi possível carregar a campanha.'));
  }, [id, router]);

  useEffect(() => {
    carregar();
  }, [carregar]);

  async function acao(fn: () => Promise<void>) {
    setAcaoErro(null);
    try {
      await fn();
    } catch (e) {
      setAcaoErro(e instanceof CampanhaApiError ? e.message : 'Não foi possível concluir a ação.');
    }
  }

  // Otimista: troca na hora e reverte (com toast) se a API recusar.
  async function alternarVisibilidade(visivel: boolean) {
    setSalvandoVis(true);
    setC((x) => (x ? { ...x, visivelApp: visivel } : x));
    try {
      const r = await atualizarVisibilidadeCampanha(id, visivel);
      setC((x) => (x ? { ...x, visivelApp: r.visivelApp } : x));
    } catch (e) {
      setC((x) => (x ? { ...x, visivelApp: !visivel } : x));
      toast.error(e instanceof CampanhaApiError ? e.message : 'Não foi possível alterar a visibilidade no app.');
    } finally {
      setSalvandoVis(false);
    }
  }

  const raiz = `mx-auto flex w-full ${LARGURA_LISTA} flex-col gap-4 p-4 sm:p-6 lg:p-8`;
  if (erro) {
    return (
      <div className={raiz}>
        <p role="alert" className="flex items-center gap-2 text-sm font-medium text-destructive">
          <AlertCircle className="size-4" aria-hidden="true" />
          {erro}
        </p>
        <Link href="/hub/dashboard/campanhas" className="text-sm font-medium text-primary hover:underline">Voltar às campanhas</Link>
      </div>
    );
  }
  if (!c) {
    return (
      <div className={raiz}>
        <ListSkeleton label="Carregando campanha..." />
      </div>
    );
  }

  const ativa = c.situacao === 'em_andamento' || c.situacao === 'apurando';
  const podeCancelar = podeGerir && (c.situacao === 'agendada' || ativa);
  const dias = diasAte(c.dataFim, hoje);
  const sub = [
    `${formatDiaMes(c.dataInicio)} a ${formatDiaMes(c.dataFim)}`,
    c.situacao === 'em_andamento' ? `faltam ${dias} dias` : null,
    c.tipo === 'extrato' && ativa && fechamentoExtrato(c.dataFim) ? `fecha sozinha em ${fechamentoExtrato(c.dataFim)}` : null,
    c.dadosAte ? `dados até ${formatDiaMes(c.dadosAte)}` : null,
    c.fechadaEm ? `resultado final congelado em ${formatDataHora(c.fechadaEm)}` : null,
  ].filter(Boolean).join(' · ');
  const temDinheiro = c.premios.some((p) => p.tipo === 'dinheiro');

  return (
    <div className={raiz}>
      <nav aria-label="Trilha" className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
        <Link href="/hub/dashboard/campanhas" className="font-medium text-primary hover:underline">Campanhas</Link>
        <span aria-hidden="true">/</span>
        <span>{c.nome}</span>
      </nav>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="font-heading text-xl font-semibold sm:text-2xl">{c.nome}</h1>
            <CampanhaSituacaoBadge situacao={c.situacao} />
            <CampanhaTipoBadge tipo={c.tipo} />
            <CampanhaVisibilidadeBadge visivel={c.visivelApp} />
          </div>
          <p className="mt-1 text-sm text-muted-foreground">{sub}</p>
          {c.descricao && <p className="mt-2 max-w-3xl text-sm">{c.descricao}</p>}
        </div>
        <div className="flex flex-wrap gap-2">
          {(ativa || c.situacao === 'encerrada') && (
            <Button variant="outline" className="min-h-11 gap-1.5 sm:min-h-8" onClick={() => acao(() => baixarRankingCsv(c.id))}>
              <Download className="size-4" aria-hidden="true" />
              Exportar CSV
            </Button>
          )}
          {c.situacao === 'encerrada' && podeEntregar && temDinheiro && (
            <Button className="min-h-11 gap-1.5 sm:min-h-8" onClick={() => acao(async () => {
              const adiados = await baixarPlanilhaPremios(c.id);
              toast.success('Planilha gerada. Entregue ao financeiro para importar no Lançamento externo.');
              if (adiados > 0) toast.warning(mensagemAdiados(adiados), { duration: 12000 });
              setVersaoVencedores((v) => v + 1);
              carregar();
            })}>
              <FileSpreadsheet className="size-4" aria-hidden="true" />
              Baixar planilha de prêmios em dinheiro
            </Button>
          )}
          {podeGerir && podeFecharAntecipado(c.situacao, c.dataFim, hoje) && (
            <Button variant="outline" className="min-h-11 sm:min-h-8" onClick={() => acao(async () => {
              await fecharCampanha(c.id);
              toast.success('Campanha fechada.');
              carregar();
            })}>
              Fechar com os dados que existem
            </Button>
          )}
          {podeCancelar && (
            <Button variant="outline" className="min-h-11 text-destructive sm:min-h-8" onClick={() => setCancelando(true)}>
              Cancelar campanha
            </Button>
          )}
        </div>
      </div>

      {c.situacao === 'encerrada' && podeEntregar && temDinheiro && (
        <p className="text-sm text-muted-foreground">Importe em Lançamento externo escolhendo o tipo Prêmio de campanha.</p>
      )}

      {acaoErro && (
        <p role="alert" className="flex items-start gap-2 rounded-md bg-destructive/10 px-3 py-2 text-sm font-medium text-destructive">
          <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          {acaoErro}
        </p>
      )}

      {c.situacao === 'cancelada' && (
        <div role="note" className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm">
          <strong>Cancelada{c.canceladaEm ? ` em ${formatDataHora(c.canceladaEm)}` : ''}.</strong>{' '}
          Motivo: {c.motivoCancelamento ?? '—'}
        </div>
      )}
      {c.situacao === 'agendada' && (
        <p className="text-sm text-muted-foreground" role="status">
          A campanha começa em {formatDiaMes(c.dataInicio, true)}. O ranking aparece depois da primeira importação de dados.
        </p>
      )}

      {podeGerir && c.situacao !== 'cancelada' && (
        <section aria-label="Visibilidade no app" className="rounded-lg border bg-card p-4">
          <CampanhaVisibilidade visivel={c.visivelApp} onChange={(v) => void alternarVisibilidade(v)} disabled={salvandoVis} />
        </section>
      )}

      {(ativa || c.situacao === 'encerrada') && c.tipo === 'extrato' && <KpisExtrato c={c} />}
      {(ativa || c.situacao === 'encerrada') && c.tipo === 'nota' && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <KpiCard label="No ranking" value={c.contagem.classificado} icon={Trophy} />
          <KpiCard label="Abaixo do corte" value={c.contagem.abaixoCorte} icon={AlertCircle} />
          <KpiCard label="Sem o mínimo de turnos" value={c.contagem.semMinimo} icon={AlertCircle} />
          {c.situacao === 'encerrada' ? (
            <KpiCard label="Prêmios a entregar" value={c.premiosPendentes} icon={Gift} />
          ) : (
            <KpiCard label="Nota de corte do top 10" value={formatNota(c.notaCorteTop10)} icon={Trophy} />
          )}
        </div>
      )}

      <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
        <div className="flex min-w-0 flex-1 flex-col gap-4">
          {c.situacao === 'encerrada' && <VencedoresSecao key={versaoVencedores} campanha={c} podeEntregar={podeEntregar} onMudou={carregar} />}
          {ativa && <RankingSecao campanha={c} />}
        </div>
        <RegrasTravadas c={c} />
      </div>

      <CampanhaCancelarDialog
        open={cancelando}
        onOpenChange={setCancelando}
        nome={c.nome}
        onCancelar={async (motivo) => {
          await cancelarCampanha(c.id, motivo);
          toast.success('Campanha cancelada.');
          setCancelando(false);
          carregar();
        }}
      />
    </div>
  );
}

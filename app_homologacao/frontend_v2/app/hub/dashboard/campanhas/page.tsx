'use client';

// campanhas do motorista (W3a) — lista com filtro por situação ("Main" do
// protótipo aprovado). Carrega todas de uma vez (teto de 10 ativas por
// entidade + histórico) para que as abas mostrem a contagem.

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { AlertCircle, Plus, Trophy } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { EmptyState } from '@/components/hub/empty-state';
import { PageHeader } from '@/components/hub/page-header';
import { ListSkeleton } from '@/components/hub/table-skeleton';
import { CampanhaExcluirRascunho } from '@/components/hub/campanha-excluir-dialog';
import { CampanhaSituacaoBadge, CampanhaTipoBadge, CampanhaVisibilidadeBadge } from '@/components/hub/status-badge';
import { useHubAuth } from '@/contexts/hub-auth-context';
import { LARGURA_LISTA } from '@/lib/hub/larguras';
import { CampanhaApiError, listarCampanhas } from '@/lib/hub/campanhas-api';
import { SITUACAO_LABELS, mostraSeloVisibilidade, type CampanhaItem, type SituacaoCampanha } from '@/lib/hub/campanhas-dto';
import {
  acaoDaSituacao,
  escopoTexto,
  formatDiaMes,
  formatPeriodo,
  hojeSP,
  participantesTexto,
  resumoPesos,
} from '@/lib/hub/campanhas-form';
import { cn } from '@/lib/utils';

type Aba = 'todas' | SituacaoCampanha;
const ABAS: Aba[] = ['todas', 'em_andamento', 'agendada', 'apurando', 'rascunho', 'encerrada', 'cancelada'];
const ROTULO_ABA: Record<Aba, string> = {
  todas: 'Todas',
  em_andamento: 'Em andamento',
  agendada: 'Agendadas',
  apurando: 'Apurando',
  rascunho: 'Rascunhos',
  encerrada: 'Encerradas',
  cancelada: 'Canceladas',
};

export default function CampanhasPage() {
  const { permissoes } = useHubAuth();
  const podeGerir = permissoes.includes('campanhas.gerir');
  const [itens, setItens] = useState<CampanhaItem[]>([]);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [aba, setAba] = useState<Aba>('todas');
  const hoje = hojeSP();

  const buscar = useCallback(async () => {
    setCarregando(true);
    setErro(null);
    try {
      setItens(await listarCampanhas());
    } catch (e) {
      setErro(e instanceof CampanhaApiError ? e.message : 'Não foi possível carregar as campanhas.');
      setItens([]);
    } finally {
      setCarregando(false);
    }
  }, []);

  useEffect(() => {
    void buscar();
  }, [buscar]);

  const contagem = useMemo(() => {
    const c: Record<string, number> = { todas: itens.length };
    for (const i of itens) c[i.situacao] = (c[i.situacao] ?? 0) + 1;
    return c;
  }, [itens]);
  const visiveis = aba === 'todas' ? itens : itens.filter((i) => i.situacao === aba);
  const dadosAte = itens.map((i) => i.dadosAte).filter((d): d is string => !!d).sort().pop();

  const botaoNova = podeGerir && (
    <Link
      href="/hub/dashboard/campanhas/nova"
      className="inline-flex min-h-11 items-center gap-1.5 rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-8"
    >
      <Plus className="size-4" aria-hidden="true" />
      Nova campanha
    </Link>
  );

  return (
    <div className={`mx-auto flex w-full ${LARGURA_LISTA} flex-col gap-4 p-4 sm:p-6 lg:p-8`}>
      <PageHeader
        titulo="Campanhas"
        subtitulo={`Rankings com data de início e fim, calculados sobre os indicadores da Performance.${dadosAte ? ` Dados atualizados até ${formatDiaMes(dadosAte)}.` : ''}`}
      >
        {botaoNova}
      </PageHeader>

      <div role="tablist" aria-label="Filtrar por situação" className="flex flex-wrap gap-2">
        {ABAS.filter((a) => a === 'todas' || (contagem[a] ?? 0) > 0 || aba === a).map((a) => (
          <button
            key={a}
            type="button"
            role="tab"
            aria-selected={aba === a}
            onClick={() => setAba(a)}
            className={cn(
              'min-h-11 rounded-full border px-4 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-9',
              aba === a ? 'border-primary bg-primary/10 text-foreground' : 'text-muted-foreground hover:bg-muted/50'
            )}
          >
            {ROTULO_ABA[a]} · {contagem[a] ?? 0}
          </button>
        ))}
      </div>

      {carregando ? (
        <ListSkeleton label="Carregando campanhas..." />
      ) : erro ? (
        <div role="alert" className="flex flex-col items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-10 text-center">
          <AlertCircle className="size-8 text-destructive" aria-hidden="true" />
          <p className="text-sm font-medium text-destructive">{erro}</p>
          <Button size="sm" variant="outline" className="min-h-11 sm:min-h-8" onClick={() => void buscar()}>
            Tentar novamente
          </Button>
        </div>
      ) : visiveis.length === 0 ? (
        <EmptyState
          icone={Trophy}
          titulo={aba === 'todas' ? 'Nenhuma campanha ainda' : `Nenhuma campanha ${SITUACAO_LABELS[aba].toLowerCase()}`}
          dica="Crie uma campanha para o ranking dos motoristas."
        >
          {podeGerir && aba === 'todas' && botaoNova}
        </EmptyState>
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Campanha</TableHead>
                <TableHead>Período</TableHead>
                <TableHead>Indicadores</TableHead>
                <TableHead>Participantes</TableHead>
                <TableHead>Situação</TableHead>
                <TableHead>App</TableHead>
                <TableHead className="text-right">
                  <span className="sr-only">Ações</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visiveis.map((c) => {
                const acao = acaoDaSituacao(c.situacao);
                const href = `/hub/dashboard/campanhas/${c.id}${acao.editar ? '/editar' : ''}`;
                return (
                  <TableRow key={c.id}>
                    <TableCell className="max-w-[320px] whitespace-normal">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{c.nome}</span>
                        <CampanhaTipoBadge tipo={c.tipo} />
                      </div>
                      <div className="text-xs text-muted-foreground">{escopoTexto(c)}</div>
                    </TableCell>
                    <TableCell className="whitespace-nowrap">{formatPeriodo(c.dataInicio, c.dataFim)}</TableCell>
                    <TableCell className="max-w-[260px] whitespace-normal text-xs">{c.tipo === 'extrato' ? 'Valor somado dos turnos válidos' : resumoPesos(c.pesos)}</TableCell>
                    <TableCell className="max-w-[220px] whitespace-normal text-xs">{participantesTexto(c, hoje)}</TableCell>
                    <TableCell>
                      <CampanhaSituacaoBadge situacao={c.situacao} />
                    </TableCell>
                    <TableCell>
                      {mostraSeloVisibilidade(c.situacao) ? <CampanhaVisibilidadeBadge visivel={c.visivelApp} /> : <span aria-label="não se aplica">—</span>}
                    </TableCell>
                    <TableCell className="text-right">
                      {podeGerir && c.situacao === 'rascunho' && (
                        <CampanhaExcluirRascunho id={c.id} nome={c.nome} onExcluida={() => void buscar()} />
                      )}
                      <Link
                        href={href}
                        className="inline-flex min-h-11 items-center px-2 text-sm font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-8"
                      >
                        {acao.rotulo}
                        <span className="sr-only"> — {c.nome}</span>
                      </Link>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

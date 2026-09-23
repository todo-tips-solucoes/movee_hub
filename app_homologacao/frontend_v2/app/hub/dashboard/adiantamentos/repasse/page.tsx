'use client';

// adiantamento-motorista — app/hub/dashboard/adiantamentos/repasse/page.tsx
// (tasks.md 7.8, H14): remanescente semanal por motorista, exportação CSV e
// fechamento de apuração (D-23: recusa com `APURACAO_COM_PENDENCIAS`).
//
// Divergência do protótipo H14 (Constitution VI): não existe endpoint que
// calcule "o período de apuração vigente" a partir de `apuracaoDiaInicio`/
// `apuracaoDataBase` — `GET /repasse` exige o `periodo` (data de início) na
// query, sem default no servidor. Reimplementar esse cálculo de dia-da-semana
// no cliente arriscaria o MESMO defeito de fuso já corrigido 2x nesta feature
// (dec-063/dec-067 nos totais, dec-108/dec-111 no driver) — em vez disso, o
// campo nasce com a data de HOJE no fuso LOCAL (`paraISO`, já usado nos
// demais filtros de data do hub — nunca `toISOString()`, que vira UTC) e o
// financeiro ajusta explicitamente, mesmo padrão de filtro de data manual já
// aceito em `pagamentos/page.tsx` (H09 "Solicitadas em").
//
// Ref: docs/specs/adiantamento-motorista/contracts/hub-api.md §Repasse;
// spec.md US6/FR-037..FR-041; prototipo H14.

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { AlertCircle, Download, Inbox, Lock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { PaginationControls } from '@/components/pagination-controls';
import { ListSkeleton } from '@/components/hub/table-skeleton';
import { EmptyState } from '@/components/hub/empty-state';
import { PageHeader } from '@/components/hub/page-header';
import { FilterBar } from '@/components/hub/filter-bar';
import { AdiantamentosAbas } from '@/components/hub/adiantamentos-abas';
import { FecharApuracaoDialog, useFecharApuracaoDialog } from '@/components/hub/adiantamento-fechar-apuracao-dialog';
import { useHubAuth } from '@/contexts/hub-auth-context';
import { useDebounce } from '@/hooks/use-debounce';
import { paraISO, inicioDaSemanaApuracao } from '@/lib/hub/periodo';
import { LARGURA_LISTA } from '@/lib/hub/larguras';
import {
  AdiantamentosApiError,
  exportarRepasseCsv,
  obterConfiguracoes,
  obterRepasse,
  type RepasseResponse,
} from '@/lib/hub/adiantamentos-api';
import { formatBRL, formatDateBR } from '@/lib/utils';

const PAGE_SIZE = 20;

/** Lógica isolada do JSX (mesmo padrão de `useContasLista`). */
export function useRepasseLista() {
  // A1 (briefing adiantamento-repasse-us6): começa VAZIO de propósito. O
  // período default é a semana de apuração configurada, e o dia em que ela
  // começa só se sabe depois de carregar a configuração — abrir em `hoje`
  // (como antes) sugeria fechar um intervalo diferente do que o motorista vê
  // em 6 dos 7 dias. `buscar()` já ignora período vazio, então nada é
  // requisitado até a configuração chegar.
  const [periodo, setPeriodoState] = useState('');
  const [busca, setBuscaState] = useState('');
  const [somenteNegativos, setSomenteNegativosState] = useState(false);
  const [page, setPage] = useState(1);
  const [dados, setDados] = useState<RepasseResponse | null>(null);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [descontos, setDescontos] = useState<{ adiantamentos: boolean; debitos: boolean } | null>(null);

  const buscaDebounced = useDebounce(busca, 300);

  const setPeriodo = useCallback((v: string) => { setPeriodoState(v); setPage(1); }, []);
  const setBusca = useCallback((v: string) => { setBuscaState(v); setPage(1); }, []);
  const setSomenteNegativos = useCallback((v: boolean) => { setSomenteNegativosState(v); setPage(1); }, []);

  const buscar = useCallback(async () => {
    if (!periodo) return;
    setCarregando(true);
    setErro(null);
    try {
      const resposta = await obterRepasse({
        periodo, busca: buscaDebounced || undefined, somenteNegativos, page, pageSize: PAGE_SIZE,
      });
      setDados(resposta);
    } catch (e) {
      setErro(e instanceof AdiantamentosApiError ? e.message : 'Não foi possível carregar o repasse.');
      setDados(null);
    } finally {
      setCarregando(false);
    }
  }, [periodo, buscaDebounced, somenteNegativos, page]);

  useEffect(() => {
    buscar();
  }, [buscar]);

  // Alinha o período inicial à semana de apuração configurada. Roda uma vez;
  // depois disso quem manda é o operador pelo seletor de data. Se a
  // configuração não tiver `apuracaoDiaInicio`, cai em `hoje` — o
  // comportamento antigo, e o gatilho da 0086 ainda recusa fechar uma janela
  // desalinhada, então o pior caso é sugerir uma data que a gravação nega.
  // Uma única leitura da configuração serve a dois propósitos: alinhar o
  // período inicial (A1) e alimentar os pills informativos de desconto.
  useEffect(() => {
    let vivo = true;
    obterConfiguracoes()
      .then((r) => {
        if (!vivo) return;
        const dia = r.vigente?.apuracaoDiaInicio;
        // Só preenche se o operador ainda não escolheu: a configuração pode
        // chegar DEPOIS de ele digitar uma data, e sobrescrever descartava a escolha.
        setPeriodoState((atual) =>
          atual || (typeof dia === 'number' ? inicioDaSemanaApuracao(new Date(), dia) : paraISO(new Date()))
        );
        if (r.vigente) {
          setDescontos({ adiantamentos: r.vigente.descontoAdiantamentos, debitos: r.vigente.descontoDebitos });
        }
      })
      // Falhar aqui não pode deixar a tela sem período: cai no comportamento
      // antigo (hoje). Os pills de desconto são informativos e simplesmente
      // não aparecem.
      .catch(() => { if (vivo) setPeriodoState((atual) => atual || paraISO(new Date())); });
    return () => { vivo = false; };
  }, []);

  const totalPaginas = Math.max(1, Math.ceil((dados?.total ?? 0) / PAGE_SIZE));

  return {
    periodo, setPeriodo, busca, setBusca, somenteNegativos, setSomenteNegativos,
    page, setPage, totalPaginas, dados, carregando, erro, refetch: buscar, descontos,
  };
}

export default function AdiantamentosRepassePage() {
  const h = useRepasseLista();
  const { permissoes } = useHubAuth();
  const podeFechar = permissoes.includes('adiantamentos.pagamento_confirmar');

  // `descontos` vem do gancho: a configuração é lida UMA vez, e a mesma
  // leitura que alinha o período inicial (A1) alimenta estes pills.
  const descontos = h.descontos;

  const fecharDialog = useFecharApuracaoDialog({
    periodo: h.periodo,
    onSucesso: (resultado) => {
      toast.success(`Apuração fechada: ${resultado.motoristas} motorista(s), total ${formatBRL(resultado.total)}.`);
      h.refetch();
    },
  });

  const [exportando, setExportando] = useState(false);
  const exportar = useCallback(async () => {
    setExportando(true);
    try {
      await exportarRepasseCsv(h.periodo);
    } catch (e) {
      toast.error(e instanceof AdiantamentosApiError ? e.message : 'Não foi possível exportar o CSV.');
    } finally {
      setExportando(false);
    }
  }, [h.periodo]);

  const periodoAberto = h.dados?.periodo.situacao === 'aberto';

  return (
    <div className={`mx-auto flex w-full ${LARGURA_LISTA} flex-col gap-4 p-4 sm:p-6 lg:p-8`}>
      <PageHeader titulo="Repasse semanal" subtitulo="Remanescente por motorista no período de apuração.">
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" className="min-h-11 gap-1.5 sm:min-h-8" disabled={exportando || !h.dados} onClick={exportar}>
            <Download className="size-4" aria-hidden="true" />
            Exportar CSV
          </Button>
          {podeFechar && (
            <Button
              size="sm"
              className="min-h-11 gap-1.5 sm:min-h-8"
              disabled={!h.dados || !periodoAberto}
              onClick={fecharDialog.abrir}
            >
              <Lock className="size-4" aria-hidden="true" />
              Fechar apuração
            </Button>
          )}
        </div>
      </PageHeader>
      <AdiantamentosAbas />

      <FilterBar gridClassName="grid-cols-1 xs:grid-cols-2 lg:grid-cols-4">
        <div className="flex flex-col gap-1">
          <Label htmlFor="repasse-periodo">Período de apuração (início)</Label>
          <Input id="repasse-periodo" type="date" className="h-11 sm:h-9" value={h.periodo} onChange={(e) => h.setPeriodo(e.target.value)} />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="repasse-busca">Motorista</Label>
          <Input id="repasse-busca" placeholder="Nome" className="h-11 sm:h-9" value={h.busca} onChange={(e) => h.setBusca(e.target.value)} />
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Situação</span>
          {h.dados && (
            <Badge variant={periodoAberto ? 'outline' : 'secondary'} className="w-fit">
              {/* A4: período fechado mostra os valores CONGELADOS na apuração,
                  não um recálculo. A data no rótulo é o que diz ao operador de
                  QUANDO é o retrato — sem ela, um lançamento retroativo que não
                  aparece na tela vira suspeita de erro do sistema. */}
              {periodoAberto
                ? 'Em apuração'
                : `Fechado${h.dados.periodo.fechadoEm ? ` em ${formatDateBR(h.dados.periodo.fechadoEm)}` : ''}`}
            </Badge>
          )}
        </div>
        <label className="flex items-center gap-2 self-end pb-1.5 text-sm">
          <Checkbox checked={h.somenteNegativos} onCheckedChange={(v) => h.setSomenteNegativos(v === true)} aria-label="Somente negativos" />
          Somente negativos
        </label>
      </FilterBar>

      {descontos && (
        <div role="status" className="flex flex-wrap gap-2 text-xs">
          <Badge variant={descontos.adiantamentos ? 'success' : 'outline'}>
            {descontos.adiantamentos ? '✓' : '—'} Adiantamentos (bruto)
          </Badge>
          <Badge variant={descontos.debitos ? 'success' : 'outline'}>
            {descontos.debitos ? '✓' : '—'} Débitos EntreGô
          </Badge>
        </div>
      )}

      {h.carregando ? (
        <ListSkeleton label="Carregando repasse..." />
      ) : h.erro ? (
        <div role="alert" className="flex flex-col items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-10 text-center">
          <AlertCircle className="size-8 text-destructive" aria-hidden="true" />
          <p className="text-sm font-medium text-destructive">{h.erro}</p>
          <Button size="sm" variant="outline" className="min-h-11 sm:min-h-8" onClick={h.refetch}>
            Tentar novamente
          </Button>
        </div>
      ) : !h.dados || h.dados.itens.length === 0 ? (
        <EmptyState icone={Inbox} titulo="Nenhum motorista neste período" dica="Ajuste o período ou os filtros." />
      ) : (
        <>
          {h.dados.naoPagosNoPeriodo > 0 && (
            <p role="status" className="text-xs text-muted-foreground">
              {h.dados.naoPagosNoPeriodo} solicitação(ões) ainda não finalizada(s) neste período.
            </p>
          )}
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Motorista</TableHead>
                  <TableHead className="text-right">Créditos</TableHead>
                  <TableHead className="text-right">Adiantamentos</TableHead>
                  <TableHead className="text-right">Débitos</TableHead>
                  <TableHead className="text-right">Remanescente</TableHead>
                  <TableHead>Observação</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {h.dados.itens.map((item) => (
                  <TableRow key={item.entregadorId}>
                    <TableCell>{item.nome}</TableCell>
                    <TableCell className="text-right font-mono">{formatBRL(item.creditos)}</TableCell>
                    <TableCell className="text-right font-mono">− {formatBRL(item.adiantamentos)}</TableCell>
                    <TableCell className="text-right font-mono">{item.debitos !== '0.00' ? `− ${formatBRL(item.debitos)}` : '—'}</TableCell>
                    <TableCell className={`text-right font-mono font-semibold ${item.negativo ? 'text-destructive' : ''}`}>
                      {formatBRL(item.remanescente)}
                    </TableCell>
                    <TableCell>
                      {item.emProcessamento && <Badge variant="default">Em processamento</Badge>}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
              <TableFooter>
                <TableRow>
                  <TableCell className="font-semibold">Total ({h.dados.totais.motoristas} motorista(s))</TableCell>
                  <TableCell className="text-right font-mono font-semibold">{formatBRL(h.dados.totais.creditos)}</TableCell>
                  <TableCell className="text-right font-mono font-semibold">− {formatBRL(h.dados.totais.adiantamentos)}</TableCell>
                  <TableCell className="text-right font-mono font-semibold">− {formatBRL(h.dados.totais.debitos)}</TableCell>
                  <TableCell className="text-right font-mono font-semibold">{formatBRL(h.dados.totais.remanescente)}</TableCell>
                  <TableCell />
                </TableRow>
              </TableFooter>
            </Table>
          </div>

          <PaginationControls
            currentPage={h.page}
            totalPages={h.totalPaginas}
            recordsPerPage={PAGE_SIZE}
            totalRecords={h.dados.total}
            onPageChange={h.setPage}
          />

          {h.dados.periodo.dataRepasse && (
            <p className="text-xs text-muted-foreground">Repasse previsto para {formatDateBR(h.dados.periodo.dataRepasse)}.</p>
          )}
        </>
      )}

      <FecharApuracaoDialog d={fecharDialog} />
    </div>
  );
}

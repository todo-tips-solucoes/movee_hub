'use client';

// hub-importacoes (S4) FASE 6 task 6.1 — rota `/hub/dashboard/importacoes`:
// histórico paginado (tabela + filtros) + entrada do wizard de upload.
//
// Nota de correção de rota (tasks.md FASE 6): `plan.md` §Project Structure
// lista `app/hub/importacoes/page.tsx`, mas a convenção real do shell (S3,
// `lib/hub/module-nav.ts` `moduloParaRota`) é `/hub/dashboard/<codigo>` —
// esta é a rota REAL. Módulo `importacoes` já semeado (0007), ícone `Upload`
// já mapeado em `ICON_MAP` — nenhuma mudança em `module-nav.ts` necessária.
//
// Ref: docs/specs/hub-importacoes/plan.md §Plano por fases item 6,
// contracts/importacoes-api.md §GET /importacoes.

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  AlertCircle,
  Clock,
  FileText,
  RotateCw,
  Upload as UploadIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useHubAuth } from '@/contexts/hub-auth-context';
import { ImportWizard } from '@/components/hub/import-wizard';
import { listarImportacoes, ImportacaoApiError } from '@/lib/hub/importacoes-api';
import {
  STATUS_LABELS,
  TIPO_LABELS,
  TIPOS_IMPORTACAO,
  type ImportacaoListItem,
  type StatusImportacao,
  type TipoImportacao,
} from '@/lib/hub/importacoes-dto';
import { formatDateBR } from '@/lib/utils';

const STATUS_OPCOES: StatusImportacao[] = [
  'pending',
  'validating',
  'processing',
  'completed',
  'completed_with_errors',
  'failed',
  'cancelled',
];

const PAGE_SIZE = 20;

export interface ImportacoesFiltros {
  tipo: TipoImportacao | '';
  status: StatusImportacao | '';
  responsavel: string;
  de: string;
  ate: string;
}

const FILTROS_INICIAIS: ImportacoesFiltros = { tipo: '', status: '', responsavel: '', de: '', ate: '' };

function badgeVariantDoStatus(status: StatusImportacao): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (status === 'completed') return 'default';
  if (status === 'completed_with_errors') return 'outline';
  if (status === 'failed') return 'destructive';
  if (status === 'cancelled') return 'secondary';
  return 'outline'; // pending/validating/processing — em andamento
}

/** Lógica isolada do JSX (mesmo padrão de `usePerfil`/`useEntitySwitcher`). */
export function useImportacoesHistorico() {
  const [filtros, setFiltrosState] = useState<ImportacoesFiltros>(FILTROS_INICIAIS);
  const [page, setPage] = useState(1);
  const [items, setItems] = useState<ImportacaoListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);

  const buscar = useCallback(async () => {
    setCarregando(true);
    setErro(null);
    try {
      const resposta = await listarImportacoes({
        tipo: filtros.tipo || undefined,
        status: filtros.status || undefined,
        responsavel: filtros.responsavel || undefined,
        de: filtros.de ? new Date(`${filtros.de}T00:00:00`).toISOString() : undefined,
        ate: filtros.ate ? new Date(`${filtros.ate}T23:59:59`).toISOString() : undefined,
        page,
        pageSize: PAGE_SIZE,
      });
      setItems(resposta.items);
      setTotal(resposta.total);
    } catch (e) {
      setErro(e instanceof ImportacaoApiError ? e.message : 'Não foi possível carregar o histórico de importações.');
      setItems([]);
      setTotal(0);
    } finally {
      setCarregando(false);
    }
  }, [filtros, page]);

  useEffect(() => {
    buscar();
  }, [buscar]);

  const setFiltros = useCallback((partial: Partial<ImportacoesFiltros>) => {
    setFiltrosState((prev) => ({ ...prev, ...partial }));
    setPage(1);
  }, []);

  const resetFiltros = useCallback(() => {
    setFiltrosState(FILTROS_INICIAIS);
    setPage(1);
  }, []);

  const totalPaginas = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return {
    filtros,
    setFiltros,
    resetFiltros,
    page,
    setPage,
    totalPaginas,
    items,
    total,
    carregando,
    erro,
    refetch: buscar,
  };
}

function LinhaAguardandoLock() {
  return (
    <Tooltip>
      <TooltipTrigger
        aria-label="Aguardando outra importação do mesmo tipo terminar"
        className="ml-1 inline-flex items-center gap-1 rounded-md px-1 py-0.5 text-xs font-medium text-muted-foreground hover:bg-muted"
      >
        <Clock className="size-3.5" aria-hidden="true" />
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">
        <p>Aguardando outra importação do mesmo tipo terminar (lock ocupado).</p>
      </TooltipContent>
    </Tooltip>
  );
}

function StatusBadge({ item }: { item: ImportacaoListItem }) {
  return (
    <span className="inline-flex items-center">
      <Badge variant={badgeVariantDoStatus(item.status)}>{STATUS_LABELS[item.status]}</Badge>
      {/* 6.5 — dec-032/CHK013: sinal adicional distinguindo "pending recém-criado"
          de "pending aguardando lock", sem introduzir novo estado na máquina. */}
      {item.aguardandoLock && <LinhaAguardandoLock />}
    </span>
  );
}

export default function ImportacoesPage() {
  const { permissoes } = useHubAuth();
  const podeCriar = permissoes.includes('importacoes.criar');
  const h = useImportacoesHistorico();

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4 p-4 sm:p-6 lg:p-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-heading text-xl font-semibold text-foreground sm:text-2xl">Importações</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Histórico de importações de faturamento e performance.
          </p>
        </div>
        <ImportWizard podeCriar={podeCriar} onEnviado={() => h.refetch()} />
      </div>

      {/* Filtros */}
      <div className="rounded-lg border bg-card p-3">
        <div className="grid grid-cols-1 gap-3 xs:grid-cols-2 lg:grid-cols-5">
          <div className="flex flex-col gap-1">
            <label htmlFor="importacoes-filtro-tipo" className="text-xs text-muted-foreground">
              Tipo
            </label>
            <select
              id="importacoes-filtro-tipo"
              aria-label="Tipo"
              value={h.filtros.tipo}
              onChange={(e) => h.setFiltros({ tipo: e.target.value as TipoImportacao | '' })}
              className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm sm:h-9"
            >
              <option value="">Todos</option>
              {TIPOS_IMPORTACAO.map((t) => (
                <option key={t} value={t}>
                  {TIPO_LABELS[t]}
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor="importacoes-filtro-status" className="text-xs text-muted-foreground">
              Status
            </label>
            <select
              id="importacoes-filtro-status"
              aria-label="Status"
              value={h.filtros.status}
              onChange={(e) => h.setFiltros({ status: e.target.value as StatusImportacao | '' })}
              className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm sm:h-9"
            >
              <option value="">Todos</option>
              {STATUS_OPCOES.map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABELS[s]}
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor="importacoes-filtro-responsavel" className="text-xs text-muted-foreground">
              Responsável
            </label>
            <Input
              id="importacoes-filtro-responsavel"
              value={h.filtros.responsavel}
              onChange={(e) => h.setFiltros({ responsavel: e.target.value })}
              placeholder="ID do responsável..."
              className="h-11 sm:h-9"
            />
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor="importacoes-filtro-de" className="text-xs text-muted-foreground">
              De
            </label>
            <Input
              id="importacoes-filtro-de"
              type="date"
              value={h.filtros.de}
              onChange={(e) => h.setFiltros({ de: e.target.value })}
              className="h-11 sm:h-9"
            />
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor="importacoes-filtro-ate" className="text-xs text-muted-foreground">
              Até
            </label>
            <Input
              id="importacoes-filtro-ate"
              type="date"
              value={h.filtros.ate}
              onChange={(e) => h.setFiltros({ ate: e.target.value })}
              className="h-11 sm:h-9"
            />
          </div>
        </div>

        <div className="mt-2 flex justify-end">
          <Button size="sm" variant="ghost" className="min-h-11 sm:min-h-8" onClick={h.resetFiltros}>
            Limpar filtros
          </Button>
        </div>
      </div>

      {/* Conteúdo */}
      {h.carregando ? (
        <div role="status" className="flex flex-col items-center gap-2 rounded-lg border p-10 text-muted-foreground">
          <RotateCw className="size-6 animate-spin" aria-hidden="true" />
          <p className="text-sm">Carregando importações...</p>
        </div>
      ) : h.erro ? (
        <div
          role="alert"
          className="flex flex-col items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-10 text-center"
        >
          <AlertCircle className="size-8 text-destructive" aria-hidden="true" />
          <p className="text-sm font-medium text-destructive">{h.erro}</p>
          <Button size="sm" variant="outline" className="min-h-11 sm:min-h-8" onClick={h.refetch}>
            Tentar novamente
          </Button>
        </div>
      ) : h.items.length === 0 ? (
        <div
          role="status"
          className="flex flex-col items-center gap-2 rounded-lg border border-dashed p-10 text-center text-muted-foreground"
        >
          <FileText className="size-10 opacity-30" aria-hidden="true" />
          <p className="font-medium">Nenhuma importação encontrada</p>
          <p className="text-xs">Ajuste os filtros ou importe um novo arquivo.</p>
        </div>
      ) : (
        <>
          {/* Mobile card layout */}
          <div className="flex flex-col gap-2 md:hidden">
            {h.items.map((item) => (
              <Link
                key={item.id}
                href={`/hub/dashboard/importacoes/${item.id}`}
                className="rounded-lg border p-3 hover:bg-muted/50"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">{TIPO_LABELS[item.tipo]}</span>
                  <StatusBadge item={item} />
                </div>
                <p className="mt-1 truncate text-xs text-muted-foreground">{item.nomeArquivo}</p>
                <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                  <span>Total: {item.totalLinhas ?? '-'}</span>
                  <span>Válidas: {item.linhasValidas ?? '-'}</span>
                  <span>Inválidas: {item.linhasInvalidas ?? '-'}</span>
                  {item.dataReferencia && <span>{formatDateBR(item.dataReferencia)}</span>}
                </div>
              </Link>
            ))}
          </div>

          {/* Desktop table */}
          <div className="hidden rounded-lg border md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Tipo</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Arquivo</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                  <TableHead className="text-right">Válidas</TableHead>
                  <TableHead className="text-right">Inválidas</TableHead>
                  <TableHead>Data referência</TableHead>
                  <TableHead>Duração</TableHead>
                  <TableHead className="text-right">Ações</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {h.items.map((item) => (
                  <TableRow key={item.id} className="hover:bg-muted/50">
                    <TableCell>{TIPO_LABELS[item.tipo]}</TableCell>
                    <TableCell>
                      <StatusBadge item={item} />
                    </TableCell>
                    <TableCell className="max-w-[220px] truncate">{item.nomeArquivo}</TableCell>
                    <TableCell className="text-right font-mono">{item.totalLinhas ?? '-'}</TableCell>
                    <TableCell className="text-right font-mono">{item.linhasValidas ?? '-'}</TableCell>
                    <TableCell className="text-right font-mono">{item.linhasInvalidas ?? '-'}</TableCell>
                    <TableCell className="text-sm">{formatDateBR(item.dataReferencia)}</TableCell>
                    <TableCell className="text-sm">
                      {item.duracaoSegundos !== null ? `${item.duracaoSegundos}s` : '-'}
                    </TableCell>
                    <TableCell className="text-right">
                      <Link
                        href={`/hub/dashboard/importacoes/${item.id}`}
                        className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
                      >
                        <UploadIcon className="size-3.5" aria-hidden="true" />
                        Detalhes
                      </Link>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          {/* Paginação */}
          <div className="flex items-center justify-between gap-2 text-sm text-muted-foreground">
            <span>
              Página {h.page} de {h.totalPaginas} — {h.total} registro{h.total === 1 ? '' : 's'}
            </span>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" className="min-h-11 sm:min-h-8" disabled={h.page <= 1} onClick={() => h.setPage(h.page - 1)}>
                Anterior
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="min-h-11 sm:min-h-8"
                disabled={h.page >= h.totalPaginas}
                onClick={() => h.setPage(h.page + 1)}
              >
                Próxima
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

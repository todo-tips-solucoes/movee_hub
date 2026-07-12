'use client';

// hub-motoristas (S5) FASE 7 task 7.1.1 — rota `/hub/dashboard/motoristas`:
// lista paginada com filtros server-side (nome/ativo/área/vínculo).
//
// Mesmo molde de `.../importacoes/page.tsx` (task 7.1.1 exige reusar o
// padrão): hook de filtro/paginação local (state puro, sem sync de URL —
// convenção observada na S4), cards no mobile + `Table` no desktop, filtros
// inline em `<select>`/`<Input>` do shadcn. Sem componente `<DataTable>`
// genérico — não existe no hub (só no legado `/dashboard`).
//
// Ref: docs/specs/hub-motoristas/plan.md §Plano por fases item 7,
// contracts/motoristas-api.md §GET /motoristas.

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { AlertCircle, ChevronRight, Truck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useHubAuth } from '@/contexts/hub-auth-context';
import { PageHeader } from '@/components/hub/page-header';
import { EmptyState } from '@/components/hub/empty-state';
import { ListSkeleton } from '@/components/hub/table-skeleton';
import { AtivoBadge, VinculoBadge } from '@/components/hub/status-badge';
import { MotoristaDetalheDialog, useMotoristaDetalheDialog } from '@/components/hub/motorista-detalhe-dialog';
import { listarAreasMotoristas, listarMotoristas, MotoristaApiError } from '@/lib/hub/motoristas-api';
import type { MotoristaListItem } from '@/lib/hub/motoristas-dto';

const PAGE_SIZE = 20;

export interface MotoristasFiltros {
  nome: string;
  ativo: '' | 'true' | 'false';
  area: string;
  comVinculo: '' | 'true' | 'false';
}

const FILTROS_INICIAIS: MotoristasFiltros = { nome: '', ativo: '', area: '', comVinculo: '' };

/** Lógica isolada do JSX (mesmo padrão de `useImportacoesHistorico`). */
export function useMotoristasLista() {
  const [filtros, setFiltrosState] = useState<MotoristasFiltros>(FILTROS_INICIAIS);
  const [page, setPage] = useState(1);
  const [items, setItems] = useState<MotoristaListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);

  const buscar = useCallback(async () => {
    setCarregando(true);
    setErro(null);
    try {
      const resposta = await listarMotoristas({
        nome: filtros.nome || undefined,
        ativo: filtros.ativo === '' ? undefined : filtros.ativo === 'true',
        area: filtros.area || undefined,
        comVinculo: filtros.comVinculo === '' ? undefined : filtros.comVinculo === 'true',
        page,
        pageSize: PAGE_SIZE,
      });
      setItems(resposta.items);
      setTotal(resposta.total);
    } catch (e) {
      setErro(e instanceof MotoristaApiError ? e.message : 'Não foi possível carregar a lista de motoristas.');
      setItems([]);
      setTotal(0);
    } finally {
      setCarregando(false);
    }
  }, [filtros, page]);

  useEffect(() => {
    buscar();
  }, [buscar]);

  const setFiltros = useCallback((partial: Partial<MotoristasFiltros>) => {
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

export default function MotoristasPage() {
  const { permissoes } = useHubAuth();
  const podeConsultar = permissoes.includes('motoristas.consultar');
  const h = useMotoristasLista();
  // uiux-hub pós-F4: o filtro "Área" deixou de ser texto livre — as opções
  // vêm de GET /motoristas/areas (subpraças distintas do escopo). Falha na
  // carga degrada para só "Todas" (o filtro fica inerte, a lista não quebra).
  const [areasOpcoes, setAreasOpcoes] = useState<string[]>([]);
  useEffect(() => {
    let ativo = true;
    listarAreasMotoristas()
      .then((areas) => { if (ativo) setAreasOpcoes(areas); })
      .catch(() => { if (ativo) setAreasOpcoes([]); });
    return () => { ativo = false; };
  }, []);
  // uiux-hub pós-F4: na tabela desktop, tanto a linha quanto a ação "Detalhes"
  // abrem o detalhe em modal (mesmos campos do legado); a página completa
  // segue acessível pelo rodapé do modal e pelos cards mobile.
  const detalheDialog = useMotoristaDetalheDialog();

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4 p-4 sm:p-6 lg:p-8">
      <PageHeader
        titulo="Motoristas"
        subtitulo="Pessoas entregadoras conhecidas pelas importações de faturamento e performance."
      />

      {/* Filtros */}
      <div className="rounded-lg border bg-card p-3">
        <div className="grid grid-cols-1 gap-3 xs:grid-cols-2 lg:grid-cols-4">
          <div className="flex flex-col gap-1">
            <label htmlFor="motoristas-filtro-nome" className="text-xs text-muted-foreground">
              Nome
            </label>
            <Input
              id="motoristas-filtro-nome"
              value={h.filtros.nome}
              onChange={(e) => h.setFiltros({ nome: e.target.value })}
              placeholder="Buscar por nome..."
              className="h-11 sm:h-9"
            />
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor="motoristas-filtro-ativo" className="text-xs text-muted-foreground">
              Situação
            </label>
            <select
              id="motoristas-filtro-ativo"
              aria-label="Situação"
              value={h.filtros.ativo}
              onChange={(e) => h.setFiltros({ ativo: e.target.value as MotoristasFiltros['ativo'] })}
              className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm sm:h-9"
            >
              <option value="">Todas</option>
              <option value="true">Ativo</option>
              <option value="false">Inativo</option>
            </select>
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor="motoristas-filtro-area" className="text-xs text-muted-foreground">
              Área (subpraça)
            </label>
            <select
              id="motoristas-filtro-area"
              aria-label="Área (subpraça)"
              value={h.filtros.area}
              onChange={(e) => h.setFiltros({ area: e.target.value })}
              className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm sm:h-9"
            >
              <option value="">Todas</option>
              {areasOpcoes.map((area) => (
                <option key={area} value={area}>
                  {area}
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor="motoristas-filtro-vinculo" className="text-xs text-muted-foreground">
              Vínculo
            </label>
            <select
              id="motoristas-filtro-vinculo"
              aria-label="Vínculo"
              value={h.filtros.comVinculo}
              onChange={(e) => h.setFiltros({ comVinculo: e.target.value as MotoristasFiltros['comVinculo'] })}
              className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm sm:h-9"
            >
              <option value="">Todos</option>
              <option value="true">Vinculado</option>
              <option value="false">Sem vínculo</option>
            </select>
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
        <ListSkeleton label="Carregando motoristas..." />
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
        <EmptyState
          icone={Truck}
          titulo="Nenhum motorista encontrado"
          dica="Ajuste os filtros ou aguarde uma nova importação."
        />
      ) : (
        <>
          {/* Mobile card layout */}
          <div className="flex flex-col gap-2 md:hidden">
            {h.items.map((item) => (
              <Link
                key={item.id}
                href={podeConsultar ? `/hub/dashboard/motoristas/${item.id}` : '#'}
                aria-disabled={!podeConsultar}
                className="rounded-lg border p-3 hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">{item.nome}</span>
                  <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <AtivoBadge ativo={item.ativo} />
                  <VinculoBadge vinculado={item.comVinculo} />
                </div>
                {item.areas.length > 0 && (
                  <p className="mt-2 truncate text-xs text-muted-foreground">{item.areas.join(', ')}</p>
                )}
              </Link>
            ))}
          </div>

          {/* Desktop table */}
          <div className="hidden rounded-lg border md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Nome</TableHead>
                  <TableHead>Situação</TableHead>
                  <TableHead>Vínculo</TableHead>
                  <TableHead>Áreas</TableHead>
                  <TableHead className="text-right">Ações</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {h.items.map((item) => (
                  <TableRow
                    key={item.id}
                    className={podeConsultar ? 'cursor-pointer hover:bg-muted/50' : undefined}
                    onClick={podeConsultar ? () => detalheDialog.abrir(item.id) : undefined}
                  >
                    <TableCell className="font-medium">{item.nome}</TableCell>
                    <TableCell>
                      <AtivoBadge ativo={item.ativo} />
                    </TableCell>
                    <TableCell>
                      <VinculoBadge vinculado={item.comVinculo} />
                    </TableCell>
                    <TableCell className="max-w-[260px] truncate text-sm text-muted-foreground">
                      {item.areas.join(', ') || '-'}
                    </TableCell>
                    <TableCell className="text-right">
                      {podeConsultar ? (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            detalheDialog.abrir(item.id);
                          }}
                          className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
                        >
                          Detalhes
                          <ChevronRight className="size-3.5" aria-hidden="true" />
                        </button>
                      ) : (
                        <span className="text-sm text-muted-foreground">-</span>
                      )}
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
              <Button
                size="sm"
                variant="outline"
                className="min-h-11 sm:min-h-8"
                disabled={h.page <= 1}
                onClick={() => h.setPage(h.page - 1)}
              >
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

          <MotoristaDetalheDialog state={detalheDialog} />
        </>
      )}
    </div>
  );
}

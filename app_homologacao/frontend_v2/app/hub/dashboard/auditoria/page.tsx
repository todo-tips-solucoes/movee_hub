'use client';

// hub-auditoria-admin (S9) FASE 5.1 task 5.1.3 — rota
// `/hub/dashboard/auditoria`: lista paginada da trilha de auditoria (mais
// recentes primeiro), filtros combináveis, drawer client-side de detalhe do
// evento (SEM `GET /:id` — research Decision 9) e seletor de entidade
// visível SÓ para admin_plataforma (US2).
//
// Mesmo molde de `.../faturamento/page.tsx`: hook de filtro/paginação local
// isolado do JSX, cards no mobile + `Table` no desktop, filtros inline em
// `<Input>`/`<select>` do shadcn.
//
// admin_plataforma: como `useHubAuth()` não expõe um flag dedicado, usamos
// `permissoes.includes('admin.gerenciar')` como proxy — essa permissão é
// exclusiva do papel `admin_plataforma` no catálogo fixo (dec-008,
// contracts/papeis-api.md); o backend é quem de fato barra/libera a visão
// global (403 se `entidadeId` fora do escopo) — este proxy só decide o que
// a UI OFERECE, nunca o que o backend PERMITE.
//
// Ref: docs/specs/hub-auditoria-admin/contracts/auditoria-api.md,
// spec.md FR-001/FR-004/FR-012, quickstart.md Cenário 8.

import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, Eye, ShieldCheck } from 'lucide-react';
import { PageHeader } from '@/components/hub/page-header';
import { EmptyState } from '@/components/hub/empty-state';
import { ListSkeleton } from '@/components/hub/table-skeleton';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useHubAuth } from '@/contexts/hub-auth-context';
import { AuditoriaApiError, listarAuditoria } from '@/lib/hub/auditoria-api';
import type { AuditoriaEvento } from '@/lib/hub/auditoria-dto';

const PAGE_SIZE = 20;

export interface AuditoriaFiltrosUI {
  acao: string;
  usuarioId: string;
  recurso: string;
  de: string;
  ate: string;
  entidadeId: string;
}

const FILTROS_INICIAIS: AuditoriaFiltrosUI = {
  acao: '',
  usuarioId: '',
  recurso: '',
  de: '',
  ate: '',
  entidadeId: '',
};

function formatDataHoraBR(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
}

/** Lógica isolada do JSX (mesmo padrão de `useFaturamentoLista`). */
export function useAuditoriaLista() {
  const [filtros, setFiltrosState] = useState<AuditoriaFiltrosUI>(FILTROS_INICIAIS);
  const [page, setPage] = useState(1);
  const [eventos, setEventos] = useState<AuditoriaEvento[]>([]);
  const [total, setTotal] = useState(0);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);

  const filtrosApi = useCallback(
    () => ({
      acao: filtros.acao || undefined,
      usuarioId: filtros.usuarioId ? Number(filtros.usuarioId) : undefined,
      recurso: filtros.recurso || undefined,
      de: filtros.de || undefined,
      ate: filtros.ate || undefined,
      entidadeId: filtros.entidadeId ? Number(filtros.entidadeId) : undefined,
    }),
    [filtros]
  );

  const buscar = useCallback(async () => {
    setCarregando(true);
    setErro(null);
    try {
      const resposta = await listarAuditoria({ ...filtrosApi(), page, pageSize: PAGE_SIZE });
      setEventos(resposta.eventos);
      setTotal(resposta.total);
    } catch (e) {
      setErro(e instanceof AuditoriaApiError ? e.message : 'Não foi possível carregar a auditoria.');
      setEventos([]);
      setTotal(0);
    } finally {
      setCarregando(false);
    }
  }, [filtrosApi, page]);

  useEffect(() => {
    buscar();
  }, [buscar]);

  const setFiltros = useCallback((partial: Partial<AuditoriaFiltrosUI>) => {
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
    eventos,
    total,
    carregando,
    erro,
    refetch: buscar,
  };
}

function DetalheDrawer({ evento, onClose }: { evento: AuditoriaEvento | null; onClose: () => void }) {
  return (
    <Sheet open={evento !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right" className="w-full max-w-md sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>Detalhe do evento</SheetTitle>
          <SheetDescription>
            {evento ? `${evento.acao} — ${formatDataHoraBR(evento.criadoEm)}` : ''}
          </SheetDescription>
        </SheetHeader>
        {evento && (
          <div className="flex flex-col gap-3 overflow-y-auto p-4 text-sm">
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5">
              <dt className="text-muted-foreground">Ação</dt>
              <dd className="font-medium">{evento.acao}</dd>
              <dt className="text-muted-foreground">Recurso</dt>
              <dd>{evento.recurso}{evento.recursoId ? ` #${evento.recursoId}` : ''}</dd>
              <dt className="text-muted-foreground">Usuário</dt>
              <dd>{evento.usuarioId !== null ? `#${evento.usuarioId}` : '—'}</dd>
              <dt className="text-muted-foreground">Entidade</dt>
              <dd>{evento.entidadeId !== null ? `#${evento.entidadeId}` : 'Evento global'}</dd>
              <dt className="text-muted-foreground">IP</dt>
              <dd>{evento.ip ?? '—'}</dd>
              <dt className="text-muted-foreground">Data/hora</dt>
              <dd>{formatDataHoraBR(evento.criadoEm)}</dd>
            </dl>
            <div>
              <p className="mb-1 text-xs font-medium text-muted-foreground">
                Detalhes (já filtrados de dados sensíveis pelo servidor)
              </p>
              {Object.keys(evento.detalhes).length === 0 ? (
                <p className="text-xs text-muted-foreground">Sem detalhes adicionais.</p>
              ) : (
                <pre className="max-h-64 overflow-auto rounded-md border bg-muted/40 p-2 text-xs">
                  {JSON.stringify(evento.detalhes, null, 2)}
                </pre>
              )}
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

export default function AuditoriaPage() {
  const { permissoes } = useHubAuth();
  // Proxy documentado no cabeçalho do arquivo: admin.gerenciar é exclusivo
  // do papel admin_plataforma (dec-008).
  const podeVerTudo = permissoes.includes('admin.gerenciar');
  const h = useAuditoriaLista();
  const [eventoSelecionado, setEventoSelecionado] = useState<AuditoriaEvento | null>(null);

  return (
    <div className="mx-auto flex w-full max-w-[96rem] flex-col gap-4 p-4 sm:p-6 lg:p-8">
      <PageHeader
        titulo="Auditoria"
        subtitulo={`Trilha imutável de ações relevantes ${podeVerTudo ? 'de toda a plataforma' : 'da sua entidade'}.`}
      />

      {/* Filtros */}
      <div className="rounded-lg border bg-card p-3">
        <div className="grid grid-cols-1 gap-3 xs:grid-cols-2 lg:grid-cols-6">
          <div className="flex flex-col gap-1">
            <label htmlFor="auditoria-filtro-de" className="text-xs text-muted-foreground">
              De
            </label>
            <Input
              id="auditoria-filtro-de"
              type="date"
              value={h.filtros.de}
              onChange={(e) => h.setFiltros({ de: e.target.value })}
              className="h-11 sm:h-9"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="auditoria-filtro-ate" className="text-xs text-muted-foreground">
              Até
            </label>
            <Input
              id="auditoria-filtro-ate"
              type="date"
              value={h.filtros.ate}
              onChange={(e) => h.setFiltros({ ate: e.target.value })}
              className="h-11 sm:h-9"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="auditoria-filtro-acao" className="text-xs text-muted-foreground">
              Ação
            </label>
            <Input
              id="auditoria-filtro-acao"
              value={h.filtros.acao}
              onChange={(e) => h.setFiltros({ acao: e.target.value })}
              placeholder="Ex.: usuario_criado"
              className="h-11 sm:h-9"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="auditoria-filtro-recurso" className="text-xs text-muted-foreground">
              Recurso
            </label>
            <Input
              id="auditoria-filtro-recurso"
              value={h.filtros.recurso}
              onChange={(e) => h.setFiltros({ recurso: e.target.value })}
              placeholder="Ex.: Usuario"
              className="h-11 sm:h-9"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="auditoria-filtro-usuario" className="text-xs text-muted-foreground">
              ID do usuário responsável
            </label>
            <Input
              id="auditoria-filtro-usuario"
              type="number"
              min={1}
              value={h.filtros.usuarioId}
              onChange={(e) => h.setFiltros({ usuarioId: e.target.value })}
              placeholder="Ex.: 17"
              className="h-11 sm:h-9"
            />
          </div>
          {podeVerTudo && (
            <div className="flex flex-col gap-1">
              <label htmlFor="auditoria-filtro-entidade" className="text-xs text-muted-foreground">
                ID da entidade (vazio = todas)
              </label>
              <Input
                id="auditoria-filtro-entidade"
                type="number"
                min={1}
                value={h.filtros.entidadeId}
                onChange={(e) => h.setFiltros({ entidadeId: e.target.value })}
                placeholder="Ex.: 9001"
                className="h-11 sm:h-9"
              />
            </div>
          )}
        </div>
        <div className="mt-2 flex justify-end">
          <Button size="sm" variant="ghost" className="min-h-11 sm:min-h-8" onClick={h.resetFiltros}>
            Limpar filtros
          </Button>
        </div>
      </div>

      {/* Conteúdo */}
      {h.carregando ? (
        <ListSkeleton label="Carregando trilha de auditoria..." linhas={8} />
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
      ) : h.eventos.length === 0 ? (
        <EmptyState
          icone={ShieldCheck}
          titulo="Nenhum evento encontrado"
          dica="Ajuste os filtros ou o período selecionado."
        />
      ) : (
        <>
          {/* Mobile card layout */}
          <div className="flex flex-col gap-2 md:hidden">
            {h.eventos.map((evento) => (
              <button
                key={evento.id}
                type="button"
                onClick={() => setEventoSelecionado(evento)}
                className="rounded-lg border p-3 text-left"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">{evento.acao}</span>
                  <Eye className="size-4 text-muted-foreground" aria-hidden="true" />
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {evento.recurso}{evento.recursoId ? ` #${evento.recursoId}` : ''} — {formatDataHoraBR(evento.criadoEm)}
                </div>
                {evento.entidadeId === null && (
                  <span className="mt-1 inline-block rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                    Evento global
                  </span>
                )}
              </button>
            ))}
          </div>

          {/* Desktop table */}
          <div className="hidden rounded-lg border md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Data/hora</TableHead>
                  <TableHead>Ação</TableHead>
                  <TableHead>Recurso</TableHead>
                  <TableHead>Usuário</TableHead>
                  {podeVerTudo && <TableHead>Entidade</TableHead>}
                  <TableHead className="text-right">Detalhe</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {h.eventos.map((evento) => (
                  <TableRow key={evento.id} className="hover:bg-muted/50">
                    <TableCell className="text-sm text-muted-foreground">{formatDataHoraBR(evento.criadoEm)}</TableCell>
                    <TableCell className="font-medium">{evento.acao}</TableCell>
                    <TableCell className="text-sm">
                      {evento.recurso}{evento.recursoId ? ` #${evento.recursoId}` : ''}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {evento.usuarioId !== null ? `#${evento.usuarioId}` : '—'}
                    </TableCell>
                    {podeVerTudo && (
                      <TableCell className="text-sm text-muted-foreground">
                        {evento.entidadeId !== null ? `#${evento.entidadeId}` : 'Global'}
                      </TableCell>
                    )}
                    <TableCell className="text-right">
                      <Button size="sm" variant="ghost" onClick={() => setEventoSelecionado(evento)}>
                        <Eye className="size-4" aria-hidden="true" />
                        <span className="sr-only">Ver detalhe do evento {evento.id}</span>
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          {/* Paginação */}
          <div className="flex items-center justify-between gap-2 text-sm text-muted-foreground">
            <span>
              Página {h.page} de {h.totalPaginas} — {h.total} evento{h.total === 1 ? '' : 's'}
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
        </>
      )}

      <DetalheDrawer evento={eventoSelecionado} onClose={() => setEventoSelecionado(null)} />
    </div>
  );
}

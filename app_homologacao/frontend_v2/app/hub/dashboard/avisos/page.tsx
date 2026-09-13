'use client';

// hub-avisos (push-motorista, FASE 7 — tasks.md 7.2) — rota
// `/hub/dashboard/avisos`: cobertura por plataforma (FR-023/SC-011) + lista
// paginada de avisos com status/contagens + botão "Novo aviso" (gate por
// `avisos.enviar`, padrão de `app/hub/dashboard/importacoes/page.tsx:241`).
//
// Ref: docs/specs/envioMassa_homologacao/contracts/hub-avisos.md
// §GET /avisos, §GET /avisos/cobertura, tasks.md 7.2.

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AlertCircle, Bell, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { PaginationControls } from '@/components/pagination-controls';
import { ListSkeleton } from '@/components/hub/table-skeleton';
import { EmptyState } from '@/components/hub/empty-state';
import { PageHeader } from '@/components/hub/page-header';
import { AvisoStatusBadge } from '@/components/hub/status-badge';
import { AvisoDialog, useAvisoDialog } from '@/components/hub/aviso-dialog';
import { useHubAuth } from '@/contexts/hub-auth-context';
import { LARGURA_LISTA } from '@/lib/hub/larguras';
import { AvisoApiError, listarAvisos, obterCobertura } from '@/lib/hub/avisos-api';
import { MODO_DESTINATARIOS_LABELS, type AvisoListItem, type AvisosCobertura } from '@/lib/hub/avisos-dto';
import { formatDateBR } from '@/lib/utils';

const PAGE_SIZE = 20;

/** Lógica isolada do JSX (mesmo padrão de `useImportacoesHistorico`). */
export function useAvisosLista() {
  const [items, setItems] = useState<AvisoListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);

  const buscar = useCallback(async () => {
    setCarregando(true);
    setErro(null);
    try {
      const resposta = await listarAvisos({ page, pageSize: PAGE_SIZE });
      setItems(resposta.itens);
      setTotal(resposta.total);
    } catch (e) {
      setErro(e instanceof AvisoApiError ? e.message : 'Não foi possível carregar os avisos.');
      setItems([]);
      setTotal(0);
    } finally {
      setCarregando(false);
    }
  }, [page]);

  useEffect(() => {
    buscar();
  }, [buscar]);

  const totalPaginas = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const refetch = useCallback(() => buscar(), [buscar]);

  return { items, total, page, setPage, totalPaginas, carregando, erro, refetch };
}

/** 7.2.1 — cobertura por plataforma (FR-023/SC-011): 3 categorias de
 * `ativos`, 3 de `impedidos` e `naoAtivadas`, com os NÚMEROS do backend. */
function useCoberturaAvisos() {
  const [cobertura, setCobertura] = useState<AvisosCobertura | null>(null);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);

  // setState só dentro do callback assíncrono `buscar` (useCallback), nunca
  // direto no corpo do efeito — mesmo padrão de `useAvisosLista`/
  // `useImportacoesHistorico` (react-hooks/set-state-in-effect).
  const buscar = useCallback(async () => {
    setCarregando(true);
    setErro(null);
    try {
      const c = await obterCobertura();
      setCobertura(c);
    } catch (e) {
      setErro(e instanceof AvisoApiError ? e.message : 'Não foi possível carregar a cobertura.');
    } finally {
      setCarregando(false);
    }
  }, []);

  useEffect(() => {
    buscar();
  }, [buscar]);

  return { cobertura, carregando, erro };
}

function CoberturaCard() {
  const { cobertura, carregando, erro } = useCoberturaAvisos();
  return (
    <Card>
      <CardHeader>
        <CardTitle as="h2" className="text-base">
          Cobertura de notificações
        </CardTitle>
      </CardHeader>
      <CardContent className="px-4">
        {carregando ? (
          <p role="status" className="text-sm text-muted-foreground">
            Carregando cobertura...
          </p>
        ) : erro ? (
          <p role="alert" className="flex items-center gap-2 text-sm font-medium text-destructive">
            <AlertCircle className="size-4 shrink-0" aria-hidden="true" />
            {erro}
          </p>
        ) : cobertura ? (
          <div className="flex flex-col gap-4 text-sm">
            <div>
              <p className="mb-1.5 text-xs font-medium text-muted-foreground">Ativos por plataforma</p>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <p className="text-xs text-muted-foreground">Android</p>
                  <p className="font-mono text-base">{cobertura.ativos.android}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">iOS</p>
                  <p className="font-mono text-base">{cobertura.ativos.ios}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Desktop/outros</p>
                  <p className="font-mono text-base">{cobertura.ativos.desktopOutros}</p>
                </div>
              </div>
            </div>
            <div>
              <p className="mb-1.5 text-xs font-medium text-muted-foreground">Impedidos</p>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <p className="text-xs text-muted-foreground">iOS sem instalação</p>
                  <p className="font-mono text-base">{cobertura.impedidos.iosSemInstalacao}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Bloqueadas</p>
                  <p className="font-mono text-base">{cobertura.impedidos.bloqueadas}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Sem suporte</p>
                  <p className="font-mono text-base">{cobertura.impedidos.semSuporte}</p>
                </div>
              </div>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Não ativadas</p>
              <p className="font-mono text-base">{cobertura.naoAtivadas}</p>
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function AvisosConteudo() {
  const { permissoes } = useHubAuth();
  const podeEnviar = permissoes.includes('avisos.enviar');
  const h = useAvisosLista();
  const dialog = useAvisoDialog(() => h.refetch());
  const router = useRouter();

  return (
    <div className={`mx-auto flex w-full ${LARGURA_LISTA} flex-col gap-4 p-4 sm:p-6 lg:p-8`}>
      <PageHeader titulo="Avisos" subtitulo="Notificações push para os motoristas do grupo Movee.">
        <AvisoDialog podeCriar={podeEnviar} state={dialog} />
      </PageHeader>

      <CoberturaCard />

      {h.carregando ? (
        <ListSkeleton label="Carregando avisos..." />
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
        <EmptyState icone={Bell} titulo="Nenhum aviso enviado" dica="Dispare um aviso para os motoristas do grupo Movee.">
          {podeEnviar && (
            <Button size="sm" className="min-h-11 gap-1.5 sm:min-h-8" onClick={() => dialog.setOpen(true)}>
              <Bell className="size-4" aria-hidden="true" />
              Novo aviso
            </Button>
          )}
        </EmptyState>
      ) : (
        <>
          {/* Mobile card layout */}
          <div className="flex flex-col gap-2 md:hidden">
            {h.items.map((item) => (
              <Link
                key={item.id}
                href={`/hub/dashboard/avisos/${item.id}`}
                className="rounded-lg border p-3 hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate font-medium">{item.titulo}</span>
                  <AvisoStatusBadge status={item.status} />
                </div>
                <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                  <span>Visados: {item.contagens.visados}</span>
                  <span>Aceitos: {item.contagens.aceitos}</span>
                  <span>Falhas: {item.contagens.falhas}</span>
                  <span>{formatDateBR(item.criadoEm)}</span>
                </div>
              </Link>
            ))}
          </div>

          {/* Desktop table */}
          <div className="hidden rounded-lg border md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Título</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Destinatários</TableHead>
                  <TableHead className="text-right">Visados</TableHead>
                  <TableHead className="text-right">Aceitos</TableHead>
                  <TableHead className="text-right">Falhas</TableHead>
                  <TableHead className="text-right">Mortas</TableHead>
                  <TableHead>Criado em</TableHead>
                  <TableHead className="text-right">Ações</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {h.items.map((item) => (
                  <TableRow
                    key={item.id}
                    className="cursor-pointer hover:bg-muted/50"
                    onClick={() => router.push(`/hub/dashboard/avisos/${item.id}`)}
                  >
                    <TableCell className="max-w-[260px] truncate">{item.titulo}</TableCell>
                    <TableCell>
                      <AvisoStatusBadge status={item.status} />
                    </TableCell>
                    <TableCell>{MODO_DESTINATARIOS_LABELS[item.modoDestinatarios]}</TableCell>
                    <TableCell className="text-right font-mono">{item.contagens.visados}</TableCell>
                    <TableCell className="text-right font-mono">{item.contagens.aceitos}</TableCell>
                    <TableCell className="text-right font-mono">{item.contagens.falhas}</TableCell>
                    <TableCell className="text-right font-mono">{item.contagens.mortas}</TableCell>
                    <TableCell className="whitespace-nowrap text-sm">{formatDateBR(item.criadoEm)}</TableCell>
                    <TableCell className="text-right">
                      <Link
                        href={`/hub/dashboard/avisos/${item.id}`}
                        className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
                      >
                        Detalhes
                        <ChevronRight className="size-3.5" aria-hidden="true" />
                      </Link>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          <PaginationControls
            currentPage={h.page}
            totalPages={h.totalPaginas}
            recordsPerPage={PAGE_SIZE}
            totalRecords={h.total}
            onPageChange={h.setPage}
          />
        </>
      )}
    </div>
  );
}

export default function AvisosPage() {
  return <AvisosConteudo />;
}

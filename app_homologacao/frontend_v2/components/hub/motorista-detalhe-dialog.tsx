'use client';

// uiux-hub (pós-fase 4): detalhe rápido do motorista em modal, aberto pela
// ação "Detalhes" da lista — mesmos campos da tela de motoristas do legado
// (`app/dashboard/motoristas`): Nome, CNPJ, Cadastro e Situação. No hub o
// Entregador não tem CNPJ próprio: CNPJ (mascarado) e cadastro vêm do vínculo
// com a `ContaMotorista`; sem vínculo, o CNPJ aparece como "—". A página
// completa (`/hub/dashboard/motoristas/[id]`) segue acessível pelo rodapé.

import { useCallback, useState } from 'react';
import Link from 'next/link';
import { AlertCircle, ChevronRight } from 'lucide-react';
import { Button, buttonVariants } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { AtivoBadge, VinculoBadge } from '@/components/hub/status-badge';
import { ListSkeleton } from '@/components/hub/table-skeleton';
import { obterMotorista, MotoristaApiError } from '@/lib/hub/motoristas-api';
import type { MotoristaDetalhe } from '@/lib/hub/motoristas-dto';

/** Lógica isolada do JSX (mesmo padrão de `useVinculoMotoristaDialog`). */
export function useMotoristaDetalheDialog() {
  const [open, setOpen] = useState(false);
  const [motoristaId, setMotoristaId] = useState<number | null>(null);
  const [detalhe, setDetalhe] = useState<MotoristaDetalhe | null>(null);
  const [carregando, setCarregando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  const buscar = useCallback(async (id: number) => {
    setCarregando(true);
    setErro(null);
    try {
      setDetalhe(await obterMotorista(id));
    } catch (e) {
      setErro(e instanceof MotoristaApiError ? e.message : 'Não foi possível carregar o motorista.');
    } finally {
      setCarregando(false);
    }
  }, []);

  const abrir = useCallback(
    (id: number) => {
      setMotoristaId(id);
      setDetalhe(null);
      setOpen(true);
      buscar(id);
    },
    [buscar]
  );

  const refetch = useCallback(() => {
    if (motoristaId !== null) buscar(motoristaId);
  }, [motoristaId, buscar]);

  return { open, setOpen, motoristaId, detalhe, carregando, erro, abrir, refetch };
}

interface MotoristaDetalheDialogProps {
  state: ReturnType<typeof useMotoristaDetalheDialog>;
}

export function MotoristaDetalheDialog({ state: v }: MotoristaDetalheDialogProps) {
  return (
    <Dialog open={v.open} onOpenChange={v.setOpen}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Detalhes do motorista</DialogTitle>
          <DialogDescription>
            Dados cadastrais da pessoa entregadora. CNPJ e cadastro vêm da conta de acesso vinculada.
          </DialogDescription>
        </DialogHeader>

        {v.carregando ? (
          <ListSkeleton label="Carregando motorista..." linhas={4} />
        ) : v.erro ? (
          <div role="alert" className="flex flex-col items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-6 text-center">
            <AlertCircle className="size-6 text-destructive" aria-hidden="true" />
            <p className="text-sm font-medium text-destructive">{v.erro}</p>
            <Button size="sm" variant="outline" className="min-h-11 sm:min-h-8" onClick={v.refetch}>
              Tentar novamente
            </Button>
          </div>
        ) : v.detalhe ? (
          <dl className="grid grid-cols-[auto_1fr] items-center gap-x-6 gap-y-3 text-sm">
            <dt className="text-muted-foreground">Nome</dt>
            <dd className="font-medium">{v.detalhe.nome || '—'}</dd>

            <dt className="text-muted-foreground">CNPJ</dt>
            <dd className="tabular-nums">{v.detalhe.vinculo?.cnpjPrestadorMascarado || '—'}</dd>

            <dt className="text-muted-foreground">Cadastro</dt>
            <dd className="flex flex-wrap items-center gap-2">
              <VinculoBadge vinculado={v.detalhe.vinculo !== null} />
              {v.detalhe.vinculo && (
                <span className="text-muted-foreground">conta: {v.detalhe.vinculo.nome}</span>
              )}
            </dd>

            <dt className="text-muted-foreground">Situação</dt>
            <dd>
              <AtivoBadge ativo={v.detalhe.ativo} />
            </dd>
          </dl>
        ) : null}

        <DialogFooter>
          <Button variant="outline" className="min-h-11 sm:min-h-9" onClick={() => v.setOpen(false)}>
            Fechar
          </Button>
          {v.motoristaId !== null && (
            <Link
              href={`/hub/dashboard/motoristas/${v.motoristaId}`}
              className={buttonVariants({ variant: 'default', className: 'min-h-11 sm:min-h-9' })}
            >
              Ver página completa
              <ChevronRight className="size-4" aria-hidden="true" />
            </Link>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

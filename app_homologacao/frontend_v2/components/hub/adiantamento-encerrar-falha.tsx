'use client';

// adiantamento-motorista — components/hub/adiantamento-encerrar-falha.tsx
// (tasks.md 7.3.5, D-23): "Encerrar sem pagamento" — visível SÓ em `FALHOU`,
// motivo obrigatório, diálogo DISTINTO de rejeitar/reprocessar (rota
// POST /:id/encerrar-falha, RPC hub_adiantamento_encerrar_falha FALHOU ->
// ENCERRADA). Componente próprio (padrão `adiantamento-*.tsx` de diálogos,
// Project Structure F7) em vez de reusar `adiantamento-acao-dialog.tsx`:
// é a única ação que encerra em definitivo uma solicitação que já FALHOU
// (não retorna à fila de reprocessamento, ao contrário de "Reprocessar").
//
// Ref: docs/specs/adiantamento-motorista/contracts/hub-api.md §Solicitações;
// prototipo H02 (nota "Outras ações por estado").

import { useCallback, useId, useState } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  AdiantamentosApiError,
  encerrarSemPagamento,
  type SolicitacaoResumo,
} from '@/lib/hub/adiantamentos-api';
import { cn } from '@/lib/utils';

const MOTIVO_MAX = 500;

export interface UseEncerrarFalhaDialogArgs {
  id: number;
  onSucesso: (resumo: SolicitacaoResumo) => void;
}

/** Lógica isolada do JSX (mesmo padrão de `useAdiantamentoAcaoDialog`). */
export function useEncerrarFalhaDialog({ id, onSucesso }: UseEncerrarFalhaDialogArgs) {
  const [open, setOpenState] = useState(false);
  const [motivo, setMotivo] = useState('');
  const [confirmando, setConfirmando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  const setOpen = useCallback((next: boolean) => {
    if (confirmando) return; // CHK011 — não fecha no meio de uma requisição em voo
    setOpenState(next);
    if (!next) {
      setMotivo('');
      setErro(null);
    }
  }, [confirmando]);

  const abrir = useCallback(() => setOpen(true), [setOpen]);
  const fechar = useCallback(() => setOpen(false), [setOpen]);
  const motivoOk = motivo.trim().length >= 3;

  const confirmar = useCallback(async () => {
    if (!motivoOk) return;
    setConfirmando(true);
    setErro(null);
    try {
      const resumo = await encerrarSemPagamento(id, motivo.trim());
      onSucesso(resumo);
      setOpenState(false);
      setMotivo('');
    } catch (e) {
      setErro(e instanceof AdiantamentosApiError ? e.message : 'Não foi possível encerrar a solicitação.');
    } finally {
      setConfirmando(false);
    }
  }, [motivoOk, id, motivo, onSucesso]);

  return { open, setOpen, abrir, fechar, motivo, setMotivo, confirmando, erro, motivoOk, confirmar };
}

export function EncerrarFalhaDialog({ d }: { d: ReturnType<typeof useEncerrarFalhaDialog> }) {
  const inputId = useId();

  return (
    <Dialog open={d.open} onOpenChange={d.setOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="size-4 shrink-0 text-destructive" aria-hidden="true" />
            Encerrar sem pagamento?
          </DialogTitle>
          <DialogDescription>
            A solicitação sai definitivamente da fila de reprocessamento e vai para ENCERRADA. Essa ação não pode ser
            desfeita — se o motorista precisar do adiantamento, ele terá que solicitar de novo.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between">
              <label htmlFor={`${inputId}-motivo`} className="text-sm font-medium">
                Motivo (obrigatório)
              </label>
              <span className={cn('text-xs', d.motivo.length > MOTIVO_MAX ? 'text-destructive' : 'text-muted-foreground')}>
                {d.motivo.length}/{MOTIVO_MAX}
              </span>
            </div>
            <textarea
              id={`${inputId}-motivo`}
              value={d.motivo}
              maxLength={MOTIVO_MAX}
              disabled={d.confirmando}
              onChange={(e) => d.setMotivo(e.target.value)}
              rows={3}
              placeholder="Explique por que o pagamento não vai acontecer — o motorista pode ver este texto."
              className="w-full rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50 md:text-sm dark:bg-input/30"
            />
          </div>

          {d.erro && (
            <p role="alert" className="flex items-center gap-2 rounded-md bg-destructive/10 px-3 py-2 text-sm font-medium text-destructive">
              <AlertTriangle className="size-4 shrink-0" aria-hidden="true" />
              {d.erro}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" className="min-h-11 sm:min-h-8" disabled={d.confirmando} onClick={d.fechar}>
            Voltar
          </Button>
          <Button variant="destructive" className="min-h-11 sm:min-h-8" disabled={!d.motivoOk || d.confirmando} onClick={d.confirmar}>
            {d.confirmando && <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden="true" />}
            Encerrar sem pagamento
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

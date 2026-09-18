'use client';

// adiantamento-motorista — components/hub/adiantamento-cancelar-lote-dialog.tsx
// (tasks.md 7.7.3, FR-035): cancela um lote (motivo obrigatório) e devolve
// as solicitações para LIBERADA. Depois do 1º download (`status EXPORTADO`,
// data-model.md §State Transitions), a RPC exige a confirmação explícita de
// que o arquivo NÃO foi enviado à Transfeera
// (`CONFIRMACAO_NAO_ENVIADO_OBRIGATORIA`, hub_adiantamento_lote_cancelar) —
// por isso o checkbox extra só aparece quando `lote.status === 'EXPORTADO'`.
//
// Ref: docs/specs/adiantamento-motorista/contracts/hub-api.md §Pagamentos e
// lotes; spec.md US5 cenário 9, FR-035, edge #20; prototipo H12 (botão
// "Cancelar lote").

import { useCallback, useId, useState } from 'react';
import { AlertCircle, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { AdiantamentosApiError, cancelarLote, type Lote } from '@/lib/hub/adiantamentos-api';
import { cn } from '@/lib/utils';

const MOTIVO_MAX = 500;

export interface UseCancelarLoteDialogArgs {
  loteId: number;
  /** Status atual do lote — string vazia (lote ainda não carregado) nunca
   * exige a declaração, mesmo comportamento seguro de "ainda não sei". */
  status: string;
  onSucesso: (lote: Lote) => void;
}

/** Lógica isolada do JSX (mesmo padrão de `useEncerrarFalhaDialog`). */
export function useCancelarLoteDialog({ loteId, status, onSucesso }: UseCancelarLoteDialogArgs) {
  const [open, setOpenState] = useState(false);
  const [motivo, setMotivo] = useState('');
  const [naoEnviado, setNaoEnviado] = useState(false);
  const [confirmando, setConfirmando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  // FR-035: só EXPORTADO (já baixado ao menos uma vez) exige a declaração
  // explícita de "não foi enviado à Transfeera" — GERADO ainda não foi baixado.
  const exigeDeclaracao = status === 'EXPORTADO';

  const setOpen = useCallback((next: boolean) => {
    if (confirmando) return; // CHK011 — não fecha no meio de uma requisição em voo
    setOpenState(next);
    if (!next) {
      setMotivo('');
      setNaoEnviado(false);
      setErro(null);
    }
  }, [confirmando]);

  const abrir = useCallback(() => setOpen(true), [setOpen]);
  const fechar = useCallback(() => setOpen(false), [setOpen]);
  const motivoOk = motivo.trim().length >= 3;
  const podeConfirmar = motivoOk && (!exigeDeclaracao || naoEnviado);

  const confirmar = useCallback(async () => {
    if (!podeConfirmar) return;
    setConfirmando(true);
    setErro(null);
    try {
      const atualizado = await cancelarLote(loteId, motivo.trim(), naoEnviado);
      onSucesso(atualizado);
      setOpenState(false);
      setMotivo('');
      setNaoEnviado(false);
    } catch (e) {
      setErro(e instanceof AdiantamentosApiError ? e.message : 'Não foi possível cancelar o lote.');
    } finally {
      setConfirmando(false);
    }
  }, [podeConfirmar, loteId, motivo, naoEnviado, onSucesso]);

  return { open, setOpen, abrir, fechar, motivo, setMotivo, naoEnviado, setNaoEnviado, exigeDeclaracao, confirmando, erro, podeConfirmar, confirmar };
}

export function CancelarLoteDialog({ d }: { d: ReturnType<typeof useCancelarLoteDialog> }) {
  const inputId = useId();

  return (
    <Dialog open={d.open} onOpenChange={d.setOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Cancelar lote?</DialogTitle>
          <DialogDescription>
            As solicitações voltam a liberadas e podem entrar num próximo lote. Esta ação é auditada.
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
              placeholder="Explique por que este lote está sendo cancelado."
              className="w-full rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50 md:text-sm dark:bg-input/30"
            />
          </div>

          {d.exigeDeclaracao && (
            <label className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/10 p-2.5 text-sm">
              <Checkbox
                checked={d.naoEnviado}
                disabled={d.confirmando}
                onCheckedChange={(v) => d.setNaoEnviado(v === true)}
                aria-label="Confirmo que este arquivo não foi enviado à Transfeera"
              />
              <span>Confirmo que este arquivo <strong>não foi enviado</strong> à Transfeera.</span>
            </label>
          )}

          {d.erro && (
            <p role="alert" className="flex items-center gap-2 rounded-md bg-destructive/10 px-3 py-2 text-sm font-medium text-destructive">
              <AlertCircle className="size-4 shrink-0" aria-hidden="true" />
              {d.erro}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" className="min-h-11 sm:min-h-8" disabled={d.confirmando} onClick={d.fechar}>
            Voltar
          </Button>
          <Button variant="destructive" className="min-h-11 sm:min-h-8" disabled={!d.podeConfirmar || d.confirmando} onClick={d.confirmar}>
            {d.confirmando && <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden="true" />}
            Cancelar lote
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

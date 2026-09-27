'use client';

// adiantamento-motorista — components/hub/adiantamento-fechar-apuracao-dialog.tsx
// (tasks.md 7.8.2/7.8.4, D-23, FR-041): fecha um período de apuração —
// grava um retrato permanente por motorista. Sem motivo (FR-041 não exige
// um); a única entrada é a confirmação. Recusa com `APURACAO_COM_PENDENCIAS`
// carrega a contagem de solicitações pendentes POR STATUS
// (routes/hub-adiantamentos.js:1213-1216) — mostrada aqui, não escondida
// atrás de uma mensagem genérica (7.8.4).
//
// F3 (repasse-saldo-minimo, tasks.md 3.3.3): fechar passa a poder RETER quem
// fica abaixo do piso configurado — o total pago não é mais necessariamente
// o remanescente inteiro. O aviso deixa isso explícito para quem confirma.
// Fechamento fora de ordem (pular ou repetir uma semana) é recusado com
// `APURACAO_FORA_DE_ORDEM` — mensagem tratada em lib/hub/adiantamentos-api.ts.
//
// Ref: docs/specs/adiantamento-motorista/contracts/hub-api.md §Repasse;
// docs/specs/repasse-saldo-minimo/contracts/hub-repasse-api.md;
// spec.md US6 cenário 5, FR-041; prototipo H14 (botão "Fechar apuração").

import { useCallback, useState } from 'react';
import { Loader2 } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { rotuloStatusAdiantamento } from '@/components/hub/status-badge';
import {
  AdiantamentosApiError,
  fecharRepasse,
  type FecharRepasseResponse,
} from '@/lib/hub/adiantamentos-api';

export interface UseFecharApuracaoDialogArgs {
  periodo: string;
  onSucesso: (resultado: FecharRepasseResponse) => void;
}

/** Lógica isolada do JSX (mesmo padrão de `useEncerrarFalhaDialog`). */
export function useFecharApuracaoDialog({ periodo, onSucesso }: UseFecharApuracaoDialogArgs) {
  const [open, setOpenState] = useState(false);
  const [confirmando, setConfirmando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [pendencias, setPendencias] = useState<Record<string, number> | null>(null);

  const setOpen = useCallback((next: boolean) => {
    if (confirmando) return; // CHK011 — não fecha no meio de uma requisição em voo
    setOpenState(next);
    if (next) {
      setErro(null);
      setPendencias(null);
    }
  }, [confirmando]);

  const abrir = useCallback(() => setOpen(true), [setOpen]);
  const fechar = useCallback(() => setOpen(false), [setOpen]);

  const confirmar = useCallback(async () => {
    setConfirmando(true);
    setErro(null);
    setPendencias(null);
    try {
      const resultado = await fecharRepasse(periodo);
      onSucesso(resultado);
      setOpenState(false);
    } catch (e) {
      if (e instanceof AdiantamentosApiError && e.codigo === 'APURACAO_COM_PENDENCIAS') {
        setPendencias(e.detalhe ?? {});
      } else {
        setErro(e instanceof AdiantamentosApiError ? e.message : 'Não foi possível fechar a apuração.');
      }
    } finally {
      setConfirmando(false);
    }
  }, [periodo, onSucesso]);

  return { open, setOpen, abrir, fechar, confirmando, erro, pendencias, confirmar };
}

export function FecharApuracaoDialog({ d }: { d: ReturnType<typeof useFecharApuracaoDialog> }) {
  return (
    <AlertDialog open={d.open} onOpenChange={d.setOpen}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Fechar apuração deste período?</AlertDialogTitle>
          <AlertDialogDescription>
            Grava um retrato permanente do remanescente por motorista — não muda depois, mesmo que dados de
            origem sejam corrigidos (FR-041). Quem fica abaixo do valor mínimo configurado não recebe nesta
            semana: o valor passa para o repasse da próxima. Esta ação não pode ser desfeita.
          </AlertDialogDescription>
        </AlertDialogHeader>

        {d.pendencias && (
          <div role="alert" className="flex flex-col gap-1.5 rounded-md bg-warning/10 px-3 py-2 text-sm text-warning-strong">
            <p className="font-medium">Há solicitações pendentes neste período — o fechamento foi recusado.</p>
            <ul className="flex flex-col gap-0.5 pl-4 text-xs">
              {Object.entries(d.pendencias).map(([status, quantidade]) => (
                <li key={status} className="list-disc">
                  {rotuloStatusAdiantamento(status)}: <span className="font-mono">{quantidade}</span>
                </li>
              ))}
            </ul>
            <p className="text-xs">Confirme os pagamentos, reprocesse ou encerre sem pagamento as falhas, depois tente de novo.</p>
          </div>
        )}

        {d.erro && !d.pendencias && (
          <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm font-medium text-destructive">
            {d.erro}
          </p>
        )}

        <AlertDialogFooter>
          <AlertDialogCancel disabled={d.confirmando}>Voltar</AlertDialogCancel>
          <AlertDialogAction onClick={d.confirmar} disabled={d.confirmando}>
            {d.confirmando && <Loader2 className="mr-2 size-4 motion-safe:animate-spin" aria-hidden="true" />}
            Fechar apuração
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

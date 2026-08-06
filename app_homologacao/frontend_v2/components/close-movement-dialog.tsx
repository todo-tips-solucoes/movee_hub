'use client';

import { useState } from 'react';
import { Lock, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { toast } from 'sonner';
import type { StatsData } from '@/types';

interface CloseMovementDialogProps {
  onConfirm: () => Promise<void>;
  /** Números do movimento para o resumo de impacto — omitido, o diálogo cai
   * no texto sem resumo (callers legados que não têm stats à mão). */
  stats?: StatsData | null;
}

export function CloseMovementDialog({ onConfirm, stats }: CloseMovementDialogProps) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleConfirm = async () => {
    try {
      setLoading(true);
      await onConfirm();
      toast.success('Movimento fechado com sucesso!');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro ao fechar o movimento');
    } finally {
      setLoading(false);
      setOpen(false);
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger render={<Button size="sm" variant="outline" className="gap-1.5 text-warm-2 hover:text-warm-3" />}>
        <Lock className="h-4 w-4" />
        Fechar movimento
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Fechar o movimento?</AlertDialogTitle>
          {/* impeccable rodada 2 (P1): a ação mais irreversível do fluxo agora
              fala o mesmo idioma do confirm de disparo — pt-BR correto e
              resumo quantitativo do que será travado. */}
          <AlertDialogDescription>
            Esta ação é permanente: com o movimento fechado, não será mais possível editar registros
            nem disparar envios para ele.
            {stats && stats.total > 0 && (
              <>
                {' '}
                Neste momento o movimento tem {stats.total} registro{stats.total === 1 ? '' : 's'},{' '}
                {stats.msgEnviada} já com mensagem enviada e {stats.total - stats.msgEnviada} ainda
                sem envio.
              </>
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={loading}>Cancelar</AlertDialogCancel>
          <AlertDialogAction onClick={handleConfirm} disabled={loading} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
            {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Fechar movimento
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

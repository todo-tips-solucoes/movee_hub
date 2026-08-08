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
  /** Disparo em andamento. Fechar o movimento no meio do envio o lacra com
   * parte dos motoristas notificados e parte não — daí o bloqueio
   * (impeccable rodada 5, P1: o botão seguia clicável durante o disparo). */
  isActive?: boolean;
  /** Período do movimento em pt-BR ("01/08/2026 a 07/08/2026"), quando conhecido. */
  periodo?: string | null;
  /** A lista do movimento falhou ao carregar: `stats` está zerado por erro, não
   *  porque o movimento esteja vazio. Bloqueia a confirmação (rodada 7). */
  dadosIndisponiveis?: boolean;
}

export function CloseMovementDialog({
  onConfirm,
  stats,
  isActive = false,
  periodo = null,
  dadosIndisponiveis = false,
}: CloseMovementDialogProps) {
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
      {/* impeccable rodada 5 (P1). Duas correções no mesmo gatilho:
          1. CONTRASTE: era `text-warm-2` (#2ceabc), que sobre o botão outline
             claro dá 1,54:1 — e 1,39:1 sobre o fundo bege da página. O mínimo
             AA é 4,5:1 para texto e 3:1 para componente. Era, aliás, a única
             ocorrência de `warm-*` em todo o código de componentes: a cor de
             assinatura da marca não pertence a uma ação de encerramento.
          2. HIERARQUIA: renderizada igual ao "Download XML" ao lado, a ação
             irreversível lia-se como a menos importante das seis. O idioma
             destrutivo aqui é o mesmo que `process-controls.tsx` já usa no
             botão de parar. */}
      <AlertDialogTrigger
        render={
          <Button
            size="sm"
            variant="outline"
            disabled={isActive}
            title={
              isActive
                ? 'Não é possível fechar o movimento durante um disparo em andamento — pare o envio primeiro.'
                : undefined
            }
            className="gap-1.5 border-destructive/50 text-destructive hover:bg-destructive/10 hover:text-destructive"
          />
        }
      >
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
            {/* rodada 7: QUAL movimento. A pergunta era feita sem nunca nomear
                o período que está sendo lacrado. */}
            {periodo && (
              <>
                Movimento de <strong className="text-foreground">{periodo}</strong>.{' '}
              </>
            )}
            Esta ação é permanente: com o movimento fechado, não será mais possível editar registros
            nem disparar envios para ele.
            {/* impeccable rodada 7 (P1): sem os números, não há confirmação de
                impacto — e uma falha de carga zera `stats`, então o texto
                genérico sozinho descreveria como vazio um movimento de 340
                linhas. Neste caso o diálogo diz que não sabe, e a confirmação
                sai do ar. */}
            {dadosIndisponiveis ? (
              <>
                {' '}
                <strong className="text-destructive">
                  Os dados do movimento não puderam ser carregados
                </strong>
                , então não é possível mostrar o que será travado. Recarregue a lista antes de
                fechar.
              </>
            ) : (
              stats &&
              stats.total > 0 && (
                <>
                  {' '}
                  Neste momento o movimento tem {stats.total} registro{stats.total === 1 ? '' : 's'},{' '}
                  {stats.msgEnviada} já com mensagem enviada e {stats.total - stats.msgEnviada} ainda
                  sem envio.
                </>
              )
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={loading}>Cancelar</AlertDialogCancel>
          <AlertDialogAction onClick={handleConfirm} disabled={loading || dadosIndisponiveis} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
            {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Fechar movimento
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

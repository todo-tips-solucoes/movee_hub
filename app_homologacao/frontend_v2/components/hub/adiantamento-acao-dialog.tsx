'use client';

// adiantamento-motorista — components/hub/adiantamento-acao-dialog.tsx (tasks.md 7.3.3)
//
// Diálogo único e parametrizado para as 5 ações de transição do detalhe da
// solicitação (H02): rejeitar/recalcular/encerrar/atualizar-conta/reprocessar.
// As 4 primeiras (exceto recalcular) exigem motivo (>=3, <=500 chars — mesma
// regra de `motivoValido` em routes/hub-adiantamentos.js); recalcular não
// pede motivo. Mesmo padrão de hook "isolado do JSX" de
// `useCredencialMotoristaDialog`/`useVinculoMotoristaDialog`.
//
// "Encerrar sem pagamento" (D-23, tasks.md 7.3.5) tem diálogo PRÓPRIO
// (`adiantamento-encerrar-falha.tsx`) — visualmente distinto por ser
// destrutivo num sentido diferente (interrompe de vez uma solicitação que já
// FALHOU), conforme nota do protótipo H02.
//
// Ref: docs/specs/adiantamento-motorista/contracts/hub-api.md §Solicitações;
// prototipo H02.

import { useCallback, useId, useState } from 'react';
import { AlertCircle, Loader2 } from 'lucide-react';
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
  atualizarContaSolicitacao,
  encerrarSolicitacao,
  recalcularSolicitacao,
  rejeitarSolicitacao,
  reprocessarSolicitacao,
  type SolicitacaoResumo,
} from '@/lib/hub/adiantamentos-api';
import { cn } from '@/lib/utils';

export type AcaoAdiantamento = 'rejeitar' | 'recalcular' | 'encerrar' | 'atualizar-conta' | 'reprocessar';

const MOTIVO_MAX = 500;

interface AcaoConfig {
  titulo: string;
  descricao: string;
  labelConfirmar: string;
  destrutiva: boolean;
  exigeMotivo: boolean;
  chamar: (id: number, motivo: string) => Promise<SolicitacaoResumo>;
}

const CONFIG: Record<AcaoAdiantamento, AcaoConfig> = {
  rejeitar: {
    titulo: 'Rejeitar solicitação?',
    descricao: 'A solicitação não poderá entrar em lote. O motorista recebe uma notificação com o motivo.',
    labelConfirmar: 'Rejeitar solicitação',
    destrutiva: true,
    exigeMotivo: true,
    chamar: (id, motivo) => rejeitarSolicitacao(id, motivo),
  },
  recalcular: {
    titulo: 'Recalcular solicitação?',
    descricao: 'Refaz o cálculo com a produção mais recente disponível.',
    labelConfirmar: 'Recalcular',
    destrutiva: false,
    exigeMotivo: false,
    chamar: (id) => recalcularSolicitacao(id),
  },
  encerrar: {
    titulo: 'Encerrar solicitação?',
    descricao: 'A solicitação sai da fila de produção (fica INELEGÍVEL) e não pode mais ser retomada.',
    labelConfirmar: 'Encerrar',
    destrutiva: true,
    exigeMotivo: true,
    chamar: (id, motivo) => encerrarSolicitacao(id, motivo),
  },
  'atualizar-conta': {
    titulo: 'Atualizar conta de destino?',
    descricao: 'Troca a conta congelada nesta solicitação pela conta aprovada vigente do motorista (pendência CONTA_ALTERADA).',
    labelConfirmar: 'Atualizar conta',
    destrutiva: false,
    exigeMotivo: true,
    chamar: (id, motivo) => atualizarContaSolicitacao(id, motivo),
  },
  reprocessar: {
    titulo: 'Reprocessar solicitação?',
    descricao: 'Volta para a fila de pagamento (LIBERADA) para tentar novamente.',
    labelConfirmar: 'Reprocessar',
    destrutiva: false,
    exigeMotivo: true,
    chamar: (id, motivo) => reprocessarSolicitacao(id, motivo),
  },
};

export interface UseAdiantamentoAcaoDialogArgs {
  id: number;
  /** Chamado após ação bem-sucedida com o `SolicitacaoResumo` atualizado —
   * a página-mãe funde o resultado no `SolicitacaoDetalhe` corrente. */
  onSucesso: (resumo: SolicitacaoResumo) => void;
}

/** Lógica isolada do JSX (mesmo padrão de `useCredencialMotoristaDialog`). */
export function useAdiantamentoAcaoDialog({ id, onSucesso }: UseAdiantamentoAcaoDialogArgs) {
  const [acaoAberta, setAcaoAberta] = useState<AcaoAdiantamento | null>(null);
  const [motivo, setMotivo] = useState('');
  const [confirmando, setConfirmando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  const abrir = useCallback((acao: AcaoAdiantamento) => {
    setAcaoAberta(acao);
    setMotivo('');
    setErro(null);
  }, []);

  const fechar = useCallback(() => {
    if (confirmando) return; // CHK011 — não fecha no meio de uma requisição em voo
    setAcaoAberta(null);
    setMotivo('');
    setErro(null);
  }, [confirmando]);

  const motivoOk = !CONFIG[acaoAberta ?? 'recalcular'].exigeMotivo || motivo.trim().length >= 3;

  const confirmar = useCallback(async () => {
    if (!acaoAberta || !motivoOk) return;
    setConfirmando(true);
    setErro(null);
    try {
      const resumo = await CONFIG[acaoAberta].chamar(id, motivo.trim());
      onSucesso(resumo);
      setAcaoAberta(null);
      setMotivo('');
    } catch (e) {
      setErro(e instanceof AdiantamentosApiError ? e.message : 'Não foi possível concluir a ação.');
    } finally {
      setConfirmando(false);
    }
  }, [acaoAberta, motivoOk, id, motivo, onSucesso]);

  return { acaoAberta, abrir, fechar, motivo, setMotivo, confirmando, erro, motivoOk, confirmar };
}

export function AdiantamentoAcaoDialog({ d }: { d: ReturnType<typeof useAdiantamentoAcaoDialog> }) {
  const inputId = useId();
  const config = d.acaoAberta ? CONFIG[d.acaoAberta] : null;

  return (
    <Dialog open={d.acaoAberta !== null} onOpenChange={(open) => !open && d.fechar()}>
      {config && (
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{config.titulo}</DialogTitle>
            <DialogDescription>{config.descricao}</DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-3">
            {config.exigeMotivo && (
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
                  placeholder="Explique o motivo — o motorista pode ver este texto."
                  className="w-full rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50 md:text-sm dark:bg-input/30"
                />
              </div>
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
            {/* CHK011 — desabilitado + estado de carregamento entre clique e
                resposta (impede um 2º clique disparar uma 2ª requisição). */}
            <Button
              variant={config.destrutiva ? 'destructive' : 'default'}
              className="min-h-11 sm:min-h-8"
              disabled={!d.motivoOk || d.confirmando}
              onClick={d.confirmar}
            >
              {d.confirmando && <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden="true" />}
              {config.labelConfirmar}
            </Button>
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  );
}

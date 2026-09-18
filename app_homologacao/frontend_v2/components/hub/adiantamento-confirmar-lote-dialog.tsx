'use client';

// adiantamento-motorista — components/hub/adiantamento-confirmar-lote-dialog.tsx
// (tasks.md 7.7.2, H15, D-16): confirmação MANUAL do resultado de um lote —
// o caminho definitivo (importar o retorno da Transfeera) está bloqueado por
// Q-B1 (FASE 9, sem arquivo real de exemplo — Constitution VI). Só lotes
// `EXPORTADO` podem ser confirmados (`hub_adiantamento_lote_confirmar`,
// infra/hub/migrations/0067:1729-1745, `TRANSICAO_INVALIDA` fora disso).
//
// Regra do backend espelhada aqui (não reimplementada, só refletida na
// tela): todo item `incluido` que NÃO for marcado como falha vira `pago`
// automaticamente — por isso o diálogo lista os itens ainda `incluido` com
// um checkbox "Falhou" opt-in, motivo obrigatório só nos marcados.
//
// Ref: docs/specs/adiantamento-motorista/contracts/hub-api.md §Pagamentos e
// lotes; spec.md US5 cenário 7, FR-033; prototipo H15.

import { useCallback, useId, useMemo, useState } from 'react';
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
import {
  AdiantamentosApiError,
  confirmarLote,
  type Lote,
  type LoteItemDetalhe,
} from '@/lib/hub/adiantamentos-api';
import { cn } from '@/lib/utils';

const MOTIVO_MAX = 500;

interface FalhaState {
  marcado: boolean;
  motivo: string;
}

export interface UseConfirmarLoteDialogArgs {
  loteId: number;
  /** Todos os itens do lote — o hook filtra os `incluido` (únicos elegíveis). */
  itens: LoteItemDetalhe[];
  onSucesso: (lote: Lote) => void;
}

function estadoInicial(incluidos: LoteItemDetalhe[]): Record<number, FalhaState> {
  return Object.fromEntries(incluidos.map((i) => [i.id, { marcado: false, motivo: '' }]));
}

/** Lógica isolada do JSX (mesmo padrão de `useAdiantamentoAcaoDialog`). */
export function useConfirmarLoteDialog({ loteId, itens, onSucesso }: UseConfirmarLoteDialogArgs) {
  const incluidos = useMemo(() => itens.filter((i) => i.situacao === 'incluido'), [itens]);
  const [open, setOpenState] = useState(false);
  const [falhas, setFalhas] = useState<Record<number, FalhaState>>(() => estadoInicial(incluidos));
  const [confirmando, setConfirmando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  const setOpen = useCallback((next: boolean) => {
    if (confirmando) return; // CHK011 — não fecha no meio de uma requisição em voo
    setOpenState(next);
    if (next) setFalhas(estadoInicial(incluidos));
    setErro(null);
  }, [confirmando, incluidos]);

  const abrir = useCallback(() => setOpen(true), [setOpen]);
  const fechar = useCallback(() => setOpen(false), [setOpen]);

  const marcarFalha = useCallback((id: number, marcado: boolean) => {
    setFalhas((atual) => ({ ...atual, [id]: { marcado, motivo: atual[id]?.motivo ?? '' } }));
  }, []);

  const setMotivo = useCallback((id: number, motivo: string) => {
    setFalhas((atual) => ({ ...atual, [id]: { marcado: atual[id]?.marcado ?? false, motivo } }));
  }, []);

  const marcados = Object.entries(falhas)
    .filter(([, v]) => v.marcado)
    .map(([id, v]) => ({ id: Number(id), motivo: v.motivo }));
  const todosMotivosOk = marcados.every((f) => f.motivo.trim().length >= 3);

  const confirmar = useCallback(async () => {
    if (!todosMotivosOk) return;
    setConfirmando(true);
    setErro(null);
    try {
      const lote = await confirmarLote(loteId, {
        falhas: marcados.map((f) => ({ id: f.id, motivo: f.motivo.trim() })),
      });
      onSucesso(lote);
      setOpenState(false);
    } catch (e) {
      setErro(e instanceof AdiantamentosApiError ? e.message : 'Não foi possível confirmar o resultado do lote.');
    } finally {
      setConfirmando(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [todosMotivosOk, JSON.stringify(marcados), loteId, onSucesso]);

  return {
    open, setOpen, abrir, fechar, incluidos, falhas, marcarFalha, setMotivo,
    confirmando, erro, todosMotivosOk, confirmar, marcadosCount: marcados.length,
  };
}

export function ConfirmarLoteDialog({ d }: { d: ReturnType<typeof useConfirmarLoteDialog> }) {
  const inputId = useId();

  return (
    <Dialog open={d.open} onOpenChange={d.setOpen}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Confirmar resultado do lote?</DialogTitle>
          <DialogDescription>
            Use depois de fechar o lote na Transfeera. Marque só as exceções — os demais viram pagos
            automaticamente.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          {d.incluidos.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nenhum item pendente de confirmação neste lote.</p>
          ) : (
            <ul className="flex flex-col gap-3">
              {d.incluidos.map((item) => {
                const falha = d.falhas[item.id];
                return (
                  <li key={item.id} className="flex flex-col gap-2 rounded-md border p-2.5">
                    <label className="flex items-start gap-2 text-sm">
                      <Checkbox
                        checked={falha?.marcado ?? false}
                        disabled={d.confirmando}
                        onCheckedChange={(v) => d.marcarFalha(item.id, v === true)}
                        aria-label={`Marcar ${item.integrationId} como falha`}
                      />
                      <span className="flex-1">
                        <span className="font-mono">{item.integrationId}</span> — {item.nome}
                      </span>
                    </label>
                    {falha?.marcado && (
                      <div className="flex flex-col gap-1 pl-6">
                        <div className="flex items-center justify-between">
                          <label htmlFor={`${inputId}-${item.id}`} className="text-xs font-medium">
                            Motivo da falha (obrigatório)
                          </label>
                          <span className={cn('text-xs', falha.motivo.length > MOTIVO_MAX ? 'text-destructive' : 'text-muted-foreground')}>
                            {falha.motivo.length}/{MOTIVO_MAX}
                          </span>
                        </div>
                        <input
                          id={`${inputId}-${item.id}`}
                          value={falha.motivo}
                          maxLength={MOTIVO_MAX}
                          disabled={d.confirmando}
                          onChange={(e) => d.setMotivo(item.id, e.target.value)}
                          placeholder="Ex.: Conta encerrada no banco de destino"
                          className="w-full rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50 dark:bg-input/30"
                        />
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
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
          <Button
            className="min-h-11 sm:min-h-8"
            disabled={!d.todosMotivosOk || d.confirmando || d.incluidos.length === 0}
            onClick={d.confirmar}
          >
            {d.confirmando && <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden="true" />}
            Confirmar resultado
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

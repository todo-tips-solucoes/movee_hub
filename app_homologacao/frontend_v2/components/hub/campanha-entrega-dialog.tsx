'use client';

// campanhas do motorista (W3a) — "Marcar como entregue" (prêmio em OBJETO).
// Registro à parte e auditado: não altera a campanha. Só uma vez por prêmio.

import { useId, useRef, useState } from 'react';
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
import { CampanhaApiError } from '@/lib/hub/campanhas-api';

export const OBSERVACAO_MAX = 300;

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Ex.: "Rafael Souza Costa — Moto Honda CG 160". */
  descricao: string;
  onRegistrar: (observacao: string) => Promise<void>;
}

function Conteudo({ descricao, onRegistrar, onOpenChange }: Omit<Props, 'open'>) {
  const id = useId();
  const [obs, setObs] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const emVoo = useRef(false);

  async function confirmar() {
    if (emVoo.current) return;
    emVoo.current = true;
    setEnviando(true);
    setErro(null);
    try {
      await onRegistrar(obs.trim());
    } catch (e) {
      setErro(e instanceof CampanhaApiError ? e.message : 'Não foi possível registrar a entrega.');
      emVoo.current = false;
      setEnviando(false);
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>Marcar como entregue</DialogTitle>
        <DialogDescription>
          {descricao}. O registro guarda a data e quem entregou, e não pode ser desfeito.
        </DialogDescription>
      </DialogHeader>
      <div className="flex flex-col gap-1">
        <label htmlFor={id} className="text-sm font-medium">
          Observação (opcional)
        </label>
        <textarea
          id={id}
          value={obs}
          maxLength={OBSERVACAO_MAX}
          rows={3}
          disabled={enviando}
          onChange={(e) => setObs(e.target.value)}
          placeholder="Ex.: retirado na base, recibo assinado."
          className="w-full rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-base outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50 md:text-sm dark:bg-input/30"
        />
      </div>
      {erro && (
        <p role="alert" className="flex items-start gap-2 rounded-md bg-destructive/10 px-3 py-2 text-sm font-medium text-destructive">
          <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          {erro}
        </p>
      )}
      <DialogFooter>
        <Button variant="outline" className="min-h-11 sm:min-h-8" onClick={() => onOpenChange(false)} disabled={enviando}>
          Voltar
        </Button>
        <Button className="min-h-11 sm:min-h-8" onClick={confirmar} disabled={enviando}>
          {enviando && <Loader2 className="mr-2 size-4 motion-safe:animate-spin" aria-hidden="true" />}
          Registrar entrega
        </Button>
      </DialogFooter>
    </>
  );
}

export function CampanhaEntregaDialog({ open, onOpenChange, descricao, onRegistrar }: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <Conteudo descricao={descricao} onRegistrar={onRegistrar} onOpenChange={onOpenChange} />
      </DialogContent>
    </Dialog>
  );
}

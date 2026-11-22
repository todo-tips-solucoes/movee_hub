'use client';

// campanhas do motorista (W3a) — "Cancelar campanha": motivo obrigatório
// (5..500, CONTRATOS §6), auditado no backend. Mesmo molde do
// `adiantamento-acao-dialog` (textarea + contador + erro em `role="alert"`).

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
import { cn } from '@/lib/utils';

export const MOTIVO_MIN = 5;
export const MOTIVO_MAX = 500;

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  nome: string;
  onCancelar: (motivo: string) => Promise<void>;
}

function Conteudo({ nome, onCancelar, onOpenChange }: Omit<Props, 'open'>) {
  const id = useId();
  const [motivo, setMotivo] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const emVoo = useRef(false);
  const valido = motivo.trim().length >= MOTIVO_MIN && motivo.length <= MOTIVO_MAX;

  async function confirmar() {
    if (emVoo.current || !valido) return;
    emVoo.current = true;
    setEnviando(true);
    setErro(null);
    try {
      await onCancelar(motivo.trim());
    } catch (e) {
      setErro(e instanceof CampanhaApiError ? e.message : 'Não foi possível cancelar a campanha.');
      emVoo.current = false;
      setEnviando(false);
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>Cancelar “{nome}”?</DialogTitle>
        <DialogDescription>
          A campanha some do app dos motoristas e fica registrada aqui no hub. Não dá para desfazer. O motivo fica
          gravado na auditoria.
        </DialogDescription>
      </DialogHeader>
      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between">
          <label htmlFor={id} className="text-sm font-medium">
            Motivo (obrigatório)
          </label>
          <span className={cn('text-xs', motivo.length > MOTIVO_MAX ? 'text-destructive' : 'text-muted-foreground')}>
            {motivo.length}/{MOTIVO_MAX}
          </span>
        </div>
        <textarea
          id={id}
          value={motivo}
          maxLength={MOTIVO_MAX}
          disabled={enviando}
          onChange={(e) => setMotivo(e.target.value)}
          rows={3}
          placeholder={`Explique por que cancelar (mínimo ${MOTIVO_MIN} caracteres).`}
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
          Manter campanha
        </Button>
        <Button variant="destructive" className="min-h-11 sm:min-h-8" onClick={confirmar} disabled={!valido || enviando}>
          {enviando && <Loader2 className="mr-2 size-4 motion-safe:animate-spin" aria-hidden="true" />}
          Cancelar campanha
        </Button>
      </DialogFooter>
    </>
  );
}

export function CampanhaCancelarDialog({ open, onOpenChange, nome, onCancelar }: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <Conteudo nome={nome} onCancelar={onCancelar} onOpenChange={onOpenChange} />
      </DialogContent>
    </Dialog>
  );
}

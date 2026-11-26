'use client';

// campanhas do motorista (0133/D5) — "Alterar data" do prêmio: date + salvar. Vale depois de lançar
// (único campo mutável da campanha lançada); o backend valida a faixa e audita antes/depois.
// Vazio = sem data (volta ao comportamento padrão).

import { useId, useRef, useState } from 'react';
import { AlertCircle, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { CampanhaApiError } from '@/lib/hub/campanhas-api';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  atual: string | null;
  onSalvar: (data: string | null) => Promise<void>;
}

function Conteudo({ atual, onSalvar, onOpenChange }: Omit<Props, 'open'>) {
  const id = useId();
  const [data, setData] = useState(atual ?? '');
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const emVoo = useRef(false);

  async function salvar() {
    if (emVoo.current) return;
    emVoo.current = true;
    setEnviando(true);
    setErro(null);
    try {
      await onSalvar(data === '' ? null : data);
    } catch (e) {
      setErro(e instanceof CampanhaApiError ? e.message : 'Não foi possível alterar a data.');
      emVoo.current = false;
      setEnviando(false);
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>Data de pagamento/entrega do prêmio</DialogTitle>
        <DialogDescription>
          Dinheiro sai na planilha a partir desta data; objeto, quando a equipe registrar a entrega. Deixe vazio para não definir.
          Quem já foi exportado mantém a data gravada.
        </DialogDescription>
      </DialogHeader>
      <div className="flex flex-col gap-1">
        <label htmlFor={id} className="text-sm font-medium">Nova data</label>
        <Input id={id} type="date" className="min-h-11 sm:min-h-8 sm:w-48" value={data} disabled={enviando}
          onChange={(e) => setData(e.target.value)} />
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
        <Button className="min-h-11 sm:min-h-8" onClick={salvar} disabled={enviando}>
          {enviando && <Loader2 className="mr-2 size-4 motion-safe:animate-spin" aria-hidden="true" />}
          Salvar
        </Button>
      </DialogFooter>
    </>
  );
}

export function CampanhaDataPremioDialog({ open, onOpenChange, atual, onSalvar }: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <Conteudo atual={atual} onSalvar={onSalvar} onOpenChange={onOpenChange} />
      </DialogContent>
    </Dialog>
  );
}

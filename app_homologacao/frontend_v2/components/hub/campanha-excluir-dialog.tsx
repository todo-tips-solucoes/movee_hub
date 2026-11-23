'use client';

// campanhas do motorista — "Excluir rascunho": só rascunho (o banco recusa o resto com
// CAMPANHA_IMUTAVEL). Botão destrutivo + confirmação com o nome; usado na linha da lista e na
// tela de edição. Mesmo molde do `campanha-cancelar-dialog`.

import { useRef, useState } from 'react';
import { AlertCircle, Loader2, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { CampanhaApiError, excluirCampanha } from '@/lib/hub/campanhas-api';

interface Props {
  id: number;
  nome: string;
  /** Chamado depois de excluir (ex.: recarregar a lista ou voltar para ela). */
  onExcluida: () => void;
}

function Conteudo({ id, nome, onExcluida, onOpenChange }: Props & { onOpenChange: (o: boolean) => void }) {
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const emVoo = useRef(false);

  async function confirmar() {
    if (emVoo.current) return;
    emVoo.current = true;
    setEnviando(true);
    setErro(null);
    try {
      await excluirCampanha(id);
      toast.success('Rascunho excluído.');
      onOpenChange(false);
      onExcluida();
    } catch (e) {
      setErro(e instanceof CampanhaApiError ? e.message : 'Não foi possível excluir o rascunho.');
      emVoo.current = false;
      setEnviando(false);
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>Excluir “{nome}”?</DialogTitle>
        <DialogDescription>
          A exclusão não pode ser desfeita. O rascunho, os prêmios e as faixas somem; o registro de quem excluiu fica
          na auditoria.
        </DialogDescription>
      </DialogHeader>
      {erro && (
        <p role="alert" className="flex items-start gap-2 rounded-md bg-destructive/10 px-3 py-2 text-sm font-medium text-destructive">
          <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          {erro}
        </p>
      )}
      <DialogFooter>
        <Button variant="outline" className="min-h-11 sm:min-h-8" onClick={() => onOpenChange(false)} disabled={enviando}>
          Manter rascunho
        </Button>
        <Button variant="destructive" className="min-h-11 sm:min-h-8" onClick={confirmar} disabled={enviando}>
          {enviando && <Loader2 className="mr-2 size-4 motion-safe:animate-spin" aria-hidden="true" />}
          Excluir definitivamente
        </Button>
      </DialogFooter>
    </>
  );
}

export function CampanhaExcluirRascunho({ id, nome, onExcluida }: Props) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="outline" className="min-h-11 text-destructive sm:min-h-8" onClick={() => setOpen(true)}>
        <Trash2 className="mr-1.5 size-4" aria-hidden="true" />
        Excluir rascunho
        <span className="sr-only"> — {nome}</span>
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <Conteudo id={id} nome={nome} onExcluida={onExcluida} onOpenChange={setOpen} />
        </DialogContent>
      </Dialog>
    </>
  );
}

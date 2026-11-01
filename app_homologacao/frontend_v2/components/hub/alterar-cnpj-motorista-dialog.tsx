'use client';

// Alterar o CNPJ da conta de acesso vinculada (frente motorista-cadastro-hub F3).
// Substitui a troca que o painel legado fazia pela edição do movimento. A página-mãe
// só renderiza botão e diálogo com `motoristas.credencial` (mesmo gate da credencial).
//
// Vocabulário herdado das telas vizinhas: "CNPJ do prestador" (credencial-motorista-dialog),
// "Conta de acesso vinculada" / "Trocar" (card do detalhe) e o aviso de impacto do
// edit-dialog ("Alterar o CNPJ atualizará o cadastro de login do motorista no app.").

import { useCallback, useState } from 'react';
import { AlertCircle, AlertTriangle, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { MotoristaApiError, trocarCnpjCredencial } from '@/lib/hub/motoristas-api';
import type { TrocarCnpjResponse } from '@/lib/hub/motoristas-dto';

const soDigitos = (v: string) => v.replace(/\D/g, '');

/** Máscara visual XX.XXX.XXX/XXXX-XX; o valor interno segue só em dígitos. */
export function mascararCnpjDigitado(digitos: string): string {
  const d = digitos.slice(0, 14);
  if (d.length <= 2) return d;
  if (d.length <= 5) return `${d.slice(0, 2)}.${d.slice(2)}`;
  if (d.length <= 8) return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5)}`;
  if (d.length <= 12) return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8)}`;
  return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`;
}

export interface UseAlterarCnpjMotoristaDialogArgs {
  entregadorId: number;
  /** Chamado após a troca; a página re-busca o detalhe e avisa da conta bancária PJ. */
  onAlterado: (resposta: TrocarCnpjResponse) => void;
}

export function useAlterarCnpjMotoristaDialog({ entregadorId, onAlterado }: UseAlterarCnpjMotoristaDialogArgs) {
  const [open, setOpenState] = useState(false);
  const [cnpj, setCnpj] = useState('');
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  const setOpen = useCallback((next: boolean) => {
    setOpenState(next);
    if (!next) {
      setCnpj('');
      setErro(null);
    }
  }, []);

  const cnpjValido = cnpj.length === 14;

  const confirmar = useCallback(async () => {
    if (!cnpjValido) {
      setErro('CNPJ deve conter 14 dígitos.');
      return;
    }
    setSalvando(true);
    setErro(null);
    try {
      const resposta = await trocarCnpjCredencial(entregadorId, { cnpjPrestador: cnpj });
      onAlterado(resposta);
      setOpen(false);
    } catch (e) {
      setErro(e instanceof MotoristaApiError ? e.message : 'Falha ao alterar o CNPJ.');
    } finally {
      setSalvando(false);
    }
  }, [cnpj, cnpjValido, entregadorId, onAlterado, setOpen]);

  return { open, setOpen, cnpj, setCnpj, cnpjValido, salvando, erro, confirmar };
}

export function AlterarCnpjMotoristaDialog({ state: v }: { state: ReturnType<typeof useAlterarCnpjMotoristaDialog> }) {
  return (
    <Dialog open={v.open} onOpenChange={v.setOpen}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Alterar CNPJ</DialogTitle>
          <DialogDescription>
            Informe o novo CNPJ do prestador. Os movimentos desta empresa com o CNPJ atual passam para o novo.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <label htmlFor="alterar-cnpj" className="text-sm font-medium text-foreground">
              CNPJ do prestador
            </label>
            <Input
              id="alterar-cnpj"
              inputMode="numeric"
              autoComplete="off"
              value={mascararCnpjDigitado(v.cnpj)}
              onChange={(e) => v.setCnpj(soDigitos(e.target.value).slice(0, 14))}
              placeholder="00.000.000/0000-00"
              disabled={v.salvando}
              aria-invalid={v.cnpj.length > 0 && !v.cnpjValido}
              className="h-11 sm:h-9"
            />
            {v.cnpj.length > 0 && !v.cnpjValido && (
              <p className="text-xs text-destructive">CNPJ deve conter 14 dígitos ({v.cnpj.length}/14)</p>
            )}
          </div>
          <div
            role="note"
            className="flex items-start gap-1.5 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-300"
          >
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            <span>
              Alterar o CNPJ atualizará o cadastro de login do motorista no app. A conta bancária já cadastrada
              não é alterada.
            </span>
          </div>
          {v.erro && (
            <p role="alert" className="flex items-center gap-2 rounded-md bg-destructive/10 px-3 py-2 text-sm font-medium text-destructive">
              <AlertCircle className="size-4 shrink-0" aria-hidden="true" />
              {v.erro}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" className="min-h-11 sm:min-h-8" disabled={v.salvando} onClick={() => v.setOpen(false)}>
            Cancelar
          </Button>
          <Button className="min-h-11 sm:min-h-8" disabled={v.salvando || !v.cnpjValido} onClick={v.confirmar}>
            {v.salvando && <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden="true" />}
            Alterar CNPJ
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

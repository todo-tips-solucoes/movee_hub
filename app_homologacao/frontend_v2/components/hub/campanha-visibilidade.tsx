'use client';

// Interruptor "Motoristas veem esta campanha no app" — um só componente para o
// detalhe (liga/desliga na hora) e o formulário do rascunho (vai no corpo do POST/PUT).

import { useId } from 'react';
import { Switch } from '@/components/ui/switch';

export function CampanhaVisibilidade({
  visivel,
  onChange,
  disabled = false,
}: {
  visivel: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        <label htmlFor={id} className="text-sm font-medium">
          Motoristas veem esta campanha no app
        </label>
        <span className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground" aria-hidden="true">{visivel ? 'Ligado' : 'Desligado'}</span>
          <Switch id={id} checked={visivel} disabled={disabled} onCheckedChange={onChange} className="min-h-6" />
        </span>
      </div>
      <p className="text-sm text-muted-foreground">
        Desligado: a campanha não aparece no app (lista, card na Início, detalhe e turnos) e nenhum aviso por push é enviado.
        O cálculo, o ranking e os prêmios continuam aqui no hub. Pode ligar e desligar a qualquer momento.
      </p>
      <p className="text-xs text-muted-foreground">
        Toda campanha nasce oculta. Ao ligar durante o período, o aviso de início vai para os motoristas do público (uma vez só).
        Cada mudança fica na Auditoria.
      </p>
    </div>
  );
}

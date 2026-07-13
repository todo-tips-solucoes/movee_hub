'use client';

// hub-motorista-canonico FASE 4 (task 4.1.3, gap CHK004/CHK037
// requirements.md) — mecanismo de "copiável" do `idExterno` (uuid) na
// listagem e no detalhe do motorista (FR-016). Decisão de menor esforço:
// ícone de copiar (`navigator.clipboard`) ao lado do valor, com feedback
// visual momentâneo (ícone vira Check) — paridade visual com o resto do
// hub (mesmo padrão de toast/ícone de estado usado em outros componentes,
// ex. `components/hub/status-badge.tsx`). Alternativa avaliada e descartada:
// depender apenas de seleção nativa de texto (`user-select`) — não sinaliza
// visualmente a affordance de cópia, pior para descoberta (WCAG 2.4.4/3.2.4
// consistência de mecanismo de interação já usado alhures).
//
// `navigator.clipboard` pode estar ausente (contexto não-seguro/browser
// antigo) — falha SEMPRE silenciosa com fallback de seleção de texto via
// `title`, nunca lança/quebra a tela (defesa em profundidade, mesmo
// princípio de outros componentes best-effort do hub).

import { useCallback, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';

interface CopyableUuidProps {
  value: string;
  /** Rótulo acessível do botão (ex.: "Copiar identificador do motorista"). */
  label?: string;
  className?: string;
}

/** uuid em fonte monoespaçada + botão de copiar com feedback momentâneo. */
export function CopyableUuid({ value, label = 'Copiar identificador (uuid)', className }: CopyableUuidProps) {
  const [copiado, setCopiado] = useState(false);

  const copiar = useCallback(async () => {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(value);
      } else {
        throw new Error('clipboard indisponível');
      }
      setCopiado(true);
      toast.success('Identificador copiado.');
      setTimeout(() => setCopiado(false), 1500);
    } catch {
      toast.error('Não foi possível copiar. Selecione o texto manualmente.');
    }
  }, [value]);

  return (
    <span className={cn('inline-flex items-center gap-1.5 font-mono text-xs', className)}>
      <span className="truncate" title={value}>
        {value}
      </span>
      <button
        type="button"
        onClick={copiar}
        aria-label={label}
        title={label}
        className="inline-flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {copiado ? (
          <Check className="size-3.5 text-success" aria-hidden="true" />
        ) : (
          <Copy className="size-3.5" aria-hidden="true" />
        )}
      </button>
    </span>
  );
}

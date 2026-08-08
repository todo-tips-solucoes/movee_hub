'use client';

import { Play, Square, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';

interface ProcessControlsProps {
  isActive: boolean;
  isLoading: boolean;
  onStart: () => void;
  onStop: () => void;
  /**
   * Quantas mensagens o disparo REALMENTE envia com a seleção atual (impeccable
   * rodada 6/7). Zero ou ausente = disparo do movimento inteiro. O botão declara
   * o escopo antes do clique: era possível marcar linhas e ler "Iniciar", sem
   * nada dizendo que a seleção não mudava o alcance da ação.
   */
  selecionados?: number;
  /**
   * Total marcado, incluindo quem já recebeu (impeccable rodada 7). Só serve
   * para a tooltip explicar por que o botão mostra um número menor — sem isso,
   * "Disparar para 5" com 12 linhas marcadas parece defeito.
   */
  selecionadosMarcados?: number;
}

export function ProcessControls({
  isActive,
  isLoading,
  onStart,
  onStop,
  selecionados = 0,
  selecionadosMarcados = 0,
}: ProcessControlsProps) {
  const jaEnviados = Math.max(0, selecionadosMarcados - selecionados);
  return (
    <div className="flex items-center gap-2">
      <Tooltip>
        <TooltipTrigger render={
          <Button
            size="sm"
            variant={isActive ? 'outline' : 'default'}
            className={`gap-1.5 ${!isActive && !isLoading ? 'bg-success text-success-foreground hover:bg-success/90' : ''}`}
            onClick={onStart}
            disabled={isActive || isLoading}
          />
        }>
          {isLoading && !isActive ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Play className="h-4 w-4" />
          )}
          {/* Quem manda no rótulo é ter seleção, não o tamanho dela: com 12
              marcados que já receberam, `selecionados` é 0 e o botão dizendo
              "Iniciar" prometeria o movimento inteiro. */}
          {selecionadosMarcados > 0 ? `Disparar para ${selecionados}` : 'Iniciar'}
        </TooltipTrigger>
        <TooltipContent>
          {selecionadosMarcados === 0
            ? 'Iniciar processamento do envio para todo o movimento aberto'
            : jaEnviados > 0
              ? `${selecionados} de ${selecionadosMarcados} marcados — ${jaEnviados} já ${jaEnviados === 1 ? 'recebeu' : 'receberam'} mensagem`
              : `Dispara apenas para ${selecionados} registro${selecionados === 1 ? '' : 's'} selecionado${selecionados === 1 ? '' : 's'}`}
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger render={
          <Button
            size="sm"
            variant="outline"
            className={`gap-1.5 ${isActive ? 'border-destructive/50 text-destructive hover:bg-destructive/10 hover:text-destructive' : ''}`}
            onClick={onStop}
            disabled={!isActive || isLoading}
          />
        }>
          {isLoading && isActive ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Square className="h-4 w-4" />
          )}
          Parar
        </TooltipTrigger>
        <TooltipContent>Parar processamento</TooltipContent>
      </Tooltip>
      {isActive && (
        <span className="flex items-center gap-1.5 text-sm font-medium text-success">
          <span className="relative flex h-2.5 w-2.5">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-success opacity-75" />
            <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-success" />
          </span>
          Processando...
        </span>
      )}
    </div>
  );
}

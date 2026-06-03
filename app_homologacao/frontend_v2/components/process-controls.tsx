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
}

export function ProcessControls({ isActive, isLoading, onStart, onStop }: ProcessControlsProps) {
  return (
    <div className="flex items-center gap-2">
      <Tooltip>
        <TooltipTrigger render={
          <Button
            size="sm"
            variant={isActive ? 'outline' : 'default'}
            className={`gap-1.5 ${!isActive && !isLoading ? 'bg-green-600 hover:bg-green-700 text-white' : ''}`}
            onClick={onStart}
            disabled={isActive || isLoading}
          />
        }>
          {isLoading && !isActive ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Play className="h-4 w-4" />
          )}
          Iniciar
        </TooltipTrigger>
        <TooltipContent>Iniciar processamento do envio</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger render={
          <Button
            size="sm"
            variant="outline"
            className={`gap-1.5 ${isActive ? 'border-red-500/50 text-red-500 hover:bg-red-500/10 hover:text-red-500' : ''}`}
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
        <span className="flex items-center gap-1.5 text-sm font-medium text-green-500">
          <span className="relative flex h-2.5 w-2.5">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-green-500" />
          </span>
          Processando...
        </span>
      )}
    </div>
  );
}

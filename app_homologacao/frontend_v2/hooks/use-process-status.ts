'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import { api } from '@/lib/api-client';
import { ProcessStatus } from '@/types';

interface UseProcessStatusOptions {
  onRefresh: () => void;
}

export function useProcessStatus({ onRefresh }: UseProcessStatusOptions) {
  const [isActive, setIsActive] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  // impeccable rodada 6 (P1-2): a virada ativo → inativo é o FIM do disparo.
  // Quem detecta é este hook (é ele que faz o polling), não a tela — na tela
  // sairia um `useEffect` comparando o valor anterior, que é justamente o
  // padrão "setState síncrono dentro de effect" que o lint proíbe. Consumir é
  // opcional: o painel legado ignora estes dois campos e segue igual.
  const [disparoConcluido, setDisparoConcluido] = useState(false);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);
  /** Última resposta conhecida de /process-status — usada só para detectar a
   *  virada ativo → inativo (refresh final + recibo). */
  const estavaAtivoRef = useRef(false);

  const clearPolling = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  const checkStatus = useCallback(async () => {
    try {
      const result = await api.get<ProcessStatus>('/process-status');
      setIsActive(result.active);
      // impeccable rodada 6: o refresh acontecia só ENQUANTO ativo, nunca na
      // virada para inativo — a tela terminava o disparo exibindo os números
      // do penúltimo poll (até 13s de defasagem, e as últimas linhas enviadas
      // ficavam de fora). Vale para as duas telas que usam este hook.
      if (result.active || estavaAtivoRef.current) {
        onRefresh();
      }
      // Disparo novo apaga o recibo do anterior — nunca dois na tela.
      if (result.active) setDisparoConcluido(false);
      else if (estavaAtivoRef.current) setDisparoConcluido(true);
      estavaAtivoRef.current = result.active;
      return result.active;
    } catch {
      setIsActive(false);
      estavaAtivoRef.current = false;
      return false;
    }
  }, [onRefresh]);

  const startPolling = useCallback(() => {
    clearPolling();
    intervalRef.current = setInterval(() => {
      checkStatus();
    }, 13000);
  }, [checkStatus, clearPolling]);

  /**
   * `ids` (impeccable rodada 6): dispara só para os registros selecionados.
   * Omitido ou vazio = movimento aberto inteiro, como sempre foi — a rota
   * trata a ausência do campo, não um array vazio.
   */
  const startProcess = useCallback(async (ids?: number[]) => {
    try {
      setIsLoading(true);
      await api.post('/start-process', ids && ids.length ? { ids } : undefined);
      setIsActive(true);
      estavaAtivoRef.current = true;
      setDisparoConcluido(false);
      startPolling();
    } finally {
      setIsLoading(false);
    }
  }, [startPolling]);

  const stopProcess = useCallback(async () => {
    try {
      setIsLoading(true);
      await api.post('/stop-process');
      setIsActive(false);
      // Parar na mão também termina um disparo: o operador precisa saber
      // quantas mensagens saíram antes de ele apertar o botão.
      if (estavaAtivoRef.current) setDisparoConcluido(true);
      estavaAtivoRef.current = false;
      clearPolling();
      onRefresh();
    } finally {
      setIsLoading(false);
    }
  }, [clearPolling, onRefresh]);

  useEffect(() => {
    checkStatus().then((active) => {
      if (active) startPolling();
    });
    return clearPolling;
  }, [checkStatus, startPolling, clearPolling]);

  const dispensarRecibo = useCallback(() => setDisparoConcluido(false), []);

  return {
    isActive,
    isLoading,
    startProcess,
    stopProcess,
    /** true entre o fim de um disparo e o próximo (ou o dispensar). */
    disparoConcluido,
    dispensarRecibo,
  };
}

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
  /**
   * impeccable rodada 17 (h1): a frase que a região viva da tela anuncia.
   * Marcos, não ticks — início e fim. Vive aqui porque é o hook que detecta as
   * viradas (o mesmo lugar de onde o recibo da r6 nasceu); a tela só desenha.
   */
  const [anuncio, setAnuncio] = useState<string | null>(null);
  /** O poll falhou: o estado exibido é o último conhecido, não o atual. */
  const [statusIndisponivel, setStatusIndisponivel] = useState(false);
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
      if (result.active) {
        setDisparoConcluido(false);
      } else if (estavaAtivoRef.current) {
        setDisparoConcluido(true);
        setAnuncio('Disparo concluído.');
      }
      estavaAtivoRef.current = result.active;
      setStatusIndisponivel(false);
      return result.active;
    } catch {
      // impeccable rodada 7 (P1): erro de transporte NÃO é informação sobre o
      // processo. Zerar `isActive` aqui fazia um blip de rede declarar "Parado"
      // no meio de um envio — o botão Iniciar reabilitava (`disabled={isActive
      // || isLoading}`) e um segundo disparo notificaria os mesmos motoristas
      // de novo. Zerar `estavaAtivoRef` ainda apagava a virada, então o recibo
      // do fim do disparo nunca aparecia. Preserva-se o último estado conhecido
      // e sinaliza-se a incerteza.
      setStatusIndisponivel(true);
      // `true` mantém o polling ligado mesmo quando o primeiro check falha —
      // é o único caminho de volta para um estado conhecido.
      return true;
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
      // O início é sabido AQUI, na ação aceita pelo backend — não numa virada
      // de poll. `startProcess` já marca `estavaAtivoRef`, então o primeiro
      // check nunca veria a transição. E abrir a tela com um disparo em
      // andamento (iniciado em outra sessão) não deve anunciar "iniciado":
      // aquilo não começou agora; ali fala a conclusão, quando vier.
      setAnuncio('Disparo iniciado.');
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
      if (estavaAtivoRef.current) {
        setDisparoConcluido(true);
        setAnuncio('Disparo concluído.');
      }
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

  /**
   * Região viva guarda mensagem TRANSITÓRIA: o texto existe para ser
   * anunciado e sair. Mantê-lo no DOM faria quem navega o documento tropeçar
   * em "Disparo concluído." horas depois — e foi assim que o teste da r6
   * pegou este defeito, ao encontrar a frase fora do recibo já dispensado.
   */
  useEffect(() => {
    if (!anuncio) return;
    const timer = setTimeout(() => setAnuncio(null), 5000);
    return () => clearTimeout(timer);
  }, [anuncio]);

  return {
    isActive,
    isLoading,
    startProcess,
    stopProcess,
    /** true entre o fim de um disparo e o próximo (ou o dispensar). */
    disparoConcluido,
    dispensarRecibo,
    /** true quando o último poll falhou — `isActive` é o último valor conhecido. */
    statusIndisponivel,
    /** Frase de marco para a região viva da tela (r17). null = nada a dizer. */
    anuncio,
  };
}

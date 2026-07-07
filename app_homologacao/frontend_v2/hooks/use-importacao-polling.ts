'use client';

// hub-importacoes (S4) FASE 6 task 6.2.1 — polling do detalhe/progresso de
// 1 importação enquanto `status ∈ {pending, validating, processing}`
// (contracts/importacoes-api.md §GET /importacoes/:id).
//
// Mesmo espírito de `hooks/use-process-status.ts` (interval + cleanup no
// unmount), mas um hook PRÓPRIO: aquele fala com endpoints de propósito
// específico (`/process-status`, `/start-process`, `/stop-process`, shape
// `{active}`) que não mapeiam para o contrato desta feature (`GET
// /importacoes/:id`, shape `ImportacaoDetalhe`, parada por `status`
// terminal em vez de um toggle explícito).

import { useCallback, useEffect, useRef, useState } from 'react';
import { obterImportacao, ImportacaoApiError } from '@/lib/hub/importacoes-api';
import { STATUS_EM_ANDAMENTO, type ImportacaoDetalhe } from '@/lib/hub/importacoes-dto';

const POLL_INTERVAL_MS = 4000;

export function useImportacaoPolling(id: number, intervalMs = POLL_INTERVAL_MS) {
  const [detalhe, setDetalhe] = useState<ImportacaoDetalhe | null>(null);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const pararPolling = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  const buscar = useCallback(async () => {
    try {
      const d = await obterImportacao(id);
      setDetalhe(d);
      setErro(null);
      if (!STATUS_EM_ANDAMENTO.has(d.status)) {
        pararPolling();
      }
      return d;
    } catch (e) {
      setErro(e instanceof ImportacaoApiError ? e.message : 'Não foi possível consultar o status da importação.');
      pararPolling();
      return null;
    } finally {
      setCarregando(false);
    }
  }, [id, pararPolling]);

  const iniciarPolling = useCallback(() => {
    pararPolling();
    intervalRef.current = setInterval(() => {
      buscar();
    }, intervalMs);
  }, [buscar, intervalMs, pararPolling]);

  useEffect(() => {
    let cancelado = false;
    buscar().then((d) => {
      if (!cancelado && d && STATUS_EM_ANDAMENTO.has(d.status)) {
        iniciarPolling();
      }
    });
    return () => {
      cancelado = true;
      pararPolling();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- iniciarPolling/pararPolling só mudam se id mudar
  }, [id]);

  return { detalhe, carregando, erro, refetch: buscar };
}

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
//
// F8 (pós-review PR #57 — polling frágil):
//   1. `iniciarPolling` é exposto no retorno — o caller (page.tsx) o chama
//      de novo depois de `POST .../reprocessar`, quando o status volta a
//      `pending`/`processing` (o polling anterior já tinha parado ao
//      chegar num estado terminal — sem reiniciar manualmente, a tela
//      ficava "congelada" mostrando o status antigo).
//   2. (refetch da tabela de erros ao detectar terminal com invalidas>0 —
//      implementado no CALLER, page.tsx, que observa `detalhe`.)
//   3. Um erro de fetch TRANSIENTE não encerra o polling permanentemente:
//      tolera `MAX_FALHAS_CONSECUTIVAS` falhas seguidas (uma consulta OK
//      zera o contador) antes de marcar `atualizacaoPausada` e parar —
//      distinto de `erro` (mensagem sempre atualizada, mesmo com `detalhe`
//      presente, para o caller poder mostrar um indicador sem substituir a
//      tela inteira).
//   4. Guarda de requisição in-flight (`emVooRef`) + `montadoRef` evita
//      `setState` pós-unmount e uma resposta VELHA (de um poll anterior que
//      demorou) sobrescrever uma mais nova.

import { useCallback, useEffect, useRef, useState } from 'react';
import { obterImportacao, ImportacaoApiError } from '@/lib/hub/importacoes-api';
import { STATUS_EM_ANDAMENTO, type ImportacaoDetalhe } from '@/lib/hub/importacoes-dto';

const POLL_INTERVAL_MS = 4000;
// F8.3 — falhas consecutivas toleradas antes de pausar a atualização
// automática (uma consulta bem-sucedida no meio zera o contador).
const MAX_FALHAS_CONSECUTIVAS = 3;

export function useImportacaoPolling(id: number, intervalMs = POLL_INTERVAL_MS) {
  const [detalhe, setDetalhe] = useState<ImportacaoDetalhe | null>(null);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  // F8.3 — distinto de `erro`: só vira true depois de MAX_FALHAS_CONSECUTIVAS
  // falhas seguidas (é o que efetivamente para o polling); `erro` reflete a
  // ÚLTIMA falha mesmo antes disso, para feedback imediato.
  const [atualizacaoPausada, setAtualizacaoPausada] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const falhasConsecutivasRef = useRef(0);
  const emVooRef = useRef(false); // F8.4 — guarda contra requisição sobreposta
  const montadoRef = useRef(true);

  const pararPolling = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  const buscar = useCallback(async () => {
    if (emVooRef.current) return null; // F8.4 — já existe uma requisição em voo
    emVooRef.current = true;
    try {
      const d = await obterImportacao(id);
      if (!montadoRef.current) return null; // F8.4 — não seta estado pós-unmount
      falhasConsecutivasRef.current = 0;
      setDetalhe(d);
      setErro(null);
      setAtualizacaoPausada(false);
      if (!STATUS_EM_ANDAMENTO.has(d.status)) {
        pararPolling();
      }
      return d;
    } catch (e) {
      if (!montadoRef.current) return null;
      falhasConsecutivasRef.current += 1;
      setErro(e instanceof ImportacaoApiError ? e.message : 'Não foi possível consultar o status da importação.');
      // F8.3 — só desiste (pausa de fato) depois de N falhas SEGUIDAS; uma
      // falha isolada de rede não deve derrubar o acompanhamento.
      if (falhasConsecutivasRef.current >= MAX_FALHAS_CONSECUTIVAS) {
        setAtualizacaoPausada(true);
        pararPolling();
      }
      return null;
    } finally {
      emVooRef.current = false;
      if (montadoRef.current) setCarregando(false);
    }
  }, [id, pararPolling]);

  const iniciarPolling = useCallback(() => {
    pararPolling();
    falhasConsecutivasRef.current = 0;
    setAtualizacaoPausada(false);
    intervalRef.current = setInterval(() => {
      buscar();
    }, intervalMs);
  }, [buscar, intervalMs, pararPolling]);

  useEffect(() => {
    montadoRef.current = true;
    buscar().then((d) => {
      if (montadoRef.current && d && STATUS_EM_ANDAMENTO.has(d.status)) {
        iniciarPolling();
      }
    });
    return () => {
      montadoRef.current = false;
      pararPolling();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- iniciarPolling/pararPolling só mudam se id mudar
  }, [id]);

  return {
    detalhe, carregando, erro, atualizacaoPausada, refetch: buscar, iniciarPolling,
  };
}

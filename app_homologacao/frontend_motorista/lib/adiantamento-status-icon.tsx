/**
 * adiantamento-motorista — lib/adiantamento-status-icon.tsx (tasks.md 6.3)
 *
 * Ícone do STATUS atual — companion de `lib/adiantamento-status.ts`
 * (rótulo/variante), separado por ser `.tsx` (JSX): `lib/adiantamento-status.ts`
 * é testado por `node --test` puro, que não transforma JSX; este arquivo só
 * é consumido pelas páginas (Next.js/tsc), nunca pelo teste do irmão.
 */

import type { ComponentType, HTMLAttributes } from 'react';
import {
  Schedule, HourglassTop, TaskAlt, Inventory2, Sync, Paid, Block,
  RemoveCircle, Close, AlertCircle,
} from '@/components/ui/icons';
import type { StatusAdiantamento } from './adiantamento-status';

type IconeComponente = ComponentType<HTMLAttributes<HTMLSpanElement>>;

const ICONES: Record<StatusAdiantamento, IconeComponente> = {
  AGUARDANDO_CORTE: Schedule,
  AGUARDANDO_PRODUCAO: HourglassTop,
  LIBERADA: TaskAlt,
  EM_LOTE: Inventory2,
  EXPORTADA: Sync,
  PAGA: Paid,
  FALHOU: AlertCircle,
  REJEITADA: Block,
  INELEGIVEL: RemoveCircle,
  CANCELADA: Close,
  ENCERRADA: Close,
};

/** Nunca lança: status desconhecido cai no ícone neutro (mesma postura de
 * `statusInfo`). */
export function iconeStatus(status: string): IconeComponente {
  return ICONES[status as StatusAdiantamento] || Close;
}

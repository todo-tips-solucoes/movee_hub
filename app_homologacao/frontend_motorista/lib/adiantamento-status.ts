/**
 * adiantamento-motorista — lib/adiantamento-status.ts (tasks.md 6.3)
 *
 * Rótulo + variante de badge do STATUS atual de uma solicitação (pill de
 * topo, prototipo M07-M11/M10 — `ST`/`HST`). Distinto do rótulo de EVENTO
 * da timeline, que já vem pronto em `timeline[].etapa`, e do `statusRotulo`
 * de `GET /motorista/adiantamentos` — nenhum dos dois é duplicado aqui, os
 * dois vêm prontos da API (`rotuloStatusAdiantamento`/`ETAPA_ADIANTAMENTO`,
 * backend `lib/adiantamento-dto.js`).
 *
 * PURO (sem import de componente/JSX) de propósito — este módulo é testado
 * por `node --test` puro (sem transform de JSX); o ícone por status vive em
 * `lib/adiantamento-status-icon.tsx` (companion `.tsx`, consumido só pelas
 * páginas, nunca pelo teste deste arquivo).
 */

export type StatusAdiantamento =
  | 'AGUARDANDO_CORTE'
  | 'AGUARDANDO_PRODUCAO'
  | 'LIBERADA'
  | 'EM_LOTE'
  | 'EXPORTADA'
  | 'PAGA'
  | 'REJEITADA'
  | 'INELEGIVEL'
  | 'FALHOU'
  | 'ENCERRADA'
  | 'CANCELADA';

export interface StatusInfo {
  variant: 'success' | 'warning' | 'info' | 'muted';
  label: string;
}

const MAPA: Record<StatusAdiantamento, StatusInfo> = {
  AGUARDANDO_CORTE: { variant: 'info', label: 'Aguardando fechamento' },
  AGUARDANDO_PRODUCAO: { variant: 'warning', label: 'Aguardando produção' },
  LIBERADA: { variant: 'success', label: 'Liberado' },
  EM_LOTE: { variant: 'info', label: 'Incluído para pagamento' },
  EXPORTADA: { variant: 'info', label: 'Pagamento em processamento' },
  PAGA: { variant: 'success', label: 'Pago' },
  FALHOU: { variant: 'warning', label: 'Pagamento falhou' },
  REJEITADA: { variant: 'warning', label: 'Rejeitado' },
  INELEGIVEL: { variant: 'muted', label: 'Não liberado' },
  CANCELADA: { variant: 'muted', label: 'Cancelado' },
  ENCERRADA: { variant: 'muted', label: 'Não realizado' },
};

/** Nunca lança: status desconhecido cai num badge neutro com o próprio
 * código como rótulo (mesma postura defensiva do backend
 * `rotuloStatusAdiantamento`, que devolve o código cru se não reconhecido). */
export function statusInfo(status: string): StatusInfo {
  return MAPA[status as StatusAdiantamento] || { variant: 'muted', label: status };
}

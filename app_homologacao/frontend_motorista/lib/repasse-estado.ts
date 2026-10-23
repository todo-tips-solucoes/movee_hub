/**
 * adiantamento-motorista — lib/repasse-estado.ts (tasks.md 6.6.3)
 *
 * Classifica o erro de `GET /motorista/repasse` em PURO (sem I/O, testável
 * por `node --test`): 404 `NAO_DISPONIVEL` é a configuração desligada
 * (`repasseVisivelApp=false`, FR-039) — a tela não deve renderizar conteúdo
 * nem oferecer "tentar de novo" (não é falha, é ausência da função). Qualquer
 * outro erro é infra/desconhecido e mantém o "tentar de novo" (CLAUDE.md
 * "Regras de domínio": nunca mascarar negócio como indisponibilidade, nem o
 * oposto).
 */

import { ApiError } from './api-client.ts';

export type EstadoRepasseErro = 'indisponivel' | 'erro';

export function classificarErroRepasse(err: unknown): EstadoRepasseErro {
  if (err instanceof ApiError && err.status === 404) return 'indisponivel';
  return 'erro';
}

/** 0117: linha "Pago por fora" da decomposição. `null` = nada a mostrar (zero/ausente/inválido);
 * senão `{ sinal, valor }` com `valor` em módulo — o sinal é explícito para a conta fechar à vista. */
export function parcelaPagoPorFora(lancamentosExternos: string | null | undefined): { sinal: '+' | '−'; valor: number } | null {
  const n = Number(lancamentosExternos);
  if (!lancamentosExternos || !Number.isFinite(n) || n === 0) return null;
  return { sinal: n < 0 ? '−' : '+', valor: Math.abs(n) };
}

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

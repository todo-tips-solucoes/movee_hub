// hub-shell (S3) FASE 6.3 — fórmula de score de acessibilidade (axe ≥95).
//
// Nem spec.md/plan.md/tasks.md definem a fórmula exata de "score" (o axe-core
// nativamente reporta apenas violações discretas por `impact`, sem um número
// 0-100) — decisão de interpretação desta onda (Decisão registrada no
// runtime: "fórmula de score axe", score 2, sem sonda empírica de segurança
// aplicável, é uma convenção de medição, não uma escalada). Adota-se a
// prática comum de gates de acessibilidade: penalidade ponderada por
// impacto × nº de nós afetados, subtraída de 100, piso 0. Pesos calibrados
// para que QUALQUER violação `critical` isolada já derrube o score abaixo do
// gate de 95 (25 > 5), forçando correção antes de fechar a fase.
export interface AxeViolationLike {
  impact?: string | null;
  nodes: unknown[];
}

const PESOS: Record<string, number> = {
  critical: 25,
  serious: 10,
  moderate: 5,
  minor: 2,
};

export function computeAxeScore(violations: AxeViolationLike[]): number {
  let penalidade = 0;
  for (const v of violations) {
    const peso = PESOS[v.impact ?? 'moderate'] ?? 5;
    penalidade += peso * Math.max(1, v.nodes.length);
  }
  return Math.max(0, 100 - penalidade);
}

export const AXE_SCORE_GATE = 95;

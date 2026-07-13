// hub-motorista-canonico FASE 2 / WS-B (tasks.md 2.1/2.2) — tipos + parse do
// shape compartilhado de `GET /faturamento/entregadores` e
// `GET /performance/entregadores` (contracts/api-motorista-canonico.md
// §WS-B). Os dois endpoints são espelhos exatos (mesmo shape de resposta),
// por isso o parser vive em UM módulo neutro consumido por
// `faturamento-api.ts` e `performance-api.ts` — evita duplicar a mesma
// validação de shape 2x (dec — reuso explícito, diferente do padrão de
// helpers de rota duplicados no backend, que são pequenos o bastante para
// não justificar acoplamento cross-domain).
//
// Mesmo padrão defensivo de `faturamento-dto.ts#parseAreasResponse`: NÃO
// confia cegamente que a rede devolveu exatamente o que o contrato promete.

function isString(v: unknown): v is string {
  return typeof v === 'string';
}

function isNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

export interface EntregadorBuscaItem {
  id: number;
  nome: string;
}

/** Valida + normaliza `{ items: [{ id, nome }] }` — item malformado é
 * descartado silenciosamente (nunca quebra o combobox por 1 linha ruim). */
export function parseEntregadorBuscaResponse(raw: unknown): EntregadorBuscaItem[] {
  if (!raw || typeof raw !== 'object') {
    throw new TypeError('Resposta de busca de entregador inválida: shape não é objeto');
  }
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.items)) {
    throw new TypeError('Resposta de busca de entregador inválida: items não é array');
  }
  const items: EntregadorBuscaItem[] = [];
  for (const item of r.items) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    if (!isNumber(obj.id) || !isString(obj.nome)) continue;
    items.push({ id: obj.id, nome: obj.nome });
  }
  return items;
}

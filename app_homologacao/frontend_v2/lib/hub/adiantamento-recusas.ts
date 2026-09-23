// F4-B: transforma a lista de recusas da geração de movimentos numa linha que
// o operador lê de relance.
//
// Por que agrupar por motivo em vez de listar motorista a motorista: numa
// semana real são centenas de recusas, quase todas pelo MESMO motivo ("já tem
// movimento aberto", "sem CNPJ no hub"). Uma lista nominal rolaria para fora
// da tela e esconderia justamente o que é acionável — quantos, e por quê.
import type { MovimentoRecusado } from './adiantamentos-api';

/** Ordem de leitura: o que o operador consegue resolver vem primeiro. */
const PRIORIDADE = ['SEM_CNPJ', 'SEM_DIVISAO', 'FALHA_AO_GRAVAR', 'VALOR_ZERO', 'MOVIMENTO_ABERTO', 'JA_GERADO'];

const ROTULO: Record<string, string> = {
  SEM_CNPJ: 'sem CNPJ no hub',
  SEM_DIVISAO: 'apuração fechada antes de configurar a nota',
  VALOR_ZERO: 'base da nota zerada',
  JA_GERADO: 'já gerados antes',
  MOVIMENTO_ABERTO: 'já têm movimento aberto',
  FALHA_AO_GRAVAR: 'falha ao gravar',
};

export function resumirRecusas(recusados: MovimentoRecusado[]): string {
  const porMotivo = new Map<string, number>();
  for (const r of recusados) porMotivo.set(r.motivo, (porMotivo.get(r.motivo) ?? 0) + 1);

  return [...porMotivo.entries()]
    .sort((a, b) => {
      const ia = PRIORIDADE.indexOf(a[0]);
      const ib = PRIORIDADE.indexOf(b[0]);
      // Motivo desconhecido (backend novo, front antigo) vai para o fim, mas
      // NUNCA some do resumo — sumir seria esconder recusa do operador.
      return (ia < 0 ? PRIORIDADE.length : ia) - (ib < 0 ? PRIORIDADE.length : ib) || b[1] - a[1];
    })
    .map(([motivo, n]) => `${n} ${ROTULO[motivo] ?? motivo}`)
    .join(' · ');
}

// Lote de pagamento do repasse — lógica pura da seção na aba Repasse
// (components/hub/repasse-lotes-section.tsx). Fica fora do JSX para ser testável.

import type { CriarRepasseLoteInput, RepasseLotePreviaBloqueada, RepasseLotePreviaLinha, RepasseLotePreviaResponse } from '@/lib/hub/adiantamentos-api';

/** Por que um pagamento não entra no lote, e o que o operador faz a respeito.
 *  Códigos de `hub_repasse_lote_avaliar` (migration 0108). Código desconhecido
 *  aparece cru em `rotuloBloqueio`: melhor o código que uma frase inventada. */
const BLOQUEIO: Record<string, { rotulo: string; acao: string }> = {
  JA_EM_LOTE: {
    rotulo: 'Já está em outro lote',
    acao: 'Conclua ou cancele o lote em que ele está para poder incluí-lo de novo.',
  },
  JA_PAGO_CONCILIADO: {
    rotulo: 'Já pago fora da plataforma (conciliado)',
    acao: 'Um movimento desta semana foi conciliado pela planilha UneCont; pagar de novo seria pagamento em duplicidade.',
  },
  APURACAO_ABERTA: {
    rotulo: 'A apuração da semana ainda não foi fechada',
    acao: 'Use "Gerar do repasse" no topo da tela.',
  },
  VALOR_INVALIDO: {
    rotulo: 'Sem valor a pagar',
    acao: 'O valor a pagar desta semana está zerado ou inválido; não há o que pagar.',
  },
  NOTA_REPROVADA: {
    rotulo: 'Nota fiscal reprovada',
    acao: 'O motorista precisa enviar a nota corrigida (tela Validação XML).',
  },
  NOTA_PENDENTE: {
    rotulo: 'Nota fiscal ainda não enviada ou não validada',
    acao: 'Aguarde o motorista enviar a nota; o pagamento fica retido até lá.',
  },
  SEM_CONTA: {
    rotulo: 'Sem conta bancária aprovada',
    acao: 'Aprove a conta do motorista na aba Contas bancárias.',
  },
};

export function rotuloBloqueio(motivo: string): { rotulo: string; acao: string } {
  return BLOQUEIO[motivo] ?? { rotulo: motivo, acao: '' };
}

export interface GrupoBloqueio {
  motivo: string;
  rotulo: string;
  acao: string;
  linhas: RepasseLotePreviaBloqueada[];
}

/** Agrupa as bloqueadas por motivo, na ordem em que cada motivo aparece. */
export function agruparBloqueadas(bloqueadas: RepasseLotePreviaBloqueada[]): GrupoBloqueio[] {
  const grupos = new Map<string, GrupoBloqueio>();
  for (const b of bloqueadas) {
    const g = grupos.get(b.motivo) ?? { motivo: b.motivo, ...rotuloBloqueio(b.motivo), linhas: [] };
    g.linhas.push(b);
    grupos.set(b.motivo, g);
  }
  return [...grupos.values()];
}

/** Teto de pagamentos por lote. ESPELHA o teto da RPC `hub_repasse_lote_criar`
 *  (`LOTE_ACIMA_DO_LIMITE`): se um mudar, o outro tem de mudar junto. */
export const LOTE_LIMITE_ITENS = 5000;

/** Quem entra neste lote: até `LOTE_LIMITE_ITENS`, as apurações MAIS ANTIGAS
 *  primeiro (quem espera há mais tempo recebe antes). `ficam` é o que sobra para
 *  o lote seguinte. Com ≤ teto não recorta nem reordena nada. */
export function selecionarParaLote(aptas: RepasseLotePreviaLinha[]): { entram: RepasseLotePreviaLinha[]; ficam: number; total: string } {
  const entram = aptas.length <= LOTE_LIMITE_ITENS
    ? aptas
    : [...aptas]
        .sort((a, b) => a.periodoInicio.localeCompare(b.periodoInicio) || a.apuracaoId - b.apuracaoId || a.entregadorId - b.entregadorId)
        .slice(0, LOTE_LIMITE_ITENS);
  const centavos = entram.reduce((acc, l) => acc + Math.round(Number(l.valor) * 100), 0);
  return { entram, ficam: aptas.length - entram.length, total: (centavos / 100).toFixed(2) };
}

/** Corpo do `POST /lotes`: as aptas que entram (ver `selecionarParaLote`), com o
 *  total e a quantidade DELAS — o servidor recusa (`PREVIA_DESATUALIZADA`) se
 *  algo mudou desde a prévia. `null` quando não há o que pagar. */
export function montarCriacao(previa: RepasseLotePreviaResponse, chaveIdempotencia: string): CriarRepasseLoteInput | null {
  if (previa.aptas.length === 0) return null;
  const { entram, total } = selecionarParaLote(previa.aptas);
  return {
    apuracoes: entram.map((l) => l.apuracaoId),
    entregadores: entram.map((l) => l.entregadorId),
    quantidadeEsperada: entram.length,
    totalEsperado: total,
    chaveIdempotencia,
  };
}

/** Aviso do recorte, mostrado ANTES de gerar. `null` quando tudo cabe num lote. */
export function avisoRecorte(ficam: number, entram: number): string | null {
  if (ficam <= 0) return null;
  return `O lote aceita no máximo ${LOTE_LIMITE_ITENS.toLocaleString('pt-BR')} pagamentos. Entram ${entram.toLocaleString('pt-BR')}, das apurações mais antigas; ficam ${ficam.toLocaleString('pt-BR')} para o próximo. Depois de gerar, gere outro lote para o restante.`;
}

/** Mensagem do erro ao gerar; a rede de segurança se o recorte falhar. `null` = usar a mensagem padrão. */
export function mensagemErroGerar(codigo: string | undefined): string | null {
  return codigo === 'LOTE_ACIMA_DO_LIMITE'
    ? `O lote aceita no máximo ${LOTE_LIMITE_ITENS.toLocaleString('pt-BR')} pagamentos. Atualize a lista: serão selecionados os ${LOTE_LIMITE_ITENS.toLocaleString('pt-BR')} mais antigos.`
    : null;
}

const PODE_BAIXAR = ['GERADO', 'EXPORTADO', 'CONCLUIDO', 'CONCLUIDO_COM_FALHAS'];
const PODE_CANCELAR = ['GERANDO', 'GERADO', 'EXPORTADO'];

/** O que cada botão do lote exige: permissão E status (mesmas regras da tela de detalhe do adiantamento). */
export function acoesDoLote(status: string, permissoes: readonly string[]) {
  const tem = (p: string) => permissoes.includes(p);
  return {
    baixar: tem('adiantamentos.exportar') && PODE_BAIXAR.includes(status),
    cancelar: tem('adiantamentos.reprocessar') && PODE_CANCELAR.includes(status),
    retorno: tem('adiantamentos.pagamento_confirmar') && status === 'EXPORTADO',
    confirmar: tem('adiantamentos.pagamento_confirmar') && status === 'EXPORTADO',
  };
}

export function podeGerarLote(permissoes: readonly string[]): boolean {
  return permissoes.includes('adiantamentos.lote_criar');
}

export function podeVerLotes(permissoes: readonly string[]): boolean {
  return permissoes.includes('adiantamentos.pagamentos_consultar');
}

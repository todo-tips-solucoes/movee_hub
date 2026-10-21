// corrigir-movimento (FASE 5): traduz o desfecho REAL do backend para a tela.
// Regra do defeito original: a tela nunca diz "sucesso" sem gravação confirmada.
import { ApiError } from '@/lib/api-client';

export type TomFeedback = 'sucesso' | 'aviso' | 'info' | 'erro';
export interface Feedback { tom: TomFeedback; texto: string }

/** Corpo 200 do PATCH /update-envio-massa quando o valor foi enviado. */
export interface RespostaCorrecao {
  resultado?: 'atualizado' | 'inalterado';
  mensagem_ajustada?: boolean;
  mensagem_valor_antigo?: boolean;
  aviso?: string;
}

export function descreverCorrecao(r: RespostaCorrecao | null | undefined): Feedback {
  if (r?.resultado === 'inalterado') {
    return { tom: 'info', texto: 'O valor informado já era o gravado — nada foi alterado.' };
  }
  if (r?.resultado !== 'atualizado') {
    // 200 sem desfecho reconhecível: não afirmar gravação que não podemos provar.
    return { tom: 'aviso', texto: 'O servidor respondeu sem confirmar o desfecho. Confira o valor na tabela antes de seguir.' };
  }
  const partes = ['Valor corrigido.'];
  if (r.aviso) partes.push(r.aviso);
  if (r.mensagem_valor_antigo) {
    partes.push('Atenção: este movimento já tinha a mensagem enviada ao motorista com o valor antigo.');
  }
  return { tom: r.aviso || r.mensagem_valor_antigo ? 'aviso' : 'sucesso', texto: partes.join(' ') };
}

/** Erro do PATCH de valor -> texto para o operador (409/404/400/500 com desfecho real). */
export function descreverErroCorrecao(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.resultado === 'pulado_nota_enviada') {
      return 'Este movimento já tem nota enviada; o valor NÃO foi alterado. Cancele a nota antes de corrigir.';
    }
    if (err.resultado === 'pulado_mov_fechado') {
      return 'O movimento está fechado; o valor NÃO foi alterado.';
    }
    if (err.status === 404 || err.resultado === 'nao_encontrado') {
      return 'Movimento não encontrado (removido ou de outra empresa); nada foi alterado.';
    }
    if (err.status >= 500) return `${err.message} Nada foi confirmado.`;
  }
  return err instanceof Error ? err.message : 'Erro ao atualizar registro';
}

export interface ResumoImportacao {
  total_linhas: number;
  criados: number;
  atualizados: number;
  inalterados: number;
  pulados_nota_enviada: number;
  pulados_mov_fechado: number;
  ambiguos: number;
  sem_identificador: number;
  mensagem_valor_antigo: number;
  /** Movimentos corrigidos cuja mensagem1 da planilha ainda cita outro valor e nao pode ser ajustada sozinha. */
  mensagem_divergente: number;
}
export interface AmbiguoImportacao { linha: number; cnpj_prestador: string; candidatos: number[] }
export interface PuladoImportacao { linha: number; id: number; motivo: 'nota_enviada' | 'mov_fechado' }
export interface ResultadoImportacao {
  resumo?: ResumoImportacao;
  ambiguos?: AmbiguoImportacao[];
  pulados?: PuladoImportacao[];
}

export const ROTULOS_RESUMO: { chave: keyof ResumoImportacao; rotulo: string; destaque?: boolean }[] = [
  { chave: 'criados', rotulo: 'Novos registros criados' },
  { chave: 'atualizados', rotulo: 'Valores corrigidos' },
  { chave: 'inalterados', rotulo: 'Já estavam corretos (inalterados)' },
  { chave: 'pulados_nota_enviada', rotulo: 'Pulados — nota já enviada', destaque: true },
  { chave: 'pulados_mov_fechado', rotulo: 'Pulados — movimento fechado', destaque: true },
  { chave: 'ambiguos', rotulo: 'Ambíguos — não alterados, aguardam decisão', destaque: true },
  { chave: 'sem_identificador', rotulo: 'Criados sem identificador (uuid)' },
];

export const ROTULO_PULO: Record<PuladoImportacao['motivo'], string> = {
  nota_enviada: 'nota já enviada',
  mov_fechado: 'movimento fechado',
};

/** Texto de uma importação interrompida (500 com `parcial`), ou null. */
export function descreverInterrompida(err: unknown): string | null {
  if (!(err instanceof ApiError)) return null;
  const p = err.corpo.parcial as { atualizacoes_confirmadas?: number; linhas_novas_criadas?: boolean } | undefined;
  if (!p) return null;
  return `${err.message} Atualizações já confirmadas: ${p.atualizacoes_confirmadas ?? 0}. ` +
    `Linhas novas ${p.linhas_novas_criadas ? 'criadas' : 'NÃO criadas'}.`;
}

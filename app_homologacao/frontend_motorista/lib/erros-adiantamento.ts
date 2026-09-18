/**
 * adiantamento-motorista — lib/erros-adiantamento.ts (tasks.md 6.1.2)
 *
 * Mapa código de erro → mensagem pt-BR (FR-054), distinguindo erro de
 * NEGÓCIO (4xx com `erro`/`motivo` conhecido — mensagem real do domínio) de
 * erro de INFRA (timeout/5xx/sem resposta — 502 `INDISPONIVEL`), conforme
 * CLAUDE.md "Regras de domínio": nunca mascarar regra de negócio como
 * indisponibilidade (security CHK002).
 *
 * Ref: contracts/motorista-api.md §Parte 2 "Erros"/§GET disponibilidade
 * `reason`; contracts/motorista-api.md §Autenticação (`AVISO_NAO_DISPONIVEL`);
 * routes/hub-avisos.js (`SEM_DESTINATARIOS`, só aparece no hub, mapeado aqui
 * por completude caso o código atravesse alguma rota compartilhada).
 */

import { ApiError } from './api-client.ts';

/** `reason` de `GET /adiantamento/disponibilidade`, também usado como
 * `motivo` de `409 {erro:'SOLICITACAO_INDISPONIVEL'}`. */
export type MotivoIndisponivel =
  | 'DAY_NOT_ALLOWED'
  | 'BEFORE_OPENING'
  | 'AFTER_CUTOFF'
  | 'ALREADY_REQUESTED'
  | 'NO_BANK_ACCOUNT'
  | 'BANK_ACCOUNT_PENDING'
  | 'NOT_LINKED'
  | 'NOT_CONFIGURED'
  | 'MODULE_DISABLED'
  | 'OUTSIDE_GROUP';

const MENSAGENS_MOTIVO: Record<MotivoIndisponivel, string> = {
  DAY_NOT_ALLOWED: 'Hoje não é um dia habilitado para solicitar adiantamento.',
  BEFORE_OPENING: 'O horário de solicitação de hoje ainda não abriu.',
  AFTER_CUTOFF: 'O horário de solicitação de hoje já encerrou.',
  ALREADY_REQUESTED: 'Você já tem uma solicitação de adiantamento hoje.',
  NO_BANK_ACCOUNT: 'Cadastre uma conta bancária para solicitar adiantamento.',
  BANK_ACCOUNT_PENDING: 'Sua conta bancária ainda está em análise.',
  NOT_LINKED: 'Seu cadastro ainda não está vinculado a uma empresa habilitada para adiantamento.',
  NOT_CONFIGURED: 'O adiantamento ainda não foi configurado para sua empresa.',
  MODULE_DISABLED: 'O adiantamento não está disponível para sua empresa.',
  OUTSIDE_GROUP: 'O adiantamento não está disponível para sua empresa.',
};

/** Código de erro de negócio (`{erro:'CODIGO'}`). */
export type CodigoErroAdiantamento =
  | 'DADOS_INVALIDOS'
  | 'NAO_ENCONTRADO'
  | 'NAO_ENCONTRADA'
  | 'TRANSICAO_INVALIDA'
  | 'LIMITE_EXCEDIDO'
  | 'SOLICITACAO_INDISPONIVEL'
  | 'VERSAO_DESATUALIZADA'
  | 'NAO_DISPONIVEL'
  | 'AVISO_NAO_DISPONIVEL'
  | 'SEM_DESTINATARIOS'
  | 'INDISPONIVEL';

const MENSAGENS_CODIGO: Record<CodigoErroAdiantamento, string> = {
  DADOS_INVALIDOS: 'Alguns dados informados são inválidos. Confira e tente novamente.',
  NAO_ENCONTRADO: 'Não encontramos essa solicitação.',
  NAO_ENCONTRADA: 'Não encontramos essa notificação.',
  TRANSICAO_INVALIDA: 'Essa ação não é mais possível para esta solicitação.',
  LIMITE_EXCEDIDO: 'Muitas tentativas em pouco tempo. Aguarde alguns minutos e tente de novo.',
  SOLICITACAO_INDISPONIVEL: 'Não é possível solicitar adiantamento agora.',
  VERSAO_DESATUALIZADA: 'As regras do adiantamento foram atualizadas. Atualize a tela e tente de novo.',
  NAO_DISPONIVEL: 'Essa informação não está disponível no momento.',
  AVISO_NAO_DISPONIVEL: 'Esse aviso não está disponível.',
  SEM_DESTINATARIOS: 'Não há destinatários para este aviso.',
  INDISPONIVEL: 'Serviço temporariamente indisponível. Tente novamente em instantes.',
};

export interface ErroTraduzido {
  mensagem: string;
  /** `negocio`: 4xx com código conhecido — mensagem real do domínio.
   *  `infra`: timeout/5xx/sem resposta — nunca confundido com negócio (CHK002). */
  tipo: 'negocio' | 'infra';
  codigo?: string;
  motivo?: string;
}

/** Mensagem pt-BR de um `MotivoIndisponivel` (`reason` de `GET
 * /adiantamento/disponibilidade`) — mesmo mapa usado para `409
 * SOLICITACAO_INDISPONIVEL`, reaproveitado pelo card da home (6.2.2) para
 * nunca duplicar a mensagem em outro lugar. */
export function mensagemMotivo(motivo: MotivoIndisponivel): string {
  return MENSAGENS_MOTIVO[motivo];
}

/** Traduz um erro de `lib/adiantamento-api.ts` (sempre `ApiError`, ver
 * `lib/api-client.ts#handleResponse`) para mensagem pt-BR exibível ao
 * motorista (FR-054). */
export function traduzirErroAdiantamento(erro: unknown): ErroTraduzido {
  if (!(erro instanceof ApiError)) {
    return { mensagem: MENSAGENS_CODIGO.INDISPONIVEL, tipo: 'infra' };
  }
  // Timeout/5xx/PostgREST fora do ar — sempre infra, nunca mascarado como
  // regra de negócio (CLAUDE.md "Regras de domínio").
  if (erro.status >= 500 || erro.code === 'INDISPONIVEL') {
    return { mensagem: MENSAGENS_CODIGO.INDISPONIVEL, tipo: 'infra' };
  }

  if (erro.code === 'SOLICITACAO_INDISPONIVEL' && erro.motivo && erro.motivo in MENSAGENS_MOTIVO) {
    const motivo = erro.motivo as MotivoIndisponivel;
    return { mensagem: MENSAGENS_MOTIVO[motivo], tipo: 'negocio', codigo: erro.code, motivo };
  }
  if (erro.code && erro.code in MENSAGENS_CODIGO) {
    const codigo = erro.code as CodigoErroAdiantamento;
    return { mensagem: MENSAGENS_CODIGO[codigo], tipo: 'negocio', codigo, motivo: erro.motivo };
  }
  // 401 ("Não autorizado") e qualquer outro 4xx sem código mapeado: propaga
  // a mensagem real do servidor em vez de mensagem genérica (6.7.3/FR-054).
  return { mensagem: erro.message || MENSAGENS_CODIGO.INDISPONIVEL, tipo: 'negocio', codigo: erro.code, motivo: erro.motivo };
}

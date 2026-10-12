// hub-validacao-xml (F4b nota-pendente-motorista): chamada HTTP para
// `GET /api/v1/validacao-xml/regularizadas` — notas que o motorista enviou
// DEPOIS do fechamento do movimento. Mesmo molde de lib/hub/avisos-api.ts.

import { HubApiError, criarRequest, codigoDoErro, mensagemPorCodigo } from './api';

const MENSAGENS_CODIGO: Record<string, string> = {
  NAO_AUTENTICADO: 'Sua sessão expirou. Faça login novamente.',
  ENTIDADE_NAO_SELECIONADA: 'Selecione uma entidade antes de continuar.',
  PERMISSAO_NEGADA: 'Você não tem permissão para ver estas notas.',
  MODULO_DESABILITADO: 'O módulo de validação XML está desabilitado para esta empresa.',
  ERRO_SERVIDOR: 'Erro no servidor. Tente novamente em instantes.',
};

export class ValidacaoXmlApiError extends HubApiError {
  readonly name = 'ValidacaoXmlApiError';
}

const request = criarRequest(
  (status, body) =>
    new ValidacaoXmlApiError(status, mensagemPorCodigo(MENSAGENS_CODIGO, body, status), codigoDoErro(body))
);

export interface NotaRegularizada {
  id: number;
  nome: string;
  cnpjPrestador: string;
  valor: string | number | null;
  dtInicial: string | null;
  dtFinal: string | null;
  regularizadaEm: string;
  /** `true` = aprovada; `false` = recusada (ou sem XML válido). */
  notaAprovada: boolean;
}

export interface RegularizadasResponse {
  itens: NotaRegularizada[];
  /** Total real no banco — pode passar de `limite`. */
  total: number;
  limite: number;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

export function parseRegularizadasResponse(raw: unknown): RegularizadasResponse {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const lista = Array.isArray(r.itens) ? r.itens : [];
  const itens = lista.map((x): NotaRegularizada => {
    const i = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
    return {
      id: Number(i.id),
      nome: str(i.nome),
      cnpjPrestador: str(i.cnpjPrestador),
      valor: typeof i.valor === 'number' || typeof i.valor === 'string' ? i.valor : null,
      dtInicial: i.dtInicial ? str(i.dtInicial) : null,
      dtFinal: i.dtFinal ? str(i.dtFinal) : null,
      regularizadaEm: str(i.regularizadaEm),
      notaAprovada: i.notaAprovada === true,
    };
  });
  return {
    itens,
    total: typeof r.total === 'number' ? r.total : itens.length,
    limite: typeof r.limite === 'number' ? r.limite : 100,
  };
}

export async function listarRegularizadas(): Promise<RegularizadasResponse> {
  const raw = await request<unknown>('/validacao-xml/regularizadas');
  return parseRegularizadasResponse(raw);
}

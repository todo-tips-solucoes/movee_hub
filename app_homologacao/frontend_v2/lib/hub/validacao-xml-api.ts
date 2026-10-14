// hub-validacao-xml (F4b nota-pendente-motorista): chamada HTTP para
// `GET /api/v1/validacao-xml/regularizadas` — notas que o motorista enviou
// DEPOIS do fechamento do movimento. Mesmo molde de lib/hub/avisos-api.ts.
// Ações do financeiro (migration 0113): marcar como já pago / desfazer / apagar nota.

import { HubApiError, criarRequest, codigoDoErro, mensagemPorCodigo } from './api';

const MENSAGENS_CODIGO: Record<string, string> = {
  NAO_AUTENTICADO: 'Sua sessão expirou. Faça login novamente.',
  ENTIDADE_NAO_SELECIONADA: 'Selecione uma entidade antes de continuar.',
  PERMISSAO_NEGADA: 'Você não tem permissão para ver estas notas.',
  MODULO_DESABILITADO: 'O módulo de validação XML está desabilitado para esta empresa.',
  ERRO_SERVIDOR: 'Erro no servidor. Tente novamente em instantes.',
  NAO_ENCONTRADO: 'Este pagamento retido não existe mais. Atualize a lista.',
  JA_MARCADO_COMO_PAGO: 'Este movimento já está marcado como pago.',
  NAO_MARCADO_COMO_PAGO: 'Este movimento não está marcado como pago.',
  CONCILIACAO_NAO_MANUAL: 'Este pagamento veio da conciliação com a planilha e não pode ser desfeito por aqui.',
  MARCADO_COMO_PAGO: 'Desfaça o "Já foi pago" antes de apagar a nota.',
  ESTADO_MUDOU: 'Alguém alterou este movimento agora há pouco. Atualize a lista e tente de novo.',
  DADOS_INVALIDOS: 'Informe o motivo.',
  LIMITE_EXCEDIDO: 'Muitas ações seguidas. Aguarde alguns minutos.',
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
  numeroNota: string | null;
  /** Preenchido = pago fora da plataforma. `manual` = marcado por esta tela (pode desfazer). */
  jaPago: { em: string; manual: boolean; por: string | null; referencia: string | null } | null;
  /** Se a nota for apagada, o motorista consegue reenviar pelo app (semana dentro do corte)? */
  podeReenviarNoApp: boolean | null;
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

export function parseNotaRegularizada(x: unknown): NotaRegularizada {
  const i = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
  const jp = (i.jaPago && typeof i.jaPago === 'object' ? i.jaPago : null) as Record<string, unknown> | null;
  return {
    id: Number(i.id),
    nome: str(i.nome),
    cnpjPrestador: str(i.cnpjPrestador),
    valor: typeof i.valor === 'number' || typeof i.valor === 'string' ? i.valor : null,
    dtInicial: i.dtInicial ? str(i.dtInicial) : null,
    dtFinal: i.dtFinal ? str(i.dtFinal) : null,
    regularizadaEm: str(i.regularizadaEm),
    notaAprovada: i.notaAprovada === true,
    numeroNota: i.numeroNota == null || i.numeroNota === '' ? null : str(i.numeroNota),
    jaPago: jp
      ? { em: str(jp.em), manual: jp.manual === true, por: jp.por ? str(jp.por) : null, referencia: jp.referencia ? str(jp.referencia) : null }
      : null,
    podeReenviarNoApp: typeof i.podeReenviarNoApp === 'boolean' ? i.podeReenviarNoApp : null,
  };
}

export function parseRegularizadasResponse(raw: unknown): RegularizadasResponse {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const itens = (Array.isArray(r.itens) ? r.itens : []).map(parseNotaRegularizada);
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

const base = (id: number) => `/validacao-xml/regularizadas/${encodeURIComponent(String(id))}`;

export async function marcarJaPago(id: number, referencia: string): Promise<NotaRegularizada> {
  const raw = await request<{ item?: unknown }>(`${base(id)}/ja-pago`, {
    method: 'POST',
    body: JSON.stringify({ referencia }),
  });
  return parseNotaRegularizada(raw?.item);
}

export async function desfazerJaPago(id: number): Promise<NotaRegularizada> {
  const raw = await request<{ item?: unknown }>(`${base(id)}/ja-pago`, { method: 'DELETE' });
  return parseNotaRegularizada(raw?.item);
}

/** Devolve se o motorista consegue reenviar pelo app (semana dentro do corte). */
export async function apagarNota(id: number, motivo: string): Promise<{ podeReenviarNoApp: boolean }> {
  const raw = await request<{ podeReenviarNoApp?: unknown }>(`${base(id)}/apagar-nota`, {
    method: 'POST',
    body: JSON.stringify({ motivo }),
  });
  return { podeReenviarNoApp: raw?.podeReenviarNoApp === true };
}

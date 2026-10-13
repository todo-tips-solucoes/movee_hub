/**
 * Notas pendentes do motorista (frente nota-pendente-motorista, F3).
 *
 * Cliente tipado das rotas `GET /motorista/notas-pendentes` e
 * `POST /motorista/notas-pendentes/:id/validar` (prefixo `/motorista`, não
 * `/api/v1/motorista`), mais a lógica pura da UI (rótulos, aria-label,
 * mensagem de erro) — separada dos componentes para ser testável com
 * `node --test`, sem jsdom.
 *
 * Ref: docs/plans/nota-pendente-motorista/BRIEFING.md
 */

import { api, ApiError } from './api-client.ts';
import { formatDate } from './utils.ts';

export type OrigemNota = 'MOVIMENTO' | 'REPASSE';

export interface NotaPendente {
  id: number;
  criadoEm: string;
  valor: string | number | null;
  dtInicial: string | null;
  dtFinal: string | null;
  cnpjTomador: string | null;
  tomador: string | null;
  origem: OrigemNota;
  /** Só vem quando a nota já foi enviada e recusada; item nunca enviado não tem a chave. */
  camposInvalidos?: CampoInvalido[];
}

export interface CampoInvalido {
  campo: string;
  mensagem: string;
}

/** Resposta 200 do envio — `valid:false` é nota reprovada pela validação. */
export interface ResultadoEnvio {
  valid: boolean;
  notaOk: boolean;
  mensagem?: string;
  camposInvalidos?: CampoInvalido[];
  instrucao?: string;
}

export async function listarNotasPendentes(): Promise<NotaPendente[]> {
  const data = await api.get<{ notas: NotaPendente[] }>('/motorista/notas-pendentes');
  return data.notas ?? [];
}

export function enviarNotaPendente(id: number, arquivo: File): Promise<ResultadoEnvio> {
  return api.uploadFile<ResultadoEnvio>(`/motorista/notas-pendentes/${id}/validar`, arquivo);
}

// ── Lógica pura da UI ────────────────────────────────────────────────────

/** O card da home só existe quando há pendência — nada de "você não tem". */
export function mostrarCardPendentes(contagem: number | null | undefined): boolean {
  return typeof contagem === 'number' && contagem > 0;
}

export function textoContagem(contagem: number): string {
  return contagem === 1 ? '1 nota pendente' : `${contagem} notas pendentes`;
}

/** "Movimento semanal" para planilha; "Repasse" para nota gerada pelo repasse. */
export function rotuloOrigem(origem: OrigemNota | string): string {
  return origem === 'REPASSE' ? 'Repasse' : 'Movimento semanal';
}

/** Data de referência da linha: início do período, senão fim, senão criação. */
export function dataDaPendencia(n: Pick<NotaPendente, 'dtInicial' | 'dtFinal' | 'criadoEm'>): string {
  return formatDate(n.dtInicial || n.dtFinal || n.criadoEm);
}

/** Período "dd/mm/aaaa a dd/mm/aaaa" quando há dois extremos diferentes. */
export function periodoDaPendencia(n: Pick<NotaPendente, 'dtInicial' | 'dtFinal' | 'criadoEm'>): string {
  if (n.dtInicial && n.dtFinal && formatDate(n.dtInicial) !== formatDate(n.dtFinal)) {
    return `${formatDate(n.dtInicial)} a ${formatDate(n.dtFinal)}`;
  }
  return dataDaPendencia(n);
}

/** Identifica de qual pendência é o input de arquivo: "Enviar nota de 05/10". */
export function ariaLabelEnvio(n: Pick<NotaPendente, 'dtInicial' | 'dtFinal' | 'criadoEm'>): string {
  const [dia, mes] = dataDaPendencia(n).split('/');
  return `Enviar nota de ${dia}/${mes}`;
}

/** Motivo real devolvido pelo backend (422 negócio, 502 infra, 409, 404...). */
export function mensagemErroEnvio(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error && err.message) return err.message;
  return 'Erro ao enviar. Tente novamente.';
}

/** Motivos de uma nota reprovada (200 com `valid:false`), na ordem do backend. */
export function motivosReprovacao(r: ResultadoEnvio): string[] {
  const campos = (r.camposInvalidos ?? []).map((c) => c.mensagem);
  return r.instrucao ? [...campos, r.instrucao] : campos;
}

/** Mensagens da recusa anterior (nota já enviada e não aceita); [] se nunca foi enviada. */
export function motivosRecusaAnterior(n: Pick<NotaPendente, 'camposInvalidos'>): string[] {
  return (n.camposInvalidos ?? []).map((c) => c.mensagem);
}

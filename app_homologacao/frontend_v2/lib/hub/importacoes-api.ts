// hub-importacoes (S4) — FASE 6: chamadas HTTP para `/api/v1/importacoes*`.
//
// Distinto de `contexts/hub-auth-context.tsx` (`hubFetch`, não exportado):
// aquele só extrai `body.erro` (string humana). O contrato desta feature
// (contracts/importacoes-api.md) usa DOIS formatos de erro —
// `{erro: "NAO_ENCONTRADO"}` (401/400/403/404/500, código-enum) e
// `{error: "CONFLITO", importacaoOriginalId}` / `{error: "INVALIDO", motivo}`
// (409/422, com dado extra que a UI precisa: link para a importação
// original, motivo legível) — por isso a leitura do erro é própria daqui,
// enquanto o `fetch` em si vem do molde compartilhado `lib/hub/api.ts`.
//
// Ref: docs/specs/hub-importacoes/contracts/importacoes-api.md.

import { HUB_API_BASE, HubApiError, criarRequest, query } from './api';
import {
  parseImportacaoDetalhe,
  parseImportacaoErrosResponse,
  parseImportacaoListResponse,
  type ImportacaoDetalhe,
  type ImportacaoErrosResponse,
  type ImportacaoListResponse,
  type TipoImportacao,
} from './importacoes-dto';

/** Mensagens legíveis para os `motivo`/códigos que o backend emite
 * (routes/hub-importacoes.js) — nunca expor o código bruto na tela. */
const MENSAGENS_MOTIVO: Record<string, string> = {
  tipo_invalido: 'Tipo de importação inválido. Selecione faturamento ou performance.',
  arquivo_ausente: 'Selecione um arquivo para enviar.',
  extensao_invalida: 'Extensão de arquivo não suportada. Envie um .csv ou .zip.',
  mime_invalido: 'Tipo de arquivo não reconhecido. Envie um .csv ou .zip válido.',
  arquivo_vazio: 'O arquivo está vazio.',
  tamanho_excedido: 'O arquivo excede o tamanho máximo de 20 MB.',
  conteudo_invalido: 'Não foi possível ler o conteúdo do arquivo. Confira o formato.',
  conteudo_vazio: 'O arquivo não contém nenhuma linha legível.',
  upload_invalido: 'Falha ao enviar o arquivo. Tente novamente.',
};

const MENSAGENS_CODIGO: Record<string, string> = {
  NAO_AUTENTICADO: 'Sua sessão expirou. Faça login novamente.',
  ENTIDADE_NAO_SELECIONADA: 'Selecione uma entidade antes de continuar.',
  PERMISSAO_NEGADA: 'Você não tem permissão para esta ação.',
  NAO_ENCONTRADO: 'Importação não encontrada.',
  ERRO_SERVIDOR: 'Erro no servidor. Tente novamente em instantes.',
};

export class ImportacaoApiError extends HubApiError {
  constructor(
    status: number,
    message: string,
    codigo?: string,
    public readonly motivo?: string,
    public readonly importacaoOriginalId?: number
  ) {
    super(status, message, codigo);
    this.name = 'ImportacaoApiError';
  }
}

/** Único módulo do hub que aceita as DUAS chaves — ver o cabeçalho. */
function codigoDoErroImportacao(body: Record<string, unknown>): string | undefined {
  return (
    (typeof body.erro === 'string' && body.erro) ||
    (typeof body.error === 'string' && body.error) ||
    undefined
  );
}

function mensagemAmigavel(body: Record<string, unknown>, status: number): string {
  const motivo = typeof body.motivo === 'string' ? body.motivo : undefined;
  if (motivo && MENSAGENS_MOTIVO[motivo]) return MENSAGENS_MOTIVO[motivo];

  const codigo = codigoDoErroImportacao(body);
  if (codigo === 'CONFLITO') return 'Este arquivo já foi importado anteriormente.';
  if (codigo && MENSAGENS_CODIGO[codigo]) return MENSAGENS_CODIGO[codigo];
  return `Erro ${status}. Tente novamente.`;
}

const request = criarRequest(
  (status, body) =>
    new ImportacaoApiError(
      status,
      mensagemAmigavel(body, status),
      codigoDoErroImportacao(body),
      typeof body.motivo === 'string' ? body.motivo : undefined,
      typeof body.importacaoOriginalId === 'number' ? body.importacaoOriginalId : undefined
    )
);

/** impeccable rodada 16: allowlist correspondente vive em
 *  `ORDENAVEIS_IMPORTACOES` (`routes/hub-importacoes.js`). */
export type ColunaImportacoes =
  | 'criado_em'
  | 'tipo'
  | 'status'
  | 'nome_arquivo'
  | 'total_linhas'
  | 'data_referencia';

export interface ListarImportacoesQuery {
  ordenarPor?: ColunaImportacoes | '';
  direcao?: 'asc' | 'desc' | '';
  tipo?: TipoImportacao | '';
  status?: string;
  de?: string;
  ate?: string;
  responsavel?: string;
  page?: number;
  pageSize?: number;
}

export async function listarImportacoes(filtros: ListarImportacoesQuery = {}): Promise<ImportacaoListResponse> {
  const raw = await request<unknown>(`/importacoes${query(filtros)}`);
  return parseImportacaoListResponse(raw);
}

export async function obterImportacao(id: number): Promise<ImportacaoDetalhe> {
  const raw = await request<unknown>(`/importacoes/${id}`);
  return parseImportacaoDetalhe(raw);
}

export async function listarErros(
  id: number,
  paginacao: { page?: number; pageSize?: number } = {}
): Promise<ImportacaoErrosResponse> {
  const raw = await request<unknown>(`/importacoes/${id}/erros${query(paginacao)}`);
  return parseImportacaoErrosResponse(raw);
}

/** Dispara o download do CSV de erros (`?format=csv`) — mesmo padrão de
 * `api.downloadBlob` (lib/api-client.ts), mas escopado a `HUB_API_BASE`. */
export async function baixarErrosCsv(id: number, nomeArquivoFallback = `importacao-${id}-erros.csv`): Promise<void> {
  const res = await fetch(`${HUB_API_BASE}/importacoes/${id}/erros?format=csv`, { credentials: 'include' });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ImportacaoApiError(res.status, mensagemAmigavel(body, res.status));
  }
  const blob = await res.blob();
  const disposition = res.headers.get('Content-Disposition');
  const match = disposition?.match(/filename="?([^"]+)"?/);
  const filename = match ? match[1] : nomeArquivoFallback;
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.URL.revokeObjectURL(url);
}

/** Download do arquivo original. Lança `ImportacaoApiError` com `status
 * 410` quando o arquivo físico não está mais disponível (CHK021) — a UI
 * deve mostrar essa mensagem em vez de tentar o download. */
export async function baixarOriginal(id: number, nomeArquivoFallback = `importacao-${id}`): Promise<void> {
  const res = await fetch(`${HUB_API_BASE}/importacoes/${id}/original`, { credentials: 'include' });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const bodyObj = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    if (res.status === 410) {
      throw new ImportacaoApiError(410, 'O arquivo original não está mais disponível para download.', 'ARQUIVO_INDISPONIVEL');
    }
    throw new ImportacaoApiError(res.status, mensagemAmigavel(bodyObj, res.status));
  }
  const blob = await res.blob();
  const disposition = res.headers.get('Content-Disposition');
  const match = disposition?.match(/filename="?([^"]+)"?/);
  const filename = match ? match[1] : nomeArquivoFallback;
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.URL.revokeObjectURL(url);
}

export async function enviarImportacao(tipo: TipoImportacao, file: File): Promise<{ id: number; status: string }> {
  const formData = new FormData();
  formData.append('tipo', tipo);
  formData.append('file', file);
  return request<{ id: number; status: string }>('/importacoes', { method: 'POST', body: formData });
}

export async function reprocessarImportacao(id: number): Promise<{ id: number; status: string }> {
  return request<{ id: number; status: string }>(`/importacoes/${id}/reprocessar`, { method: 'POST' });
}

export async function cancelarImportacao(id: number): Promise<{ id: number; status: string }> {
  return request<{ id: number; status: string }>(`/importacoes/${id}/cancelar`, { method: 'POST' });
}

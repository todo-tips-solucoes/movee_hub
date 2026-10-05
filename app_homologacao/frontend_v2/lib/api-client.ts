const BASE = '/api';
const DEFAULT_TIMEOUT = 10_000;

async function fetchWithTimeout(input: RequestInfo, init?: RequestInit, timeout = DEFAULT_TIMEOUT): Promise<Response> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new Error('Tempo limite excedido. Tente novamente.');
    }
    throw new Error('Falha na conexao com o servidor. Verifique sua rede.');
  } finally {
    clearTimeout(id);
  }
}

/** Uma linha da planilha que o backend recusou, já normalizada para a tela. */
export interface LinhaInvalida {
  /** número da linha como aparece no Excel (cabeçalho = 1) */
  linha: number;
  motivos: string[];
}

/**
 * Erro de API que PRESERVA o detalhe que o backend mandou.
 *
 * O `/upload` do envio em massa devolve, junto da mensagem genérica, a lista de
 * linhas recusadas com o motivo de cada uma — e esse detalhe vinha sendo jogado
 * fora aqui, no `new Error(body.message)`. Com 982 linhas na planilha, "Erros de
 * validação encontrados" manda a pessoa caçar à mão o que o servidor já sabia:
 * em 05/10 eram 4 linhas com texto ("Em andamento", "Não localizado") na coluna
 * do CNPJ, e as outras 978 não entraram por causa delas.
 *
 * NÃO carrega o `preview` (a linha inteira da planilha, com nome e telefone):
 * para corrigir basta o número da linha e o motivo, e dado pessoal não precisa
 * circular pela tela nem pela área de transferência.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly linhasInvalidas: LinhaInvalida[];

  constructor(message: string, status: number, linhasInvalidas: LinhaInvalida[] = []) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.linhasInvalidas = linhasInvalidas;
  }
}

/** `errors` do backend -> `LinhaInvalida[]`, tolerante a formato inesperado. */
function extrairLinhasInvalidas(body: unknown): LinhaInvalida[] {
  const lista = (body as { errors?: unknown })?.errors;
  if (!Array.isArray(lista)) return [];
  return lista
    .map((item) => {
      const linha = Number((item as { rowIndex?: unknown })?.rowIndex);
      const motivosBrutos = (item as { errors?: unknown })?.errors;
      const motivos = Array.isArray(motivosBrutos) ? motivosBrutos.map(String) : [];
      return Number.isFinite(linha) && motivos.length > 0 ? { linha, motivos } : null;
    })
    .filter((x): x is LinhaInvalida => x !== null);
}

async function handleResponse(res: Response) {
  if (res.status === 401) {
    throw new Error('Não autorizado');
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({ message: 'Erro desconhecido' }));
    throw new ApiError(
      body.message || body.error || `Erro ${res.status}`,
      res.status,
      extrairLinhasInvalidas(body)
    );
  }
  return res;
}

function buildQuery(params?: Record<string, string | number | undefined | null>): string {
  if (!params) return '';
  const qs = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
  return qs ? `?${qs}` : '';
}

export const api = {
  async get<T = unknown>(path: string, query?: Record<string, string | number | undefined | null>): Promise<T> {
    const res = await fetchWithTimeout(`${BASE}${path}${buildQuery(query)}`, { credentials: 'include' });
    await handleResponse(res);
    return res.json();
  },

  async post<T = unknown>(path: string, body?: Record<string, unknown>): Promise<T> {
    const res = await fetchWithTimeout(`${BASE}${path}`, {
      method: 'POST',
      credentials: 'include',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    await handleResponse(res);
    return res.json();
  },

  async patch<T = unknown>(path: string, body: Record<string, unknown>): Promise<T> {
    const res = await fetchWithTimeout(`${BASE}${path}`, {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    await handleResponse(res);
    return res.json();
  },

  async del<T = unknown>(path: string, query?: Record<string, string | number | undefined | null>): Promise<T> {
    const res = await fetchWithTimeout(`${BASE}${path}${buildQuery(query)}`, {
      method: 'DELETE',
      credentials: 'include',
    });
    await handleResponse(res);
    return res.json();
  },

  async uploadFile<T = unknown>(path: string, file: File, extraFields?: Record<string, string>): Promise<T> {
    const formData = new FormData();
    formData.append('file', file);
    if (extraFields) {
      for (const [key, value] of Object.entries(extraFields)) {
        formData.append(key, value);
      }
    }
    const res = await fetchWithTimeout(`${BASE}${path}`, {
      method: 'POST',
      credentials: 'include',
      body: formData,
    });
    await handleResponse(res);
    return res.json();
  },

  async uploadMultipleFilesAndDownload(path: string, fieldName: string, files: File[], extraFields?: Record<string, string>): Promise<void> {
    const formData = new FormData();
    for (const file of files) {
      formData.append(fieldName, file);
    }
    if (extraFields) {
      for (const [key, value] of Object.entries(extraFields)) {
        formData.append(key, value);
      }
    }
    const res = await fetch(`${BASE}${path}`, {
      method: 'POST',
      credentials: 'include',
      body: formData,
    });
    await handleResponse(res);
    const blob = await res.blob();
    const disposition = res.headers.get('Content-Disposition');
    const match = disposition?.match(/filename=(.+)/);
    const filename = match ? match[1] : 'validacao_nfse.csv';
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.URL.revokeObjectURL(url);
  },

  async downloadBlob(path: string, filename: string, query?: Record<string, string | number | undefined | null>): Promise<void> {
    const res = await fetchWithTimeout(`${BASE}${path}${buildQuery(query)}`, { credentials: 'include' });
    await handleResponse(res);
    const blob = await res.blob();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.URL.revokeObjectURL(url);
  },
};

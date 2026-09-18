/**
 * API Client para o App Motorista PWA.
 * Adaptado de frontend_v2/lib/api-client.ts — rotas /api/motorista/*.
 * Ref: tarefa 4.1.2 / contracts/motorista-api.md
 */

const BASE = '/api';
const DEFAULT_TIMEOUT = 15_000; // 15s (upload de XML pode ser mais lento)

async function fetchWithTimeout(
  input: RequestInfo,
  init?: RequestInit,
  timeout = DEFAULT_TIMEOUT,
): Promise<Response> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new Error('Tempo limite excedido. Tente novamente.');
    }
    throw err;
  } finally {
    clearTimeout(id);
  }
}

// push-motorista (tasks.md 6.1) — `status` no erro permite ao chamador
// distinguir, por exemplo, `409 CHAVE_DESATUALIZADA` de qualquer outra
// falha sem parsear a mensagem (lib/push.ts#sincronizar).
//
// adiantamento-motorista (tasks.md 6.1.2, contracts/motorista-api.md
// "Mudanças em contratos existentes"): as rotas novas respondem
// `{erro:'CODIGO', motivo?}` em vez de `{message}`/`{error}` — `code`/
// `motivo` preservam o valor cru para lib/erros-adiantamento.ts traduzir
// por código, sem que os chamadores existentes (lib/push.ts) precisem mudar.
export class ApiError extends Error {
  status: number;
  code?: string;
  motivo?: string;
  constructor(message: string, status: number, code?: string, motivo?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.motivo = motivo;
  }
}

// adiantamento-motorista (tasks.md 6.7.3/FR-054): 401 costumava sempre virar
// a mensagem fixa "Não autorizado", descartando o motivo real que o servidor
// mandou (ex.: "Credenciais inválidas.", "Token de atualização inválido.").
// Agora lê o corpo como qualquer outro erro — só cai no genérico se o corpo
// realmente não trouxer nada (ex.: resposta vazia).
async function handleResponse(res: Response): Promise<void> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const code = typeof body.erro === 'string' ? body.erro : undefined;
    const motivo = typeof body.motivo === 'string' ? body.motivo : undefined;
    const generico = res.status === 401 ? 'Não autorizado' : `Erro ${res.status}`;
    throw new ApiError(body.message || body.error || code || generico, res.status, code, motivo);
  }
}

// push-motorista (tasks.md 6.1) — PUT /motorista/push/{inscricao,estado}
// respondem 204 sem corpo; `res.json()` incondicional quebraria nesse caso.
async function parseBody<T>(res: Response): Promise<T> {
  if (res.status === 204) return undefined as T;
  return res.json();
}

export const api = {
  async get<T = unknown>(path: string): Promise<T> {
    const res = await fetchWithTimeout(`${BASE}${path}`, { credentials: 'include' });
    await handleResponse(res);
    return parseBody<T>(res);
  },

  async post<T = unknown>(path: string, body?: Record<string, unknown>): Promise<T> {
    const res = await fetchWithTimeout(`${BASE}${path}`, {
      method: 'POST',
      credentials: 'include',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    await handleResponse(res);
    return parseBody<T>(res);
  },

  async put<T = unknown>(path: string, body?: Record<string, unknown>): Promise<T> {
    const res = await fetchWithTimeout(`${BASE}${path}`, {
      method: 'PUT',
      credentials: 'include',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    await handleResponse(res);
    return parseBody<T>(res);
  },

  /** Upload de arquivo XML — multipart/form-data */
  async uploadFile<T = unknown>(path: string, file: File, fieldName = 'file'): Promise<T> {
    const formData = new FormData();
    formData.append(fieldName, file);
    const res = await fetchWithTimeout(
      `${BASE}${path}`,
      {
        method: 'POST',
        credentials: 'include',
        body: formData,
      },
      30_000, // upload pode demorar mais
    );
    await handleResponse(res);
    return res.json();
  },
};

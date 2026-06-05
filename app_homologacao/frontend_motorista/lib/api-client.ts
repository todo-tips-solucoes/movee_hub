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

async function handleResponse(res: Response): Promise<void> {
  if (res.status === 401) {
    throw new Error('Não autorizado');
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({ message: 'Erro desconhecido' }));
    throw new Error(body.message || body.error || `Erro ${res.status}`);
  }
}

export const api = {
  async get<T = unknown>(path: string): Promise<T> {
    const res = await fetchWithTimeout(`${BASE}${path}`, { credentials: 'include' });
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

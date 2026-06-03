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

async function handleResponse(res: Response) {
  if (res.status === 401) {
    throw new Error('Não autorizado');
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({ message: 'Erro desconhecido' }));
    throw new Error(body.message || body.error || `Erro ${res.status}`);
  }
  return res;
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

  async del<T = unknown>(path: string): Promise<T> {
    const res = await fetchWithTimeout(`${BASE}${path}`, {
      method: 'DELETE',
      credentials: 'include',
    });
    await handleResponse(res);
    return res.json();
  },

  async uploadFile<T = unknown>(path: string, file: File): Promise<T> {
    const formData = new FormData();
    formData.append('file', file);
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

  async downloadBlob(path: string, filename: string): Promise<void> {
    const res = await fetchWithTimeout(`${BASE}${path}`, { credentials: 'include' });
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

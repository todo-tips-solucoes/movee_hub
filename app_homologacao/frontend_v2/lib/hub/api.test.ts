// Testes do molde compartilhado `lib/hub/api.ts`.
//
// Cobrem o que a consolidação dos 7 `*-api.ts` passou a depender e que antes
// era garantido por cópia: a hierarquia de erros (as páginas discriminam com
// `instanceof XApiError`), o `name` literal sobrevivendo ao build, e os dois
// casos que só existiam em um módulo cada e viraram comportamento comum
// (`204` → `undefined`, `FormData` sem `Content-Type` forçado).

import { describe, expect, it, vi, afterEach } from 'vitest';

import { HubApiError, criarRequest, query, codigoDoErro, mensagemPorCodigo } from './api';
import { UsuariosApiError } from './usuarios-api';
import { MotoristaApiError } from './motoristas-api';

function respostaFake(body: unknown, init: { status?: number } = {}) {
  const status = init.status ?? 200;
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('query', () => {
  it('omite undefined, null e string vazia', () => {
    expect(query({ a: 1, b: undefined, c: null, d: '', e: 'x' })).toBe('?a=1&e=x');
  });

  it('devolve string vazia (não "?") quando não sobra nada', () => {
    expect(query({})).toBe('');
    expect(query({ a: undefined })).toBe('');
  });

  it('encoda chave e valor', () => {
    expect(query({ 'a b': 'c&d' })).toBe('?a%20b=c%26d');
  });
});

describe('codigoDoErro / mensagemPorCodigo', () => {
  it('lê a chave `erro` e ignora `error`', () => {
    expect(codigoDoErro({ erro: 'PERMISSAO_NEGADA' })).toBe('PERMISSAO_NEGADA');
    expect(codigoDoErro({ error: 'PERMISSAO_NEGADA' })).toBeUndefined();
  });

  it('cai no fallback por status quando o código é desconhecido', () => {
    const mensagens = { PERMISSAO_NEGADA: 'Sem permissão.' };
    expect(mensagemPorCodigo(mensagens, { erro: 'PERMISSAO_NEGADA' }, 403)).toBe('Sem permissão.');
    expect(mensagemPorCodigo(mensagens, { erro: 'DESCONHECIDO' }, 500)).toBe('Erro 500. Tente novamente.');
    expect(mensagemPorCodigo(mensagens, {}, 502)).toBe('Erro 502. Tente novamente.');
  });
});

describe('hierarquia de erros', () => {
  // As páginas fazem `e instanceof UsuariosApiError ? e.message : 'fallback'`.
  it('a subclasse é instanceof dela mesma, de HubApiError e de Error', () => {
    const e = new UsuariosApiError(403, 'Sem permissão.', 'PERMISSAO_NEGADA');
    expect(e).toBeInstanceOf(UsuariosApiError);
    expect(e).toBeInstanceOf(HubApiError);
    expect(e).toBeInstanceOf(Error);
  });

  it('não confunde subclasses de domínios diferentes', () => {
    expect(new UsuariosApiError(500, 'x')).not.toBeInstanceOf(MotoristaApiError);
  });

  it('name é a string literal (sobrevive à minificação do build)', () => {
    expect(new UsuariosApiError(500, 'x').name).toBe('UsuariosApiError');
    expect(new MotoristaApiError(500, 'x').name).toBe('MotoristaApiError');
  });

  it('a subclasse preserva status/codigo e os campos extras', () => {
    const e = new MotoristaApiError(409, 'Conflito.', 'CONFLITO', 'conta_ja_vinculada', {
      entregadorId: 7,
      nome: 'Fulano',
    });
    expect(e.status).toBe(409);
    expect(e.codigo).toBe('CONFLITO');
    expect(e.motivo).toBe('conta_ja_vinculada');
    expect(e.vinculadaA).toEqual({ entregadorId: 7, nome: 'Fulano' });
  });
});

describe('criarRequest', () => {
  const falha = (status: number, body: Record<string, unknown>) =>
    new UsuariosApiError(status, mensagemPorCodigo({}, body, status), codigoDoErro(body));

  it('devolve o corpo desserializado em 2xx', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => respostaFake({ items: [1, 2] })));
    const request = criarRequest(falha);
    await expect(request('/usuarios')).resolves.toEqual({ items: [1, 2] });
  });

  it('lança o erro construído por `falha` fora de 2xx', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => respostaFake({ erro: 'PERMISSAO_NEGADA' }, { status: 403 })));
    const request = criarRequest(falha);
    await expect(request('/usuarios')).rejects.toMatchObject({
      name: 'UsuariosApiError',
      status: 403,
      codigo: 'PERMISSAO_NEGADA',
    });
  });

  it('corpo não-JSON vira {} em vez de estourar', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        status: 500,
        ok: false,
        json: async () => {
          throw new SyntaxError('não é JSON');
        },
      }))
    );
    const request = criarRequest(falha);
    await expect(request('/usuarios')).rejects.toMatchObject({ status: 500, codigo: undefined });
  });

  // Antes só existia em motoristas-api.ts; hoistado porque só
  // routes/hub-motoristas.js responde 204 no backend.
  it('204 devolve undefined sem tentar ler o corpo', async () => {
    const json = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async () => ({ status: 204, ok: true, json })));
    const request = criarRequest(falha);
    await expect(request('/motoristas/1/vinculo')).resolves.toBeUndefined();
    expect(json).not.toHaveBeenCalled();
  });

  /** Stub de `fetch` que guarda os argumentos da chamada. */
  function capturarFetch() {
    const capturado: { url?: string; init?: RequestInit } = {};
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        capturado.url = url;
        capturado.init = init;
        return respostaFake({});
      })
    );
    return capturado;
  }

  it('manda os cookies da sessão', async () => {
    const capturado = capturarFetch();
    await criarRequest(falha)('/usuarios');
    expect(capturado.url).toBe('/api/v1/usuarios');
    expect(capturado.init).toMatchObject({ credentials: 'include' });
  });

  it('body JSON ganha Content-Type', async () => {
    const capturado = capturarFetch();
    await criarRequest(falha)('/usuarios', { method: 'POST', body: JSON.stringify({ a: 1 }) });
    expect(capturado.init?.headers).toMatchObject({ 'Content-Type': 'application/json' });
  });

  // Antes só existia em importacoes-api.ts: forçar Content-Type em FormData
  // destrói o boundary do multipart e o upload falha.
  it('FormData NÃO ganha Content-Type', async () => {
    const capturado = capturarFetch();
    const fd = new FormData();
    fd.append('file', new Blob(['x']), 'a.csv');
    await criarRequest(falha)('/importacoes', { method: 'POST', body: fd });
    expect(capturado.init?.headers).not.toHaveProperty('Content-Type');
  });
});

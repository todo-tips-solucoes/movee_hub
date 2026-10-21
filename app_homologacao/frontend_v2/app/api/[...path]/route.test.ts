// @vitest-environment node
//
// hub-sessao-inatividade (2026-09-06): prova, no handler REAL do proxy, que
// uma tela continua funcionando depois que o access vence (o proxy renova e
// encaminha) e que, se a renovação falha, o 401 chega ao cliente com os
// cookies limpos — daí o contexto (contexts/hub-auth-context.test.tsx,
// "401 in-flight limpa o estado") e o guard (components/hub/session-guard.test.tsx)
// levam ao /hub/login.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET, POST } from './route';
import { _limparRenovacoes } from '@/lib/hub/sessao-proxy';

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const accessVencido = `${b64({ alg: 'HS256' })}.${b64({ sub: 1, exp: 1 })}.x`;
const accessValido = `${b64({ alg: 'HS256' })}.${b64({ sub: 1, exp: Math.floor(Date.now() / 1000) + 600 })}.x`;

function resposta(status: number, corpo: unknown = {}, cookies: string[] = []) {
  const h = new Headers({ 'content-type': 'application/json' });
  for (const c of cookies) h.append('set-cookie', c);
  return new Response(JSON.stringify(corpo), { status, headers: h });
}
const COOKIES_NOVOS = ['hub_accessToken=a2; Max-Age=900; Path=/; HttpOnly', 'hub_refreshToken=1757.r2; Max-Age=21600; Path=/; HttpOnly'];
const COOKIES_LIMPOS = ['hub_accessToken=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT', 'hub_refreshToken=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT'];

function req(path: string, cookie: string, init: { method?: string; body?: string; contentType?: string } = {}) {
  const headers = new Headers({ cookie });
  if (init.contentType) headers.set('content-type', init.contentType);
  return new NextRequest(`http://front${path}`, { method: init.method ?? 'GET', headers, body: init.body });
}
const chamadas = () => vi.mocked(fetch).mock.calls.map(([url, i]) => ({ url: String(url), cookie: (i?.headers as Record<string, string> | Headers | undefined) instanceof Headers ? (i!.headers as Headers).get('cookie') : (i?.headers as Record<string, string>)?.cookie, body: i?.body }));

beforeEach(() => {
  _limparRenovacoes();
  vi.stubGlobal('fetch', vi.fn());
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('proxy — renovação silenciosa da sessão do hub', () => {
  it('access vencido + refresh válido: renova ANTES, encaminha com os cookies novos e devolve-os ao browser', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(resposta(200, { ok: true }, COOKIES_NOVOS)) // POST /v1/auth/refresh
      .mockResolvedValueOnce(resposta(200, { usuario: { id: 1 } })); // GET /v1/me
    const res = await GET(req('/api/v1/me', `hub_accessToken=${accessVencido}; hub_refreshToken=1757.r1`));
    expect(res.status).toBe(200);
    const c = chamadas();
    expect(c.map((x) => x.url)).toEqual(['http://localhost:3000/v1/auth/refresh', 'http://localhost:3000/v1/me']);
    expect(c[0].cookie).toContain('hub_refreshToken=1757.r1');
    expect(c[1].cookie).toBe('hub_accessToken=a2; hub_refreshToken=1757.r2');
    expect(res.headers.getSetCookie()).toEqual(COOKIES_NOVOS);
  });

  it('access ausente (cookie de 15 min já caiu no browser) conta como vencido', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(resposta(200, {}, COOKIES_NOVOS)).mockResolvedValueOnce(resposta(200));
    const res = await GET(req('/api/v1/me', 'hub_refreshToken=1757.r1'));
    expect(res.status).toBe(200);
    expect(chamadas()[0].url).toBe('http://localhost:3000/v1/auth/refresh');
  });

  it('renovação falha (inatividade/teto/reuso): o 401 chega ao cliente com os cookies LIMPOS — fim da sessão', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(resposta(401, { erro: 'Sessão inválida.' }, COOKIES_LIMPOS))
      .mockResolvedValueOnce(resposta(401, { erro: 'NAO_AUTENTICADO' }));
    const res = await GET(req('/api/v1/me', `hub_accessToken=${accessVencido}; hub_refreshToken=1757.r1`));
    expect(res.status).toBe(401);
    expect(res.headers.getSetCookie()).toEqual(COOKIES_LIMPOS);
    expect(fetch).toHaveBeenCalledTimes(2); // não repete o refresh já falhado
  });

  it('access válido mas backend responde 401 (ex.: segredo rotacionado): renova e repete UMA vez, reenviando o corpo JSON', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(resposta(401, { erro: 'NAO_AUTENTICADO' }))
      .mockResolvedValueOnce(resposta(200, {}, COOKIES_NOVOS))
      .mockResolvedValueOnce(resposta(200, { entidade_ativa: 9 }));
    const res = await POST(
      req('/api/v1/me/entidade', `hub_accessToken=${accessValido}; hub_refreshToken=1757.r1`, {
        method: 'POST', body: '{"empresa_id":9}', contentType: 'application/json',
      })
    );
    expect(res.status).toBe(200);
    const c = chamadas();
    expect(c.map((x) => x.url)).toEqual(['http://localhost:3000/v1/me/entidade', 'http://localhost:3000/v1/auth/refresh', 'http://localhost:3000/v1/me/entidade']);
    expect(c[2].body).toBe('{"empresa_id":9}');
    expect(c[2].cookie).toBe('hub_accessToken=a2; hub_refreshToken=1757.r2');
  });

  it('duas requisições concorrentes com access vencido fazem UM único refresh (não dispara a detecção de reuso)', async () => {
    vi.mocked(fetch).mockImplementation(async (url) =>
      String(url).endsWith('/auth/refresh') ? resposta(200, {}, COOKIES_NOVOS) : resposta(200, {})
    );
    const cookie = `hub_accessToken=${accessVencido}; hub_refreshToken=1757.r1`;
    const [a, b] = await Promise.all([GET(req('/api/v1/me', cookie)), GET(req('/api/v1/importacoes', cookie))]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(chamadas().filter((x) => x.url.endsWith('/auth/refresh'))).toHaveLength(1);
  });

  it('401 de /v1/auth/login (senha errada) NÃO tenta renovar', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(resposta(401, { erro: 'E-mail ou senha inválidos.' }));
    const res = await POST(req('/api/v1/auth/login', 'hub_refreshToken=1757.r1', { method: 'POST', body: '{}', contentType: 'application/json' }));
    expect(res.status).toBe(401);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('rota do legado (fora de /v1) segue byte a byte como antes: sem renovar, sem repetir', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(resposta(401, {}));
    const res = await GET(req('/api/verify-auth', 'accessToken=legado; hub_refreshToken=1757.r1'));
    expect(res.status).toBe(401);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it('upload multipart com access válido que leva 401: corpo é stream, não repete (só a renovação preventiva o cobre)', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(resposta(401, {}));
    const res = await POST(
      req('/api/v1/importacoes', `hub_accessToken=${accessValido}; hub_refreshToken=1757.r1`, {
        method: 'POST', body: '--x\r\n', contentType: 'multipart/form-data; boundary=x',
      })
    );
    expect(res.status).toBe(401);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

// retorno-transfeera-xlsx (2026-10-21): o retorno da Transfeera passou a ser um
// XLSX (ZIP) enviado em BINÁRIO. O proxy fazia `await req.text()` para todo
// content-type que não fosse multipart: decodificava UTF-8 e todo byte >= 0x80
// inválido virava U+FFFD — o arquivo bom chegava ao backend corrompido e
// nenhum teste do backend pegaria, porque o proxy é Next. Estes testes falam
// com o handler REAL.
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const DEZ_MB = 10 * 1024 * 1024;

/** Bytes que NÃO sobrevivem a `text()`: assinatura ZIP + 0x80..0xFF + NUL. */
function bytesXlsx() {
  const b = new Uint8Array(4 + 256 + 2);
  b.set([0x50, 0x4b, 0x03, 0x04]);
  for (let i = 0; i < 128; i += 1) b[4 + i] = 0x80 + i;
  for (let i = 0; i < 128; i += 1) b[4 + 128 + i] = 0xff - i;
  b[260] = 0x00;
  b[261] = 0xc3; // lead byte UTF-8 sem continuação: inválido
  return b;
}

function reqBin(
  cookie: string,
  corpo: Uint8Array,
  { contentType = XLSX_MIME, contentLength }: { contentType?: string; contentLength?: string | null } = {},
) {
  const headers = new Headers({ cookie, 'content-type': contentType });
  const cl = contentLength === undefined ? String(corpo.byteLength) : contentLength;
  if (cl !== null) headers.set('content-length', cl);
  return new NextRequest('http://front/api/v1/adiantamentos/lotes/900/retorno', { method: 'POST', headers, body: corpo as BodyInit });
}
const COOKIE_OK = () => `hub_accessToken=${accessValido}; hub_refreshToken=1757.r1`;

describe('proxy — corpo binário do retorno XLSX (FR-016/017/018)', () => {
  it('bytes 0x80..0xFF e PK\\x03\\x04 chegam ao backend byte a byte idênticos (sem U+FFFD)', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(resposta(200, { aplicadas: 1 }));
    const original = bytesXlsx();
    const res = await POST(reqBin(COOKIE_OK(), original));
    expect(res.status).toBe(200);
    const body = chamadas()[0].body as unknown;
    expect(typeof body).not.toBe('string');
    expect(Buffer.from(body as Uint8Array).equals(Buffer.from(original))).toBe(true);
  });

  it('mime com parâmetro (; charset) ainda entra no ramo binário', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(resposta(200));
    const original = bytesXlsx();
    await POST(reqBin(COOKIE_OK(), original, { contentType: `${XLSX_MIME}; charset=binary` }));
    expect(Buffer.from(chamadas()[0].body as Uint8Array).equals(Buffer.from(original))).toBe(true);
  });

  it('mime só PARECIDO (substring no meio do valor) NÃO entra no ramo binário', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(resposta(200));
    await POST(reqBin(COOKIE_OK(), new TextEncoder().encode('abc'), { contentType: 'text/plain; x=spreadsheetml.sheet' }));
    expect(chamadas()[0].body).toBe('abc'); // caminho de texto de sempre
  });

  it('content-length ausente -> 411 sem ler o corpo nem chamar o backend', async () => {
    const r = reqBin(COOKIE_OK(), bytesXlsx(), { contentLength: null });
    const lido = vi.spyOn(r, 'arrayBuffer');
    const res = await POST(r);
    expect(res.status).toBe(411);
    expect(lido).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('content-length inválido -> 411 sem ler o corpo', async () => {
    const r = reqBin(COOKIE_OK(), bytesXlsx(), { contentLength: 'abc' });
    const lido = vi.spyOn(r, 'arrayBuffer');
    expect((await POST(r)).status).toBe(411);
    expect(lido).not.toHaveBeenCalled();
  });

  it('content-length acima de 10 MB -> 413 ARQUIVO_MUITO_GRANDE sem ler o corpo', async () => {
    const r = reqBin(COOKIE_OK(), bytesXlsx(), { contentLength: String(DEZ_MB + 1) });
    const lido = vi.spyOn(r, 'arrayBuffer');
    const res = await POST(r);
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ erro: 'ARQUIVO_INVALIDO', motivo: 'ARQUIVO_MUITO_GRANDE' });
    expect(lido).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('exatamente 10 MB ainda é aceito', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(resposta(200));
    const res = await POST(reqBin(COOKIE_OK(), new Uint8Array(DEZ_MB).fill(0x50)));
    expect(res.status).toBe(200);
    expect((chamadas()[0].body as Uint8Array).byteLength).toBe(DEZ_MB);
  });

  it('CHK012 (a): 401 com corpo binário -> renova a sessão e REENVIA os mesmos bytes', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(resposta(401, { erro: 'NAO_AUTENTICADO' }))
      .mockResolvedValueOnce(resposta(200, {}, COOKIES_NOVOS)) // /v1/auth/refresh
      .mockResolvedValueOnce(resposta(200, { aplicadas: 1 }));
    const original = bytesXlsx();
    const res = await POST(reqBin(COOKIE_OK(), original));
    expect(res.status).toBe(200);
    const c = chamadas();
    expect(c.map((x) => x.url)).toEqual([
      'http://localhost:3000/v1/adiantamentos/lotes/900/retorno',
      'http://localhost:3000/v1/auth/refresh',
      'http://localhost:3000/v1/adiantamentos/lotes/900/retorno',
    ]);
    expect(Buffer.from(c[0].body as Uint8Array).equals(Buffer.from(original))).toBe(true);
    expect(Buffer.from(c[2].body as Uint8Array).equals(Buffer.from(original))).toBe(true);
    expect(c[2].cookie).toBe('hub_accessToken=a2; hub_refreshToken=1757.r2');
  });

  it('CHK012 (b): 401 com corpo multipart (stream) continua NÃO reenviável — uma única chamada', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(resposta(401, {}));
    const res = await POST(
      req('/api/v1/importacoes', COOKIE_OK(), { method: 'POST', body: '--x\r\n', contentType: 'multipart/form-data; boundary=x' })
    );
    expect(res.status).toBe(401);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('endpoint JSON segue recebendo `init.body` string (regressão do caminho existente)', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(resposta(200));
    await POST(req('/api/v1/me/entidade', COOKIE_OK(), { method: 'POST', body: '{"empresa_id":9}', contentType: 'application/json' }));
    expect(chamadas()[0].body).toBe('{"empresa_id":9}');
  });
});

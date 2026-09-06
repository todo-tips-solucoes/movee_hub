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

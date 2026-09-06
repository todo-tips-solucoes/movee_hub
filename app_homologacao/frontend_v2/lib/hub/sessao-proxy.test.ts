// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _limparRenovacoes,
  accessVenceEmBreve,
  mesclarCookies,
  renovarSessao,
  rotaExigeSessao,
} from './sessao-proxy';

function jwtCom(exp: unknown): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'HS256' })}.${b64({ sub: 1, exp })}.assinatura`;
}

describe('rotaExigeSessao', () => {
  it('rotas do hub exigem; /v1/auth/* e o legado não', () => {
    expect(rotaExigeSessao('/v1/me')).toBe(true);
    expect(rotaExigeSessao('/v1/importacoes/3/original')).toBe(true);
    expect(rotaExigeSessao('/v1/auth/login')).toBe(false);
    expect(rotaExigeSessao('/v1/auth/refresh')).toBe(false);
    expect(rotaExigeSessao('/verify-auth')).toBe(false);
  });
});

describe('accessVenceEmBreve', () => {
  const agora = 1_757_100_000_000;
  it('ausente, ilegível ou sem exp -> renova', () => {
    expect(accessVenceEmBreve(undefined, agora)).toBe(true);
    expect(accessVenceEmBreve('lixo', agora)).toBe(true);
    expect(accessVenceEmBreve(jwtCom('amanhã'), agora)).toBe(true);
  });
  it('vence em 10 min -> não renova; vence em 10 s -> renova; já venceu -> renova', () => {
    expect(accessVenceEmBreve(jwtCom(agora / 1000 + 600), agora)).toBe(false);
    expect(accessVenceEmBreve(jwtCom(agora / 1000 + 10), agora)).toBe(true);
    expect(accessVenceEmBreve(jwtCom(agora / 1000 - 1), agora)).toBe(true);
  });
});

describe('mesclarCookies', () => {
  it('troca só os cookies emitidos e preserva os demais', () => {
    const r = mesclarCookies('accessToken=legado; hub_accessToken=velho; hub_refreshToken=r1', [
      'hub_accessToken=novo; Max-Age=900; Path=/; HttpOnly',
      'hub_refreshToken=r2; Path=/; HttpOnly; Secure',
    ]);
    expect(r).toBe('accessToken=legado; hub_accessToken=novo; hub_refreshToken=r2');
  });
});

describe('renovarSessao — uma chamada em voo por token', () => {
  beforeEach(() => {
    _limparRenovacoes();
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => vi.unstubAllGlobals());

  const resposta = (status: number, cookies: string[]) => {
    const h = new Headers();
    for (const c of cookies) h.append('set-cookie', c);
    return new Response(null, { status, headers: h });
  };

  it('duas requisições concorrentes com o MESMO refresh token fazem UM refresh e recebem os mesmos cookies', async () => {
    vi.mocked(fetch).mockResolvedValue(resposta(200, ['hub_accessToken=a2; Path=/', 'hub_refreshToken=r2; Path=/']));
    const [x, y] = await Promise.all([
      renovarSessao('r1', { cookie: 'hub_refreshToken=r1' }, 'http://b/v1/auth/refresh'),
      renovarSessao('r1', { cookie: 'hub_refreshToken=r1' }, 'http://b/v1/auth/refresh'),
    ]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(x).toEqual({ ok: true, setCookies: ['hub_accessToken=a2; Path=/', 'hub_refreshToken=r2; Path=/'] });
    expect(y).toBe(x);
  });

  it('requisição atrasada (dentro de 60 s) com o token antigo reaproveita o resultado', async () => {
    vi.mocked(fetch).mockResolvedValue(resposta(200, ['hub_refreshToken=r2; Path=/']));
    await renovarSessao('r1', {}, 'http://b/v1/auth/refresh');
    await renovarSessao('r1', {}, 'http://b/v1/auth/refresh');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('tokens diferentes renovam separadamente; falha de rede vira ok=false sem lançar', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(resposta(200, [])).mockRejectedValueOnce(new Error('ECONNREFUSED'));
    expect((await renovarSessao('r1', {}, 'u')).ok).toBe(true);
    expect(await renovarSessao('r9', {}, 'u')).toEqual({ ok: false, setCookies: [] });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

// hub-sessao-inatividade (2026-09-06) — renovação silenciosa da sessão do hub,
// executada pelo proxy `app/api/[...path]/route.ts`: o ÚNICO ponto por onde
// passam todas as chamadas do hub (hubFetch do contexto, lib/hub/api.ts,
// downloads CSV e o upload multipart). Sem timer, de propósito: só uma
// requisição REAL do usuário dispara a renovação — um timer no cliente faria
// uma aba esquecida contar como atividade e derrotaria a inatividade de 6 h
// que o backend impõe (routes/hub-auth.js).
//
// Módulo puro (sem Next): testável em vitest com `fetch` mockado.

export const COOKIE_ACCESS = 'hub_accessToken';
export const COOKIE_REFRESH = 'hub_refreshToken';

/** Renova quando faltam menos de 30 s para o access vencer — cobre o intervalo entre esta leitura e o `jwt.verify` do backend. */
const MARGEM_EXP_MS = 30_000;
/** Por quanto tempo o resultado de uma renovação fica disponível a requisições atrasadas que ainda trazem o refresh token anterior. */
const CACHE_RENOVACAO_MS = 60_000;

/** Rota do hub que exige sessão. As de `/v1/auth/*` respondem 401 por motivo de negócio (senha errada, token inválido), nunca por sessão vencida. */
export function rotaExigeSessao(path: string): boolean {
  return path.startsWith('/v1/') && !path.startsWith('/v1/auth/');
}

/** Lê o `exp` do JWT SEM verificar assinatura: é só uma dica para renovar antes de encaminhar. Quem decide é o backend (HS256 pinado). */
export function accessVenceEmBreve(accessToken: string | undefined, agora: number = Date.now()): boolean {
  if (!accessToken) return true;
  try {
    const payload: { exp?: unknown } = JSON.parse(Buffer.from(accessToken.split('.')[1], 'base64url').toString('utf8'));
    return typeof payload.exp !== 'number' || payload.exp * 1000 - agora < MARGEM_EXP_MS;
  } catch {
    return true;
  }
}

function lerPar(par: string, jar: Map<string, string>) {
  const i = par.indexOf('=');
  if (i > 0) jar.set(par.slice(0, i).trim(), par.slice(i + 1).trim());
}

/** Substitui, no header `Cookie` recebido do browser, os cookies que o backend acabou de emitir via `Set-Cookie`. */
export function mesclarCookies(cookieHeader: string, setCookies: string[]): string {
  const jar = new Map<string, string>();
  for (const par of cookieHeader.split(';')) lerPar(par, jar);
  for (const sc of setCookies) lerPar(sc.split(';')[0], jar);
  return [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
}

export interface Renovacao {
  ok: boolean;
  /** Linhas `Set-Cookie` do backend — novos tokens se ok, limpeza dos cookies se não. Sempre repassar ao browser. */
  setCookies: string[];
}

// ponytail: cache em memória do processo — frontend_v2 roda 1 réplica (stop-first).
// Com N réplicas, mover a tolerância à reapresentação para o backend.
const renovacoes = new Map<string, { promessa: Promise<Renovacao>; ate: number }>();

/**
 * Uma única chamada a `POST /v1/auth/refresh` em voo por refresh token.
 * Requisições concorrentes — ou atrasadas em até 60 s — que ainda trazem o
 * MESMO token recebem o mesmo resultado. Sem isso, a segunda apresentação do
 * token já rotacionado dispararia a detecção de reuso do backend (Decision 9)
 * e derrubaria todos os devices do usuário.
 */
export function renovarSessao(refreshToken: string, cabecalhos: Record<string, string>, urlRefresh: string): Promise<Renovacao> {
  const agora = Date.now();
  for (const [k, v] of renovacoes) if (v.ate <= agora) renovacoes.delete(k);
  const emVoo = renovacoes.get(refreshToken);
  if (emVoo) return emVoo.promessa;
  const promessa: Promise<Renovacao> = fetch(urlRefresh, { method: 'POST', headers: cabecalhos, cache: 'no-store' })
    .then((r) => ({ ok: r.ok, setCookies: r.headers.getSetCookie() }))
    .catch(() => ({ ok: false, setCookies: [] }));
  renovacoes.set(refreshToken, { promessa, ate: agora + CACHE_RENOVACAO_MS });
  return promessa;
}

/** Só para testes: esvazia o cache de renovações. */
export function _limparRenovacoes() {
  renovacoes.clear();
}

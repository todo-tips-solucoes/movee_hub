// Base compartilhada das chamadas HTTP do hub (`/api/v1`).
//
// Cada `lib/hub/*-api.ts` mantinha sua própria cópia de `HUB_API_BASE`,
// `request<T>()`, `query()`, `mensagemAmigavel()` e de uma classe de erro que
// só diferia no `name` — 7 cópias, das quais 5 byte a byte iguais e 2 já
// divergidas (importações tratava `FormData`, motoristas tratava `204`; cada
// uma corrigida só no seu arquivo). É exatamente o drift que a duplicação
// produz, então o molde vive aqui.
//
// O que NÃO é compartilhado, de propósito: o mapa `MENSAGENS_CODIGO` e a
// construção do erro. Cada domínio tem seus códigos e alguns carregam campos
// extras (`motivo`, `importacaoOriginalId`, `vinculadaA`), então quem chama
// `criarRequest` decide qual erro lançar.

/** Prefixo de todas as rotas do hub. Exportado porque os downloads de blob
 * (CSV/arquivo original) montam a URL na mão — precisam de `res.blob()`, não
 * do `request<T>()` que desserializa JSON. */
export const HUB_API_BASE = '/api/v1';

/**
 * Base de todos os erros de API do hub. As subclasses por domínio existem
 * porque as páginas discriminam com `instanceof` (ex.: `e instanceof
 * UsuariosApiError ? e.message : 'fallback'`) — o `name` é fixado como string
 * literal em cada uma para sobreviver à minificação do build de produção.
 */
export class HubApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly codigo?: string
  ) {
    super(message);
    this.name = 'HubApiError';
  }
}

/**
 * Querystring a partir de um objeto, omitindo `undefined`/`null`/`''`.
 * Devolve `''` (não `'?'`) quando não sobra nada.
 */
export function query<T extends object>(params: T): string {
  const qs = Object.entries(params as Record<string, unknown>)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
  return qs ? `?${qs}` : '';
}

/** Código de erro do contrato do hub — sempre a chave `erro`, nunca `error`. */
export function codigoDoErro(body: Record<string, unknown>): string | undefined {
  return typeof body.erro === 'string' ? body.erro : undefined;
}

/** Mensagem amigável pelo código do contrato, com fallback pelo status. */
export function mensagemPorCodigo(
  mensagens: Record<string, string>,
  body: Record<string, unknown>,
  status: number
): string {
  const codigo = codigoDoErro(body);
  if (codigo && mensagens[codigo]) return mensagens[codigo];
  return `Erro ${status}. Tente novamente.`;
}

/** Constrói o erro a lançar quando a resposta não é `ok`. */
export type ConstrutorDeFalha = (status: number, body: Record<string, unknown>) => Error;

/**
 * Monta o `request<T>()` do módulo: `fetch` com os cookies httpOnly da sessão,
 * `Content-Type: application/json` só quando há body que não seja `FormData`
 * (senão o boundary do multipart é destruído), `204` → `undefined`, corpo
 * inválido → `{}`, e `falha()` para qualquer status fora de 2xx.
 */
export function criarRequest(falha: ConstrutorDeFalha) {
  return async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${HUB_API_BASE}${path}`, {
      credentials: 'include',
      ...init,
      headers: {
        ...(init?.body && !(init.body instanceof FormData)
          ? { 'Content-Type': 'application/json' }
          : {}),
        ...(init?.headers as Record<string, string> | undefined),
      },
    });
    if (res.status === 204) {
      return undefined as T;
    }
    const body: unknown = await res.json().catch(() => ({}));
    const bodyObj = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    if (!res.ok) {
      throw falha(res.status, bodyObj);
    }
    return body as T;
  };
}

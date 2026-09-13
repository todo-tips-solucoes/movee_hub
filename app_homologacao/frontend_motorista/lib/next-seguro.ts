/**
 * push-motorista (tasks.md 3.3, achado owasp-security S3) — resolução segura
 * do parâmetro `next` usado em `/login?next=<caminho>` (link de um aviso,
 * `contracts/motorista-push.md`).
 *
 * `next` só é aceito quando resolve para a MESMA origem do app. Nenhuma lista
 * de prefixos proibidos é necessária: o próprio parser WHATWG URL normaliza
 * `//evil.example` e `/\evil.example` para um host diferente (origin
 * diverge), remove caracteres de controle (TAB/LF) ANTES de montar a
 * authority — então `"/\t/evil.example"`/`"/\n/evil.example"` também viram
 * origin divergente — e um esquema como `javascript:...` produz
 * `origin === "null"`, que nunca bate com o origin do app. A checagem de
 * origin cobre os 4 casos com uma única regra, sem enumerar variações.
 *
 * @param nextRaw - valor cru do query param `next`
 * @param fallback - destino default (produção: sempre `/movimento`)
 * @param origin - origin do app; default `window.location.origin` (browser).
 *   Parametrizado para o teste unitário rodar sem DOM (tasks.md 3.3.2).
 */
export function resolveNextSeguro(
  nextRaw: string | null | undefined,
  fallback = '/movimento',
  origin: string = typeof window !== 'undefined' ? window.location.origin : ''
): string {
  if (!nextRaw || !origin) return fallback;
  let url: URL;
  try {
    url = new URL(nextRaw, origin);
  } catch {
    return fallback;
  }
  if (url.origin !== origin) return fallback;
  const destino = `${url.pathname}${url.search}${url.hash}`;
  return destino || fallback;
}

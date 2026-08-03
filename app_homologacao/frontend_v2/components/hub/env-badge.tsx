'use client';

// hub-shell (S3) task 2.1 — banner de identificação de ambiente + favicon
// alternativo. Presente em toda tela do shell via layout raiz (FR-008/SC-004).
//
// Fail-safe (CHK029 / checklists/requirements.md): só o valor EXATO
// `"production"` esconde o aviso. Qualquer outra coisa — valor reconhecido
// (`"homologacao"`, `"staging"`, ...), valor não reconhecido, ou a env var
// nem existir — é tratada como NÃO-produção e MOSTRA o aviso. Isso evita que
// uma env mal configurada (esquecida, digitada errado, ausente no deploy)
// esconda silenciosamente o alerta "HOMOLOGAÇÃO — dados fictícios" — o
// padrão seguro aqui é "avisar demais", nunca "esconder por engano".
//
// Ref: docs/specs/hub-shell/plan.md §3.2, research.md D6,
// checklists/requirements.md CHK029.

import { useEffect } from 'react';

const PRODUCTION_VALUE = 'production';

/** Único valor que esconde o banner — qualquer outra coisa é fail-safe. */
export function isProductionEnv(value: string | undefined | null): boolean {
  return value === PRODUCTION_VALUE;
}

// Favicon alternativo como SVG inline (data URI) — evita introduzir um novo
// asset binário só para o sinal visual de ambiente; um selo amarelo com "H"
// sobreposto ao ícone padrão sinaliza "não é produção" na aba do browser.
const NON_PROD_FAVICON =
  'data:image/svg+xml,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">' +
      '<rect width="32" height="32" rx="7" fill="#ffb72a"/>' +
      '<text x="16" y="22" font-family="system-ui,sans-serif" font-size="17" ' +
      'font-weight="700" text-anchor="middle" fill="#0f1849">H</text>' +
      '</svg>'
  );

const FAVICON_MARKER_ATTR = 'data-hub-env-favicon';

function aplicarFaviconAlternativo(ativar: boolean) {
  if (typeof document === 'undefined') return;
  const existente = document.querySelector<HTMLLinkElement>(`link[${FAVICON_MARKER_ATTR}]`);
  if (!ativar) {
    existente?.remove();
    return;
  }
  const link = existente ?? document.createElement('link');
  link.rel = 'icon';
  link.href = NON_PROD_FAVICON;
  link.setAttribute(FAVICON_MARKER_ATTR, 'true');
  if (!existente) document.head.appendChild(link);
}

/**
 * Banner fixo "HOMOLOGAÇÃO — dados fictícios" + favicon alternativo,
 * montado no layout raiz do shell (100% das telas). `null` quando
 * `NEXT_PUBLIC_APP_ENV === "production"` — em qualquer outro caso, exibe.
 */
export function EnvBadge() {
  // Lido a cada render (não memoizado no módulo) para o componente ser
  // testável com `NEXT_PUBLIC_APP_ENV` mutado entre casos de teste.
  const appEnv = process.env.NEXT_PUBLIC_APP_ENV;
  const isProd = isProductionEnv(appEnv);

  useEffect(() => {
    aplicarFaviconAlternativo(!isProd);
    return () => aplicarFaviconAlternativo(false);
  }, [isProd]);

  if (isProd) return null;

  // O badge é `sticky top-0` e global; qualquer chrome que gruda logo abaixo
  // (header e sidebar do hub) precisa saber a altura dele, senão empilha em
  // top-0 também e fica escondido atrás. A var só existe quando o badge existe
  // — em produção ele não renderiza e o fallback `0px` de quem a consome vale.
  return (
    <>
      <style>{':root{--env-badge-h:1.75rem}'}</style>
      <div
        role="status"
        aria-live="polite"
        className="sticky top-0 z-[60] flex h-[var(--env-badge-h)] w-full items-center justify-center bg-warning px-3 text-center text-xs font-semibold text-warning-foreground"
      >
        HOMOLOGAÇÃO — dados fictícios
      </div>
    </>
  );
}

'use client';

// hub-shell (S3) task 4.5.2/4.5.3 — guard de rota do shell autenticado.
//
// Monta dentro de `app/hub/layout.tsx`, ACIMA de toda a subárvore `/hub/*`.
//
// FR-015/spec Q3-dec-009: cada navegação ENTRE rotas do shell dispara
// `refetchMe()` — SEM polling temporizado. Perda de vínculo
// (`entidade_ativa` vira null) ou expiração de sessão (401) é refletida no
// próximo refetch, nunca por um timer. A primeira busca de `/me` já é feita
// pelo próprio `HubAuthProvider` ao montar (contexts/hub-auth-context.tsx)
// — este guard só refaz a busca a cada TROCA de pathname subsequente.
//
// Rotas PÚBLICAS do fluxo de auth (login/recuperar-senha/redefinir-senha)
// não exigem sessão; as demais (`/hub/dashboard`, `/hub/dashboard/perfil`,
// módulos futuros) exigem `usuario` não-nulo — senão redireciona a
// `/hub/login`. A limpeza de sessão em si (401 in-flight de uma ação em
// andamento, edge case CHK017) é feita por `authenticatedFetch` dentro de
// `contexts/hub-auth-context.tsx` — este guard só REAGE ao estado já
// limpo (`usuario === null`), não decide quando limpar.
//
// Ref: docs/specs/hub-shell/plan.md §3.4, spec.md FR-013/FR-015/Q3-dec-009,
// checklists/requirements.md CHK017.

import { useEffect, useRef, type ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useHubAuth } from '@/contexts/hub-auth-context';

export const HUB_LOGIN_ROUTE = '/hub/login';

const ROTAS_PUBLICAS = ['/hub/login', '/hub/recuperar-senha', '/hub/redefinir-senha'];

/** Pura — testável sem depender de mocks de roteamento. */
export function rotaEhPublica(pathname: string): boolean {
  return ROTAS_PUBLICAS.some((rota) => pathname === rota || pathname.startsWith(`${rota}/`));
}

export function HubSessionGuard({ children }: { children: ReactNode }) {
  const { usuario, carregando, refetchMe } = useHubAuth();
  const pathname = usePathname();
  const jaMontou = useRef(false);

  // Guard de rota (FR-015): refetch a cada navegação SUBSEQUENTE (o
  // HubAuthProvider já fez a primeira busca ao montar — não duplicar).
  useEffect(() => {
    if (!jaMontou.current) {
      jaMontou.current = true;
      return;
    }
    void refetchMe();
  }, [pathname, refetchMe]);

  const publica = rotaEhPublica(pathname ?? '');
  const semSessao = !carregando && !usuario && !publica;

  const router = useRouter();
  useEffect(() => {
    if (semSessao) {
      router.replace(HUB_LOGIN_ROUTE);
    }
  }, [semSessao, router]);

  // Evita "flash" de conteúdo protegido enquanto o replace acima resolve.
  if (semSessao) return null;

  return <>{children}</>;
}

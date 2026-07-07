// hub-shell (S3) Fase 4 — layout raiz de TODA a subárvore `/hub/*` (login,
// recuperar-senha, redefinir-senha, dashboard, dashboard/perfil, e módulos
// futuros S4+ em `/hub/dashboard/<codigo>`). Monta o `HubAuthProvider` UMA
// ÚNICA VEZ para toda a árvore — diferente do layout de segmento da Fase 3
// (`app/selecionar-entidade/layout.tsx`, que serve só aquela rota isolada)
// — evita refetches de `/me` redundantes ao navegar dentro do shell
// autenticado. `/selecionar-entidade` continua com seu próprio provider:
// já shipped/testado na Fase 3 e fora do namespace `/hub/` (dec-041).
//
// dec-039/dec-041 (Fase 4): namespace `/hub/` isola as rotas do shell do
// envio-massa LEGADO (`app/login`, `app/dashboard` e subrotas
// motoristas/configuracoes/validacao-xml) sem tocar nenhum arquivo dele.
//
// Ref: docs/specs/hub-shell/plan.md §3.4-bis.
import type { ReactNode } from 'react';
import { HubAuthProvider } from '@/contexts/hub-auth-context';
import { HubSessionGuard } from '@/components/hub/session-guard';

export default function HubLayout({ children }: { children: ReactNode }) {
  return (
    <HubAuthProvider>
      <HubSessionGuard>{children}</HubSessionGuard>
    </HubAuthProvider>
  );
}

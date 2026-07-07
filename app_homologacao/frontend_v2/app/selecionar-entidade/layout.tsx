// hub-shell (S3) task 3.2 — layout de segmento que monta o HubAuthProvider
// para a rota /selecionar-entidade. O layout raiz (app/layout.tsx) só monta
// o AuthProvider legado (envio-massa) + EnvBadge — o shell do hub ainda não
// tem layout próprio (achado dec-036, Fase 2). Como esta é a primeira rota
// do shell que efetivamente CONSOME useHubAuth(), o provider precisa existir
// em algum ponto da árvore acima da página; um layout de segmento aqui é a
// forma canônica do App Router, sem alterar app/layout.tsx nem afetar
// nenhuma outra rota.
import type { ReactNode } from 'react';
import { HubAuthProvider } from '@/contexts/hub-auth-context';

export default function SelecionarEntidadeLayout({ children }: { children: ReactNode }) {
  return <HubAuthProvider>{children}</HubAuthProvider>;
}

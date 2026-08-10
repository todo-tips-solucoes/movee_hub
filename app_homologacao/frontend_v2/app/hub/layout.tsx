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
import type { Metadata } from 'next';
import { HubAuthProvider } from '@/contexts/hub-auth-context';
import { HubSessionGuard } from '@/components/hub/session-guard';

// impeccable rodada 8 (P2): as 13 rotas do hub compartilhavam UM título de aba
// — e ele nomeava o produto legado ("EntreGô — Envio em Massa") mesmo em
// Auditoria ou Faturamento. Quem trabalha com Importações, Faturamento e Envio
// em Massa abertos ao mesmo tempo lia três abas idênticas e trocava por
// tentativa e erro, várias vezes por dia; histórico e favoritos ficavam
// igualmente indistinguíveis.
//
// Aqui fica só o piso de toda a subárvore `/hub/*` (inclusive login e
// recuperação de senha, que não têm chrome). O nome do módulo é aplicado por
// `TituloDaRota` no layout do dashboard: as páginas são todas `'use client'` e
// não podem exportar `metadata` — e criar 12 layouts de servidor só para isso
// seria doze arquivos para um dado que a navegação já carrega.
export const metadata: Metadata = {
  title: { default: 'Hub de Frota', template: '%s · Hub de Frota' },
};

export default function HubLayout({ children }: { children: ReactNode }) {
  return (
    <HubAuthProvider>
      <HubSessionGuard>{children}</HubSessionGuard>
    </HubAuthProvider>
  );
}

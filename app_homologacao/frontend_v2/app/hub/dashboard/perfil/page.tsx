'use client';

// hub-shell (S3) task 4.4 — tela `/hub/dashboard/perfil`.
//
// A partir do hub-motorista-canonico (FASE 1, task 1.2, FR-005): o miolo de
// exibição (nome/e-mail + "Trocar senha") foi extraído para
// `components/hub/perfil-card.tsx`, reusado também pelo modal "Meu perfil"
// (`perfil-dialog.tsx`, task 1.3). Esta página continua respondendo
// diretamente pela URL com as MESMAS informações (D-A1) — só o "Sair"
// (infraestrutura de sessão, task 4.4.3 do hub-shell, spec Q5/dec-011, não
// conta como módulo) permanece local, pois não faz parte do escopo do card
// compartilhado (evita duplicar logout dentro do modal).
//
// Ref: docs/specs/hub-shell/plan.md §3.4, spec.md FR-011;
// docs/specs/hub-motorista-canonico/spec.md FR-003/FR-005, decisão task 1.2.3.

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, LogOut } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { LARGURA_FORM } from '@/lib/hub/larguras';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { useHubAuth } from '@/contexts/hub-auth-context';
import { PerfilCard } from '@/components/hub/perfil-card';

/** Logout local da página — isolado do `PerfilCard` compartilhado (ver nota acima). */
function useSairDaConta() {
  const { logout } = useHubAuth();
  const router = useRouter();
  const [saindo, setSaindo] = useState(false);

  async function sair() {
    setSaindo(true);
    try {
      await logout();
    } finally {
      router.replace('/hub/login');
    }
  }

  return { saindo, sair };
}

export default function PerfilPage() {
  const { usuario } = useHubAuth();
  const { saindo, sair } = useSairDaConta();

  if (!usuario) return null;

  return (
    <div className={`mx-auto flex min-h-svh ${LARGURA_FORM} flex-col justify-center gap-4 p-4`}>
      <Card>
        <CardHeader>
          <CardTitle as="h1">Meu perfil</CardTitle>
          <CardDescription>Dados da sua conta no Hub de Frota.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4 px-4">
          <PerfilCard />

          <Separator />

          <Button variant="outline" className="w-fit min-h-11" disabled={saindo} onClick={sair}>
            {saindo ? <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden="true" /> : <LogOut className="size-4" aria-hidden="true" />}
            Sair
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

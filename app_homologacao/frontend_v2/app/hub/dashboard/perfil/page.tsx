'use client';

// hub-shell (S3) task 4.4 — tela `/hub/dashboard/perfil`.
//
// Exibe `usuario.nome`/`usuario.email` (somente leitura, vêm de `/me` via
// `HubAuthProvider`). "Trocar senha" (task 4.4.2, decisão da task 1.2.3):
// reusa o MESMO fluxo de recuperação de senha das tasks 4.2/4.3 — sem
// endpoint novo de backend. Como o e-mail já é conhecido da sessão, não há
// formulário: um clique chama `recuperarSenha(usuario.email)` diretamente
// (mesmo `POST /api/v1/auth/recuperar-senha` da tela `/hub/recuperar-senha`)
// e mostra a confirmação — o usuário conclui a troca pelo link recebido,
// igual a qualquer outra recuperação (`/hub/redefinir-senha?token=...`).
//
// Botão de logout sempre visível nesta área (task 4.4.3 — infraestrutura do
// shell, spec Q5/dec-011, não conta como módulo).
//
// Ref: docs/specs/hub-shell/plan.md §3.4, spec.md FR-011, decisão da task 1.2.3.

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertCircle, KeyRound, Loader2, LogOut, MailCheck, User } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { useHubAuth, HubApiError } from '@/contexts/hub-auth-context';

/** Lógica isolada do JSX — testável sem depender do roteador. */
export function usePerfil() {
  const { usuario, logout, recuperarSenha } = useHubAuth();
  const router = useRouter();
  const [enviandoTrocaSenha, setEnviandoTrocaSenha] = useState(false);
  const [mensagemTrocaSenha, setMensagemTrocaSenha] = useState<string | null>(null);
  const [erroTrocaSenha, setErroTrocaSenha] = useState<string | null>(null);
  const [saindo, setSaindo] = useState(false);

  async function acionarTrocaSenha() {
    if (!usuario) return;
    setErroTrocaSenha(null);
    setEnviandoTrocaSenha(true);
    try {
      const resposta = await recuperarSenha(usuario.email);
      setMensagemTrocaSenha(resposta.mensagem);
    } catch (err) {
      setErroTrocaSenha(
        err instanceof HubApiError ? err.message : 'Não foi possível iniciar a troca de senha agora.'
      );
    } finally {
      setEnviandoTrocaSenha(false);
    }
  }

  async function sair() {
    setSaindo(true);
    try {
      await logout();
    } finally {
      router.replace('/hub/login');
    }
  }

  return {
    usuario,
    enviandoTrocaSenha,
    mensagemTrocaSenha,
    erroTrocaSenha,
    acionarTrocaSenha,
    saindo,
    sair,
  };
}

export default function PerfilPage() {
  const { usuario, enviandoTrocaSenha, mensagemTrocaSenha, erroTrocaSenha, acionarTrocaSenha, saindo, sair } =
    usePerfil();

  if (!usuario) return null;

  return (
    <div className="mx-auto flex min-h-svh max-w-lg flex-col justify-center gap-4 p-4">
      <Card>
        <CardHeader>
          <CardTitle as="h1">Meu perfil</CardTitle>
          <CardDescription>Dados da sua conta no Hub de Frota.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4 px-4">
          <div className="flex items-center gap-3 rounded-md border border-border p-3">
            <User className="size-8 shrink-0 text-muted-foreground" aria-hidden="true" />
            <div className="min-w-0">
              <p className="truncate font-medium">{usuario.nome}</p>
              <p className="truncate text-sm text-muted-foreground">{usuario.email}</p>
            </div>
          </div>

          <Separator />

          <div className="flex flex-col gap-2">
            <h2 className="text-sm font-semibold">Senha</h2>
            {mensagemTrocaSenha ? (
              <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
                <MailCheck className="size-4 shrink-0 text-primary" aria-hidden="true" />
                {mensagemTrocaSenha}
              </p>
            ) : (
              <>
                {erroTrocaSenha && (
                  <p
                    role="alert"
                    className="flex items-center gap-2 rounded-md bg-destructive/10 px-3 py-2 text-sm font-medium text-destructive"
                  >
                    <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
                    {erroTrocaSenha}
                  </p>
                )}
                <Button
                  variant="outline"
                  className="w-fit min-h-11"
                  disabled={enviandoTrocaSenha}
                  onClick={acionarTrocaSenha}
                >
                  {enviandoTrocaSenha ? (
                    <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                  ) : (
                    <KeyRound className="size-4" aria-hidden="true" />
                  )}
                  Trocar senha
                </Button>
              </>
            )}
          </div>

          <Separator />

          <Button variant="outline" className="w-fit min-h-11" disabled={saindo} onClick={sair}>
            {saindo ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : <LogOut className="size-4" aria-hidden="true" />}
            Sair
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

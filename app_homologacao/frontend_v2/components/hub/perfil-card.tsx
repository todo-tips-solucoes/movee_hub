'use client';

// hub-motorista-canonico (FASE 1, task 1.2, FR-003/FR-004/FR-005) — miolo de
// exibição do perfil do usuário logado, extraído de
// `app/hub/dashboard/perfil/page.tsx` (task 4.4 do hub-shell) para ser
// reusado em DOIS lugares: a página `/hub/dashboard/perfil` (que continua
// respondendo diretamente pela URL — D-A1, FR-005) e o modal "Meu perfil"
// (`perfil-dialog.tsx`, task 1.3, FR-003) aberto a partir do
// `account-menu.tsx`.
//
// Escopo desta peça: nome/e-mail (somente leitura, vêm de `/me` via
// `HubAuthProvider`) + ação "Trocar senha" (reusa o MESMO fluxo de
// recuperação de senha — sem endpoint novo de backend: `recuperarSenha(email)`
// → `POST /api/v1/auth/recuperar-senha`). O botão "Sair" NÃO faz parte deste
// componente — já existe a 1 clique no `account-menu.tsx` (uiux-hub F2) e a
// página `/hub/dashboard/perfil` mantém o seu próprio (task 4.4.3 do
// hub-shell); duplicá-lo dentro do modal seria ruído (FR-003 pede só "ver e
// editar o próprio perfil", não gerenciamento de sessão).
//
// Ref: docs/specs/hub-motorista-canonico/spec.md FR-003/FR-004/FR-005,
// research.md Decision 2, quickstart.md Scenario 2.

import { useState } from 'react';
import { AlertCircle, KeyRound, Loader2, MailCheck, User } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { useHubAuth, HubApiError } from '@/contexts/hub-auth-context';
import { MetasPadraoCard } from '@/components/hub/metas-padrao-card';

/** Lógica isolada do JSX — testável sem depender do roteador (mesmo padrão de `usePerfilDialog`/`useMotoristaDetalheDialog`). */
export function usePerfilCard() {
  const { usuario, recuperarSenha } = useHubAuth();
  const [enviandoTrocaSenha, setEnviandoTrocaSenha] = useState(false);
  const [mensagemTrocaSenha, setMensagemTrocaSenha] = useState<string | null>(null);
  const [erroTrocaSenha, setErroTrocaSenha] = useState<string | null>(null);

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

  return { usuario, enviandoTrocaSenha, mensagemTrocaSenha, erroTrocaSenha, acionarTrocaSenha };
}

export function PerfilCard() {
  const { usuario, enviandoTrocaSenha, mensagemTrocaSenha, erroTrocaSenha, acionarTrocaSenha } = usePerfilCard();

  if (!usuario) return null;

  return (
    <div className="flex flex-col gap-4">
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
                <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden="true" />
              ) : (
                <KeyRound className="size-4" aria-hidden="true" />
              )}
              Trocar senha
            </Button>
          </>
        )}
      </div>

      {/* impeccable r24: configuração de METAS da entidade, onde o operador
          pediu (2026-08-17) — dentro de "Meu perfil". O card se identifica
          como escopo de entidade e só aparece para quem tem a permissão; ver o
          cabeçalho de `metas-padrao-card.tsx`. Como o `PerfilCard` é reusado
          pela página /hub/dashboard/perfil e pelo modal, a seção aparece nos
          dois lugares de uma vez. */}
      <MetasPadraoCard />
    </div>
  );
}

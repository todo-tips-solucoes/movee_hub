'use client';

// hub-shell (S3) task 4.2 — tela `/hub/recuperar-senha`.
//
// Consome `HubAuthProvider.recuperarSenha()` -> `POST /api/v1/auth/recuperar-senha`
// (contexts/hub-auth-context.tsx). O backend (routes/hub-auth.js) responde
// SEMPRE com a MESMA mensagem de sucesso, exista ou não o e-mail (FR-012) —
// esta tela nunca discrimina o resultado por e-mail, só exibe `mensagem` tal
// como veio do backend. Único desvio tratado é o `429` do `authRateLimiter`
// (task 4.2.3).
//
// Ref: docs/specs/hub-shell/plan.md §3.4, spec.md FR-012/FR-014.

import { useState } from 'react';
import Link from 'next/link';
import { AlertCircle, Loader2, Mail, MailCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { useHubAuth, HubApiError } from '@/contexts/hub-auth-context';

type Estado = 'formulario' | 'enviado' | 'rate-limit';

/** Lógica isolada do JSX — mesmo espírito de `useSelecionarEntidade`/`useHubLogin`. */
export function useRecuperarSenha() {
  const [email, setEmail] = useState('');
  const [carregando, setCarregando] = useState(false);
  const [estado, setEstado] = useState<Estado>('formulario');
  const [mensagem, setMensagem] = useState('');
  const { recuperarSenha } = useHubAuth();

  async function submeter(e: React.FormEvent) {
    e.preventDefault();
    setCarregando(true);
    try {
      // FR-012/SC-005: `mensagem` é IDÊNTICA para e-mail existente ou não —
      // nunca ramificamos por esse resultado aqui.
      const resposta = await recuperarSenha(email);
      setMensagem(resposta.mensagem);
      setEstado('enviado');
    } catch (err) {
      if (err instanceof HubApiError && err.status === 429) {
        setMensagem(err.message);
      } else {
        setMensagem('Não foi possível enviar agora. Tente novamente mais tarde.');
      }
      setEstado('rate-limit');
    } finally {
      setCarregando(false);
    }
  }

  return { email, setEmail, carregando, estado, mensagem, submeter };
}

export default function RecuperarSenhaPage() {
  const { email, setEmail, carregando, estado, mensagem, submeter } = useRecuperarSenha();

  return (
    <div className="flex min-h-svh items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="items-center text-center">
          {estado === 'enviado' ? (
            <MailCheck className="mb-2 size-10 text-primary" aria-hidden="true" />
          ) : (
            <Mail className="mb-2 size-10 text-muted-foreground" aria-hidden="true" />
          )}
          <CardTitle as="h1">Recuperar senha</CardTitle>
          <CardDescription>
            Informe o e-mail da sua conta. Se existir, enviaremos um link de redefinição.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4 px-4">
          {estado === 'enviado' ? (
            <p role="status" className="text-center text-sm text-muted-foreground">
              {mensagem}
            </p>
          ) : (
            <form onSubmit={submeter} className="grid gap-4">
              {estado === 'rate-limit' && (
                <p
                  role="alert"
                  className="flex items-center gap-2 rounded-md bg-destructive/10 px-3 py-2 text-sm font-medium text-destructive"
                >
                  <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
                  {mensagem}
                </p>
              )}
              <div className="grid gap-1.5">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="email"
                  placeholder="seu@email.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoComplete="email"
                  aria-required="true"
                  className="h-11 sm:h-10"
                />
              </div>
              <Button type="submit" className="h-11 w-full sm:h-10" disabled={carregando}>
                {carregando && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Enviar link de redefinição
              </Button>
            </form>
          )}
          <Link href="/hub/login" className="text-center text-sm text-primary hover:underline">
            Voltar ao login
          </Link>
        </CardContent>
      </Card>
    </div>
  );
}

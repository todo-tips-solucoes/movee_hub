'use client';

// hub-shell (S3) task 4.3 — tela `/hub/redefinir-senha?token=...`.
//
// Consome o token bruto vindo por query string (link recebido por e-mail,
// mock via `MAIL_MOCK_URL` — routes/hub-auth.js) + formulário de nova senha.
// Chama `HubAuthProvider.redefinirSenha()` -> `POST /api/v1/auth/redefinir-senha`.
//
// Erros reais (hub-auth.js `/redefinir-senha`): `400` token/senha ausentes ou
// senha curta, `400` token inválido (mesmo status, mensagem distinta —
// discriminado só pelo texto porque o backend não separa por status aqui),
// `410` token expirado. Validação client-side (>=8 chars) é só UX — o
// servidor é sempre a autoridade final (task 4.3.2).
//
// Ref: docs/specs/hub-shell/plan.md §3.4.

import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { AlertCircle, CheckCircle2, Eye, EyeOff, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { AuthShell } from '@/components/hub/auth-shell';
import { Wordmark } from '@/components/brand/wordmark';
import { useHubAuth, HubApiError } from '@/contexts/hub-auth-context';

const SENHA_MIN_LENGTH = 8;

type Estado = 'formulario' | 'sucesso';

/** Lógica isolada do JSX — testável sem depender de `useSearchParams`. */
export function useRedefinirSenha(token: string | null) {
  const [novaSenha, setNovaSenha] = useState('');
  const [carregando, setCarregando] = useState(false);
  const [estado, setEstado] = useState<Estado>('formulario');
  const [erro, setErro] = useState<string | null>(null);
  const { redefinirSenha } = useHubAuth();

  const erroValidacaoLocal =
    novaSenha.length > 0 && novaSenha.length < SENHA_MIN_LENGTH
      ? `A senha precisa ter pelo menos ${SENHA_MIN_LENGTH} caracteres.`
      : null;

  async function submeter(e: React.FormEvent) {
    e.preventDefault();
    setErro(null);

    if (!token) {
      setErro('Link inválido: token ausente. Solicite uma nova recuperação de senha.');
      return;
    }
    if (novaSenha.length < SENHA_MIN_LENGTH) {
      setErro(`A senha precisa ter pelo menos ${SENHA_MIN_LENGTH} caracteres.`);
      return;
    }

    setCarregando(true);
    try {
      await redefinirSenha(token, novaSenha);
      setEstado('sucesso');
    } catch (err) {
      if (err instanceof HubApiError) {
        // task 4.3.3: 400 (token/senha ausentes ou curtos / token inválido)
        // e 410 (token expirado) já vêm com mensagem humana distinta do
        // backend — exibida tal como está (hub-auth.js `/redefinir-senha`).
        setErro(err.message);
      } else {
        setErro('Não foi possível redefinir a senha agora. Tente novamente mais tarde.');
      }
    } finally {
      setCarregando(false);
    }
  }

  return { novaSenha, setNovaSenha, erroValidacaoLocal, carregando, estado, erro, submeter };
}

function RedefinirSenhaConteudo() {
  const searchParams = useSearchParams();
  const token = searchParams.get('token');
  const { novaSenha, setNovaSenha, erroValidacaoLocal, carregando, estado, erro, submeter } =
    useRedefinirSenha(token);
  const [mostrarSenha, setMostrarSenha] = useState(false);

  return (
    // Moldura compartilhada das telas de auth (uiux-hub F3 — orbs + glass +
    // Wordmark, paridade com o login).
    <AuthShell>
      <Card className="glass w-full border-0 shadow-none">
        <CardHeader className="items-center text-center">
          <div className="mb-3 flex justify-center">
            <Wordmark className="h-10" />
          </div>
          {estado === 'sucesso' ? (
            <CheckCircle2 className="mb-2 size-10 text-primary" aria-hidden="true" />
          ) : null}
          <CardTitle as="h1">Redefinir senha</CardTitle>
          {estado === 'formulario' && <CardDescription>Escolha uma nova senha para sua conta.</CardDescription>}
        </CardHeader>
        <CardContent className="flex flex-col gap-4 px-4">
          {estado === 'sucesso' ? (
            <>
              <p role="status" className="text-center text-sm text-muted-foreground">
                Senha redefinida com sucesso. Todas as sessões ativas foram encerradas — faça
                login novamente com a nova senha.
              </p>
              <Link href="/hub/login" className="text-center text-sm text-primary hover:underline">
                Ir para o login
              </Link>
            </>
          ) : (
            <form onSubmit={submeter} className="grid gap-4">
              {!token && (
                <p
                  role="alert"
                  className="flex items-center gap-2 rounded-md bg-destructive/10 px-3 py-2 text-sm font-medium text-destructive"
                >
                  <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
                  Link inválido: token ausente na URL.
                </p>
              )}
              {erro && (
                <p
                  role="alert"
                  className="flex items-center gap-2 rounded-md bg-destructive/10 px-3 py-2 text-sm font-medium text-destructive"
                >
                  <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
                  {erro}
                </p>
              )}
              <div className="grid gap-1.5">
                <Label htmlFor="nova-senha">Nova senha</Label>
                {/* uiux-hub F3: toggle mostrar/ocultar — paridade com o login,
                    especialmente útil ao digitar uma senha NOVA. */}
                <div className="relative">
                  <Input
                    id="nova-senha"
                    type={mostrarSenha ? 'text' : 'password'}
                    placeholder="********"
                    value={novaSenha}
                    onChange={(e) => setNovaSenha(e.target.value)}
                    autoComplete="new-password"
                    aria-required="true"
                    aria-invalid={!!erroValidacaoLocal}
                    className="h-11 pr-10 sm:h-10"
                  />
                  <button
                    type="button"
                    onClick={() => setMostrarSenha((v) => !v)}
                    // impeccable polish 2026-08-06: sem tabIndex={-1} — o
                    // toggle faz parte do fluxo de teclado (WCAG 2.1.1).
                    className="absolute right-3 top-1/2 -translate-y-1/2 rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    aria-label={mostrarSenha ? 'Ocultar senha' : 'Mostrar senha'}
                  >
                    {mostrarSenha ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
                {erroValidacaoLocal && (
                  <p className="text-xs font-medium text-muted-foreground">{erroValidacaoLocal}</p>
                )}
              </div>
              <Button type="submit" className="h-11 w-full sm:h-10" disabled={carregando}>
                {carregando && <Loader2 className="mr-2 h-4 w-4 motion-safe:animate-spin" />}
                Redefinir senha
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </AuthShell>
  );
}

// `useSearchParams` exige Suspense no App Router (mesmo padrão já usado no
// /dashboard legado, app/dashboard/page.tsx `DashboardClient`).
export default function RedefinirSenhaPage() {
  return (
    <Suspense fallback={null}>
      <RedefinirSenhaConteudo />
    </Suspense>
  );
}

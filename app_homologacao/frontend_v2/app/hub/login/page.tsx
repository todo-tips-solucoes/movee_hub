'use client';

// hub-shell (S3) task 4.1 — tela de login do hub.
//
// Distinta do `/login` legado (envio-massa, `contexts/auth-context.tsx`,
// intocado): fala com `HubAuthProvider.login()` -> `POST /api/v1/auth/login`
// (contexts/hub-auth-context.tsx). Vive em `/hub/login` — dec-039/dec-041,
// namespace que evita colidir com a página legada `app/login/page.tsx`.
//
// Pós-login (task 4.1.3): sempre encaminha a `/selecionar-entidade` — essa
// rota (Fase 3, app/selecionar-entidade/page.tsx) já decide o ramo por
// `entidades.length` (>1 → escolha manual; ===1 → auto-seleção e segue a
// `/hub/dashboard`; ===0 → tela "sem acesso"), evitando duplicar a lógica de
// branching aqui.
//
// dec-033 (contexts/hub-auth-context.tsx): o backend NUNCA envia um
// código-enum no corpo — discriminar por HTTP status (401/423/429) é o
// único contrato confiável; `HubApiError.message` já traz o texto humano em
// PT-BR pronto para exibição (task 4.1.2 — só os 3 erros reais nunca uma
// mensagem inventada de "sem vínculo": o login nunca recusa por isso).
//
// Ref: docs/specs/hub-shell/plan.md §3.4/§3.4-bis, spec.md US2/Q2-dec-008.

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Loader2, Eye, EyeOff, AlertCircle, Lock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { useHubAuth, HubApiError } from '@/contexts/hub-auth-context';
import { ThemeToggle } from '@/components/theme-toggle';
import { Wordmark } from '@/components/brand/wordmark';

export const SELECIONAR_ENTIDADE_ROUTE = '/selecionar-entidade';

/** Os 3 erros reais do `/auth/login` (task 4.1.2) — discriminados por status. */
export type ErroLogin = 'credenciais' | 'bloqueada' | 'rate-limit' | 'desconhecido';

/** Pura — testável sem montar o componente. */
export function classificarErroLogin(status: number): ErroLogin {
  if (status === 401) return 'credenciais';
  if (status === 423) return 'bloqueada';
  if (status === 429) return 'rate-limit';
  return 'desconhecido';
}

/** Lógica de submissão isolada do JSX (mesmo espírito de `useSelecionarEntidade`). */
export function useHubLogin() {
  const [email, setEmail] = useState('');
  const [senha, setSenha] = useState('');
  const [carregandoSubmit, setCarregandoSubmit] = useState(false);
  const [erro, setErro] = useState<{ tipo: ErroLogin; mensagem: string } | null>(null);
  const { usuario, carregando, login } = useHubAuth();
  const router = useRouter();

  // Já autenticado (ex.: refresh da página com cookie válido) → não fica
  // preso na tela de login, segue o fluxo pós-login normal.
  useEffect(() => {
    if (!carregando && usuario) {
      router.replace(SELECIONAR_ENTIDADE_ROUTE);
    }
  }, [usuario, carregando, router]);

  async function submeter(e: React.FormEvent) {
    e.preventDefault();
    setErro(null);
    setCarregandoSubmit(true);
    try {
      await login(email, senha);
      router.push(SELECIONAR_ENTIDADE_ROUTE);
    } catch (e) {
      if (e instanceof HubApiError) {
        setErro({ tipo: classificarErroLogin(e.status), mensagem: e.message });
      } else {
        setErro({ tipo: 'desconhecido', mensagem: 'Não foi possível entrar. Tente novamente.' });
      }
    } finally {
      setCarregandoSubmit(false);
    }
  }

  return {
    email,
    setEmail,
    senha,
    setSenha,
    carregandoSubmit,
    erro,
    submeter,
    telaCarregando: carregando || Boolean(usuario),
  };
}

export default function HubLoginPage() {
  const { email, setEmail, senha, setSenha, carregandoSubmit, erro, submeter, telaCarregando } = useHubLogin();
  const [mostrarSenha, setMostrarSenha] = useState(false);
  const emailRef = useRef<HTMLInputElement>(null);

  if (telaCarregando) return null;

  return (
    <div className="relative flex min-h-dvh items-center justify-center overflow-hidden px-4 py-10 sm:px-6">
      <div className="pointer-events-none absolute inset-0 -z-10 bg-background" />
      <div className="aurora-orb bg-gradient-warm -left-24 -top-24 h-72 w-72 animate-float" aria-hidden />
      <div
        className="aurora-orb bg-gradient-blue -bottom-32 -right-24 h-80 w-80 animate-float-soft"
        aria-hidden
      />
      <div className="absolute top-4 right-4 z-10">
        <ThemeToggle />
      </div>
      <div className="w-full max-w-[95vw] sm:max-w-sm">
        <Card className="glass w-full border-0 shadow-none">
          <CardHeader className="text-center">
            <div className="mb-3 flex justify-center">
              <Wordmark className="h-12" />
            </div>
            <CardTitle className="font-display text-2xl">Hub de Frota</CardTitle>
            <CardDescription>Entre com suas credenciais</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={submeter} className="grid gap-4">
              {erro && (
                <p
                  role="alert"
                  className="flex items-center gap-2 rounded-md bg-destructive/10 px-3 py-2 text-sm font-medium text-destructive"
                >
                  {erro.tipo === 'bloqueada' ? (
                    <Lock className="h-4 w-4 shrink-0" aria-hidden="true" />
                  ) : (
                    <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
                  )}
                  {erro.mensagem}
                </p>
              )}
              <div className="grid gap-1.5">
                <Label htmlFor="email">Email</Label>
                <Input
                  ref={emailRef}
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
              <div className="grid gap-1.5">
                <div className="flex items-center justify-between">
                  <Label htmlFor="senha">Senha</Label>
                  <Link href="/hub/recuperar-senha" className="text-xs text-primary hover:underline">
                    Esqueci minha senha
                  </Link>
                </div>
                <div className="relative">
                  <Input
                    id="senha"
                    type={mostrarSenha ? 'text' : 'password'}
                    placeholder="********"
                    value={senha}
                    onChange={(e) => setSenha(e.target.value)}
                    autoComplete="current-password"
                    aria-required="true"
                    className="h-11 pr-10 sm:h-10"
                  />
                  <button
                    type="button"
                    onClick={() => setMostrarSenha((v) => !v)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                    tabIndex={-1}
                    aria-label={mostrarSenha ? 'Ocultar senha' : 'Mostrar senha'}
                  >
                    {mostrarSenha ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>
              <Button type="submit" className="h-11 w-full sm:h-10" disabled={carregandoSubmit}>
                {carregandoSubmit && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Entrar
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

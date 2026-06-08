'use client';

/**
 * Tela de Login do Motorista.
 * Ref: tarefa 5.1.1 / spec US1 / contracts §login / quickstart 1, 2
 */

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useAuth } from '@/contexts/auth-context';
import { formatCNPJ, unformatCNPJ } from '@/lib/utils';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Wordmark } from '@/components/brand/wordmark';
import { LogoMark } from '@/components/brand/logo-mark';
import { ThemeToggle } from '@/components/theme-toggle';

export default function LoginPage() {
  const { login, user } = useAuth();
  const router = useRouter();

  const [cnpj, setCnpj] = useState('');
  const [senha, setSenha] = useState('');
  const [loading, setLoading] = useState(false);
  const [errors, setErrors] = useState<{ cnpj?: string; senha?: string; geral?: string }>({});

  // Redirect de usuário já autenticado em efeito (não durante o render) —
  // evita "update durante render". O return null abaixo só impede o flash.
  useEffect(() => {
    if (user) router.replace('/movimento');
  }, [user, router]);

  if (user) return null;

  function validate() {
    const errs: typeof errors = {};
    const cnpjDigits = unformatCNPJ(cnpj);
    if (!cnpjDigits || cnpjDigits.length !== 14) errs.cnpj = 'CNPJ inválido. Informe os 14 dígitos.';
    if (!senha) errs.senha = 'Informe a senha.';
    return errs;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const errs = validate();
    if (Object.keys(errs).length > 0) {
      setErrors(errs);
      return;
    }
    setErrors({});
    setLoading(true);
    try {
      await login(unformatCNPJ(cnpj), senha);
      router.replace('/movimento');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Erro ao fazer login.';
      let geral = 'Erro ao conectar. Tente novamente.';
      if (msg.includes('Não autorizado') || msg.includes('Credenciais')) {
        geral = 'CNPJ ou senha incorretos.';
      } else if (msg.includes('inativa') || msg.includes('403')) {
        geral = 'Conta inativa. Entre em contato com o suporte.';
      }
      setErrors({ geral });
      toast.error(geral);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="relative flex min-h-dvh flex-col overflow-hidden bg-muted/30">
      {/* brilho de marca sutil ao fundo (decorativo) */}
      <div
        aria-hidden
        className="bg-gradient-blue pointer-events-none absolute inset-x-0 top-0 h-64 opacity-[0.13] blur-2xl"
      />

      <div className="relative z-10 flex justify-end px-4 pt-[max(0.75rem,env(safe-area-inset-top))]">
        <ThemeToggle className="text-muted-foreground hover:bg-muted" />
      </div>

      <div className="relative z-10 flex flex-1 items-center justify-center px-6 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
        <div className="animate-fade-up w-full max-w-sm">
          {/* Marca */}
          <div className="mb-8 flex flex-col items-center text-center">
            <LogoMark className="h-14 w-14 text-[1.6rem]" />
            <Wordmark className="mt-4 text-3xl" />
            <p className="mt-1.5 text-xs font-medium uppercase tracking-[0.22em] text-muted-foreground">
              Soluções logísticas
            </p>
          </div>

          {/* Card */}
          <div className="rounded-2xl border border-border bg-card p-6 shadow-[0_20px_50px_-24px_rgba(14,26,43,0.45)]">
            <h1 className="font-display text-xl font-bold tracking-tight">Entrar</h1>
            <p className="mt-1 text-sm text-muted-foreground">Acesse com seu CNPJ de prestador</p>

            <form onSubmit={handleSubmit} noValidate className="mt-6 space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="cnpj">CNPJ do Prestador</Label>
                <Input
                  id="cnpj"
                  type="tel"
                  inputMode="numeric"
                  autoComplete="username"
                  value={cnpj}
                  onChange={(e) => setCnpj(formatCNPJ(e.target.value))}
                  placeholder="00.000.000/0000-00"
                  aria-invalid={!!errors.cnpj}
                  disabled={loading}
                  className="tabular"
                />
                {errors.cnpj && <p className="text-sm text-destructive">{errors.cnpj}</p>}
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="senha">Senha</Label>
                <Input
                  id="senha"
                  type="password"
                  autoComplete="current-password"
                  value={senha}
                  onChange={(e) => setSenha(e.target.value)}
                  placeholder="Sua senha"
                  aria-invalid={!!errors.senha}
                  disabled={loading}
                />
                {errors.senha && <p className="text-sm text-destructive">{errors.senha}</p>}
              </div>

              {errors.geral && (
                <p className="animate-shake rounded-lg bg-destructive/10 px-3 py-2 text-sm font-medium text-destructive">
                  {errors.geral}
                </p>
              )}

              <Button type="submit" disabled={loading} className="mt-1 w-full">
                {loading ? (
                  <>
                    <span className="spinner h-4 w-4 rounded-full border-2 border-white/40 border-t-white" />
                    Entrando…
                  </>
                ) : (
                  'Entrar'
                )}
              </Button>
            </form>
          </div>

          <p className="mt-6 text-center text-sm text-muted-foreground">
            Primeira vez?{' '}
            <Link href="/cadastro" className="font-semibold text-primary underline-offset-4 hover:underline">
              Criar conta
            </Link>
          </p>
        </div>
      </div>
    </main>
  );
}

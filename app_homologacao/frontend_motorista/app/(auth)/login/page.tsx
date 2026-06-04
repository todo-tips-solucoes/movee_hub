'use client';

/**
 * Tela de Login do Motorista.
 * Ref: tarefa 5.1.1 / spec US1 / contracts §login / quickstart 1, 2
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useAuth } from '@/contexts/auth-context';
import { formatCNPJ, unformatCNPJ } from '@/lib/utils';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Wordmark } from '@/components/brand/wordmark';
import { ThemeToggle } from '@/components/theme-toggle';

export default function LoginPage() {
  const { login, user } = useAuth();
  const router = useRouter();

  const [cnpj, setCnpj] = useState('');
  const [senha, setSenha] = useState('');
  const [loading, setLoading] = useState(false);
  const [errors, setErrors] = useState<{ cnpj?: string; senha?: string; geral?: string }>({});

  if (user) {
    router.replace('/movimento');
    return null;
  }

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
    <main className="bg-gradient-blue flex min-h-dvh flex-col text-white">
      <div className="flex justify-end px-4 pt-[max(1rem,env(safe-area-inset-top))]">
        <ThemeToggle />
      </div>

      {/* Hero */}
      <div className="flex flex-col items-center px-6 pb-8 pt-6 text-center">
        <Wordmark className="text-5xl" />
        <p className="mt-1 text-xs font-medium uppercase tracking-[0.2em] text-white/80">
          Soluções Logísticas
        </p>
      </div>

      {/* Card */}
      <div className="flex-1 rounded-t-[28px] bg-background px-6 pb-[max(2rem,env(safe-area-inset-bottom))] pt-8 text-foreground shadow-[0_-10px_30px_-12px_rgba(14,26,43,0.25)]">
        <div className="mx-auto w-full max-w-sm">
          <h1 className="font-display text-xl font-bold">Bem-vindo, motorista</h1>
          <p className="mt-1 text-sm text-muted-foreground">Entre com seu CNPJ de prestador</p>

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
              <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm font-medium text-destructive">
                {errors.geral}
              </p>
            )}

            <Button type="submit" size="lg" disabled={loading} className="w-full">
              {loading ? 'Entrando...' : 'Entrar'}
            </Button>
          </form>

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

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

export default function LoginPage() {
  const { login, user } = useAuth();
  const router = useRouter();

  const [cnpj, setCnpj] = useState('');
  const [senha, setSenha] = useState('');
  const [loading, setLoading] = useState(false);
  const [errors, setErrors] = useState<{ cnpj?: string; senha?: string; geral?: string }>({});

  // Se já autenticado, redirecionar
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
      // Mapear mensagens do backend para pt-BR amigável
      if (msg.includes('Não autorizado') || msg.includes('Credenciais')) {
        setErrors({ geral: 'CNPJ ou senha incorretos.' });
      } else if (msg.includes('inativa') || msg.includes('403')) {
        setErrors({ geral: 'Conta inativa. Entre em contato com o suporte.' });
      } else {
        setErrors({ geral: 'Erro ao conectar. Tente novamente.' });
      }
      toast.error(errors.geral ?? 'Erro ao fazer login.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center px-4 py-8">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <h1 className="text-2xl font-bold tracking-tight">App Motorista</h1>
          <p className="mt-1 text-sm text-muted-foreground">Entre com seu CNPJ de prestador</p>
        </div>

        <form onSubmit={handleSubmit} noValidate className="space-y-4">
          {/* CNPJ */}
          <div className="space-y-1">
            <label htmlFor="cnpj" className="text-sm font-medium">
              CNPJ do Prestador
            </label>
            <input
              id="cnpj"
              type="tel"
              inputMode="numeric"
              autoComplete="username"
              value={cnpj}
              onChange={(e) => setCnpj(formatCNPJ(e.target.value))}
              placeholder="00.000.000/0000-00"
              className="w-full rounded-md border border-input bg-background px-3 py-2.5 text-base outline-none ring-offset-background focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
              disabled={loading}
            />
            {errors.cnpj && <p className="text-sm text-destructive">{errors.cnpj}</p>}
          </div>

          {/* Senha */}
          <div className="space-y-1">
            <label htmlFor="senha" className="text-sm font-medium">
              Senha
            </label>
            <input
              id="senha"
              type="password"
              autoComplete="current-password"
              value={senha}
              onChange={(e) => setSenha(e.target.value)}
              placeholder="Sua senha"
              className="w-full rounded-md border border-input bg-background px-3 py-2.5 text-base outline-none ring-offset-background focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
              disabled={loading}
            />
            {errors.senha && <p className="text-sm text-destructive">{errors.senha}</p>}
          </div>

          {/* Erro geral */}
          {errors.geral && (
            <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {errors.geral}
            </p>
          )}

          {/* Botão */}
          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-md bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading ? 'Entrando...' : 'Entrar'}
          </button>
        </form>

        {/* Link para cadastro (FR-017) */}
        <p className="mt-6 text-center text-sm text-muted-foreground">
          Primeira vez?{' '}
          <Link href="/cadastro" className="font-medium text-primary underline-offset-4 hover:underline">
            Criar conta
          </Link>
        </p>
      </div>
    </main>
  );
}

'use client';

/**
 * Tela de Auto-Cadastro do Motorista.
 * Ref: tarefa 5.1.4 / spec FR-017 / contracts §register / quickstart 3
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { api } from '@/lib/api-client';
import { formatCNPJ, unformatCNPJ } from '@/lib/utils';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Wordmark } from '@/components/brand/wordmark';
import { ThemeToggle } from '@/components/theme-toggle';

export default function CadastroPage() {
  const router = useRouter();

  const [cnpj, setCnpj] = useState('');
  const [nome, setNome] = useState('');
  const [senha, setSenha] = useState('');
  const [loading, setLoading] = useState(false);
  const [errors, setErrors] = useState<{ cnpj?: string; nome?: string; senha?: string; geral?: string }>({});

  function validate() {
    const errs: typeof errors = {};
    const cnpjDigits = unformatCNPJ(cnpj);
    if (!cnpjDigits || cnpjDigits.length !== 14) errs.cnpj = 'CNPJ inválido. Informe os 14 dígitos.';
    if (!nome.trim()) errs.nome = 'Informe seu nome.';
    if (!senha || senha.length < 8) errs.senha = 'A senha deve ter pelo menos 8 caracteres.';
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
      await api.post('/motorista/register', {
        cnpjPrestador: unformatCNPJ(cnpj),
        nome: nome.trim(),
        senha,
      });
      toast.success('Conta criada! Faça login para continuar.');
      router.replace('/login');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '';
      if (msg.includes('409') || msg.includes('elegível') || msg.includes('já possui')) {
        setErrors({ geral: 'CNPJ não elegível para cadastro ou já possui conta.' });
      } else if (msg.includes('400') || msg.includes('8 caracteres')) {
        setErrors({ senha: 'A senha deve ter pelo menos 8 caracteres.' });
      } else {
        setErrors({ geral: 'Erro ao criar conta. Tente novamente.' });
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="bg-gradient-blue flex min-h-dvh flex-col text-white">
      <div className="flex items-center justify-between px-4 pt-[max(1rem,env(safe-area-inset-top))]">
        <Link href="/login" aria-label="Voltar" className="inline-flex h-9 w-9 items-center justify-center rounded-full hover:bg-white/15">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-5 w-5">
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
          </svg>
        </Link>
        <ThemeToggle />
      </div>

      <div className="flex flex-col items-center px-6 pb-6 pt-2 text-center">
        <Wordmark className="text-4xl" />
      </div>

      <div className="flex-1 rounded-t-[28px] bg-background px-6 pb-[max(2rem,env(safe-area-inset-bottom))] pt-8 text-foreground shadow-[0_-10px_30px_-12px_rgba(14,26,43,0.25)]">
        <div className="mx-auto w-full max-w-sm">
          <h1 className="font-display text-xl font-bold">Criar conta</h1>
          <p className="mt-1 text-sm text-muted-foreground">Informe o CNPJ do seu cadastro como prestador</p>

          <form onSubmit={handleSubmit} noValidate className="mt-6 space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="cnpj">CNPJ do Prestador</Label>
              <Input
                id="cnpj"
                type="tel"
                inputMode="numeric"
                value={cnpj}
                onChange={(e) => setCnpj(formatCNPJ(e.target.value))}
                placeholder="00.000.000/0000-00"
                aria-invalid={!!errors.cnpj}
                disabled={loading}
              />
              {errors.cnpj && <p className="text-sm text-destructive">{errors.cnpj}</p>}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="nome">Seu nome</Label>
              <Input
                id="nome"
                type="text"
                autoComplete="name"
                value={nome}
                onChange={(e) => setNome(e.target.value)}
                placeholder="Nome completo"
                aria-invalid={!!errors.nome}
                disabled={loading}
              />
              {errors.nome && <p className="text-sm text-destructive">{errors.nome}</p>}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="senha">Criar senha</Label>
              <Input
                id="senha"
                type="password"
                autoComplete="new-password"
                value={senha}
                onChange={(e) => setSenha(e.target.value)}
                placeholder="Mínimo 8 caracteres"
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
              {loading ? 'Criando conta...' : 'Criar conta'}
            </Button>
          </form>

          <p className="mt-6 text-center text-sm text-muted-foreground">
            Já tem conta?{' '}
            <Link href="/login" className="font-semibold text-primary underline-offset-4 hover:underline">
              Entrar
            </Link>
          </p>
        </div>
      </div>
    </main>
  );
}

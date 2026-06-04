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

export default function CadastroPage() {
  const router = useRouter();

  const [cnpj, setCnpj] = useState('');
  const [nome, setNome] = useState('');
  const [senha, setSenha] = useState('');
  const [loading, setLoading] = useState(false);
  const [errors, setErrors] = useState<{
    cnpj?: string;
    nome?: string;
    senha?: string;
    geral?: string;
  }>({});

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
      // 409: CNPJ não elegível ou já cadastrado (mensagem anti-enumeração)
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
    <main className="flex min-h-dvh flex-col items-center justify-center px-4 py-8">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <h1 className="text-2xl font-bold tracking-tight">Criar conta</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Informe o CNPJ do seu cadastro como prestador
          </p>
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
              value={cnpj}
              onChange={(e) => setCnpj(formatCNPJ(e.target.value))}
              placeholder="00.000.000/0000-00"
              className="w-full rounded-md border border-input bg-background px-3 py-2.5 text-base outline-none ring-offset-background focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
              disabled={loading}
            />
            {errors.cnpj && <p className="text-sm text-destructive">{errors.cnpj}</p>}
          </div>

          {/* Nome */}
          <div className="space-y-1">
            <label htmlFor="nome" className="text-sm font-medium">
              Seu nome
            </label>
            <input
              id="nome"
              type="text"
              autoComplete="name"
              value={nome}
              onChange={(e) => setNome(e.target.value)}
              placeholder="Nome completo"
              className="w-full rounded-md border border-input bg-background px-3 py-2.5 text-base outline-none ring-offset-background focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
              disabled={loading}
            />
            {errors.nome && <p className="text-sm text-destructive">{errors.nome}</p>}
          </div>

          {/* Senha */}
          <div className="space-y-1">
            <label htmlFor="senha" className="text-sm font-medium">
              Criar senha
            </label>
            <input
              id="senha"
              type="password"
              autoComplete="new-password"
              value={senha}
              onChange={(e) => setSenha(e.target.value)}
              placeholder="Mínimo 8 caracteres"
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

          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-md bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading ? 'Criando conta...' : 'Criar conta'}
          </button>
        </form>

        <p className="mt-6 text-center text-sm text-muted-foreground">
          Já tem conta?{' '}
          <Link href="/login" className="font-medium text-primary underline-offset-4 hover:underline">
            Entrar
          </Link>
        </p>
      </div>
    </main>
  );
}

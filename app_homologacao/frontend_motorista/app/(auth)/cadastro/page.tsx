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
import { LogoMark } from '@/components/brand/logo-mark';
import { ThemeToggle } from '@/components/theme-toggle';
import { ArrowLeft, Check, AlertCircle } from '@/components/ui/icons';

export default function CadastroPage() {
  const router = useRouter();

  const [cnpj, setCnpj] = useState('');
  const [nome, setNome] = useState('');
  const [senha, setSenha] = useState('');
  const [confirmaSenha, setConfirmaSenha] = useState('');
  const [loading, setLoading] = useState(false);
  const [errors, setErrors] = useState<{ cnpj?: string; nome?: string; senha?: string; confirmaSenha?: string; geral?: string }>({});

  // Comparação visual ao vivo das senhas (só após o usuário começar a confirmar)
  const senhasCoincidem = confirmaSenha.length > 0 && senha === confirmaSenha;
  const senhasDivergem = confirmaSenha.length > 0 && senha !== confirmaSenha;

  function validate() {
    const errs: typeof errors = {};
    const cnpjDigits = unformatCNPJ(cnpj);
    if (!cnpjDigits || cnpjDigits.length !== 14) errs.cnpj = 'CNPJ inválido. Informe os 14 dígitos.';
    if (!nome.trim()) errs.nome = 'Informe seu nome.';
    if (!senha || senha.length < 8) errs.senha = 'A senha deve ter pelo menos 8 caracteres.';
    if (!confirmaSenha) errs.confirmaSenha = 'Confirme a senha.';
    else if (senha !== confirmaSenha) errs.confirmaSenha = 'As senhas não coincidem.';
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
    <main className="relative flex min-h-dvh flex-col overflow-hidden bg-muted/30">
      <div
        aria-hidden
        className="bg-gradient-blue pointer-events-none absolute inset-x-0 top-0 h-64 opacity-[0.13] blur-2xl"
      />

      <div className="relative z-10 flex items-center justify-between px-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
        <Link
          href="/login"
          aria-label="Voltar"
          className="inline-flex h-10 w-10 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted active:scale-90"
        >
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <ThemeToggle className="text-muted-foreground hover:bg-muted" />
      </div>

      <div className="relative z-10 flex flex-1 items-center justify-center px-6 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
        <div className="animate-fade-up w-full max-w-sm">
          {/* Marca */}
          <div className="mb-7 flex flex-col items-center text-center">
            <LogoMark className="h-14 w-14 text-[1.6rem]" />
            <Wordmark className="mt-4 text-3xl" />
          </div>

          {/* Card */}
          <div className="rounded-2xl border border-border bg-card p-6 shadow-[0_20px_50px_-24px_rgba(14,26,43,0.45)]">
            <h1 className="font-display text-xl font-bold tracking-tight">Criar conta</h1>
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
                  className="tabular"
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

              <div className="space-y-1.5">
                <Label htmlFor="confirmaSenha">Confirmar senha</Label>
                <Input
                  id="confirmaSenha"
                  type="password"
                  autoComplete="new-password"
                  value={confirmaSenha}
                  onChange={(e) => setConfirmaSenha(e.target.value)}
                  placeholder="Repita a senha"
                  aria-invalid={!!errors.confirmaSenha || senhasDivergem}
                  disabled={loading}
                />
                {/* Feedback visual ao vivo da comparação */}
                {senhasCoincidem && (
                  <p className="animate-fade-up flex items-center gap-1.5 text-sm font-medium text-success">
                    <Check className="h-4 w-4" />
                    As senhas coincidem
                  </p>
                )}
                {senhasDivergem && (
                  <p className="flex items-center gap-1.5 text-sm font-medium text-destructive">
                    <AlertCircle className="h-4 w-4" />
                    As senhas não coincidem
                  </p>
                )}
                {!confirmaSenha && errors.confirmaSenha && (
                  <p className="text-sm text-destructive">{errors.confirmaSenha}</p>
                )}
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
                    Criando conta…
                  </>
                ) : (
                  'Criar conta'
                )}
              </Button>
            </form>
          </div>

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

'use client';

// Destino do link enviado por e-mail (2026-09-25). O token vem na query, vale
// 60 minutos e só pode ser usado uma vez.

import { Suspense, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Wordmark } from '@/components/brand/wordmark';
import { ThemeToggle } from '@/components/theme-toggle';
import { definirSenhaComToken } from '@/lib/recuperacao-api';

const MINIMO = 8;

function DefinirSenhaConteudo() {
  const router = useRouter();
  const token = useSearchParams().get('token') ?? '';
  const [senha, setSenha] = useState('');
  const [confirmacao, setConfirmacao] = useState('');
  const [loading, setLoading] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (senha.length < MINIMO) {
      setErro(`A senha precisa ter pelo menos ${MINIMO} caracteres.`);
      return;
    }
    // Confirmação no cliente: errar a senha nova e só descobrir no próximo
    // login gastaria o token, que é de uso único.
    if (senha !== confirmacao) {
      setErro('As senhas não conferem.');
      return;
    }
    setLoading(true);
    setErro(null);
    try {
      await definirSenhaComToken(token, senha);
      toast.success('Senha definida. Faça login com ela.');
      router.replace('/login');
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      setErro(
        msg.includes('inválido') || msg.includes('expirado')
          ? 'Este link não vale mais. Peça um novo em "Esqueci minha senha".'
          : 'Não foi possível salvar a senha. Tente novamente.'
      );
    } finally {
      setLoading(false);
    }
  }

  if (!token) {
    return (
      <>
        <h1 className="font-display text-xl font-bold tracking-tight">Link inválido</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Abra o link exatamente como veio no e-mail. Se ele já passou de 60 minutos, peça um novo.
        </p>
        <Link href="/recuperar-senha" className="mt-6 block text-center text-sm font-semibold text-primary underline-offset-4 hover:underline">
          Pedir novo link
        </Link>
      </>
    );
  }

  return (
    <>
      <h1 className="font-display text-xl font-bold tracking-tight">Criar nova senha</h1>
      <p className="mt-1 text-sm text-muted-foreground">Ela passa a valer imediatamente no app.</p>

      <form onSubmit={handleSubmit} noValidate className="mt-6 space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="nova-senha">Nova senha</Label>
          <Input
            id="nova-senha"
            type="password"
            autoComplete="new-password"
            placeholder={`mínimo ${MINIMO} caracteres`}
            value={senha}
            onChange={(e) => setSenha(e.target.value)}
            disabled={loading}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="confirmar-senha">Repita a senha</Label>
          <Input
            id="confirmar-senha"
            type="password"
            autoComplete="new-password"
            value={confirmacao}
            onChange={(e) => setConfirmacao(e.target.value)}
            disabled={loading}
          />
        </div>
        {erro && <p className="text-sm text-destructive">{erro}</p>}
        <Button type="submit" disabled={loading} className="mt-1 w-full">
          {loading ? 'Salvando…' : 'Salvar senha'}
        </Button>
      </form>
    </>
  );
}

export default function DefinirSenhaPage() {
  return (
    <main className="relative flex min-h-dvh flex-col overflow-hidden bg-background">
      <div aria-hidden className="bg-gradient-blue pointer-events-none absolute inset-x-0 top-0 h-64 opacity-[0.13] blur-2xl" />
      <div className="relative z-10 flex justify-end px-4 pt-[max(0.75rem,env(safe-area-inset-top))]">
        <ThemeToggle className="text-muted-foreground hover:bg-muted" />
      </div>
      <div className="relative z-10 flex flex-1 items-center justify-center px-6 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
        <div className="animate-fade-up w-full max-w-sm">
          <div className="mb-8 flex flex-col items-center text-center">
            <Wordmark className="h-12" />
          </div>
          <div className="rounded-2xl border border-border bg-card p-6 shadow-[0_20px_50px_-24px_rgba(14,26,43,0.45)]">
            {/* `useSearchParams` exige Suspense no App Router. */}
            <Suspense fallback={<p className="text-sm text-muted-foreground">Carregando…</p>}>
              <DefinirSenhaConteudo />
            </Suspense>
          </div>
        </div>
      </div>
    </main>
  );
}

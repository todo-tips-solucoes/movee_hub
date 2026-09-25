'use client';

// "Esqueci minha senha" (2026-09-25). Até aqui o motorista que esquecia a senha
// não tinha saída nenhuma: dependia de alguém do hub acionar o reset e informar
// a nova por fora.
//
// A resposta mostra o e-mail MASCARADO para onde o link foi (decisão do
// operador): quem tem mais de uma caixa precisa saber qual checar.

import { useState } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Wordmark } from '@/components/brand/wordmark';
import { ThemeToggle } from '@/components/theme-toggle';
import { formatCNPJ, unformatCNPJ } from '@/lib/utils';
import { pedirRecuperacaoSenha } from '@/lib/recuperacao-api';

export default function RecuperarSenhaPage() {
  const [cnpj, setCnpj] = useState('');
  const [loading, setLoading] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [enviado, setEnviado] = useState<{ emailMascarado: string | null } | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const digitos = unformatCNPJ(cnpj);
    if (digitos.length !== 14) {
      setErro('Informe os 14 dígitos do CNPJ.');
      return;
    }
    setLoading(true);
    setErro(null);
    try {
      const r = await pedirRecuperacaoSenha(digitos);
      setEnviado({ emailMascarado: r.emailMascarado });
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      setErro(
        msg.includes('Muitas tentativas')
          ? 'Muitas tentativas. Aguarde alguns minutos e tente novamente.'
          : 'Não foi possível enviar agora. Tente novamente em instantes.'
      );
      toast.error('Falha ao pedir a recuperação.');
    } finally {
      setLoading(false);
    }
  }

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
            {enviado ? (
              <>
                <h1 className="font-display text-xl font-bold tracking-tight">Verifique seu e-mail</h1>
                {enviado.emailMascarado ? (
                  <p className="mt-2 text-sm text-muted-foreground">
                    Enviamos um link para{' '}
                    <span className="font-semibold text-foreground">{enviado.emailMascarado}</span>. Ele vale por 60
                    minutos e só pode ser usado uma vez.
                  </p>
                ) : (
                  // Mesma resposta de quando o cadastro não existe: a tela não
                  // revela se aquele CNPJ está cadastrado.
                  <p className="mt-2 text-sm text-muted-foreground">
                    Se houver um e-mail cadastrado para este CNPJ, o link de recuperação foi enviado. Não achou?
                    Procure a Movee para cadastrar seu e-mail.
                  </p>
                )}
                <Link href="/login" className="mt-6 block text-center text-sm font-semibold text-primary underline-offset-4 hover:underline">
                  Voltar para o login
                </Link>
              </>
            ) : (
              <>
                <h1 className="font-display text-xl font-bold tracking-tight">Esqueci minha senha</h1>
                <p className="mt-1 text-sm text-muted-foreground">
                  Informe seu CNPJ e enviaremos um link para o e-mail cadastrado.
                </p>

                <form onSubmit={handleSubmit} noValidate className="mt-6 space-y-4">
                  <div className="space-y-1.5">
                    <Label htmlFor="cnpj-recuperacao">CNPJ do Prestador</Label>
                    <Input
                      id="cnpj-recuperacao"
                      inputMode="numeric"
                      autoComplete="username"
                      placeholder="00.000.000/0000-00"
                      value={cnpj}
                      onChange={(e) => setCnpj(formatCNPJ(e.target.value))}
                      disabled={loading}
                    />
                  </div>
                  {erro && <p className="text-sm text-destructive">{erro}</p>}
                  <Button type="submit" disabled={loading} className="mt-1 w-full">
                    {loading ? 'Enviando…' : 'Enviar link de recuperação'}
                  </Button>
                </form>
              </>
            )}
          </div>

          {!enviado && (
            <p className="mt-6 text-center text-sm text-muted-foreground">
              Lembrou a senha?{' '}
              <Link href="/login" className="font-semibold text-primary underline-offset-4 hover:underline">
                Entrar
              </Link>
            </p>
          )}
        </div>
      </div>
    </main>
  );
}

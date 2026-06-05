'use client';

import { useState, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Send, Loader2, Eye, EyeOff, Check, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { useAuth } from '@/contexts/auth-context';
import { ThemeToggle } from '@/components/theme-toggle';
import { toast } from 'sonner';
import { motion } from 'framer-motion';

function PasswordStrength({ password }: { password: string }) {
  const rules = useMemo(() => [
    { label: 'Minimo 6 caracteres', ok: password.length >= 6 },
    { label: 'Uma letra maiuscula', ok: /[A-Z]/.test(password) },
    { label: 'Um numero', ok: /\d/.test(password) },
  ], [password]);

  if (!password) return null;

  return (
    <motion.div
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: 'auto' }}
      className="space-y-1 pt-1"
    >
      {rules.map((r) => (
        <div key={r.label} className="flex items-center gap-1.5 text-xs">
          {r.ok ? (
            <Check className="h-3 w-3 text-success" />
          ) : (
            <X className="h-3 w-3 text-muted-foreground" />
          )}
          <span className={r.ok ? 'text-success' : 'text-muted-foreground'}>{r.label}</span>
        </div>
      ))}
    </motion.div>
  );
}

export default function RegisterPage() {
  const [nomeEmpresa, setNomeEmpresa] = useState('');
  const [email, setEmail] = useState('');
  const [senha, setSenha] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const { register } = useAuth();
  const router = useRouter();

  const isPasswordValid = senha.length >= 6 && /[A-Z]/.test(senha) && /\d/.test(senha);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!nomeEmpresa || !email || !senha) {
      toast.error('Preencha todos os campos');
      return;
    }
    if (!isPasswordValid) {
      toast.error('A senha nao atende aos requisitos minimos');
      return;
    }
    try {
      setLoading(true);
      await register(nomeEmpresa, email, senha);
      toast.success('Conta criada com sucesso! Faca login.');
      router.push('/login');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro ao criar conta');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="relative flex min-h-dvh items-center justify-center overflow-hidden px-4 py-10">
      {/* Hero Movee — superfície base + aurora quente assinatura */}
      <div className="pointer-events-none absolute inset-0 -z-10 bg-background" />
      <div className="aurora-orb bg-gradient-warm -right-24 -top-24 h-72 w-72 animate-float" aria-hidden />
      <div
        className="aurora-orb bg-gradient-blue -bottom-32 -left-24 h-80 w-80 animate-float-soft"
        aria-hidden
      />
      <div className="absolute top-4 right-4 z-10">
        <ThemeToggle />
      </div>
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
        className="w-full max-w-sm"
      >
        <Card className="glass w-full border-0 shadow-none">
          <CardHeader className="text-center">
            <motion.div
              className="shine shine-once mx-auto mb-3 flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-warm-rich text-white shadow-lg"
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              transition={{ delay: 0.2, type: 'spring', stiffness: 200 }}
            >
              <Send className="h-7 w-7" />
            </motion.div>
            <CardTitle className="font-display text-2xl">Criar Conta</CardTitle>
            <CardDescription>Preencha os dados para se registrar</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="grid gap-4">
              <div className="grid gap-1.5">
                <Label htmlFor="nomeEmpresa">Nome da Empresa</Label>
                <Input
                  id="nomeEmpresa"
                  placeholder="Minha Empresa LTDA"
                  value={nomeEmpresa}
                  onChange={(e) => setNomeEmpresa(e.target.value)}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="email"
                  placeholder="seu@email.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoComplete="email"
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="senha">Senha</Label>
                <div className="relative">
                  <Input
                    id="senha"
                    type={showPassword ? 'text' : 'password'}
                    placeholder="********"
                    value={senha}
                    onChange={(e) => setSenha(e.target.value)}
                    autoComplete="new-password"
                    className="pr-10"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                    tabIndex={-1}
                  >
                    {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
                <PasswordStrength password={senha} />
              </div>
              <Button type="submit" className="w-full" disabled={loading || (!isPasswordValid && senha.length > 0)}>
                {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Criar Conta
              </Button>
            </form>
            <p className="mt-4 text-center text-sm text-muted-foreground">
              Ja tem conta?{' '}
              <Link href="/login" className="text-primary hover:underline">
                Fazer login
              </Link>
            </p>
          </CardContent>
        </Card>
      </motion.div>
    </div>
  );
}

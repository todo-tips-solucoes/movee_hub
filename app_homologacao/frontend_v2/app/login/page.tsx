'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Loader2, Eye, EyeOff, AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { useAuth } from '@/contexts/auth-context';
import { ThemeToggle } from '@/components/theme-toggle';
import { Wordmark } from '@/components/brand/wordmark';
import { toast } from 'sonner';
import { motion } from 'framer-motion';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [errors, setErrors] = useState<{ email?: string; password?: string }>({});
  const [touched, setTouched] = useState<{ email?: boolean; password?: boolean }>({});
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const { user, loading: authLoading, login } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!authLoading && user) {
      router.replace('/dashboard');
    }
  }, [user, authLoading, router]);

  // Validação de apresentação (não altera a lógica de auth)
  const validate = (field: 'email' | 'password', value: string): string => {
    if (field === 'email') {
      if (!value.trim()) return 'Informe seu e-mail.';
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return 'E-mail em formato inválido.';
    }
    if (field === 'password' && !value) return 'Informe sua senha.';
    return '';
  };

  const handleBlur = (field: 'email' | 'password', value: string) => {
    setTouched((prev) => ({ ...prev, [field]: true }));
    setErrors((prev) => ({ ...prev, [field]: validate(field, value) || undefined }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const nextErrors = {
      email: validate('email', email) || undefined,
      password: validate('password', password) || undefined,
    };
    setErrors(nextErrors);
    setTouched({ email: true, password: true });
    if (nextErrors.email || nextErrors.password) {
      (nextErrors.email ? emailRef : passwordRef).current?.focus();
      return;
    }
    try {
      setLoading(true);
      await login(email, password);
      toast.success('Bem-vindo de volta!');
      router.push('/dashboard');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro ao fazer login');
    } finally {
      setLoading(false);
    }
  };

  if (authLoading) return null;

  return (
    <div className="relative flex min-h-dvh items-center justify-center overflow-hidden px-4 py-10 sm:px-6">
      {/* Hero EntreGô — superfície base + aurora assinatura (azul→menta) */}
      <div className="pointer-events-none absolute inset-0 -z-10 bg-background" />
      <div className="aurora-orb bg-gradient-warm -left-24 -top-24 h-72 w-72 animate-float" aria-hidden />
      <div
        className="aurora-orb bg-gradient-blue -bottom-32 -right-24 h-80 w-80 animate-float-soft"
        aria-hidden
      />
      <div className="absolute top-4 right-4 z-10">
        <ThemeToggle />
      </div>
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
        className="w-full max-w-[95vw] sm:max-w-sm"
      >
        <Card className="glass w-full border-0 shadow-none">
          <CardHeader className="text-center">
            <motion.div
              className="mb-3 flex justify-center"
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ delay: 0.2, type: 'spring', stiffness: 200 }}
            >
              <Wordmark className="h-12" />
            </motion.div>
            <CardTitle className="font-display text-2xl">Envio em Massa</CardTitle>
            <CardDescription>Entre com suas credenciais</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="grid gap-4">
              <div className="grid gap-1.5">
                <Label htmlFor="email">
                  Email <span className="text-destructive" aria-hidden="true">*</span>
                </Label>
                <Input
                  ref={emailRef}
                  id="email"
                  type="email"
                  placeholder="seu@email.com"
                  value={email}
                  onChange={(e) => {
                    setEmail(e.target.value);
                    if (touched.email) setErrors((p) => ({ ...p, email: validate('email', e.target.value) || undefined }));
                  }}
                  onBlur={(e) => handleBlur('email', e.target.value)}
                  autoComplete="email"
                  aria-required="true"
                  aria-invalid={!!errors.email}
                  aria-describedby={errors.email ? 'email-error' : undefined}
                  className="h-11 sm:h-10"
                />
                {errors.email && (
                  <p id="email-error" role="alert" className="flex items-center gap-1 text-xs font-medium text-destructive">
                    <AlertCircle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" /> {errors.email}
                  </p>
                )}
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="password">
                  Senha <span className="text-destructive" aria-hidden="true">*</span>
                </Label>
                <div className="relative">
                  <Input
                    ref={passwordRef}
                    id="password"
                    type={showPassword ? 'text' : 'password'}
                    placeholder="********"
                    value={password}
                    onChange={(e) => {
                      setPassword(e.target.value);
                      if (touched.password) setErrors((p) => ({ ...p, password: validate('password', e.target.value) || undefined }));
                    }}
                    onBlur={(e) => handleBlur('password', e.target.value)}
                    autoComplete="current-password"
                    aria-required="true"
                    aria-invalid={!!errors.password}
                    aria-describedby={errors.password ? 'password-error' : undefined}
                    className="h-11 pr-10 sm:h-10"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                    tabIndex={-1}
                    aria-label={showPassword ? 'Ocultar senha' : 'Mostrar senha'}
                  >
                    {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
                {errors.password && (
                  <p id="password-error" role="alert" className="flex items-center gap-1 text-xs font-medium text-destructive">
                    <AlertCircle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" /> {errors.password}
                  </p>
                )}
              </div>
              <Button type="submit" className="h-11 w-full sm:h-10" disabled={loading}>
                {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Entrar
              </Button>
            </form>
            <p className="mt-4 text-center text-sm text-muted-foreground">
              Nao tem conta?{' '}
              <Link href="/register" className="text-primary hover:underline">
                Criar conta
              </Link>
            </p>
          </CardContent>
        </Card>
      </motion.div>
    </div>
  );
}

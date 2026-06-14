'use client';

import { useState, useMemo, useRef } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Send, Loader2, Eye, EyeOff, Check, X, AlertCircle } from 'lucide-react';
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
  const [errors, setErrors] = useState<{ nomeEmpresa?: string; email?: string; senha?: string }>({});
  const [touched, setTouched] = useState<{ nomeEmpresa?: boolean; email?: boolean; senha?: boolean }>({});
  const nomeRef = useRef<HTMLInputElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const senhaRef = useRef<HTMLInputElement>(null);
  const { register } = useAuth();
  const router = useRouter();

  const isPasswordValid = senha.length >= 6 && /[A-Z]/.test(senha) && /\d/.test(senha);

  // Validação de apresentação (não altera a lógica de registro)
  const validate = (field: 'nomeEmpresa' | 'email' | 'senha', value: string): string => {
    if (field === 'nomeEmpresa' && !value.trim()) return 'Informe o nome da empresa.';
    if (field === 'email') {
      if (!value.trim()) return 'Informe seu e-mail.';
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return 'E-mail em formato inválido.';
    }
    if (field === 'senha') {
      if (!value) return 'Crie uma senha.';
      if (!(value.length >= 6 && /[A-Z]/.test(value) && /\d/.test(value)))
        return 'A senha não atende aos requisitos abaixo.';
    }
    return '';
  };

  const handleBlur = (field: 'nomeEmpresa' | 'email' | 'senha', value: string) => {
    setTouched((prev) => ({ ...prev, [field]: true }));
    setErrors((prev) => ({ ...prev, [field]: validate(field, value) || undefined }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const nextErrors = {
      nomeEmpresa: validate('nomeEmpresa', nomeEmpresa) || undefined,
      email: validate('email', email) || undefined,
      senha: validate('senha', senha) || undefined,
    };
    setErrors(nextErrors);
    setTouched({ nomeEmpresa: true, email: true, senha: true });
    if (nextErrors.nomeEmpresa || nextErrors.email || nextErrors.senha) {
      (nextErrors.nomeEmpresa ? nomeRef : nextErrors.email ? emailRef : senhaRef).current?.focus();
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
    <div className="relative flex min-h-dvh items-center justify-center overflow-hidden px-4 py-10 sm:px-6">
      {/* Hero EntreGô — superfície base + aurora assinatura (azul→menta) */}
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
        className="w-full max-w-[95vw] sm:max-w-sm"
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
                <Label htmlFor="nomeEmpresa">
                  Nome da Empresa <span className="text-destructive" aria-hidden="true">*</span>
                </Label>
                <Input
                  ref={nomeRef}
                  id="nomeEmpresa"
                  placeholder="Minha Empresa LTDA"
                  value={nomeEmpresa}
                  onChange={(e) => {
                    setNomeEmpresa(e.target.value);
                    if (touched.nomeEmpresa) setErrors((p) => ({ ...p, nomeEmpresa: validate('nomeEmpresa', e.target.value) || undefined }));
                  }}
                  onBlur={(e) => handleBlur('nomeEmpresa', e.target.value)}
                  aria-required="true"
                  aria-invalid={!!errors.nomeEmpresa}
                  aria-describedby={errors.nomeEmpresa ? 'nomeEmpresa-error' : undefined}
                  className="h-11 sm:h-10"
                />
                {errors.nomeEmpresa && (
                  <p id="nomeEmpresa-error" role="alert" className="flex items-center gap-1 text-xs font-medium text-destructive">
                    <AlertCircle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" /> {errors.nomeEmpresa}
                  </p>
                )}
              </div>
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
                <Label htmlFor="senha">
                  Senha <span className="text-destructive" aria-hidden="true">*</span>
                </Label>
                <div className="relative">
                  <Input
                    ref={senhaRef}
                    id="senha"
                    type={showPassword ? 'text' : 'password'}
                    placeholder="********"
                    value={senha}
                    onChange={(e) => {
                      setSenha(e.target.value);
                      if (touched.senha) setErrors((p) => ({ ...p, senha: validate('senha', e.target.value) || undefined }));
                    }}
                    onBlur={(e) => handleBlur('senha', e.target.value)}
                    autoComplete="new-password"
                    aria-required="true"
                    aria-invalid={!!errors.senha}
                    aria-describedby="senha-requisitos"
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
                {errors.senha && (
                  <p role="alert" className="flex items-center gap-1 text-xs font-medium text-destructive">
                    <AlertCircle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" /> {errors.senha}
                  </p>
                )}
                <div id="senha-requisitos">
                  <PasswordStrength password={senha} />
                </div>
              </div>
              <Button type="submit" className="h-11 w-full sm:h-10" disabled={loading || (!isPasswordValid && senha.length > 0)}>
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

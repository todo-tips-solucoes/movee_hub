'use client';

/**
 * Tela /dashboard/configuracoes/grupo
 * Gerenciamento de empresas filhas do grupo de CNPJs.
 *
 * Feature: cadastro-filiais
 * Ref: docs/specs/cadastro-filiais/spec.md FR-001..FR-010
 *      docs/specs/cadastro-filiais/contracts/grupo-empresas-api.md
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useAuth } from '@/contexts/auth-context';
import { Eye, EyeOff, Check, X, Loader2, ChevronDown, ChevronUp } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

/* ------------------------------------------------------------------ */
/* Tipos                                                                 */
/* ------------------------------------------------------------------ */

interface EmpresaFilha {
  id: number;
  nome_empresa: string;
  email?: string;
}

interface FormErrors {
  nome_empresa?: string;
  email?: string;
  senha?: string;
  cnpj?: string;
  geral?: string;
}

/* ------------------------------------------------------------------ */
/* Componente PasswordStrength (espelhado de register/page.tsx)         */
/* ------------------------------------------------------------------ */

function PasswordStrength({ password }: { password: string }) {
  const rules = useMemo(
    () => [
      { label: 'Mínimo 6 caracteres', ok: password.length >= 6 },
      { label: 'Uma letra maiúscula', ok: /[A-Z]/.test(password) },
      { label: 'Um número', ok: /\d/.test(password) },
    ],
    [password],
  );

  if (!password) return null;

  return (
    <motion.div
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: 'auto' }}
      exit={{ opacity: 0, height: 0 }}
      className="space-y-1 pt-1"
    >
      {rules.map((r) => (
        <div key={r.label} className="flex items-center gap-1.5 text-xs">
          {r.ok ? (
            <Check className="h-3 w-3 text-success" />
          ) : (
            <X className="h-3 w-3 text-muted-foreground" />
          )}
          <span className={r.ok ? 'text-success' : 'text-muted-foreground'}>
            {r.label}
          </span>
        </div>
      ))}
    </motion.div>
  );
}

/* ------------------------------------------------------------------ */
/* Helpers                                                               */
/* ------------------------------------------------------------------ */

/** Remove tudo que não for dígito e retorna os primeiros 14 caracteres */
function formatCnpj(raw: string): string {
  return raw.replace(/\D/g, '').slice(0, 14);
}

/** Valida CNPJ: exatamente 14 dígitos numéricos */
function isCnpjValido(cnpj: string): boolean {
  return /^\d{14}$/.test(cnpj);
}

/** Formata CNPJ para exibição: XX.XXX.XXX/XXXX-XX */
function exibirCnpj(cnpj: string): string {
  if (cnpj.length !== 14) return cnpj;
  return cnpj.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5');
}

/* ------------------------------------------------------------------ */
/* Página principal                                                      */
/* ------------------------------------------------------------------ */

export default function GrupoPage() {
  const { user } = useAuth();
  const isGrupoPai = (user as any)?.is_grupo_pai === true;

  /* ---- lista de filiais ---- */
  const [filhos, setFilhos] = useState<EmpresaFilha[]>([]);
  const [loading, setLoading] = useState(true);
  const [erro, setErro] = useState<string | null>(null);

  /* ---- formulário — campos obrigatórios ---- */
  const [nomeEmpresa, setNomeEmpresa] = useState('');
  const [email, setEmail] = useState('');
  const [senha, setSenha] = useState('');
  const [showSenha, setShowSenha] = useState(false);
  const [cnpj, setCnpj] = useState('');

  /* ---- formulário — campos opcionais (seção "Dados fiscais") ---- */
  const [dadosFiscaisAberto, setDadosFiscaisAberto] = useState(false);
  const [endereco, setEndereco] = useState('');
  const [numero, setNumero] = useState('');
  const [cep, setCep] = useState('');
  const [emailNota, setEmailNota] = useState('');
  const [observacao, setObservacao] = useState('');

  /* ---- estado de submit ---- */
  const [cadastrando, setCadastrando] = useState(false);
  const [formErrors, setFormErrors] = useState<FormErrors>({});
  const [sucesso, setSucesso] = useState(false);

  /* ---- refs para foco em erro ---- */
  const refNome = useRef<HTMLInputElement>(null);
  const refEmail = useRef<HTMLInputElement>(null);
  const refSenha = useRef<HTMLInputElement>(null);
  const refCnpj = useRef<HTMLInputElement>(null);

  /* ---- validações ---- */
  const isPasswordValid =
    senha.length >= 6 && /[A-Z]/.test(senha) && /\d/.test(senha);

  /* ---------------------------------------------------------------- */
  /* Carregar lista                                                      */
  /* ---------------------------------------------------------------- */

  const carregarFilhos = useCallback(async () => {
    if (!isGrupoPai) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setErro(null);
    try {
      const res = await fetch('/api/grupo/filhos', { credentials: 'include' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setErro(data.error || 'Erro ao carregar filiais.');
        return;
      }
      const data = await res.json();
      setFilhos(data.filhos || []);
    } catch {
      setErro('Erro de comunicação com o servidor.');
    } finally {
      setLoading(false);
    }
  }, [isGrupoPai]);

  useEffect(() => {
    carregarFilhos();
  }, [carregarFilhos]);

  /* ---------------------------------------------------------------- */
  /* Foco inicial no campo nome_empresa ao montar                       */
  /* ---------------------------------------------------------------- */
  useEffect(() => {
    if (isGrupoPai) {
      // Pequeno delay para garantir que o DOM está pronto
      const t = setTimeout(() => refNome.current?.focus(), 100);
      return () => clearTimeout(t);
    }
  }, [isGrupoPai]);

  /* ---------------------------------------------------------------- */
  /* Submit — Cadastrar filial                                          */
  /* ---------------------------------------------------------------- */

  const limparForm = () => {
    setNomeEmpresa('');
    setEmail('');
    setSenha('');
    setShowSenha(false);
    setCnpj('');
    setEndereco('');
    setNumero('');
    setCep('');
    setEmailNota('');
    setObservacao('');
    setDadosFiscaisAberto(false);
    setFormErrors({});
  };

  const handleCadastrarFilial = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormErrors({});
    setSucesso(false);

    /* validação client-side */
    const erros: FormErrors = {};
    if (!nomeEmpresa.trim()) erros.nome_empresa = 'Nome da empresa é obrigatório.';
    if (!email.trim()) erros.email = 'E-mail é obrigatório.';
    if (!senha) erros.senha = 'Senha é obrigatória.';
    else if (!isPasswordValid) erros.senha = 'A senha não atende aos requisitos mínimos.';
    if (!cnpj) erros.cnpj = 'CNPJ é obrigatório.';
    else if (!isCnpjValido(cnpj)) erros.cnpj = 'CNPJ deve ter exatamente 14 dígitos.';

    if (Object.keys(erros).length > 0) {
      setFormErrors(erros);
      // Foco no primeiro campo inválido
      if (erros.nome_empresa) refNome.current?.focus();
      else if (erros.email) refEmail.current?.focus();
      else if (erros.senha) refSenha.current?.focus();
      else if (erros.cnpj) refCnpj.current?.focus();
      return;
    }

    setCadastrando(true);
    try {
      const body: Record<string, string> = {
        nome_empresa: nomeEmpresa.trim(),
        email: email.trim(),
        senha,
        cnpj,
      };
      /* campos opcionais: incluir apenas se preenchidos */
      if (endereco.trim()) body.endereco = endereco.trim();
      if (numero.trim()) body.numero = numero.trim();
      if (cep.trim()) body.cep = cep.trim();
      if (emailNota.trim()) body.email_nota = emailNota.trim();
      if (observacao.trim()) body.observacao = observacao.trim();

      const res = await fetch('/api/grupo/empresas', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      const data = await res.json().catch(() => ({}));

      if (res.status === 201) {
        setSucesso(true);
        limparForm();
        await carregarFilhos();
        return;
      }

      if (res.status === 400) {
        /* Erros de campo específicos */
        const msg: string = data.error || '';
        const novosErros: FormErrors = {};
        if (/e.?mail/i.test(msg)) {
          novosErros.email = msg;
          refEmail.current?.focus();
        } else if (/cnpj/i.test(msg)) {
          novosErros.cnpj = msg;
          refCnpj.current?.focus();
        } else if (/senha/i.test(msg)) {
          novosErros.senha = msg;
          refSenha.current?.focus();
        } else if (/nome/i.test(msg)) {
          novosErros.nome_empresa = msg;
          refNome.current?.focus();
        } else {
          novosErros.geral = msg || 'Dados inválidos. Verifique os campos e tente novamente.';
        }
        setFormErrors(novosErros);
        return;
      }

      if (res.status === 409) {
        setFormErrors({ cnpj: 'CNPJ já cadastrado em outra empresa.' });
        refCnpj.current?.focus();
        return;
      }

      if (res.status === 422) {
        setFormErrors({
          geral: `Limite de 100 filiais atingido. Remova filiais antes de adicionar novas.`,
        });
        return;
      }

      if (res.status === 403) {
        setFormErrors({ geral: 'Sem permissão. Apenas administradores de grupo podem cadastrar filiais.' });
        return;
      }

      setFormErrors({ geral: data.error || 'Erro inesperado. Tente novamente.' });
    } catch {
      setFormErrors({ geral: 'Erro de comunicação com o servidor.' });
    } finally {
      setCadastrando(false);
    }
  };

  /* ---------------------------------------------------------------- */
  /* Desvincular                                                         */
  /* ---------------------------------------------------------------- */

  const handleDesvincular = async (idFilho: number) => {
    if (!confirm('Tem certeza que deseja desvincular esta empresa do grupo?')) return;
    try {
      const res = await fetch(`/api/grupo/filhos/${idFilho}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        alert(data.error || 'Erro ao desvincular empresa.');
        return;
      }
      await carregarFilhos();
    } catch {
      alert('Erro de comunicação com o servidor.');
    }
  };

  /* ---------------------------------------------------------------- */
  /* Tela bloqueada (não-admin)                                         */
  /* ---------------------------------------------------------------- */

  if (!isGrupoPai) {
    return (
      <div className="max-w-xl mx-auto mt-8 p-6 rounded-lg border bg-card text-card-foreground">
        <h1 className="font-display text-xl font-semibold mb-2">Grupo de CNPJs</h1>
        <p className="text-muted-foreground text-sm">
          Apenas administradores de grupo podem cadastrar filiais.
        </p>
      </div>
    );
  }

  /* ---------------------------------------------------------------- */
  /* JSX principal                                                       */
  /* ---------------------------------------------------------------- */

  return (
    <div className="max-w-2xl mx-auto py-8 px-4 space-y-8">
      {/* Cabeçalho */}
      <div>
        <h1 className="font-display text-2xl font-bold tracking-tight">Grupo de CNPJs</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Cadastre e gerencie as empresas filhas do seu grupo. Máximo de 100 filiais.
        </p>
      </div>

      {/* ---- Formulário: Cadastrar filial ---- */}
      <div className="rounded-lg border bg-card p-5 space-y-5">
        <h2 className="text-base font-semibold">Cadastrar filial</h2>

        {/* Banner de sucesso */}
        <AnimatePresence>
          {sucesso && (
            <motion.div
              initial={{ opacity: 0, y: -6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              role="alert"
              aria-live="polite"
              className="rounded-md border border-success/50 bg-success/10 px-4 py-3 text-sm text-success flex items-center gap-2"
            >
              <Check className="h-4 w-4 shrink-0" />
              Filial cadastrada com sucesso. A lista foi atualizada.
            </motion.div>
          )}
        </AnimatePresence>

        {/* Erro geral */}
        {formErrors.geral && (
          <div
            role="alert"
            aria-live="polite"
            className="rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive"
          >
            {formErrors.geral}
          </div>
        )}

        <form onSubmit={handleCadastrarFilial} noValidate className="space-y-4">
          {/* Legenda de obrigatoriedade */}
          <p className="text-xs text-muted-foreground">
            Campos marcados com <span className="text-destructive">*</span> são obrigatórios.
          </p>

          {/* Nome da empresa */}
          <div className="space-y-1">
            <label
              htmlFor="cad_nome_empresa"
              className="text-sm font-medium"
            >
              Nome da empresa <span className="text-destructive" aria-hidden="true">*</span>
            </label>
            <input
              ref={refNome}
              id="cad_nome_empresa"
              type="text"
              autoComplete="organization"
              value={nomeEmpresa}
              onChange={(e) => setNomeEmpresa(e.target.value)}
              aria-required="true"
              aria-invalid={!!formErrors.nome_empresa}
              aria-describedby={formErrors.nome_empresa ? 'err_nome_empresa' : undefined}
              className={`flex h-11 w-full rounded-md border bg-background px-3 py-2 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ${
                formErrors.nome_empresa
                  ? 'border-destructive'
                  : 'border-input'
              }`}
            />
            {formErrors.nome_empresa && (
              <p
                id="err_nome_empresa"
                role="alert"
                aria-live="polite"
                className="text-xs text-destructive"
              >
                {formErrors.nome_empresa}
              </p>
            )}
          </div>

          {/* E-mail */}
          <div className="space-y-1">
            <label htmlFor="cad_email" className="text-sm font-medium">
              E-mail <span className="text-destructive" aria-hidden="true">*</span>
            </label>
            <input
              ref={refEmail}
              id="cad_email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              aria-required="true"
              aria-invalid={!!formErrors.email}
              aria-describedby={formErrors.email ? 'err_email' : undefined}
              className={`flex h-11 w-full rounded-md border bg-background px-3 py-2 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ${
                formErrors.email ? 'border-destructive' : 'border-input'
              }`}
            />
            {formErrors.email && (
              <p
                id="err_email"
                role="alert"
                aria-live="polite"
                className="text-xs text-destructive"
              >
                {formErrors.email}
              </p>
            )}
          </div>

          {/* Senha */}
          <div className="space-y-1">
            <label htmlFor="cad_senha" className="text-sm font-medium">
              Senha <span className="text-destructive" aria-hidden="true">*</span>
            </label>
            <div className="relative">
              <input
                ref={refSenha}
                id="cad_senha"
                type={showSenha ? 'text' : 'password'}
                autoComplete="new-password"
                value={senha}
                onChange={(e) => setSenha(e.target.value)}
                aria-required="true"
                aria-invalid={!!formErrors.senha}
                aria-describedby={
                  formErrors.senha
                    ? 'err_senha'
                    : senha
                    ? 'senha_strength'
                    : undefined
                }
                className={`flex h-11 w-full rounded-md border bg-background px-3 py-2 pr-10 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ${
                  formErrors.senha ? 'border-destructive' : 'border-input'
                }`}
              />
              <button
                type="button"
                onClick={() => setShowSenha((v) => !v)}
                aria-label={showSenha ? 'Ocultar senha' : 'Mostrar senha'}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors p-1"
              >
                {showSenha ? (
                  <EyeOff className="h-4 w-4" />
                ) : (
                  <Eye className="h-4 w-4" />
                )}
              </button>
            </div>
            {formErrors.senha && (
              <p
                id="err_senha"
                role="alert"
                aria-live="polite"
                className="text-xs text-destructive"
              >
                {formErrors.senha}
              </p>
            )}
            <AnimatePresence>
              {senha && (
                <div id="senha_strength">
                  <PasswordStrength password={senha} />
                </div>
              )}
            </AnimatePresence>
          </div>

          {/* CNPJ */}
          <div className="space-y-1">
            <label htmlFor="cad_cnpj" className="text-sm font-medium">
              CNPJ <span className="text-destructive" aria-hidden="true">*</span>
            </label>
            <input
              ref={refCnpj}
              id="cad_cnpj"
              type="text"
              inputMode="numeric"
              autoComplete="off"
              value={cnpj ? exibirCnpj(cnpj) : ''}
              onChange={(e) => setCnpj(formatCnpj(e.target.value))}
              placeholder="00.000.000/0000-00"
              maxLength={18}
              aria-required="true"
              aria-invalid={!!formErrors.cnpj}
              aria-describedby={formErrors.cnpj ? 'err_cnpj' : undefined}
              className={`flex h-11 w-full rounded-md border bg-background px-3 py-2 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ${
                formErrors.cnpj ? 'border-destructive' : 'border-input'
              }`}
            />
            {formErrors.cnpj && (
              <p
                id="err_cnpj"
                role="alert"
                aria-live="polite"
                className="text-xs text-destructive"
              >
                {formErrors.cnpj}
              </p>
            )}
          </div>

          {/* Seção "Dados fiscais" — colapsável */}
          <div className="rounded-md border border-border overflow-hidden">
            <button
              type="button"
              onClick={() => setDadosFiscaisAberto((v) => !v)}
              aria-expanded={dadosFiscaisAberto}
              aria-controls="secao_dados_fiscais"
              className="w-full flex items-center justify-between px-4 py-3 text-sm font-medium text-left bg-muted/40 hover:bg-muted/60 transition-colors"
            >
              Dados fiscais
              <span className="text-xs text-muted-foreground flex items-center gap-1">
                Opcionais
                {dadosFiscaisAberto ? (
                  <ChevronUp className="h-3.5 w-3.5" />
                ) : (
                  <ChevronDown className="h-3.5 w-3.5" />
                )}
              </span>
            </button>

            <AnimatePresence initial={false}>
              {dadosFiscaisAberto && (
                <motion.div
                  id="secao_dados_fiscais"
                  key="fiscal"
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.2 }}
                  className="overflow-hidden"
                >
                  <div className="p-4 space-y-3 bg-background">
                    {/* Endereço */}
                    <div className="space-y-1">
                      <label htmlFor="cad_endereco" className="text-sm font-medium text-muted-foreground">
                        Endereço
                      </label>
                      <input
                        id="cad_endereco"
                        type="text"
                        autoComplete="street-address"
                        value={endereco}
                        onChange={(e) => setEndereco(e.target.value)}
                        className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                      />
                    </div>

                    {/* Número e CEP em linha */}
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1">
                        <label htmlFor="cad_numero" className="text-sm font-medium text-muted-foreground">
                          Número
                        </label>
                        <input
                          id="cad_numero"
                          type="text"
                          autoComplete="address-line2"
                          value={numero}
                          onChange={(e) => setNumero(e.target.value)}
                          className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                        />
                      </div>
                      <div className="space-y-1">
                        <label htmlFor="cad_cep" className="text-sm font-medium text-muted-foreground">
                          CEP
                        </label>
                        <input
                          id="cad_cep"
                          type="text"
                          inputMode="numeric"
                          autoComplete="postal-code"
                          value={cep}
                          onChange={(e) => setCep(e.target.value.replace(/\D/g, '').slice(0, 8))}
                          placeholder="00000-000"
                          maxLength={9}
                          className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                        />
                      </div>
                    </div>

                    {/* E-mail de nota fiscal */}
                    <div className="space-y-1">
                      <label htmlFor="cad_email_nota" className="text-sm font-medium text-muted-foreground">
                        E-mail para nota fiscal
                      </label>
                      <input
                        id="cad_email_nota"
                        type="email"
                        autoComplete="email"
                        value={emailNota}
                        onChange={(e) => setEmailNota(e.target.value)}
                        className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                      />
                    </div>

                    {/* Observação */}
                    <div className="space-y-1">
                      <label htmlFor="cad_observacao" className="text-sm font-medium text-muted-foreground">
                        Observação
                      </label>
                      <textarea
                        id="cad_observacao"
                        rows={3}
                        value={observacao}
                        onChange={(e) => setObservacao(e.target.value)}
                        className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring resize-none"
                      />
                    </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {/* Botão submit */}
          <button
            type="submit"
            disabled={cadastrando}
            className="inline-flex items-center justify-center gap-2 min-h-[44px] w-full rounded-md bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {cadastrando ? (
              <>
                <Loader2
                  className="h-4 w-4 animate-spin"
                  aria-hidden="true"
                />
                <span aria-label="Salvando...">Cadastrando filial…</span>
              </>
            ) : (
              'Cadastrar filial'
            )}
          </button>
        </form>
      </div>

      {/* ---- Lista de filiais ---- */}
      <div className="space-y-3">
        <h2 className="text-base font-semibold">
          Filiais cadastradas{' '}
          <span className="ml-1 text-muted-foreground text-sm font-normal">
            ({filhos.length}/100)
          </span>
        </h2>

        {loading && (
          <div className="flex justify-center py-8">
            <Loader2
              className="h-6 w-6 animate-spin text-primary"
              aria-label="Carregando lista de filiais"
            />
          </div>
        )}

        {!loading && erro && (
          <div
            role="alert"
            aria-live="polite"
            className="rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive"
          >
            {erro}
          </div>
        )}

        {!loading && !erro && filhos.length === 0 && (
          <p className="text-sm text-muted-foreground">
            Nenhuma filial cadastrada. Preencha o formulário para adicionar a primeira.
          </p>
        )}

        {!loading && filhos.length > 0 && (
          <div className="rounded-lg border divide-y divide-border overflow-hidden">
            {filhos.map((f) => (
              <div
                key={f.id}
                className="flex items-center justify-between px-4 py-3 bg-card hover:bg-muted/50 transition-colors"
              >
                <div>
                  <p className="text-sm font-medium">{f.nome_empresa}</p>
                  <p className="text-xs text-muted-foreground">
                    ID: <span className="tabular-nums">{f.id}</span>
                    {f.email ? ` · ${f.email}` : ''}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => handleDesvincular(f.id)}
                  className="min-h-[44px] min-w-[44px] flex items-center justify-center text-xs text-destructive hover:underline ml-4 px-2"
                >
                  Desvincular
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

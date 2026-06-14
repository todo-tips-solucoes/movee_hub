'use client';

/**
 * Tela /dashboard/configuracoes/grupo
 * Gerenciamento de empresas filhas do grupo de CNPJs.
 *
 * Feature: cadastro-filiais
 * Ref: docs/specs/cadastro-filiais/spec.md FR-001..FR-010
 *      docs/specs/cadastro-filiais/contracts/grupo-empresas-api.md
 *
 * Feature: grupo-unificado-filiais (task 3.1)
 * Adiciona modal de edição de filial: PUT /api/grupo/empresas/:id
 * Ref: docs/specs/grupo-unificado-filiais/spec.md FR-B
 *      OWASP LOW-003: autoComplete="off" no form de edição
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useAuth } from '@/contexts/auth-context';
import { Eye, EyeOff, Check, X, Loader2, ChevronDown, ChevronUp, Pencil } from 'lucide-react';
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion';
import { toast } from 'sonner';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

/* ------------------------------------------------------------------ */
/* Tipos                                                                 */
/* ------------------------------------------------------------------ */

interface EmpresaFilha {
  id: number;
  nome_empresa: string;
  email?: string;
  /** grupo-unificado-filiais: empresa-pai (matriz) — editável, mas não desvinculável */
  is_pai?: boolean;
}

interface FormErrors {
  nome_empresa?: string;
  email?: string;
  senha?: string;
  cnpj?: string;
  geral?: string;
}

/** Dados completos para o formulário de edição (task 3.1) */
interface EmpresaEditData {
  id: number;
  nome_empresa: string;
  email: string;
  cnpj: string;
  endereco: string;
  numero: string;
  cep: string;
  email_nota: string;
  observacao: string;
}

interface EditFormErrors {
  nome_empresa?: string;
  email?: string;
  cnpj?: string;
  geral?: string;
}

/* ------------------------------------------------------------------ */
/* Componente PasswordStrength (espelhado de register/page.tsx)         */
/* ------------------------------------------------------------------ */

function PasswordStrength({ password }: { password: string }) {
  const prefersReduced = useReducedMotion();
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
      initial={prefersReduced ? false : { opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: 'auto' }}
      exit={prefersReduced ? { opacity: 0 } : { opacity: 0, height: 0 }}
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
  // U010: formulário "Cadastrar filial" colapsável (progressive disclosure)
  const [cadOpen, setCadOpen] = useState(false);

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

  // U010: abre o formulário automaticamente quando surge um erro geral, mas
  // sem travar — o usuário ainda pode recolher (open controlado só por cadOpen).
  useEffect(() => {
    if (formErrors.geral) setCadOpen(true);
  }, [formErrors.geral]);

  /* ---- desvincular (AlertDialog) ---- */
  const [desvincularAlvo, setDesvincularAlvo] = useState<EmpresaFilha | null>(null);
  const [desvinculando, setDesvinculando] = useState(false);

  /* ---- editar filial (Dialog modal) — task 3.1 ---- */
  const [editModalAberto, setEditModalAberto] = useState(false);
  const [editAlvo, setEditAlvo] = useState<EmpresaEditData | null>(null);
  const [editCarregando, setEditCarregando] = useState(false);
  const [editSalvando, setEditSalvando] = useState(false);
  const [editErrors, setEditErrors] = useState<EditFormErrors>({});
  const [editDadosFiscaisAberto, setEditDadosFiscaisAberto] = useState(false);

  const prefersReduced = useReducedMotion();

  /* ---- refs para foco em erro ---- */
  const refNome = useRef<HTMLInputElement>(null);
  const refEmail = useRef<HTMLInputElement>(null);
  const refSenha = useRef<HTMLInputElement>(null);
  const refCnpj = useRef<HTMLInputElement>(null);

  /* ---- refs para foco em erro — form edição ---- */
  const refEditNome = useRef<HTMLInputElement>(null);
  const refEditEmail = useRef<HTMLInputElement>(null);
  const refEditCnpj = useRef<HTMLInputElement>(null);

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
        toast.success('Filial cadastrada com sucesso. A lista foi atualizada.');
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
  /* Editar filial — task 3.1                                           */
  /* ---------------------------------------------------------------- */

  /** Abre o modal e pré-carrega dados completos da filial via GET /api/grupo/empresas/:id */
  const abrirEditarFilial = useCallback(async (filial: EmpresaFilha) => {
    setEditErrors({});
    setEditDadosFiscaisAberto(false);
    setEditAlvo(null);
    setEditCarregando(true);
    setEditModalAberto(true);
    try {
      const res = await fetch(`/api/grupo/empresas/${filial.id}`, {
        credentials: 'include',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setEditErrors({ geral: data.error || 'Erro ao carregar dados da filial.' });
        return;
      }
      setEditAlvo({
        id:           data.id,
        nome_empresa: data.nome_empresa || '',
        email:        data.email        || '',
        cnpj:         data.cnpj         || '',
        endereco:     data.endereco     || '',
        numero:       data.numero       || '',
        cep:          data.cep          || '',
        email_nota:   data.email_nota   || '',
        observacao:   data.observacao   || '',
      });
    } catch {
      setEditErrors({ geral: 'Erro de comunicação com o servidor.' });
    } finally {
      setEditCarregando(false);
    }
  }, []);

  const fecharEditarFilial = useCallback(() => {
    if (editSalvando) return; // bloqueia fechar enquanto salva
    setEditModalAberto(false);
    setEditAlvo(null);
    setEditErrors({});
    setEditDadosFiscaisAberto(false);
  }, [editSalvando]);

  /** Atualiza um campo no editAlvo com type-safety */
  const setEditField = useCallback(
    (field: keyof EmpresaEditData, value: string | number) => {
      setEditAlvo((prev) => (prev ? { ...prev, [field]: value } : prev));
    },
    [],
  );

  const handleSalvarEdicao = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editAlvo) return;
    setEditErrors({});

    /* Validação client-side (espelha backend) */
    const erros: EditFormErrors = {};
    if (!editAlvo.nome_empresa.trim()) erros.nome_empresa = 'Nome da empresa é obrigatório.';
    if (!editAlvo.email.trim()) erros.email = 'E-mail é obrigatório.';
    const cnpjDigitos = editAlvo.cnpj.replace(/\D/g, '');
    if (!cnpjDigitos) erros.cnpj = 'CNPJ é obrigatório.';
    else if (cnpjDigitos.length !== 14) erros.cnpj = 'CNPJ deve ter exatamente 14 dígitos.';

    if (Object.keys(erros).length > 0) {
      setEditErrors(erros);
      if (erros.nome_empresa) refEditNome.current?.focus();
      else if (erros.email) refEditEmail.current?.focus();
      else if (erros.cnpj) refEditCnpj.current?.focus();
      return;
    }

    setEditSalvando(true);
    try {
      const body: Record<string, string> = {
        nome_empresa: editAlvo.nome_empresa.trim(),
        email:        editAlvo.email.trim(),
        cnpj:         cnpjDigitos,
      };
      /* campos opcionais */
      if (editAlvo.endereco.trim()) body.endereco = editAlvo.endereco.trim();
      if (editAlvo.numero.trim()) body.numero = editAlvo.numero.trim();
      if (editAlvo.cep.trim()) body.cep = editAlvo.cep.trim();
      if (editAlvo.email_nota.trim()) body.email_nota = editAlvo.email_nota.trim();
      if (editAlvo.observacao.trim()) body.observacao = editAlvo.observacao.trim();

      const res = await fetch(`/api/grupo/empresas/${editAlvo.id}`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      const data = await res.json().catch(() => ({}));

      if (res.status === 200) {
        toast.success('Filial atualizada com sucesso.');
        fecharEditarFilial();
        await carregarFilhos();
        return;
      }

      if (res.status === 400) {
        const msg: string = data.error || '';
        const novosErros: EditFormErrors = {};
        if (/e.?mail/i.test(msg)) {
          novosErros.email = msg;
          refEditEmail.current?.focus();
        } else if (/cnpj/i.test(msg)) {
          novosErros.cnpj = msg;
          refEditCnpj.current?.focus();
        } else if (/nome/i.test(msg)) {
          novosErros.nome_empresa = msg;
          refEditNome.current?.focus();
        } else {
          novosErros.geral = msg || 'Dados inválidos. Verifique os campos e tente novamente.';
        }
        setEditErrors(novosErros);
        return;
      }

      if (res.status === 409) {
        const msg: string = data.error || '';
        if (/e.?mail/i.test(msg)) {
          setEditErrors({ email: msg });
          refEditEmail.current?.focus();
        } else {
          setEditErrors({ cnpj: msg });
          refEditCnpj.current?.focus();
        }
        return;
      }

      if (res.status === 403) {
        setEditErrors({ geral: 'Sem permissão para editar esta empresa.' });
        return;
      }

      setEditErrors({ geral: data.error || 'Erro inesperado. Tente novamente.' });
    } catch {
      setEditErrors({ geral: 'Erro de comunicação com o servidor.' });
    } finally {
      setEditSalvando(false);
    }
  };

  /* ---------------------------------------------------------------- */
  /* Desvincular                                                         */
  /* ---------------------------------------------------------------- */

  const confirmarDesvincular = async () => {
    if (!desvincularAlvo) return;
    setDesvinculando(true);
    try {
      const res = await fetch(`/api/grupo/filhos/${desvincularAlvo.id}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast.error(data.error || 'Erro ao desvincular empresa.');
        return;
      }
      toast.success('Empresa desvinculada do grupo.');
      await carregarFilhos();
      setDesvincularAlvo(null);
    } catch {
      toast.error('Erro de comunicação com o servidor.');
    } finally {
      setDesvinculando(false);
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
      <details
        className="group rounded-lg border bg-card"
        open={cadOpen}
        onToggle={(e) => setCadOpen((e.currentTarget as HTMLDetailsElement).open)}
      >
        <summary className="flex cursor-pointer list-none items-center justify-between gap-2 rounded-lg p-5 [&::-webkit-details-marker]:hidden">
          <h2 className="text-base font-semibold">Cadastrar filial</h2>
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" aria-hidden="true" />
        </summary>
        <div className="space-y-5 px-5 pb-5">

        {/* Erro geral */}
        {formErrors.geral && (
          <div
            role="alert"
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
                  [
                    formErrors.senha ? 'err_senha' : null,
                    senha ? 'senha_strength' : null,
                  ]
                    .filter(Boolean)
                    .join(' ') || undefined
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
                  initial={prefersReduced ? false : { height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={prefersReduced ? { opacity: 0 } : { height: 0, opacity: 0 }}
                  transition={{ duration: prefersReduced ? 0 : 0.2 }}
                  className="overflow-hidden"
                >
                  <div className="p-4 space-y-3 bg-background">
                    {/* Endereço */}
                    <div className="space-y-1">
                      <label htmlFor="cad_endereco" className="text-sm font-medium">
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
                        <label htmlFor="cad_numero" className="text-sm font-medium">
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
                        <label htmlFor="cad_cep" className="text-sm font-medium">
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
                      <label htmlFor="cad_email_nota" className="text-sm font-medium">
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
                      <label htmlFor="cad_observacao" className="text-sm font-medium">
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
      </details>

      {/* ---- Lista de filiais ---- */}
      <div className="space-y-3">
        <h2 className="text-base font-semibold">
          Empresas do grupo{' '}
          <span className="ml-1 text-muted-foreground text-sm font-normal">
            ({filhos.filter((f) => !f.is_pai).length}/100 filiais)
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
                  <p className="text-sm font-medium">
                    {f.nome_empresa}
                    {f.is_pai && (
                      <span className="ml-2 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary align-middle">
                        Matriz
                      </span>
                    )}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    ID: <span className="tabular-nums">{f.id}</span>
                    {f.email ? ` · ${f.email}` : ''}
                  </p>
                </div>
                <div className="flex items-center gap-1 ml-4">
                  {/* Botão Editar — task 3.1 (matriz também é editável) */}
                  <button
                    type="button"
                    onClick={() => abrirEditarFilial(f)}
                    aria-label={`Editar ${f.nome_empresa}`}
                    className="min-h-[44px] min-w-[44px] flex items-center justify-center text-xs text-muted-foreground hover:text-foreground transition-colors px-2 gap-1"
                  >
                    <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                    <span className="hidden sm:inline">Editar</span>
                  </button>
                  {/* grupo-unificado-filiais: a matriz (pai) não pode ser desvinculada */}
                  {!f.is_pai && (
                    <button
                      type="button"
                      onClick={() => setDesvincularAlvo(f)}
                      className="min-h-[44px] min-w-[44px] flex items-center justify-center text-xs text-destructive hover:underline px-2"
                    >
                      Desvincular
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ────────────────────────────────────────────────────────────────── */}
      {/* Modal de edição de filial — task 3.1                              */}
      {/* ────────────────────────────────────────────────────────────────── */}
      <Dialog open={editModalAberto} onOpenChange={(o) => { if (!o) fecharEditarFilial(); }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Editar filial</DialogTitle>
            <DialogDescription>
              Atualize os dados cadastrais da filial. O campo senha não pode ser alterado por aqui.
            </DialogDescription>
          </DialogHeader>

          {/* Estado de carregamento inicial */}
          {editCarregando && (
            <div className="flex justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-primary" aria-label="Carregando dados da filial" />
            </div>
          )}

          {/* Erro ao carregar */}
          {!editCarregando && editErrors.geral && !editAlvo && (
            <div
              role="alert"
              className="rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive"
            >
              {editErrors.geral}
            </div>
          )}

          {/* Formulário de edição — exibido apenas quando os dados carregaram */}
          {!editCarregando && editAlvo && (
            <form
              id="form-editar-filial"
              onSubmit={handleSalvarEdicao}
              noValidate
              autoComplete="off"
              className="space-y-4"
            >
              {/* Erro geral */}
              {editErrors.geral && (
                <div
                  role="alert"
                  className="rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive"
                >
                  {editErrors.geral}
                </div>
              )}

              <p className="text-xs text-muted-foreground">
                Campos marcados com <span className="text-destructive">*</span> são obrigatórios.
              </p>

              {/* Nome da empresa */}
              <div className="space-y-1">
                <label htmlFor="edit_nome_empresa" className="text-sm font-medium">
                  Nome da empresa <span className="text-destructive" aria-hidden="true">*</span>
                </label>
                <input
                  ref={refEditNome}
                  id="edit_nome_empresa"
                  type="text"
                  autoComplete="off"
                  value={editAlvo.nome_empresa}
                  onChange={(e) => setEditField('nome_empresa', e.target.value)}
                  aria-required="true"
                  aria-invalid={!!editErrors.nome_empresa}
                  aria-describedby={editErrors.nome_empresa ? 'edit_err_nome' : undefined}
                  className={`flex h-11 w-full rounded-md border bg-background px-3 py-2 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ${
                    editErrors.nome_empresa ? 'border-destructive' : 'border-input'
                  }`}
                />
                {editErrors.nome_empresa && (
                  <p id="edit_err_nome" role="alert" className="text-xs text-destructive">
                    {editErrors.nome_empresa}
                  </p>
                )}
              </div>

              {/* E-mail — OWASP LOW-003: autoComplete="username" no campo email */}
              <div className="space-y-1">
                <label htmlFor="edit_email" className="text-sm font-medium">
                  E-mail <span className="text-destructive" aria-hidden="true">*</span>
                </label>
                <input
                  ref={refEditEmail}
                  id="edit_email"
                  type="email"
                  autoComplete="username"
                  value={editAlvo.email}
                  onChange={(e) => setEditField('email', e.target.value)}
                  aria-required="true"
                  aria-invalid={!!editErrors.email}
                  aria-describedby={editErrors.email ? 'edit_err_email' : undefined}
                  className={`flex h-11 w-full rounded-md border bg-background px-3 py-2 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ${
                    editErrors.email ? 'border-destructive' : 'border-input'
                  }`}
                />
                {editErrors.email && (
                  <p id="edit_err_email" role="alert" className="text-xs text-destructive">
                    {editErrors.email}
                  </p>
                )}
              </div>

              {/* CNPJ */}
              <div className="space-y-1">
                <label htmlFor="edit_cnpj" className="text-sm font-medium">
                  CNPJ <span className="text-destructive" aria-hidden="true">*</span>
                </label>
                <input
                  ref={refEditCnpj}
                  id="edit_cnpj"
                  type="text"
                  inputMode="numeric"
                  autoComplete="off"
                  value={editAlvo.cnpj ? exibirCnpj(editAlvo.cnpj.replace(/\D/g, '')) : ''}
                  onChange={(e) => setEditField('cnpj', formatCnpj(e.target.value))}
                  placeholder="00.000.000/0000-00"
                  maxLength={18}
                  aria-required="true"
                  aria-invalid={!!editErrors.cnpj}
                  aria-describedby={editErrors.cnpj ? 'edit_err_cnpj' : undefined}
                  className={`flex h-11 w-full rounded-md border bg-background px-3 py-2 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ${
                    editErrors.cnpj ? 'border-destructive' : 'border-input'
                  }`}
                />
                {editErrors.cnpj && (
                  <p id="edit_err_cnpj" role="alert" className="text-xs text-destructive">
                    {editErrors.cnpj}
                  </p>
                )}
              </div>

              {/* Seção "Dados fiscais" — colapsável */}
              <div className="rounded-md border border-border overflow-hidden">
                <button
                  type="button"
                  onClick={() => setEditDadosFiscaisAberto((v) => !v)}
                  aria-expanded={editDadosFiscaisAberto}
                  aria-controls="edit_secao_dados_fiscais"
                  className="w-full flex items-center justify-between px-4 py-3 text-sm font-medium text-left bg-muted/40 hover:bg-muted/60 transition-colors"
                >
                  Dados fiscais
                  <span className="text-xs text-muted-foreground flex items-center gap-1">
                    Opcionais
                    {editDadosFiscaisAberto ? (
                      <ChevronUp className="h-3.5 w-3.5" />
                    ) : (
                      <ChevronDown className="h-3.5 w-3.5" />
                    )}
                  </span>
                </button>

                <AnimatePresence initial={false}>
                  {editDadosFiscaisAberto && (
                    <motion.div
                      id="edit_secao_dados_fiscais"
                      key="edit-fiscal"
                      initial={prefersReduced ? false : { height: 0, opacity: 0 }}
                      animate={{ height: 'auto', opacity: 1 }}
                      exit={prefersReduced ? { opacity: 0 } : { height: 0, opacity: 0 }}
                      transition={{ duration: prefersReduced ? 0 : 0.2 }}
                      className="overflow-hidden"
                    >
                      <div className="p-4 space-y-3 bg-background">
                        {/* Endereço */}
                        <div className="space-y-1">
                          <label htmlFor="edit_endereco" className="text-sm font-medium">
                            Endereço
                          </label>
                          <input
                            id="edit_endereco"
                            type="text"
                            autoComplete="off"
                            value={editAlvo.endereco}
                            onChange={(e) => setEditField('endereco', e.target.value)}
                            className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                          />
                        </div>

                        {/* Número e CEP em linha */}
                        <div className="grid grid-cols-2 gap-3">
                          <div className="space-y-1">
                            <label htmlFor="edit_numero" className="text-sm font-medium">
                              Número
                            </label>
                            <input
                              id="edit_numero"
                              type="text"
                              autoComplete="off"
                              value={editAlvo.numero}
                              onChange={(e) => setEditField('numero', e.target.value)}
                              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                            />
                          </div>
                          <div className="space-y-1">
                            <label htmlFor="edit_cep" className="text-sm font-medium">
                              CEP
                            </label>
                            <input
                              id="edit_cep"
                              type="text"
                              inputMode="numeric"
                              autoComplete="off"
                              value={editAlvo.cep}
                              onChange={(e) => setEditField('cep', e.target.value.replace(/\D/g, '').slice(0, 8))}
                              placeholder="00000-000"
                              maxLength={9}
                              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                            />
                          </div>
                        </div>

                        {/* E-mail de nota fiscal */}
                        <div className="space-y-1">
                          <label htmlFor="edit_email_nota" className="text-sm font-medium">
                            E-mail para nota fiscal
                          </label>
                          <input
                            id="edit_email_nota"
                            type="email"
                            autoComplete="off"
                            value={editAlvo.email_nota}
                            onChange={(e) => setEditField('email_nota', e.target.value)}
                            className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                          />
                        </div>

                        {/* Observação */}
                        <div className="space-y-1">
                          <label htmlFor="edit_observacao" className="text-sm font-medium">
                            Observação
                          </label>
                          <textarea
                            id="edit_observacao"
                            rows={3}
                            value={editAlvo.observacao}
                            onChange={(e) => setEditField('observacao', e.target.value)}
                            className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring resize-none"
                          />
                        </div>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </form>
          )}

          <DialogFooter className="gap-2 sm:gap-0">
            <button
              type="button"
              onClick={fecharEditarFilial}
              disabled={editSalvando}
              className="inline-flex items-center justify-center min-h-[44px] rounded-md border border-input bg-background px-4 py-2 text-sm font-medium hover:bg-muted transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Cancelar
            </button>
            <button
              type="submit"
              form="form-editar-filial"
              disabled={editSalvando || editCarregando || !editAlvo}
              className="inline-flex items-center justify-center gap-2 min-h-[44px] rounded-md bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {editSalvando ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  <span aria-label="Salvando...">Salvando…</span>
                </>
              ) : (
                'Salvar alterações'
              )}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Diálogo de confirmação de desvínculo (substitui confirm() nativo) */}
      <AlertDialog
        open={desvincularAlvo !== null}
        onOpenChange={(o) => {
          if (!o) setDesvincularAlvo(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Desvincular filial</AlertDialogTitle>
            <AlertDialogDescription>
              {desvincularAlvo
                ? `Tem certeza que deseja desvincular "${desvincularAlvo.nome_empresa}" do grupo? A empresa não será excluída — apenas deixará de pertencer ao grupo.`
                : ''}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={desvinculando}>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                confirmarDesvincular();
              }}
              disabled={desvinculando}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {desvinculando && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Desvincular
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

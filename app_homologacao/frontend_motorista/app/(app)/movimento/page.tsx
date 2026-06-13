'use client';

/**
 * Tela do Movimento Aberto.
 * Exibe valor, período, dados fiscais e links para validação e portal.
 * Ref: tarefa 5.2 / spec US2/US4 / contracts §movimento-aberto / quickstart 3, 4, 10
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useAuth } from '@/contexts/auth-context';
import { useTenantTheme } from '@/contexts/tenant-theme-context';
import { api } from '@/lib/api-client';
import { formatCurrency, formatDate, formatCNPJ, cn } from '@/lib/utils';
import { toast } from 'sonner';
import { Button, buttonVariants } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { CountUp } from '@/components/ui/count-up';
import { CopyButton } from '@/components/ui/copy-button';
import { Wordmark } from '@/components/brand/wordmark';
import { Aurora } from '@/components/brand/aurora';
import { ThemeToggle } from '@/components/theme-toggle';
import { LogOut, RefreshCw, Calendar, FileText, AlertTriangle, ArrowUpRight, Inbox, MapPin, Mail, Info } from '@/components/ui/icons';

interface Tomador {
  razaoSocial: string | null;
  endereco: string | null;
  numero: string | null;
  cep: string | null;
  email: string | null;
  observacao: string | null;
}

interface Movimento {
  id: number;
  valor: string | number | null;
  gorjeta?: string | number | null;
  dtInicial: string | null;
  dtFinal: string | null;
  nome: string | null;
  cnpjTomador: string | null;
  cnpjPrestador: string;
  tribnac: string | null;
  notaOk: string | boolean | null;
  erroValidacao: string | null;
  tomador: Tomador | null;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return 'M';
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

// Mapa código → mensagem pt-BR dos campos reprovados na validação (mesmos
// nomes gravados em erro_validacao pelo serviço; espelha FIELD_MESSAGES do backend).
const VALIDACAO_MENSAGENS: Record<string, string> = {
  valid_cnpj_prestador: 'CNPJ do prestador (você) está incorreto na nota.',
  valid_cnpj: 'CNPJ do tomador está incorreto na nota.',
  valid_descricao_servico: 'Descrição do serviço está incorreta.',
  valid_valor: 'Valor da nota não confere com o valor do movimento.',
  valid_trib_nac: 'Tributação nacional (TribNac) está incorreta.',
  valid_trib_mun: 'Tributação municipal está incorreta.',
  valid_dCompet: 'Data de competência (dCompet) está incorreta.',
};

export default function MovimentoPage() {
  const { user, logout } = useAuth();
  const { applyBrandingForMovimento } = useTenantTheme();
  const [movimento, setMovimento] = useState<Movimento | null | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const fetchMovimento = useCallback(async (soft = false) => {
    soft ? setRefreshing(true) : setLoading(true);
    try {
      const data = await api.get<{ movimento: Movimento | null }>('/motorista/movimento-aberto');
      setMovimento(data.movimento);
      // config-ui-tenant: aplicar branding do tomador após carregar o movimento
      // Cache Map<cnpj_tomador, payload> TTL=sessão (dec-031, CHK066).
      // Timeout 3000ms server-side (dec-024, CHK038). Fail-silent: não bloqueia a tela.
      if (data.movimento?.id) {
        applyBrandingForMovimento(
          data.movimento.id,
          data.movimento.cnpjTomador ?? null
        ).catch(() => { /* fail-silent — branding é progressivo */ });
      }
    } catch {
      toast.error('Erro ao carregar movimento. Tente novamente.');
      setMovimento(null);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [applyBrandingForMovimento]);

  useEffect(() => {
    fetchMovimento();
  }, [fetchMovimento]);

  // Regra: nota_ok preenchido (o serviço grava a URL/conteúdo do XML) E
  // erro_validacao vazio = APROVADA. nota_ok preenchido + erro_validacao
  // preenchido = reprovada (cai no bloco de erro). nota_ok vazio = pendente.
  const temNotaOk =
    movimento?.notaOk != null && String(movimento.notaOk).trim() !== '';
  const semErroValidacao =
    !movimento?.erroValidacao || String(movimento.erroValidacao).trim() === '';
  const notaAprovada = temNotaOk && semErroValidacao;

  const nome = user?.nome || formatCNPJ(user?.cnpjPrestador ?? '');
  const valorNum =
    movimento?.valor != null && movimento.valor !== ''
      ? typeof movimento.valor === 'string'
        ? parseFloat(movimento.valor)
        : movimento.valor
      : NaN;

  // gorjetaNum — null quando ausente, zero ou inválido (FR-006 / CL-001 / CL-002)
  const gorjetaNum =
    movimento?.gorjeta != null && movimento.gorjeta !== ''
      ? typeof movimento.gorjeta === 'string'
        ? parseFloat(movimento.gorjeta)
        : movimento.gorjeta
      : null;

  // totalProduzido — valor da nota + gorjeta (gorjeta conta como 0 quando ausente).
  // Exibido quando o valor da nota é numérico válido.
  const totalProduzido =
    (!isNaN(valorNum) ? valorNum : 0) +
    (gorjetaNum != null && !isNaN(gorjetaNum) ? gorjetaNum : 0);

  return (
    <main className="relative flex min-h-dvh flex-col bg-muted/40">
      {/* App bar — glass */}
      <header className="glass sticky top-0 z-20 flex items-center justify-between rounded-none border-x-0 border-t-0 px-4 pb-3 pt-[max(0.85rem,env(safe-area-inset-top))]">
        <Wordmark className="h-7" />
        <div className="flex items-center gap-0.5">
          <ThemeToggle />
          <Button
            variant="ghost"
            size="sm"
            onClick={() => logout()}
            className="gap-1.5 text-muted-foreground"
          >
            <LogOut className="h-4 w-4" />
            Sair
          </Button>
        </div>
      </header>

      <div className="mx-auto w-full max-w-md flex-1 px-4 pb-10 pt-5">
        {/* Saudação com avatar */}
        <div className="animate-fade-up mb-5 flex items-center gap-3">
          <span className="bg-gradient-warm-rich flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl font-display text-base font-bold text-white shadow-[0_8px_18px_-8px_color-mix(in_oklab,var(--warm-3)_70%,transparent)]">
            {initials(nome)}
          </span>
          <div className="min-w-0">
            <p className="text-xs font-medium text-muted-foreground">Bem-vindo de volta</p>
            <p className="truncate font-display text-lg font-bold leading-tight">{nome}</p>
          </div>
        </div>

        {loading ? (
          /* Skeletons no formato do conteúdo real */
          <div className="space-y-4">
            <Skeleton className="h-44 rounded-3xl" />
            <Skeleton className="h-40 rounded-2xl" />
            <Skeleton className="h-12 rounded-xl" />
          </div>
        ) : movimento == null ? (
          /* Estado vazio — FR-004 */
          <div className="animate-fade-up flex flex-col items-center justify-center gap-4 py-16 text-center">
            <div className="animate-float-soft relative flex h-24 w-24 items-center justify-center">
              <span className="absolute inset-0 rounded-[2rem] bg-secondary" />
              <Inbox className="relative h-10 w-10 text-primary" />
            </div>
            <div>
              <p className="font-display text-lg font-bold">Nenhum movimento aberto</p>
              <p className="mx-auto mt-1 max-w-xs text-sm text-muted-foreground">
                Quando houver um movimento em aberto, ele aparecerá aqui automaticamente.
              </p>
            </div>
            <Button variant="outline" onClick={() => fetchMovimento(true)} disabled={refreshing} className="mt-1">
              <RefreshCw className={cn('h-4 w-4', refreshing && 'spinner')} />
              Atualizar
            </Button>
          </div>
        ) : (
          /* Movimento aberto */
          <div className="space-y-4">
            {/* Hero — Valor */}
            <div
              className="bg-gradient-blue shine shine-sweep animate-scale-in relative overflow-hidden rounded-3xl p-6 text-white shadow-[0_24px_50px_-24px_var(--primary)]"
            >
              <Aurora className="opacity-60" />
              <div className="relative">
                <div className="flex items-center justify-between">
                  <p className="inline-flex items-center gap-1.5 rounded-full bg-white/15 px-3 py-1 text-[0.7rem] font-semibold uppercase tracking-wider text-white/90 backdrop-blur-sm">
                    <span className="h-1.5 w-1.5 rounded-full bg-warm-1 pulse-ring" />
                    Movimento aberto
                  </p>
                </div>
                <p className="mt-4 text-xs font-medium uppercase tracking-[0.18em] text-white/75">
                  Valor da nota fiscal
                </p>
                <p className="tabular mt-1.5 text-[2.7rem] font-bold leading-none tracking-tight [text-shadow:0_2px_22px_rgba(0,0,0,0.22)]">
                  {isNaN(valorNum) ? (
                    formatCurrency(movimento.valor)
                  ) : (
                    <CountUp value={valorNum} format={formatCurrency} />
                  )}
                </p>
                <div className="bg-gradient-warm-rich animate-gradient mt-4 h-1.5 w-16 rounded-full" />
                {/* Gorjeta — exibida apenas quando não-nula e não-zero (FR-006 / CL-001) */}
                {gorjetaNum != null && !isNaN(gorjetaNum) && gorjetaNum > 0 && (
                  <div className="mt-3 flex items-baseline justify-between gap-2">
                    <span className="text-xs font-medium uppercase tracking-[0.18em] text-white/75">Gorjeta</span>
                    <span className="tabular font-semibold text-white/90">
                      {formatCurrency(gorjetaNum)}
                    </span>
                  </div>
                )}
                {/* Total produzido = valor da nota + gorjeta */}
                {!isNaN(valorNum) && (
                  <div className="mt-3 flex items-baseline justify-between gap-2 border-t border-white/15 pt-3">
                    <span className="text-xs font-semibold uppercase tracking-[0.18em] text-white/90">
                      Total produzido
                    </span>
                    <span className="tabular text-lg font-bold text-white">
                      {formatCurrency(totalProduzido)}
                    </span>
                  </div>
                )}
                <div className="mt-4 flex flex-wrap items-center gap-2">
                  <span className="inline-flex items-center gap-1.5 rounded-lg bg-white/12 px-2.5 py-1.5 text-xs font-medium text-white/90 backdrop-blur-sm">
                    <Calendar className="h-3.5 w-3.5 opacity-80" />
                    <span className="tabular">{formatDate(movimento.dtInicial)}</span>
                  </span>
                  <span className="flex items-center text-white/50">→</span>
                  <span className="inline-flex items-center gap-1.5 rounded-lg bg-white/12 px-2.5 py-1.5 text-xs font-medium text-white/90 backdrop-blur-sm">
                    <Calendar className="h-3.5 w-3.5 opacity-80" />
                    <span className="tabular">{formatDate(movimento.dtFinal)}</span>
                  </span>
                </div>
              </div>
            </div>

            {/* Dados fiscais — bento grid */}
            <div className="animate-fade-up stagger" style={{ ['--d' as string]: '90ms' }}>
              <h2 className="font-display mb-2.5 flex items-center gap-2 px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <FileText className="h-3.5 w-3.5" />
                Dados Fiscais
              </h2>
              <div className="grid grid-cols-2 gap-3">
                {(movimento.tomador?.razaoSocial || movimento.nome || movimento.cnpjTomador) && (
                  <div className="glass col-span-2 rounded-2xl p-4">
                    <p className="text-[0.7rem] font-semibold uppercase tracking-wide text-muted-foreground">
                      Tomador
                    </p>
                    {(movimento.tomador?.razaoSocial || movimento.nome) && (
                      <p className="font-display mt-1 font-semibold leading-snug">
                        {movimento.tomador?.razaoSocial || movimento.nome}
                      </p>
                    )}
                    {movimento.cnpjTomador && (
                      <div className="mt-0.5 flex items-center justify-between gap-2">
                        <p className="tabular text-sm text-muted-foreground">
                          {formatCNPJ(movimento.cnpjTomador)}
                        </p>
                        <CopyButton value={formatCNPJ(movimento.cnpjTomador)} label="CNPJ copiado" className="-my-2" />
                      </div>
                    )}
                    {(movimento.tomador?.endereco || movimento.tomador?.email) && (
                      <div className="mt-3 space-y-1 border-t border-border/60 pt-3 text-sm text-muted-foreground">
                        {movimento.tomador?.endereco && (
                          <div className="flex items-start justify-between gap-2">
                            <p className="flex items-start gap-2">
                              <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-primary/70" />
                              <span>
                                {movimento.tomador.endereco}
                                {movimento.tomador.numero ? `, ${movimento.tomador.numero}` : ''}
                                {movimento.tomador.cep ? (
                                  <>
                                    {' — CEP '}
                                    <span className="tabular">{movimento.tomador.cep}</span>
                                  </>
                                ) : null}
                              </span>
                            </p>
                            <CopyButton
                              value={`${movimento.tomador.endereco}${movimento.tomador.numero ? `, ${movimento.tomador.numero}` : ''}${movimento.tomador.cep ? ` - CEP ${movimento.tomador.cep}` : ''}`}
                              label="Endereço copiado"
                              className="-my-2"
                            />
                          </div>
                        )}
                        {movimento.tomador?.email && (
                          <div className="flex items-center justify-between gap-2">
                            <p className="flex min-w-0 items-center gap-2">
                              <Mail className="h-4 w-4 shrink-0 text-primary/70" />
                              <span className="break-all">{movimento.tomador.email}</span>
                            </p>
                            <CopyButton value={movimento.tomador.email} label="E-mail copiado" className="-my-2" />
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {movimento.tribnac && (
                  <div className="glass col-span-2 rounded-2xl p-4">
                    <p className="text-[0.7rem] font-semibold uppercase tracking-wide text-muted-foreground">
                      Tributação Nacional
                    </p>
                    <p className="tabular mt-1 text-xl font-semibold">{movimento.tribnac}</p>
                  </div>
                )}

                <div className="glass col-span-2 flex items-center justify-between gap-3 rounded-2xl p-4">
                  <p className="text-[0.7rem] font-semibold uppercase tracking-wide text-muted-foreground">
                    Status da NF
                  </p>
                  <div>
                    {notaAprovada ? (
                      <Badge variant="success">● Aprovada</Badge>
                    ) : (
                      <Badge variant="warning">● Pendente</Badge>
                    )}
                  </div>
                </div>
              </div>
            </div>

            {/* Observação de emissão da NFS-e — orienta o motorista (código de serviço etc.) */}
            {movimento.tomador?.observacao && (
              <div className="animate-fade-up stagger rounded-2xl border border-primary/25 bg-primary/5 p-4" style={{ ['--d' as string]: '120ms' }}>
                <p className="font-display flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-primary">
                  <Info className="h-4 w-4" />
                  Como emitir sua NFS-e
                </p>
                <p className="mt-2 whitespace-pre-line text-sm leading-relaxed text-foreground/80">
                  {movimento.tomador.observacao}
                </p>
              </div>
            )}

            {/* Status detalhado */}
            {notaAprovada ? (
              <div className="animate-fade-up stagger flex items-center gap-3 rounded-2xl border border-success/30 bg-success/10 p-4" style={{ ['--d' as string]: '150ms' }}>
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-success text-white shadow-[0_6px_16px_-6px_var(--success)]">
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                    <path strokeLinecap="round" strokeLinejoin="round" strokeDasharray="24" strokeDashoffset="24" style={{ animation: 'mv-draw 0.5s ease 0.2s forwards' }} d="M5 13l4 4L19 7" />
                  </svg>
                </span>
                <p className="text-sm font-medium text-success">Nota aprovada. Reenvio bloqueado.</p>
              </div>
            ) : movimento.erroValidacao ? (
              <div className="animate-fade-up stagger rounded-2xl border border-warm-2/30 bg-warm-2/10 p-4" style={{ ['--d' as string]: '150ms' }}>
                <p className="font-display flex items-center gap-2 text-sm font-semibold text-warm-3">
                  <AlertTriangle className="h-4 w-4" />
                  Última validação: campos reprovados
                </p>
                <ul className="mt-2 space-y-1.5">
                  {movimento.erroValidacao
                    .split(',')
                    .map((c) => c.trim())
                    .filter(Boolean)
                    .map((campo) => (
                      <li key={campo} className="flex items-start gap-2 text-xs text-warm-3/90">
                        <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-warm-3/70" />
                        {VALIDACAO_MENSAGENS[campo] || 'Campo inválido na nota.'}
                      </li>
                    ))}
                </ul>
              </div>
            ) : null}

            {/* Ações */}
            <div className="animate-fade-up stagger space-y-2.5 pt-1" style={{ ['--d' as string]: '210ms' }}>
              {!notaAprovada && (
                <div className="glow-warm relative">
                  <Link href="/validar" className={cn(buttonVariants({ variant: 'warm', size: 'lg' }), 'relative z-10 w-full')}>
                    <FileText className="h-5 w-5" />
                    Validar minha NFS-e
                  </Link>
                </div>
              )}

              <a
                href="https://www.nfse.gov.br"
                target="_blank"
                rel="noopener noreferrer"
                className={cn(buttonVariants({ variant: 'outline', size: 'lg' }), 'w-full')}
              >
                Portal NFS-e Nacional
                <ArrowUpRight className="h-4 w-4" />
              </a>

              <Button variant="ghost" onClick={() => fetchMovimento(true)} disabled={refreshing} className="w-full">
                <RefreshCw className={cn('h-4 w-4', refreshing && 'spinner')} />
                {refreshing ? 'Atualizando…' : 'Atualizar'}
              </Button>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}

'use client';

/**
 * Tela do Movimento Aberto.
 * Exibe valor, período, dados fiscais e links para validação e portal.
 * Ref: tarefa 5.2 / spec US2/US4 / contracts §movimento-aberto / quickstart 3, 4, 10
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useAuth } from '@/contexts/auth-context';
import { api } from '@/lib/api-client';
import { formatCurrency, formatDate, formatCNPJ } from '@/lib/utils';
import { toast } from 'sonner';

interface Movimento {
  id: number;
  valor: string | number | null;
  dtInicial: string | null;
  dtFinal: string | null;
  nome: string | null;
  cnpjTomador: string | null;
  cnpjPrestador: string;
  tribnac: string | null;
  notaOk: string | boolean | null;
  erroValidacao: string | null;
}

export default function MovimentoPage() {
  const { user, logout } = useAuth();
  const [movimento, setMovimento] = useState<Movimento | null | undefined>(undefined); // undefined = carregando
  const [loading, setLoading] = useState(true);

  const fetchMovimento = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.get<{ movimento: Movimento | null }>('/motorista/movimento-aberto');
      setMovimento(data.movimento);
    } catch {
      toast.error('Erro ao carregar movimento. Tente novamente.');
      setMovimento(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchMovimento(); }, [fetchMovimento]);

  const notaAprovada =
    movimento?.notaOk === true ||
    movimento?.notaOk === 'true' ||
    movimento?.notaOk === 'sim' ||
    movimento?.notaOk === '1';

  return (
    <main className="flex min-h-dvh flex-col px-4 py-6">
      {/* Header */}
      <header className="mb-6 flex items-center justify-between">
        <div>
          <p className="text-xs text-muted-foreground">Bem-vindo,</p>
          <p className="font-semibold">{user?.nome || formatCNPJ(user?.cnpjPrestador ?? '')}</p>
        </div>
        <button
          onClick={() => logout()}
          className="rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:bg-muted"
        >
          Sair
        </button>
      </header>

      {/* Conteúdo */}
      {loading ? (
        <div className="flex flex-1 items-center justify-center">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
        </div>
      ) : movimento === null ? (
        /* Estado vazio — FR-004 */
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
          <div className="rounded-full bg-muted p-4">
            <svg className="h-8 w-8 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
          </div>
          <p className="font-medium">Nenhum movimento aberto</p>
          <p className="text-sm text-muted-foreground">
            Quando houver um movimento em aberto, ele aparecerá aqui.
          </p>
          <button
            onClick={fetchMovimento}
            className="mt-2 rounded-md border border-input px-4 py-2 text-sm hover:bg-muted"
          >
            Atualizar
          </button>
        </div>
      ) : movimento != null ? (
        /* Movimento aberto */
        <div className="space-y-4">
          {/* Card principal — Valor */}
          <div className="rounded-xl border bg-card p-5 shadow-sm">
            <p className="text-sm text-muted-foreground">Valor do Movimento</p>
            <p className="mt-1 text-3xl font-bold tracking-tight">
              {formatCurrency(movimento.valor)}
            </p>
            <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
              <span>De: {formatDate(movimento.dtInicial)}</span>
              <span>Até: {formatDate(movimento.dtFinal)}</span>
            </div>
          </div>

          {/* Dados fiscais */}
          <div className="rounded-xl border bg-card p-5 shadow-sm">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Dados Fiscais
            </h2>
            <dl className="space-y-2 text-sm">
              {movimento.nome && (
                <div className="flex justify-between gap-2">
                  <dt className="text-muted-foreground">Nome</dt>
                  <dd className="font-medium text-right">{movimento.nome}</dd>
                </div>
              )}
              {movimento.cnpjTomador && (
                <div className="flex justify-between gap-2">
                  <dt className="text-muted-foreground">CNPJ Tomador</dt>
                  <dd className="font-mono font-medium">{formatCNPJ(movimento.cnpjTomador)}</dd>
                </div>
              )}
              {movimento.tribnac && (
                <div className="flex justify-between gap-2">
                  <dt className="text-muted-foreground">TribNac</dt>
                  <dd className="font-medium">{movimento.tribnac}</dd>
                </div>
              )}
            </dl>
          </div>

          {/* Status da nota */}
          {notaAprovada ? (
            <div className="rounded-xl border border-green-200 bg-green-50 p-4">
              <div className="flex items-center gap-2">
                <svg className="h-5 w-5 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
                <p className="text-sm font-medium text-green-800">Nota aprovada. Reenvio bloqueado.</p>
              </div>
            </div>
          ) : movimento.erroValidacao ? (
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
              <p className="text-sm font-medium text-amber-800">Última validação: campos reprovados</p>
              <p className="mt-1 text-xs text-amber-700">{movimento.erroValidacao}</p>
            </div>
          ) : null}

          {/* Ações */}
          <div className="space-y-2 pt-2">
            {!notaAprovada && (
              <Link
                href="/validar"
                className="block w-full rounded-md bg-primary px-4 py-3 text-center text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
              >
                Enviar XML para Validação
              </Link>
            )}

            {/* US4 — Atalho para portal NFS-e Nacional */}
            <a
              href="https://www.nfse.gov.br"
              target="_blank"
              rel="noopener noreferrer"
              className="block w-full rounded-md border border-input px-4 py-3 text-center text-sm font-medium transition-colors hover:bg-muted"
            >
              Portal NFS-e Nacional →
            </a>

            <button
              onClick={fetchMovimento}
              className="block w-full rounded-md px-4 py-2 text-sm text-muted-foreground hover:bg-muted"
            >
              Atualizar
            </button>
          </div>
        </div>
      ) : null}
    </main>
  );
}

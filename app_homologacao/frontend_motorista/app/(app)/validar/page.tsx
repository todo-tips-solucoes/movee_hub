'use client';

/**
 * Tela de Upload e Validação de XML da NFS-e.
 * Ref: tarefa 5.3 / spec US3 / contracts §validar-nota / quickstart 5-8
 */

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { api } from '@/lib/api-client';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { ThemeToggle } from '@/components/theme-toggle';

interface CampoInvalido {
  campo: string;
  mensagem: string;
}

interface ValidacaoResult {
  valid: boolean;
  notaOk: boolean;
  mensagem?: string;
  camposInvalidos?: CampoInvalido[];
  instrucao?: string;
}

export default function ValidarPage() {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ValidacaoResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const selected = e.target.files?.[0] ?? null;
    setFile(selected);
    setResult(null);
    setError(null);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!file) {
      setError('Selecione um arquivo XML.');
      return;
    }
    setError(null);
    setLoading(true);
    try {
      const data = await api.uploadFile<ValidacaoResult>('/motorista/validar-nota', file);
      setResult(data);
      if (data.valid) {
        toast.success('Nota validada com sucesso!');
      } else {
        toast.warning('Nota inválida. Verifique os campos abaixo.');
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '';
      if (msg.includes('409') || msg.includes('movimento em aberto')) {
        setError('Nenhum movimento em aberto para validar.');
      } else if (msg.includes('bloqueado') || msg.includes('já aprovada')) {
        setError('Nota já aprovada. Reenvio bloqueado.');
        toast.info('Nota já aprovada. Nenhuma ação necessária.');
        setTimeout(() => router.replace('/movimento'), 2000);
      } else if (msg.includes('400') || msg.includes('inválido')) {
        setError('Arquivo inválido. Envie um XML de NFS-e válido.');
      } else if (msg.includes('502') || msg.includes('503') || msg.includes('indisponível')) {
        setError('Serviço de validação indisponível. Tente novamente em instantes.');
      } else {
        setError('Erro ao validar. Tente novamente.');
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="flex min-h-dvh flex-col bg-muted/40">
      {/* App bar */}
      <header className="sticky top-0 z-10 flex items-center justify-between bg-primary px-3 pb-3.5 pt-[max(0.875rem,env(safe-area-inset-top))] text-primary-foreground shadow-sm">
        <div className="flex items-center gap-1">
          <Link
            href="/movimento"
            aria-label="Voltar"
            className="inline-flex h-9 w-9 items-center justify-center rounded-full hover:bg-white/15"
          >
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
            </svg>
          </Link>
          <h1 className="font-display text-base font-semibold">Validar NFS-e</h1>
        </div>
        <ThemeToggle />
      </header>

      <div className="flex-1 px-4 py-5">
        <h2 className="font-display text-lg font-bold">Envie sua nota</h2>
        <p className="mb-4 mt-0.5 text-sm text-muted-foreground">
          Anexe o XML da NFS-e para validação.
        </p>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Dropzone */}
          <div
            role="button"
            tabIndex={0}
            onClick={() => fileInputRef.current?.click()}
            onKeyDown={(e) => e.key === 'Enter' && fileInputRef.current?.click()}
            className="flex cursor-pointer flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed border-input bg-card p-8 text-center transition-colors hover:border-primary hover:bg-secondary/40"
          >
            <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-secondary text-primary">
              <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 13h6m-3-3v6m5 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
            </span>
            {file ? (
              <div>
                <p className="font-display font-semibold text-foreground">{file.name}</p>
                <p className="text-sm text-muted-foreground">{(file.size / 1024).toFixed(1)} KB</p>
              </div>
            ) : (
              <div>
                <p className="font-display font-semibold">Toque para escolher o XML</p>
                <p className="text-sm text-muted-foreground">somente arquivos .xml</p>
              </div>
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept=".xml,text/xml,application/xml"
              onChange={handleFileChange}
              className="hidden"
            />
          </div>

          {error && (
            <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm font-medium text-destructive">
              {error}
            </p>
          )}

          <Button type="submit" size="lg" disabled={loading || !file} className="w-full">
            {loading ? 'Validando...' : 'Enviar para validação'}
          </Button>
        </form>

        {/* Resultado */}
        {result && result.valid && (
          <div className="mt-6 rounded-2xl border border-success/30 bg-success/10 p-5">
            <div className="flex items-start gap-3">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-success text-white">
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              </span>
              <div>
                <p className="font-display font-bold text-success">{result.mensagem || 'Nota aprovada!'}</p>
                <p className="mt-1 text-sm text-success/90">Reenvio bloqueado.</p>
                <Button
                  variant="link"
                  onClick={() => router.replace('/movimento')}
                  className="mt-2 h-auto p-0 text-success underline"
                >
                  Voltar ao movimento
                </Button>
              </div>
            </div>
          </div>
        )}

        {result && !result.valid && (
          <div className="mt-6 rounded-2xl border border-destructive/30 bg-destructive/10 p-5">
            <p className="font-display font-bold text-destructive">Nota inválida</p>
            {result.camposInvalidos && result.camposInvalidos.length > 0 && (
              <ul className="mt-2 space-y-1.5">
                {result.camposInvalidos.map((c) => (
                  <li key={c.campo} className="flex items-start gap-2 text-sm text-destructive">
                    <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-destructive" />
                    {c.mensagem}
                  </li>
                ))}
              </ul>
            )}
            {result.instrucao && (
              <p className="mt-3 text-sm font-medium text-destructive">{result.instrucao}</p>
            )}
          </div>
        )}
      </div>
    </main>
  );
}

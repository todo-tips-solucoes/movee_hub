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
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { ThemeToggle } from '@/components/theme-toggle';
import { ArrowLeft, UploadCloud, CheckCircle, AlertCircle } from '@/components/ui/icons';

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
  const [dragging, setDragging] = useState(false);

  function pickFile(selected: File | null) {
    setFile(selected);
    setResult(null);
    setError(null);
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    pickFile(e.target.files?.[0] ?? null);
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragging(false);
    const dropped = e.dataTransfer.files?.[0];
    if (dropped) pickFile(dropped);
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
    <main className="relative flex min-h-dvh flex-col bg-muted/40">
      {/* App bar — glass */}
      <header className="glass sticky top-0 z-20 flex items-center justify-between rounded-none border-x-0 border-t-0 px-3 pb-3 pt-[max(0.85rem,env(safe-area-inset-top))]">
        <div className="flex items-center gap-1">
          <Link
            href="/movimento"
            aria-label="Voltar"
            className="inline-flex h-9 w-9 items-center justify-center rounded-full text-foreground transition-colors hover:bg-muted active:scale-90"
          >
            <ArrowLeft className="h-5 w-5" />
          </Link>
          <h1 className="font-display text-base font-semibold">Validar NFS-e</h1>
        </div>
        <ThemeToggle />
      </header>

      <div className="mx-auto w-full max-w-md flex-1 px-4 pb-10 pt-6">
        <div className="animate-fade-up">
          <h2 className="font-display text-2xl font-bold tracking-tight">Envie sua nota</h2>
          <p className="mb-5 mt-1 text-sm text-muted-foreground">
            Anexe o XML da NFS-e para validação automática.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="animate-fade-up stagger space-y-4" style={{ ['--d' as string]: '80ms' }}>
          {/* Dropzone */}
          <div
            role="button"
            tabIndex={0}
            onClick={() => fileInputRef.current?.click()}
            onKeyDown={(e) => e.key === 'Enter' && fileInputRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={handleDrop}
            className={cn(
              'group relative flex cursor-pointer flex-col items-center justify-center gap-3 overflow-hidden rounded-3xl border-2 border-dashed p-9 text-center transition-all duration-300',
              dragging
                ? 'scale-[1.02] border-primary bg-secondary/60 shadow-[0_0_0_6px_color-mix(in_oklab,var(--primary)_12%,transparent)]'
                : file
                  ? 'border-success/50 bg-success/5'
                  : 'border-input bg-card/60 hover:border-primary/60 hover:bg-secondary/40'
            )}
          >
            <span
              className={cn(
                'flex h-16 w-16 items-center justify-center rounded-2xl transition-all duration-300',
                file ? 'bg-success/15 text-success' : 'bg-secondary text-primary group-hover:scale-110'
              )}
            >
              {file ? (
                <CheckCircle className="h-7 w-7" />
              ) : (
                <UploadCloud className={cn('h-7 w-7 transition-transform', dragging && 'animate-float-soft')} />
              )}
            </span>
            {file ? (
              <div>
                <p className="font-display font-semibold text-foreground">{file.name}</p>
                <p className="text-sm text-muted-foreground">
                  <span className="tabular">{(file.size / 1024).toFixed(1)} KB</span> · toque para trocar
                </p>
              </div>
            ) : (
              <div>
                <p className="font-display font-semibold">
                  {dragging ? 'Solte o arquivo aqui' : 'Toque ou arraste o XML'}
                </p>
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
            <p className="animate-shake flex items-center gap-2 rounded-xl bg-destructive/10 px-3.5 py-2.5 text-sm font-medium text-destructive">
              <AlertCircle className="h-4 w-4 shrink-0" />
              {error}
            </p>
          )}

          <Button type="submit" variant="warm" size="lg" disabled={loading || !file} className="w-full">
            {loading ? (
              <>
                <span className="spinner h-4 w-4 rounded-full border-2 border-white/40 border-t-white" />
                Validando…
              </>
            ) : (
              'Enviar para validação'
            )}
          </Button>
        </form>

        {/* Resultado — aprovada */}
        {result && result.valid && (
          <div className="animate-scale-in mt-6 overflow-hidden rounded-3xl border border-success/30 bg-success/10 p-6 text-center">
            <span className="mx-auto mb-3 flex h-16 w-16 items-center justify-center rounded-full bg-success text-white shadow-[0_10px_24px_-8px_var(--success)]">
              <svg className="h-8 w-8" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" strokeDasharray="24" strokeDashoffset="24" style={{ animation: 'mv-draw 0.55s cubic-bezier(0.65,0,0.45,1) 0.15s forwards' }} d="M5 13l4 4L19 7" />
              </svg>
            </span>
            <p className="font-display text-lg font-bold text-success">{result.mensagem || 'Nota aprovada!'}</p>
            <p className="mt-1 text-sm text-success/90">Reenvio bloqueado.</p>
            <Button
              variant="success"
              size="lg"
              onClick={() => router.replace('/movimento')}
              className="mt-4 w-full"
            >
              Voltar ao movimento
            </Button>
          </div>
        )}

        {/* Resultado — inválida */}
        {result && !result.valid && (
          <div className="animate-fade-up mt-6 rounded-3xl border border-destructive/30 bg-destructive/10 p-5">
            <p className="font-display flex items-center gap-2 text-base font-bold text-destructive">
              <AlertCircle className="h-5 w-5" />
              Nota inválida
            </p>
            {result.camposInvalidos && result.camposInvalidos.length > 0 && (
              <ul className="mt-3 space-y-2">
                {result.camposInvalidos.map((c) => (
                  <li key={c.campo} className="flex items-start gap-2.5 text-sm text-destructive">
                    <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-destructive" />
                    {c.mensagem}
                  </li>
                ))}
              </ul>
            )}
            {result.instrucao && (
              <p className="mt-3 rounded-xl bg-destructive/10 px-3 py-2 text-sm font-medium text-destructive">
                {result.instrucao}
              </p>
            )}
          </div>
        )}
      </div>
    </main>
  );
}

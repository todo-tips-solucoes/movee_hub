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
    <main className="flex min-h-dvh flex-col px-4 py-6">
      {/* Header */}
      <header className="mb-6 flex items-center gap-3">
        <Link href="/movimento" className="rounded-md p-1 hover:bg-muted">
          <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </Link>
        <h1 className="text-lg font-semibold">Validar XML</h1>
      </header>

      <form onSubmit={handleSubmit} className="space-y-4">
        {/* Área de upload */}
        <div
          role="button"
          tabIndex={0}
          onClick={() => fileInputRef.current?.click()}
          onKeyDown={(e) => e.key === 'Enter' && fileInputRef.current?.click()}
          className="flex cursor-pointer flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed border-input p-8 text-center transition-colors hover:border-primary hover:bg-muted/30"
        >
          <svg className="h-10 w-10 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 13h6m-3-3v6m5 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
          {file ? (
            <div>
              <p className="font-medium text-foreground">{file.name}</p>
              <p className="text-sm text-muted-foreground">
                {(file.size / 1024).toFixed(1)} KB
              </p>
            </div>
          ) : (
            <div>
              <p className="font-medium">Toque para selecionar o XML</p>
              <p className="text-sm text-muted-foreground">Arquivo XML da NFS-e</p>
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
          <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={loading || !file}
          className="w-full rounded-md bg-primary px-4 py-3 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {loading ? 'Validando...' : 'Enviar para Validação'}
        </button>
      </form>

      {/* Resultado */}
      {result && (
        <div className={`mt-6 rounded-xl border p-5 ${result.valid
          ? 'border-green-200 bg-green-50'
          : 'border-red-200 bg-red-50'}`}>
          {result.valid ? (
            <div className="flex items-start gap-3">
              <svg className="mt-0.5 h-5 w-5 flex-shrink-0 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
              <div>
                <p className="font-semibold text-green-800">{result.mensagem}</p>
                <button
                  onClick={() => router.replace('/movimento')}
                  className="mt-3 text-sm font-medium text-green-700 underline"
                >
                  Voltar ao movimento
                </button>
              </div>
            </div>
          ) : (
            <div>
              <p className="font-semibold text-red-800">Nota inválida</p>
              {result.camposInvalidos && result.camposInvalidos.length > 0 && (
                <ul className="mt-2 space-y-1">
                  {result.camposInvalidos.map((c) => (
                    <li key={c.campo} className="flex items-start gap-1.5 text-sm text-red-700">
                      <span className="mt-0.5 text-red-500">•</span>
                      {c.mensagem}
                    </li>
                  ))}
                </ul>
              )}
              {result.instrucao && (
                <p className="mt-3 text-sm font-medium text-red-800">{result.instrucao}</p>
              )}
            </div>
          )}
        </div>
      )}
    </main>
  );
}

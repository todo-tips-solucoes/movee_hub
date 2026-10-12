'use client';

/**
 * Envio do XML de UMA nota pendente (tela /notas-pendentes).
 *
 * ⚠️ DUPLICA DE PROPÓSITO a lógica de upload inline de app/(app)/validar/page.tsx
 * (escolher .xml, limite de 2 MB, enviar, exibir resultado). A tela /validar não
 * pode ser alterada enquanto os motoristas validam por ela. A unificação das duas
 * vias está prevista no BRIEFING (docs/plans/nota-pendente-motorista/BRIEFING.md,
 * decisão B.1), com critério de saída escrito: só quando o operador validar a via
 * nova e houver envios reais bem-sucedidos por ela em produção.
 *
 * O resultado aparece NA linha (role="status"/"alert"), não em toast global.
 */

import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { AlertCircle, CheckCircle, UploadCloud } from '@/components/ui/icons';
import {
  ariaLabelEnvio,
  enviarNotaPendente,
  mensagemErroEnvio,
  motivosReprovacao,
  type NotaPendente,
} from '@/lib/notas-pendentes-api';

// Limite alinhado ao backend (multer: 2 MB), igual à /validar.
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;

type Estado =
  | { fase: 'inicial' }
  | { fase: 'enviando' }
  | { fase: 'enviado'; mensagem: string }
  | { fase: 'recusado'; motivos: string[] };

export function EnviarNotaPendente({ nota }: { nota: NotaPendente }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [arquivo, setArquivo] = useState<File | null>(null);
  const [estado, setEstado] = useState<Estado>({ fase: 'inicial' });
  const rotulo = ariaLabelEnvio(nota);

  function escolher(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0] ?? null;
    e.target.value = ''; // permite escolher o mesmo arquivo de novo após corrigir a nota
    if (!f) return;
    if (!/\.xml$/i.test(f.name) && f.type !== 'text/xml' && f.type !== 'application/xml') {
      setArquivo(null);
      setEstado({ fase: 'recusado', motivos: ['Arquivo inválido: envie o arquivo .xml da NFS-e.'] });
    } else if (f.size > MAX_UPLOAD_BYTES) {
      setArquivo(null);
      setEstado({ fase: 'recusado', motivos: ['Arquivo muito grande. O limite é 2 MB.'] });
    } else {
      setArquivo(f);
      setEstado({ fase: 'inicial' });
    }
  }

  async function enviar() {
    if (!arquivo) return;
    setEstado({ fase: 'enviando' });
    try {
      const r = await enviarNotaPendente(nota.id, arquivo);
      if (r.valid) {
        setEstado({ fase: 'enviado', mensagem: r.mensagem || 'Nota ok! Validação aprovada.' });
      } else {
        setEstado({ fase: 'recusado', motivos: motivosReprovacao(r) });
        setArquivo(null);
      }
    } catch (err: unknown) {
      setEstado({ fase: 'recusado', motivos: [mensagemErroEnvio(err)] });
    }
  }

  if (estado.fase === 'enviado') {
    return (
      <p
        role="status"
        className="flex items-center gap-2 rounded-xl bg-success/10 px-3.5 py-2.5 text-sm font-medium text-success"
      >
        <CheckCircle className="h-4 w-4 shrink-0" />
        {estado.mensagem}
      </p>
    );
  }

  const enviando = estado.fase === 'enviando';

  return (
    <div className="space-y-2.5">
      <input
        ref={inputRef}
        type="file"
        accept=".xml,text/xml,application/xml"
        aria-label={rotulo}
        onChange={escolher}
        className="hidden"
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          onClick={() => inputRef.current?.click()}
          disabled={enviando}
          className="min-h-11"
        >
          <UploadCloud className="h-4 w-4" />
          {arquivo ? 'Trocar XML' : 'Escolher XML'}
        </Button>
        {arquivo && (
          <Button type="button" variant="warm" onClick={enviar} disabled={enviando} className="min-h-11">
            {enviando ? (
              <>
                <span className="spinner h-4 w-4 rounded-full border-2 border-white/40 border-t-white" />
                Enviando…
              </>
            ) : (
              'Enviar nota'
            )}
          </Button>
        )}
      </div>
      {arquivo && !enviando && (
        <p className="truncate text-xs text-muted-foreground">{arquivo.name}</p>
      )}
      {estado.fase === 'recusado' && (
        <div role="alert" className="rounded-xl bg-destructive/10 px-3.5 py-2.5 text-sm font-medium text-destructive">
          <p className="flex items-center gap-2">
            <AlertCircle className="h-4 w-4 shrink-0" />
            Nota não aceita
          </p>
          <ul className="mt-1.5 space-y-1">
            {estado.motivos.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

'use client';

// hub-importacoes (S4) FASE 6 task 6.3 — `ImportWizard`: seleção de tipo
// (faturamento|performance) + upload de arquivo (drag/drop + seleção via
// clique) com validação client-side ESPELHANDO 3.1.1-3.1.3 do backend
// (extensão/tamanho, feedback imediato antes do POST) e tratamento
// específico de `409` (duplicado — link para a importação original) e
// `422` (inválido — `motivo` legível).
//
// Ref: docs/specs/hub-importacoes/contracts/importacoes-api.md
// §POST /importacoes, tasks.md 6.3.

import { useCallback, useId, useRef, useState } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import { AlertCircle, FileWarning, Loader2, UploadCloud } from 'lucide-react';
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
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { enviarImportacao, ImportacaoApiError } from '@/lib/hub/importacoes-api';
import {
  TIPOS_IMPORTACAO,
  TIPO_LABELS,
  validarArquivoImportacao,
  type TipoImportacao,
} from '@/lib/hub/importacoes-dto';

const MENSAGENS_VALIDACAO_CLIENT: Record<string, string> = {
  extensao_invalida: 'Extensão não suportada. Envie um arquivo .csv ou .zip.',
  tamanho_excedido: 'O arquivo excede o tamanho máximo de 20 MB.',
  arquivo_vazio: 'O arquivo está vazio.',
};

/** Lógica isolada do JSX (mesmo padrão de `usePerfil`/`useEntitySwitcher`) —
 * testável sem depender da interação real com o Dialog (Base UI, portal). */
export function useImportWizard(onEnviado?: (id: number) => void) {
  const [open, setOpenState] = useState(false);
  const [tipo, setTipo] = useState<TipoImportacao>('faturamento');
  const [arquivo, setArquivo] = useState<File | null>(null);
  const [erroValidacao, setErroValidacao] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);
  const [erroEnvio, setErroEnvio] = useState<string | null>(null);
  const [conflito, setConflito] = useState<{ importacaoOriginalId: number } | null>(null);

  const reset = useCallback(() => {
    setTipo('faturamento');
    setArquivo(null);
    setErroValidacao(null);
    setEnviando(false);
    setErroEnvio(null);
    setConflito(null);
  }, []);

  const setOpen = useCallback(
    (next: boolean) => {
      setOpenState(next);
      if (!next) reset();
    },
    [reset]
  );

  // uiux-hub F3: pedido de fechamento vindo da UI (Escape/click-fora/botão
  // Cancelar). Com arquivo selecionado, fechar descartaria a seleção em
  // silêncio — pede confirmação. Sem arquivo (ou durante o envio, que já
  // desabilita os botões), fecha direto. O fluxo de sucesso usa `setOpen`
  // diretamente e nunca passa por aqui.
  const [confirmandoDescarte, setConfirmandoDescarte] = useState(false);
  const solicitarFechamento = useCallback(
    (next: boolean) => {
      if (!next && arquivo && !enviando) {
        setConfirmandoDescarte(true);
        return;
      }
      setOpen(next);
    },
    [arquivo, enviando, setOpen]
  );
  const confirmarDescarte = useCallback(() => {
    setConfirmandoDescarte(false);
    setOpen(false);
  }, [setOpen]);
  const manterEdicao = useCallback(() => setConfirmandoDescarte(false), []);

  const selecionarArquivo = useCallback((file: File | null) => {
    setErroEnvio(null);
    setConflito(null);
    if (!file) {
      setArquivo(null);
      setErroValidacao(null);
      return;
    }
    const resultado = validarArquivoImportacao(file);
    if (!resultado.valido) {
      setArquivo(null);
      setErroValidacao(MENSAGENS_VALIDACAO_CLIENT[resultado.motivo] || 'Arquivo inválido.');
      return;
    }
    setArquivo(file);
    setErroValidacao(null);
  }, []);

  const enviar = useCallback(async () => {
    if (!arquivo) return;
    setEnviando(true);
    setErroEnvio(null);
    setConflito(null);
    try {
      const resultado = await enviarImportacao(tipo, arquivo);
      onEnviado?.(resultado.id);
      setOpen(false);
      toast.success('Importação enviada — o processamento começa em instantes.');
    } catch (e) {
      if (e instanceof ImportacaoApiError && e.importacaoOriginalId !== undefined) {
        setConflito({ importacaoOriginalId: e.importacaoOriginalId });
      } else if (e instanceof ImportacaoApiError) {
        setErroEnvio(e.message);
      } else {
        setErroEnvio('Falha ao enviar o arquivo. Tente novamente.');
      }
    } finally {
      setEnviando(false);
    }
  }, [arquivo, tipo, onEnviado, setOpen]);

  return {
    open,
    setOpen,
    tipo,
    setTipo,
    arquivo,
    erroValidacao,
    selecionarArquivo,
    enviando,
    erroEnvio,
    conflito,
    enviar,
    reset,
    confirmandoDescarte,
    solicitarFechamento,
    confirmarDescarte,
    manterEdicao,
  };
}

export interface ImportWizardProps {
  onEnviado?: (id: number) => void;
  /** Gate de permissão (`importacoes.criar`) — resolvido pela página-mãe;
   * o componente não sabe de RBAC, só não renderiza nada sem permissão. */
  podeCriar?: boolean;
  /** Estado externo (mesmo idioma de `VinculoMotoristaDialog`): a página
   * cria o hook e pode abrir o wizard de outros pontos (ex.: ação do empty
   * state — uiux-hub F2). Sem `state`, o componente se auto-gerencia. */
  state?: ReturnType<typeof useImportWizard>;
}

export function ImportWizard({ onEnviado, podeCriar = true, state }: ImportWizardProps) {
  const interno = useImportWizard(onEnviado);
  const w = state ?? interno;
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [arrastando, setArrastando] = useState(false);

  if (!podeCriar) return null;

  return (
    <Dialog open={w.open} onOpenChange={w.solicitarFechamento}>
      <DialogTrigger render={<Button className="min-h-11 gap-1.5 sm:min-h-8" />}>
        <UploadCloud className="size-4" aria-hidden="true" />
        Nova importação
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Nova importação</DialogTitle>
          <DialogDescription>
            Envie um arquivo CSV ou ZIP de faturamento ou performance (até 20 MB).
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <label htmlFor={`${inputId}-tipo`} className="text-sm font-medium">
              Tipo
            </label>
            <select
              id={`${inputId}-tipo`}
              value={w.tipo}
              onChange={(e) => w.setTipo(e.target.value as TipoImportacao)}
              disabled={w.enviando}
              className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm sm:h-9"
            >
              {TIPOS_IMPORTACAO.map((t) => (
                <option key={t} value={t}>
                  {TIPO_LABELS[t]}
                </option>
              ))}
            </select>
          </div>

          <div
            role="button"
            tabIndex={0}
            aria-label="Selecionar ou arrastar arquivo para importar"
            onDragOver={(e) => {
              e.preventDefault();
              setArrastando(true);
            }}
            onDragLeave={() => setArrastando(false)}
            onDrop={(e) => {
              e.preventDefault();
              setArrastando(false);
              const file = e.dataTransfer.files?.[0] ?? null;
              w.selecionarArquivo(file);
            }}
            onClick={() => inputRef.current?.click()}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                inputRef.current?.click();
              }
            }}
            className={cn(
              'flex cursor-pointer flex-col items-center gap-2 rounded-lg border-2 border-dashed p-6 text-center transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              arrastando ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/50'
            )}
          >
            <UploadCloud className="size-8 text-muted-foreground" aria-hidden="true" />
            <p className="text-sm text-muted-foreground">
              {w.arquivo ? (
                <span className="font-medium text-foreground">{w.arquivo.name}</span>
              ) : (
                'Arraste um arquivo aqui ou clique para selecionar (.csv, .zip)'
              )}
            </p>
            <input
              ref={inputRef}
              aria-label="Arquivo de importação"
              type="file"
              accept=".csv,.zip"
              className="sr-only"
              disabled={w.enviando}
              onChange={(e) => w.selecionarArquivo(e.target.files?.[0] ?? null)}
            />
          </div>

          {w.erroValidacao && (
            <p
              role="alert"
              className="flex items-center gap-2 rounded-md bg-destructive/10 px-3 py-2 text-sm font-medium text-destructive"
            >
              <AlertCircle className="size-4 shrink-0" aria-hidden="true" />
              {w.erroValidacao}
            </p>
          )}

          {w.conflito && (
            <p
              role="alert"
              className="flex flex-wrap items-center gap-1.5 rounded-md bg-destructive/10 px-3 py-2 text-sm font-medium text-destructive"
            >
              <FileWarning className="size-4 shrink-0" aria-hidden="true" />
              Este arquivo já foi importado anteriormente.
              <Link
                href={`/hub/dashboard/importacoes/${w.conflito.importacaoOriginalId}`}
                className="underline underline-offset-2"
              >
                Ver importação original
              </Link>
            </p>
          )}

          {w.erroEnvio && !w.conflito && (
            <p
              role="alert"
              className="flex items-center gap-2 rounded-md bg-destructive/10 px-3 py-2 text-sm font-medium text-destructive"
            >
              <AlertCircle className="size-4 shrink-0" aria-hidden="true" />
              {w.erroEnvio}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            className="min-h-11 sm:min-h-8"
            disabled={w.enviando}
            onClick={() => w.solicitarFechamento(false)}
          >
            Cancelar
          </Button>
          <Button className="min-h-11 sm:min-h-8" disabled={!w.arquivo || w.enviando} onClick={w.enviar}>
            {w.enviando ? (
              <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden="true" />
            ) : (
              <UploadCloud className="size-4" aria-hidden="true" />
            )}
            Enviar
          </Button>
        </DialogFooter>
      </DialogContent>

      <AlertDialog open={w.confirmandoDescarte} onOpenChange={(v) => !v && w.manterEdicao()}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Descartar arquivo selecionado?</AlertDialogTitle>
            <AlertDialogDescription>
              Você selecionou {w.arquivo?.name ?? 'um arquivo'} mas ainda não enviou. Fechar agora
              descarta a seleção.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={w.manterEdicao}>Continuar editando</AlertDialogCancel>
            <AlertDialogAction onClick={w.confirmarDescarte}>Descartar</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  );
}

export default ImportWizard;

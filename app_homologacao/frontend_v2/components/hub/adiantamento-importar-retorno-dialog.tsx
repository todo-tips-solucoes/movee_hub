'use client';

// adiantamento-motorista — components/hub/adiantamento-importar-retorno-dialog.tsx
// (FASE 9, Q-B1): importa o CSV de retorno da Transfeera e concilia o lote de
// uma vez, em lugar de marcar falha por falha no diálogo manual.
//
// O backend já fazia tudo isso desde 2026-09-18 (`POST /lotes/:id/retorno` +
// `lib/adiantamento-retorno-transfeera.js`); o que faltava era ESTA tela — a
// FASE 9 ficou sem UI por não haver arquivo real para conferir o layout
// (Constitution VI). O operador entregou um em 2026-09-30 e o parser o
// engoliu: 3.843 linhas, `Finalizada` 3.812 / `Devolvida` 31, nenhum status
// desconhecido.
//
// Duas coisas que o arquivo real ensinou e que moldaram esta tela:
//
//   1. Um export de PERÍODO traz todos os pagamentos da conta — repasse
//      semanal, promoções, antecipações. Só as linhas com `ADV-<id>` no "ID de
//      integração" pertencem a um lote nosso; as outras milhares voltam como
//      `ignoradas` com motivo `ID_INTEGRACAO_INVALIDO`. Listar 3.800 linhas
//      seria ruído, então agregamos por motivo.
//   2. Se o arquivo não cobre algum item do lote, a rota responde 409
//      `RETORNO_INCOMPLETO` com os ids faltantes e NÃO aplica nada — aplicar
//      pela metade marcaria como pago quem não tem retorno. A tela explica
//      isso em vez de mostrar "erro".
//
// Ref: docs/specs/adiantamento-motorista/spec.md FR-056/SC-011; tasks.md FASE 9.

import { useCallback, useId, useRef, useState } from 'react';
import { AlertCircle, FileUp, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  AdiantamentosApiError,
  importarRetornoLote,
  type RetornoIgnorada,
} from '@/lib/hub/adiantamentos-api';

/** Teto de transporte da rota (`express.json({ limit: '12mb' })`): o base64
 *  infla ~4/3, então o CSV precisa caber em ~9 MB. O export real de um mês tem
 *  3,4 MB — a checagem existe para o caso de alguém exportar o ano. */
const CSV_MAX_BYTES = 9 * 1024 * 1024;

/** Tradução dos motivos técnicos do backend
 *  (lib/adiantamento-retorno-transfeera.js#casarComItensDoLote). Não invento
 *  motivo: código desconhecido aparece cru, para o operador poder relatar. */
const MOTIVO_IGNORADA: Record<string, string> = {
  ID_INTEGRACAO_INVALIDO: 'Linhas de outros pagamentos (sem ID de integração do hub)',
  NAO_PERTENCE_AO_LOTE: 'Pagamentos de outro lote',
  JA_APLICADO: 'Já conciliados numa importação anterior',
  VALOR_DIVERGENTE: 'Valor do arquivo diferente do valor do adiantamento',
};

/** Motivos de recusa do arquivo inteiro (`RetornoTransfeeraParseError`). */
const MOTIVO_ARQUIVO: Record<string, string> = {
  CABECALHO_INVALIDO:
    'O cabeçalho não é o do retorno da Transfeera. Exporte o relatório em CSV, sem editar as colunas.',
  ARQUIVO_VAZIO: 'O arquivo está vazio.',
  LINHA_DUPLICADA:
    'O arquivo traz o mesmo pagamento duas vezes, com resultados diferentes. Exporte de novo — nada foi aplicado.',
  ARQUIVO_MUITO_GRANDE: 'O arquivo tem mais de 10.000 linhas. Exporte um período menor.',
};

function rotuloIgnorada(motivo: string): string {
  // `STATUS_DESCONHECIDO:<valor>` carrega o valor cru vindo do arquivo.
  if (motivo.startsWith('STATUS_DESCONHECIDO:')) {
    return `Status que não sabemos interpretar (${motivo.slice('STATUS_DESCONHECIDO:'.length)})`;
  }
  return MOTIVO_IGNORADA[motivo] ?? motivo;
}

/** Agrega as ignoradas por motivo, em ordem decrescente — é o que cabe na tela
 *  quando o arquivo tem milhares de linhas de outros pagamentos. */
export function agruparIgnoradas(ignoradas: RetornoIgnorada[]): { rotulo: string; total: number }[] {
  const porMotivo = new Map<string, number>();
  for (const i of ignoradas) {
    const r = rotuloIgnorada(i.motivo);
    porMotivo.set(r, (porMotivo.get(r) ?? 0) + 1);
  }
  return [...porMotivo.entries()]
    .map(([rotulo, total]) => ({ rotulo, total }))
    .sort((a, b) => b.total - a.total);
}

/** `File` -> base64 puro (sem o prefixo `data:`), que é o que a rota espera. */
function lerComoBase64(arquivo: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const leitor = new FileReader();
    leitor.onerror = () => reject(new Error('Não foi possível ler o arquivo.'));
    leitor.onload = () => {
      const resultado = typeof leitor.result === 'string' ? leitor.result : '';
      const virgula = resultado.indexOf(',');
      resolve(virgula >= 0 ? resultado.slice(virgula + 1) : '');
    };
    leitor.readAsDataURL(arquivo);
  });
}

export interface UseImportarRetornoDialogArgs {
  loteId: number;
  onSucesso: () => void;
}

type Resultado = { aplicadas: number; grupos: { rotulo: string; total: number }[] };

export function useImportarRetornoDialog({ loteId, onSucesso }: UseImportarRetornoDialogArgs) {
  const [open, setOpen] = useState(false);
  const [arquivo, setArquivo] = useState<File | null>(null);
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [resultado, setResultado] = useState<Resultado | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const abrir = useCallback(() => {
    setArquivo(null);
    setErro(null);
    setResultado(null);
    setOpen(true);
  }, []);

  const escolher = useCallback((f: File | null) => {
    setErro(null);
    setResultado(null);
    if (f && f.size > CSV_MAX_BYTES) {
      setArquivo(null);
      setErro('Arquivo grande demais (máximo 9 MB). Exporte um período menor.');
      return;
    }
    setArquivo(f);
  }, []);

  const enviar = useCallback(async () => {
    if (!arquivo) return;
    setEnviando(true);
    setErro(null);
    try {
      const base64 = await lerComoBase64(arquivo);
      const r = await importarRetornoLote(loteId, base64);
      setResultado({ aplicadas: r.aplicadas, grupos: agruparIgnoradas(r.ignoradas) });
      onSucesso();
    } catch (e) {
      if (e instanceof AdiantamentosApiError) {
        // `RETORNO_INCOMPLETO` não é erro de arquivo: é arquivo que não cobre
        // este lote. Dizer quantos faltam é o que permite ao operador agir
        // (exportar o período em que o pagamento saiu).
        if (e.codigo === 'RETORNO_INCOMPLETO') {
          const n = e.faltantes?.length ?? 0;
          setErro(
            n > 0
              ? `Este arquivo não traz o resultado de ${n} ${n === 1 ? 'pagamento' : 'pagamentos'} deste lote. Nada foi aplicado — exporte o período em que esses pagamentos saíram.`
              : e.message
          );
        } else if (e.codigo === 'ARQUIVO_INVALIDO') {
          // O `motivo` diz QUAL defeito o leitor achou — instrução útil em vez
          // de "arquivo inválido". Motivo desconhecido cai na mensagem do
          // código, nunca numa frase inventada.
          setErro((e.motivo && MOTIVO_ARQUIVO[e.motivo]) || e.message);
        } else {
          setErro(e.message);
        }
      } else {
        setErro('Não foi possível importar o retorno agora.');
      }
    } finally {
      setEnviando(false);
    }
  }, [arquivo, loteId, onSucesso]);

  return { open, setOpen, abrir, arquivo, escolher, enviar, enviando, erro, resultado, inputRef };
}

interface Props {
  /** Nome `d` por consistência com `CancelarLoteDialog`/`ConfirmarLoteDialog`
   *  desta mesma tela. */
  d: ReturnType<typeof useImportarRetornoDialog>;
}

export function ImportarRetornoDialog({ d }: Props) {
  const inputId = useId();
  const { open, setOpen, arquivo, escolher, enviar, enviando, erro, resultado } = d;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Importar retorno da Transfeera</DialogTitle>
          <DialogDescription>
            Exporte o relatório de movimentações em CSV e envie aqui. Cada pagamento é casado pelo ID de integração
            (ADV-…), nunca por nome ou valor. Linhas de outros pagamentos são ignoradas.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <label htmlFor={inputId} className="text-sm font-medium">
              Arquivo CSV
            </label>
            <input
              id={inputId}
              type="file"
              accept=".csv,text/csv"
              disabled={enviando}
              onChange={(e) => escolher(e.target.files?.[0] ?? null)}
              className="min-h-11 rounded-md border border-input bg-background px-3 py-2 text-sm file:mr-3 file:rounded file:border-0 file:bg-muted file:px-3 file:py-1.5 file:text-sm sm:min-h-10"
            />
          </div>

          {erro && (
            <p role="alert" className="flex items-start gap-2 rounded-md bg-destructive/10 px-3 py-2 text-sm font-medium text-destructive">
              <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              {erro}
            </p>
          )}

          {resultado && (
            <div role="status" className="flex flex-col gap-2 rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-sm">
              <p className="font-medium">
                {resultado.aplicadas} {resultado.aplicadas === 1 ? 'pagamento conciliado' : 'pagamentos conciliados'}.
              </p>
              {resultado.grupos.length > 0 && (
                <ul className="flex flex-col gap-1 text-xs text-muted-foreground">
                  {resultado.grupos.map((g) => (
                    <li key={g.rotulo}>
                      {g.total.toLocaleString('pt-BR')} — {g.rotulo}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={enviando}>
            {resultado ? 'Fechar' : 'Cancelar'}
          </Button>
          {!resultado && (
            <Button onClick={enviar} disabled={!arquivo || enviando}>
              {enviando ? (
                <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden="true" />
              ) : (
                <FileUp className="size-4" aria-hidden="true" />
              )}
              Importar retorno
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

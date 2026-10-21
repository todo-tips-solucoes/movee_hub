'use client';

// adiantamento-motorista — components/hub/adiantamento-importar-retorno-dialog.tsx
// (FASE 9, Q-B1): importa o XLSX de retorno da Transfeera e concilia o lote de
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
//      semanal, promoções, antecipações. Só as linhas com `ADV-<id>` no "ID
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
import { XLSX_MAX_BYTES, XLSX_MIME } from '@/lib/hub/retorno-xlsx';
import {
  AdiantamentosApiError,
  importarRetornoLote,
  type ImportarRetornoResponse,
  type RetornoIgnoradaPorMotivo,
} from '@/lib/hub/adiantamentos-api';

/** Tradução dos motivos técnicos do backend
 *  (lib/adiantamento-retorno-transfeera.js#casarComItensDoLote). Não invento
 *  motivo: código desconhecido aparece cru, para o operador poder relatar. */
const MOTIVO_IGNORADA = (produto: string): Record<string, string> => ({
  ID_INTEGRACAO_INVALIDO: 'Linhas de outros pagamentos (sem ID de integração do hub)',
  NAO_PERTENCE_AO_LOTE: 'Pagamentos de outro lote',
  JA_APLICADO: 'Já conciliados numa importação anterior',
  VALOR_DIVERGENTE: `Valor do arquivo diferente do valor do ${produto}`,
});

/** Motivos de recusa do arquivo inteiro (`RetornoTransfeeraParseError`). */
const MOTIVO_ARQUIVO: Record<string, string> = {
  CABECALHO_INVALIDO:
    'O cabeçalho não é o do retorno da Transfeera. Envie a planilha XLSX baixada de lá, sem editar as colunas.',
  FORMATO_INVALIDO:
    'O arquivo não é uma planilha XLSX válida. Envie o .xlsx baixado da Transfeera.',
  ARQUIVO_VAZIO: 'O arquivo está vazio.',
  LINHA_DUPLICADA:
    'O arquivo traz o mesmo pagamento duas vezes, com resultados diferentes. Exporte de novo — nada foi aplicado.',
  ARQUIVO_MUITO_GRANDE: 'O arquivo tem mais de 10.000 linhas. Exporte um período menor.',
};

/** Motivos de linha que PERTENCE ao lote mas foi recusada — a causa acionável do
 *  `RETORNO_INCOMPLETO`. Os demais (outro lote, ID inválido, já aplicado) são
 *  ruído de export de período e não explicam a falta. */
const MOTIVOS_DA_LINHA = /^(VALOR_AMBIGUO|VALOR_DIVERGENTE|STATUS_DESCONHECIDO)(:|$)/;

function rotuloIgnorada(motivo: string, produto: string): string {
  // `STATUS_DESCONHECIDO:<valor>` carrega o valor cru vindo do arquivo.
  if (motivo.startsWith('STATUS_DESCONHECIDO:')) {
    return `Status que não sabemos interpretar (${motivo.slice('STATUS_DESCONHECIDO:'.length)})`;
  }
  // `VALOR_AMBIGUO:<texto>`: célula sem casas decimais com ponto (milhar ou decimal?).
  if (motivo.startsWith('VALOR_AMBIGUO:')) {
    return `Valor sem casas decimais que pode ser milhar ou decimal (${motivo.slice('VALOR_AMBIGUO:'.length)}) — o sistema não adivinha. Reexporte o arquivo com vírgula e duas casas (ex.: 1.234,00)`;
  }
  return MOTIVO_IGNORADA(produto)[motivo] ?? motivo;
}

/** Traduz os motivos que o backend já devolve agregados. A agregação saiu do
 *  cliente em 2026-10-01: ela existia porque a resposta trazia linha a linha —
 *  com nome de pessoas no `ID de integração`. Agora o servidor manda só as
 *  contagens, e aqui é só rótulo. */
export function rotularIgnoradas(
  ignoradas: RetornoIgnoradaPorMotivo[],
  produto = 'adiantamento'
): { rotulo: string; total: number }[] {
  return ignoradas.map((i) => ({ rotulo: rotuloIgnorada(i.motivo, produto), total: i.total }));
}

export interface UseImportarRetornoDialogArgs {
  loteId: number;
  onSucesso: () => void;
  /** Endpoint do retorno — o default é o do adiantamento; o repasse passa o dele. */
  importar?: (id: number, xlsx: ArrayBuffer) => Promise<ImportarRetornoResponse>;
  /** Nome do produto nas frases que o citam ("valor do adiantamento" / "valor do repasse"). */
  produto?: string;
}

type Resultado = { aplicadas: number; grupos: { rotulo: string; total: number }[] };

export function useImportarRetornoDialog({ loteId, onSucesso, importar = importarRetornoLote, produto = 'adiantamento' }: UseImportarRetornoDialogArgs) {
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
    if (f && f.size > XLSX_MAX_BYTES) {
      setArquivo(null);
      setErro('Arquivo grande demais (máximo 10 MB). Exporte um período menor.');
      return;
    }
    setArquivo(f);
  }, []);

  const enviar = useCallback(async () => {
    if (!arquivo) return;
    setEnviando(true);
    setErro(null);
    try {
      // BINÁRIO: `arrayBuffer()`, nunca `text()` — decodificar o ZIP como UTF-8 o
      // corrompe. Sem base64 (ver `importarRetornoLote`).
      const xlsx = await arquivo.arrayBuffer();
      const r = await importar(loteId, xlsx);
      setResultado({ aplicadas: r.aplicadas, grupos: rotularIgnoradas(r.ignoradasPorMotivo, produto) });
      onSucesso();
    } catch (e) {
      if (e instanceof AdiantamentosApiError) {
        // `RETORNO_INCOMPLETO` não é erro de arquivo: é arquivo que não cobre
        // este lote. Diz quantos faltam E, se houver linha recusada, por quê —
        // sem a causa, o operador reexportava o período quando o problema era
        // a célula (ex.: valor `1.234`).
        if (e.codigo === 'RETORNO_INCOMPLETO') {
          const n = e.faltantes?.length ?? 0;
          const causas = rotularIgnoradas(
            (e.ignoradasPorMotivo ?? []).filter((i) => MOTIVOS_DA_LINHA.test(i.motivo)),
            produto
          );
          const base = `Este arquivo não traz o resultado de ${n} ${n === 1 ? 'pagamento' : 'pagamentos'} deste lote. Nada foi aplicado.`;
          setErro(
            n === 0
              ? e.message
              : causas.length > 0
                ? `${base} Linhas recusadas: ${causas.map((g) => `${g.total.toLocaleString('pt-BR')} — ${g.rotulo}`).join('; ')}. Corrija e reenvie.`
                : `${base} Exporte o período em que esses pagamentos saíram.`
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
  }, [arquivo, loteId, onSucesso, importar, produto]);

  return { open, setOpen, abrir, arquivo, escolher, enviar, enviando, erro, resultado, inputRef };
}

interface Props {
  /** Nome `d` por consistência com `CancelarLoteDialog`/`ConfirmarLoteDialog`
   *  desta mesma tela. */
  d: ReturnType<typeof useImportarRetornoDialog>;
  /** Prefixo do ID de integração que casa o pagamento com o lote (adiantamento `ADV-`, repasse `REP-`). */
  prefixoId?: string;
}

export function ImportarRetornoDialog({ d, prefixoId = 'ADV-' }: Props) {
  const inputId = useId();
  const { open, setOpen, arquivo, escolher, enviar, enviando, erro, resultado } = d;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Importar retorno da Transfeera</DialogTitle>
          <DialogDescription>
            Envie o arquivo .xlsx baixado da Transfeera, sem editar as colunas. Cada pagamento é casado pelo ID de
            integração ({prefixoId}…), nunca por nome ou valor. Linhas de outros pagamentos são ignoradas.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <label htmlFor={inputId} className="text-sm font-medium">
              Arquivo XLSX
            </label>
            <input
              id={inputId}
              type="file"
              accept={`.xlsx,${XLSX_MIME}`}
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

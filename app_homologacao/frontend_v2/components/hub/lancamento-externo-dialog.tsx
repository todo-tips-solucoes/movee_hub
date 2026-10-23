'use client';

// lancamento-externo — diálogo "Importar pagos por fora" (aba Repasse). Ponto de ENTRADA
// da feature na tela (FR-040; a listagem/exclusão veio depois, por emenda datada, em
// `lancamento-externo-lista-dialog.tsx` — sem página/aba nova). O tipo é
// escolhido AQUI e vale para o arquivo todo; não é coluna da planilha (FR-010).
// O resultado mostra aplicadas, recusadas e a contagem POR MOTIVO — nunca CNPJ/nome.

import { useCallback, useId, useState } from 'react';
import { AlertCircle, FileUp, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { SelectFiltro } from '@/components/hub/select-filtro';
import { XLSX_MAX_BYTES, XLSX_MIME } from '@/lib/hub/retorno-xlsx';
import {
  LancamentoExternoApiError, TIPOS_LANCAMENTO_EXTERNO, importarLancamentosExternos, mensagemErroArquivo, rotuloMotivoLinha, textoExcedente, UM_POR_DIA,
  type TipoLancamentoExterno,
} from '@/lib/hub/lancamento-externo';

type Resultado = { aplicadas: number; ignoradas: number; grupos: { rotulo: string; total: number }[]; excedentes: string[]; excedentesTotal: number };

export function useLancamentoExternoDialog({ onSucesso }: { onSucesso: () => void }) {
  const [open, setOpen] = useState(false);
  const [tipo, setTipo] = useState<TipoLancamentoExterno>('ADIANTAMENTO');
  const [arquivo, setArquivo] = useState<File | null>(null);
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [resultado, setResultado] = useState<Resultado | null>(null);

  const abrir = useCallback(() => { setArquivo(null); setTipo('ADIANTAMENTO'); setErro(null); setResultado(null); setOpen(true); }, []);
  const escolher = useCallback((f: File | null) => {
    setErro(null); setResultado(null);
    if (f && f.size > XLSX_MAX_BYTES) { setArquivo(null); setErro('Arquivo grande demais (máximo 10 MB).'); return; }
    setArquivo(f);
  }, []);

  const enviar = useCallback(async () => {
    if (!arquivo) return;
    setEnviando(true); setErro(null);
    try {
      // BINÁRIO: `arrayBuffer()`, nunca `text()` (decodificar o ZIP como UTF-8 o corrompe).
      const r = await importarLancamentosExternos(tipo, await arquivo.arrayBuffer());
      setResultado({
        aplicadas: r.aplicadas, ignoradas: r.ignoradas,
        grupos: r.ignoradasPorMotivo.map((m) => ({ rotulo: rotuloMotivoLinha(m.motivo), total: m.total })),
        excedentes: (r.excedentes ?? []).map(textoExcedente),
        // O servidor devolve só as 50 primeiras; o total verdadeiro vem na contagem por motivo.
        excedentesTotal: Math.max((r.excedentes ?? []).length, r.ignoradasPorMotivo.find((m) => m.motivo === 'VALOR_EXCEDE_LIQUIDO')?.total ?? 0),
      });
      onSucesso();
    } catch (e) {
      setErro(e instanceof LancamentoExternoApiError ? mensagemErroArquivo(e) : 'Não foi possível importar agora.');
    } finally {
      setEnviando(false);
    }
  }, [arquivo, tipo, onSucesso]);

  return { open, setOpen, abrir, tipo, setTipo, arquivo, escolher, enviar, enviando, erro, resultado };
}

export function LancamentoExternoDialog({ d }: { d: ReturnType<typeof useLancamentoExternoDialog> }) {
  const inputId = useId();
  const tipoId = useId();
  return (
    <Dialog open={d.open} onOpenChange={d.setOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Importar pagos por fora</DialogTitle>
          <DialogDescription>
            Envie a planilha .xlsx com as colunas CNPJ, Data do pagamento, Valor, Nome e Observação. O tipo vale para o arquivo
            inteiro. Linhas com problema são recusadas uma a uma e o motivo aparece abaixo; as demais são aplicadas. Uma dedução maior que o
            líquido da semana do motorista também é recusada (o líquido disponível aparece abaixo): importe o faturamento da semana antes. {UM_POR_DIA}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <label htmlFor={tipoId} className="text-sm font-medium">Tipo</label>
            <SelectFiltro id={tipoId} ariaLabel="Tipo" value={d.tipo} onChange={(v) => d.setTipo(v as TipoLancamentoExterno)}
              opcoes={TIPOS_LANCAMENTO_EXTERNO} disabled={d.enviando} />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor={inputId} className="text-sm font-medium">Arquivo XLSX</label>
            <input id={inputId} type="file" accept={`.xlsx,${XLSX_MIME}`} disabled={d.enviando}
              onChange={(e) => d.escolher(e.target.files?.[0] ?? null)}
              className="min-h-11 rounded-md border border-input bg-background px-3 py-2 text-sm file:mr-3 file:rounded file:border-0 file:bg-muted file:px-3 file:py-1.5 file:text-sm sm:min-h-9" />
          </div>
          {d.erro && (
            <p role="alert" className="flex items-start gap-2 rounded-md bg-destructive/10 px-3 py-2 text-sm font-medium text-destructive">
              <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />{d.erro}
            </p>
          )}
          {d.resultado && (
            <div role="status" className="flex flex-col gap-2 rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-sm">
              <p><span className="font-semibold">{d.resultado.aplicadas}</span> aplicada(s) · <span className="font-semibold">{d.resultado.ignoradas}</span> recusada(s)</p>
              {d.resultado.grupos.length > 0 && (
                <ul className="flex flex-col gap-0.5 pl-4 text-xs">
                  {d.resultado.grupos.map((g) => (
                    <li key={g.rotulo} className="list-disc">{g.rotulo}: <span className="font-mono">{g.total}</span></li>
                  ))}
                </ul>
              )}
              {d.resultado.excedentes.length > 0 && (
                <ul className="flex flex-col gap-0.5 pl-4 text-xs" aria-label="Linhas recusadas por exceder o líquido">
                  {d.resultado.excedentes.map((t) => <li key={t} className="list-disc">{t}</li>)}
                </ul>
              )}
              {d.resultado.excedentes.length > 0 && d.resultado.excedentesTotal > d.resultado.excedentes.length && (
                <p className="text-xs">Mostrando {d.resultado.excedentes.length} de {d.resultado.excedentesTotal} linhas recusadas por exceder o líquido.</p>
              )}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => d.setOpen(false)} disabled={d.enviando}>Fechar</Button>
          <Button onClick={d.enviar} disabled={!d.arquivo || d.enviando}>
            {d.enviando ? <Loader2 className="mr-2 size-4 motion-safe:animate-spin" aria-hidden="true" /> : <FileUp className="mr-2 size-4" aria-hidden="true" />}
            Importar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

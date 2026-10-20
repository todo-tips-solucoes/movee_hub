'use client';

import { useRef, useState, useCallback } from 'react';
import { Upload, Loader2, FileSpreadsheet, Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from 'sonner';
import { ApiError, type LinhaInvalida } from '@/lib/api-client';
import {
  ROTULOS_RESUMO,
  ROTULO_PULO,
  descreverInterrompida,
  type ResultadoImportacao,
} from '@/lib/correcao-movimento';

interface ImportButtonProps {
  onUpload: (file: File, extraFields?: Record<string, string>) => Promise<unknown>;
}

// Converte data do input nativo (YYYY-MM-DD) para o formato esperado pelo
// backend (DD/MM/YYYY). Retorna string vazia se a entrada nao casar o padrao.
function toBackendDate(isoDate: string): string {
  const match = isoDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return '';
  const [, year, month, day] = match;
  return `${day}/${month}/${year}`;
}

/**
 * Agrupa as linhas por motivo. É assim que a informação vira ação: "4 linhas com
 * CNPJ inválido: 329, 361, 413, 542" diz o que fazer; uma lista de 982 itens,
 * não. Ordena do motivo mais frequente para o menos.
 */
function agruparPorMotivo(linhas: LinhaInvalida[]): { motivo: string; linhas: number[] }[] {
  const mapa = new Map<string, number[]>();
  for (const item of linhas) {
    for (const motivo of item.motivos) {
      const atual = mapa.get(motivo) ?? [];
      atual.push(item.linha);
      mapa.set(motivo, atual);
    }
  }
  return [...mapa.entries()]
    .map(([motivo, ls]) => ({ motivo, linhas: [...ls].sort((a, b) => a - b) }))
    .sort((a, b) => b.linhas.length - a.linhas.length);
}

export function ImportButton({ onUpload }: ImportButtonProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  // Estado do dialog de range (fluxo de 2 passos)
  const [dialogOpen, setDialogOpen] = useState(false);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [dtInicial, setDtInicial] = useState('');
  const [dtFinal, setDtFinal] = useState('');
  // Linhas que o backend recusou. Vazio = nenhum erro de validação pendente.
  const [linhasInvalidas, setLinhasInvalidas] = useState<LinhaInvalida[]>([]);
  // corrigir-movimento: motivo do lote (exigido só se a planilha altera existentes)
  // e o resultado discriminado da importação.
  const [motivo, setMotivo] = useState('');
  const [erroMotivo, setErroMotivo] = useState<string | null>(null);
  const [resultado, setResultado] = useState<ResultadoImportacao | null>(null);
  const [interrompida, setInterrompida] = useState<string | null>(null);

  const resetDialog = useCallback(() => {
    setDialogOpen(false);
    setPendingFile(null);
    setDtInicial('');
    setDtFinal('');
    setMotivo('');
    setErroMotivo(null);
    if (inputRef.current) inputRef.current.value = '';
  }, []);

  // Passo 1: validar extensao e abrir o dialog (NAO chama onUpload ainda).
  const stageFile = useCallback((file: File) => {
    if (!file.name.match(/\.xlsx?$/i)) {
      toast.error('Apenas arquivos .xlsx ou .xls são aceitos');
      if (inputRef.current) inputRef.current.value = '';
      return;
    }
    setPendingFile(file);
    setDialogOpen(true);
  }, []);

  // Habilita o botao Enviar somente com range valido (SC-2).
  const rangeValido = dtInicial !== '' && dtFinal !== '' && dtInicial <= dtFinal;

  // Passo 2: confirmar -> converter datas -> onUpload(file, extraFields).
  const handleConfirm = useCallback(async () => {
    if (!pendingFile || !rangeValido) return;
    const dt_inicial = toBackendDate(dtInicial);
    const dt_final = toBackendDate(dtFinal);
    const file = pendingFile;
    let manter = false;
    try {
      setUploading(true);
      setDialogOpen(false);
      setErroMotivo(null);
      const extra: Record<string, string> = { dt_inicial, dt_final };
      if (motivo.trim()) extra.motivo = motivo.trim();
      const res = (await onUpload(file, extra)) as ResultadoImportacao | undefined;
      if (res?.resumo) {
        // Planilha que casa com movimentos existentes: mostrar o desfecho real, não só um toast.
        setResultado(res);
        toast.success(`"${file.name}" processado — veja o resumo.`);
      } else {
        toast.success(`"${file.name}" importado com sucesso!`);
      }
    } catch (err) {
      const parcial = descreverInterrompida(err);
      if (parcial) {
        setInterrompida(parcial);
      } else if (err instanceof ApiError && err.status === 400 && /^Informe o motivo/.test(err.message)) {
        // Nada foi alterado: volta ao diálogo com arquivo e datas preservados.
        manter = true;
        setErroMotivo(err.message);
        setDialogOpen(true);
      } else if (err instanceof ApiError && err.linhasInvalidas.length > 0) {
        // O backend já sabe QUAIS linhas recusou; antes isso era descartado.
        setLinhasInvalidas(err.linhasInvalidas);
        toast.error(
          `${err.linhasInvalidas.length} linha(s) precisam de correção — nenhum registro foi inserido.`
        );
      } else {
        toast.error(err instanceof Error ? err.message : 'Erro ao importar arquivo');
      }
    } finally {
      setUploading(false);
      if (!manter) {
        setPendingFile(null);
        setDtInicial('');
        setDtFinal('');
        setMotivo('');
        if (inputRef.current) inputRef.current.value = '';
      }
    }
  }, [pendingFile, rangeValido, dtInicial, dtFinal, motivo, onUpload]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) stageFile(file);
  };

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) stageFile(file);
  }, [stageFile]);

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept=".xlsx,.xls"
        className="hidden"
        onChange={handleChange}
      />
      <Button
        size="sm"
        variant="outline"
        className={`h-11 gap-1.5 transition-all sm:h-8 ${dragOver ? 'border-primary bg-primary/5 ring-2 ring-primary/20' : ''}`}
        onClick={() => inputRef.current?.click()}
        disabled={uploading}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
      >
        {uploading ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : dragOver ? (
          <FileSpreadsheet className="h-4 w-4 text-primary" />
        ) : (
          <Upload className="h-4 w-4" />
        )}
        {dragOver ? 'Soltar aqui' : 'Importar XLSX'}
      </Button>

      <Dialog
        open={dialogOpen}
        onOpenChange={(open) => {
          if (!open) resetDialog();
          else setDialogOpen(true);
        }}
      >
        {/* R003: largura mobile explícita (sem scroll horizontal) */}
        <DialogContent className="w-[calc(100vw-2rem)] sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Período da movimentação</DialogTitle>
            <DialogDescription>
              {pendingFile
                ? `Defina o período aplicado a todas as linhas de "${pendingFile.name}".`
                : 'Defina o período aplicado a todas as linhas da planilha.'}
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 py-2">
            <div className="grid gap-2">
              <Label htmlFor="import-dt-inicial">Data inicial</Label>
              <Input
                id="import-dt-inicial"
                type="date"
                value={dtInicial}
                max={dtFinal || undefined}
                onChange={(e) => setDtInicial(e.target.value)}
                className="h-11 sm:h-9"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="import-dt-final">Data final</Label>
              <Input
                id="import-dt-final"
                type="date"
                value={dtFinal}
                min={dtInicial || undefined}
                onChange={(e) => setDtFinal(e.target.value)}
                className="h-11 sm:h-9"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="import-motivo">Motivo (se a planilha corrigir movimentos já existentes)</Label>
              <Input
                id="import-motivo"
                value={motivo}
                maxLength={500}
                onChange={(e) => setMotivo(e.target.value)}
                aria-invalid={erroMotivo !== null}
                className="h-11 sm:h-9"
              />
              {erroMotivo && <p role="alert" className="text-sm text-destructive">{erroMotivo}</p>}
            </div>
            {dtInicial !== '' && dtFinal !== '' && dtInicial > dtFinal && (
              <p className="text-sm text-destructive">
                A data inicial deve ser anterior ou igual à data final.
              </p>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={resetDialog} disabled={uploading}>
              Cancelar
            </Button>
            <Button onClick={handleConfirm} disabled={!rangeValido || uploading}>
              {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Enviar'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Linhas recusadas pelo backend. Mostra número da linha e motivo — nunca
          o conteúdo da linha: para corrigir basta saber onde e o quê, e nome e
          telefone não precisam circular pela tela nem pela área de transferência. */}
      <Dialog open={linhasInvalidas.length > 0} onOpenChange={(open) => { if (!open) setLinhasInvalidas([]); }}>
        <DialogContent className="w-[calc(100vw-2rem)] sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {linhasInvalidas.length === 1
                ? '1 linha precisa de correção'
                : `${linhasInvalidas.length} linhas precisam de correção`}
            </DialogTitle>
            <DialogDescription>
              Nenhum registro foi inserido — a importação é tudo ou nada. Corrija na
              planilha e envie de novo. Os números são os da linha no Excel.
            </DialogDescription>
          </DialogHeader>

          <div className="max-h-[50vh] overflow-y-auto pr-1">
            <ul className="flex flex-col gap-3">
              {agruparPorMotivo(linhasInvalidas).map(({ motivo, linhas }) => (
                <li key={motivo} className="rounded-md border border-border p-3">
                  <p className="text-sm font-medium">
                    {linhas.length}× {motivo}
                  </p>
                  <p className="mt-1 break-words font-mono text-xs text-muted-foreground">
                    {linhas.length > 40
                      ? `linhas ${linhas.slice(0, 40).join(', ')} … (+${linhas.length - 40})`
                      : `linha${linhas.length > 1 ? 's' : ''} ${linhas.join(', ')}`}
                  </p>
                </li>
              ))}
            </ul>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              className="min-h-11 sm:min-h-9"
              onClick={() => {
                const texto = agruparPorMotivo(linhasInvalidas)
                  .map(({ motivo, linhas }) => `${linhas.length}x ${motivo}\n  linhas: ${linhas.join(', ')}`)
                  .join('\n');
                navigator.clipboard?.writeText(texto).then(
                  () => toast.success('Lista copiada'),
                  () => toast.error('Não foi possível copiar')
                );
              }}
            >
              <Copy className="mr-2 h-4 w-4" />
              Copiar lista
            </Button>
            <Button className="min-h-11 sm:min-h-9" onClick={() => setLinhasInvalidas([])}>
              Fechar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {/* corrigir-movimento: desfecho discriminado da reimportação. Pulados e ambíguos
          NÃO ficam escondidos num "pronto": são o que o operador precisa tratar. */}
      <Dialog
        open={resultado !== null || interrompida !== null}
        onOpenChange={(open) => { if (!open) { setResultado(null); setInterrompida(null); } }}
      >
        <DialogContent className="w-[calc(100vw-2rem)] sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{interrompida ? 'Importação interrompida' : 'Resultado da importação'}</DialogTitle>
            <DialogDescription>
              {interrompida ?? (resultado?.resumo ? `${resultado.resumo.total_linhas} linha(s) na planilha.` : '')}
            </DialogDescription>
          </DialogHeader>
          {resultado?.resumo && !interrompida && (
            <div className="max-h-[50vh] space-y-3 overflow-y-auto pr-1">
              <ul className="flex flex-col gap-1.5">
                {ROTULOS_RESUMO.map(({ chave, rotulo, destaque }) => (
                  <li
                    key={chave}
                    className={`flex justify-between gap-3 text-sm ${destaque && resultado.resumo![chave] > 0 ? 'font-semibold text-destructive' : ''}`}
                  >
                    <span>{rotulo}</span>
                    <span className="tabular-nums">{resultado.resumo![chave]}</span>
                  </li>
                ))}
              </ul>
              {resultado.resumo.mensagem_valor_antigo > 0 && (
                <p role="note" className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                  {resultado.resumo.mensagem_valor_antigo} movimento(s) corrigido(s) já tinham a mensagem enviada ao motorista com o valor antigo.
                </p>
              )}
              {resultado.resumo.mensagem_divergente > 0 && (
                <p role="note" className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                  {resultado.resumo.mensagem_divergente} movimento(s) tiveram o valor corrigido, mas o texto da mensagem na planilha cita outro valor e não pôde ser ajustado — revise a mensagem antes de enviar.
                </p>
              )}
              {(resultado.pulados?.length ?? 0) > 0 && (
                <div>
                  <p className="text-sm font-medium">Pulados (valor mantido)</p>
                  <ul className="mt-1 font-mono text-xs text-muted-foreground">
                    {resultado.pulados!.map((p) => (
                      <li key={`${p.linha}-${p.id}`}>linha {p.linha} · movimento {p.id} · {ROTULO_PULO[p.motivo]}</li>
                    ))}
                  </ul>
                </div>
              )}
              {(resultado.ambiguos?.length ?? 0) > 0 && (
                <div>
                  <p className="text-sm font-medium">Ambíguos — resolver manualmente</p>
                  <ul className="mt-1 font-mono text-xs text-muted-foreground">
                    {resultado.ambiguos!.map((a) => (
                      <li key={a.linha}>linha {a.linha} · CNPJ {a.cnpj_prestador} · movimentos {a.candidatos.join(', ')}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
          <DialogFooter>
            <Button className="min-h-11 sm:min-h-9" onClick={() => { setResultado(null); setInterrompida(null); }}>
              Fechar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

'use client';

import { useRef, useState, useCallback } from 'react';
import { Upload, Loader2, FileSpreadsheet } from 'lucide-react';
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

export function ImportButton({ onUpload }: ImportButtonProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  // Estado do dialog de range (fluxo de 2 passos)
  const [dialogOpen, setDialogOpen] = useState(false);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [dtInicial, setDtInicial] = useState('');
  const [dtFinal, setDtFinal] = useState('');

  const resetDialog = useCallback(() => {
    setDialogOpen(false);
    setPendingFile(null);
    setDtInicial('');
    setDtFinal('');
    if (inputRef.current) inputRef.current.value = '';
  }, []);

  // Passo 1: validar extensao e abrir o dialog (NAO chama onUpload ainda).
  const stageFile = useCallback((file: File) => {
    if (!file.name.match(/\.xlsx?$/i)) {
      toast.error('Apenas arquivos .xlsx ou .xls sao aceitos');
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
    try {
      setUploading(true);
      setDialogOpen(false);
      await onUpload(file, { dt_inicial, dt_final });
      toast.success(`"${file.name}" importado com sucesso!`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro ao importar arquivo');
    } finally {
      setUploading(false);
      setPendingFile(null);
      setDtInicial('');
      setDtFinal('');
      if (inputRef.current) inputRef.current.value = '';
    }
  }, [pendingFile, rangeValido, dtInicial, dtFinal, onUpload]);

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
        className={`gap-1.5 transition-all ${dragOver ? 'border-primary bg-primary/5 ring-2 ring-primary/20' : ''}`}
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
            <DialogTitle>Periodo da movimentacao</DialogTitle>
            <DialogDescription>
              {pendingFile
                ? `Defina o periodo aplicado a todas as linhas de "${pendingFile.name}".`
                : 'Defina o periodo aplicado a todas as linhas da planilha.'}
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
            {dtInicial !== '' && dtFinal !== '' && dtInicial > dtFinal && (
              <p className="text-sm text-destructive">
                A data inicial deve ser anterior ou igual a data final.
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
    </>
  );
}

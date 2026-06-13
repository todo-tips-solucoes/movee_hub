'use client';

import { useRef, useState, useCallback } from 'react';
import { Upload, Loader2, FileSpreadsheet } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';

interface ImportButtonProps {
  onUpload: (file: File, extraFields?: Record<string, string>) => Promise<unknown>;
}

export function ImportButton({ onUpload }: ImportButtonProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  const processFile = useCallback(async (file: File) => {
    if (!file.name.match(/\.xlsx?$/i)) {
      toast.error('Apenas arquivos .xlsx ou .xls sao aceitos');
      return;
    }
    try {
      setUploading(true);
      await onUpload(file);
      toast.success(`"${file.name}" importado com sucesso!`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro ao importar arquivo');
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  }, [onUpload]);

  const handleChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) await processFile(file);
  };

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) await processFile(file);
  }, [processFile]);

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
    </>
  );
}

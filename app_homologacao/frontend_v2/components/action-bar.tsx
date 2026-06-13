'use client';

import { Download, FileDown, Lock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { ProcessControls } from './process-controls';
import { ImportButton } from './import-button';
import { CloseMovementDialog } from './close-movement-dialog';
import { toast } from 'sonner';
import { useState } from 'react';
import { Loader2 } from 'lucide-react';

interface ActionBarProps {
  isActive: boolean;
  isProcessLoading: boolean;
  onStart: () => void;
  onStop: () => void;
  onUpload: (file: File, extraFields?: Record<string, string>) => Promise<unknown>;
  onExportCSV: () => void;
  onDownloadXML: () => Promise<void>;
  onCloseMovement: () => Promise<void>;
}

export function ActionBar({
  isActive,
  isProcessLoading,
  onStart,
  onStop,
  onUpload,
  onExportCSV,
  onDownloadXML,
  onCloseMovement,
}: ActionBarProps) {
  const [csvLoading, setCsvLoading] = useState(false);
  const [xmlLoading, setXmlLoading] = useState(false);

  const handleExportCSV = async () => {
    try {
      setCsvLoading(true);
      await onExportCSV();
      toast.success('CSV exportado com sucesso!');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro ao exportar CSV');
    } finally {
      setCsvLoading(false);
    }
  };

  const handleDownloadXML = async () => {
    try {
      setXmlLoading(true);
      await onDownloadXML();
      toast.success('XMLs baixados com sucesso!');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro ao baixar XMLs');
    } finally {
      setXmlLoading(false);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-card p-3">
      <ProcessControls
        isActive={isActive}
        isLoading={isProcessLoading}
        onStart={onStart}
        onStop={onStop}
      />

      <Separator orientation="vertical" className="hidden h-8 sm:block" />

      <div className="flex items-center gap-2">
        <ImportButton onUpload={onUpload} />
        <Button size="sm" variant="outline" className="gap-1.5" onClick={handleExportCSV} disabled={csvLoading}>
          {csvLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileDown className="h-4 w-4" />}
          Exportar CSV
        </Button>
      </div>

      <Separator orientation="vertical" className="hidden h-8 sm:block" />

      <div className="flex items-center gap-2">
        <Button size="sm" variant="outline" className="gap-1.5" onClick={handleDownloadXML} disabled={xmlLoading}>
          {xmlLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
          Download XML
        </Button>
        <CloseMovementDialog onConfirm={onCloseMovement} />
      </div>
    </div>
  );
}

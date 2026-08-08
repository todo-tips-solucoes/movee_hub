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
import type { StatsData } from '@/types';

interface ActionBarProps {
  isActive: boolean;
  isProcessLoading: boolean;
  onStart: () => void;
  onStop: () => void;
  onUpload: (file: File, extraFields?: Record<string, string>) => Promise<unknown>;
  onExportCSV: () => void;
  onDownloadXML: () => Promise<void>;
  onCloseMovement: () => Promise<void>;
  /** Números do movimento — repassados ao confirm de Fechar movimento. */
  stats?: StatsData | null;
  /** Quantas linhas marcadas o disparo REALMENTE alcança (as ainda pendentes). */
  selecionados?: number;
  /** Total de linhas marcadas, incluindo as que já receberam mensagem. */
  selecionadosMarcados?: number;
  /** Período do movimento aberto, repassado ao confirm de Fechar movimento. */
  periodo?: string | null;
  /** A lista falhou ao carregar — repassado ao confirm de Fechar movimento,
   *  que não pode oferecer ação irreversível sobre números que não existem. */
  dadosIndisponiveis?: boolean;
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
  stats,
  selecionados,
  selecionadosMarcados,
  periodo,
  dadosIndisponiveis,
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

  // R002: gaps fluidos; grupos com wrap p/ nunca causar scroll horizontal <400px
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-card p-3 sm:gap-3 md:gap-4">
      <ProcessControls
        isActive={isActive}
        isLoading={isProcessLoading}
        onStart={onStart}
        onStop={onStop}
        selecionados={selecionados}
        selecionadosMarcados={selecionadosMarcados}
      />

      <Separator orientation="vertical" className="hidden h-8 sm:block" />

      <div className="flex flex-wrap items-center gap-2">
        <ImportButton onUpload={onUpload} />
        <Button size="sm" variant="outline" className="gap-1.5" onClick={handleExportCSV} disabled={csvLoading}>
          {csvLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileDown className="h-4 w-4" />}
          Exportar CSV
        </Button>
      </div>

      <Separator orientation="vertical" className="hidden h-8 sm:block" />

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" className="gap-1.5" onClick={handleDownloadXML} disabled={xmlLoading}>
          {xmlLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
          Download XML
        </Button>
        {/* impeccable rodada 5 (P1): `isActive` chegava até aqui e parava no
            ProcessControls — o Fechar movimento seguia clicável durante o
            disparo, e um clique fora de hora lacrava o movimento com parte dos
            motoristas notificados e parte não. */}
        <CloseMovementDialog
          onConfirm={onCloseMovement}
          stats={stats}
          isActive={isActive}
          periodo={periodo}
          dadosIndisponiveis={dadosIndisponiveis}
        />
      </div>
    </div>
  );
}

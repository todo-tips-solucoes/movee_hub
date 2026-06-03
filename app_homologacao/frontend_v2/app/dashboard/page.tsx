'use client';

import { useEffect } from 'react';
import { useEnvioMassa } from '@/hooks/use-envio-massa';
import { useProcessStatus } from '@/hooks/use-process-status';
import { StatsCards } from '@/components/stats-cards';
import { ActionBar } from '@/components/action-bar';
import { Filters } from '@/components/filters';
import { DataTable } from '@/components/data-table';
import { PaginationControls } from '@/components/pagination-controls';
import { toast } from 'sonner';
import { motion } from 'framer-motion';

export default function DashboardPage() {
  const {
    paginatedData,
    stats,
    filters,
    loading,
    currentPage,
    recordsPerPage,
    totalPages,
    filteredData,
    selectedIds,
    fetchData,
    updateFilters,
    resetFilters,
    setCurrentPage,
    changeRecordsPerPage,
    deleteRecord,
    updateRecord,
    uploadFile,
    exportCSV,
    downloadXML,
    closeMovement,
    toggleSelectAll,
    toggleSelect,
  } = useEnvioMassa();

  const { isActive, isLoading: processLoading, startProcess, stopProcess } = useProcessStatus({
    onRefresh: fetchData,
  });

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleStart = async () => {
    try {
      await startProcess();
      toast.success('Processamento iniciado!');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro ao iniciar processamento');
    }
  };

  const handleStop = async () => {
    try {
      await stopProcess();
      toast.info('Processamento parado.');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro ao parar processamento');
    }
  };

  if (loading && stats.total === 0) {
    return (
      <div className="space-y-4">
        {/* Skeleton stats */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="rounded-lg border bg-card p-4">
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 rounded-lg bg-muted animate-pulse" />
                <div className="space-y-2">
                  <div className="h-6 w-12 rounded bg-muted animate-pulse" />
                  <div className="h-3 w-20 rounded bg-muted animate-pulse" />
                </div>
              </div>
            </div>
          ))}
        </div>
        {/* Skeleton action bar */}
        <div className="h-14 rounded-lg border bg-card animate-pulse" />
        {/* Skeleton table */}
        <div className="rounded-lg border bg-card">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="flex items-center gap-4 border-b last:border-0 px-4 py-3">
              <div className="h-4 w-4 rounded bg-muted animate-pulse" />
              <div className="h-4 w-16 rounded bg-muted animate-pulse" />
              <div className="h-4 w-32 rounded bg-muted animate-pulse flex-1" />
              <div className="h-4 w-20 rounded bg-muted animate-pulse" />
              <div className="h-4 w-12 rounded bg-muted animate-pulse" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <motion.div
      className="flex flex-col gap-4 md:h-full"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.3 }}
    >
      {/* Seção fixa: stats + actions + filters */}
      <div className="shrink-0 space-y-4">
        <StatsCards stats={stats} />

        <ActionBar
          isActive={isActive}
          isProcessLoading={processLoading}
          onStart={handleStart}
          onStop={handleStop}
          onUpload={uploadFile}
          onExportCSV={exportCSV}
          onDownloadXML={downloadXML}
          onCloseMovement={closeMovement}
        />

        <Filters
          filters={filters}
          onChange={updateFilters}
          onReset={resetFilters}
        />
      </div>

      {/* Tabela ocupa o espaço restante */}
      <div className="min-h-[300px] md:flex-1 md:min-h-0">
        <DataTable
          data={paginatedData}
          selectedIds={selectedIds}
          onToggleSelectAll={toggleSelectAll}
          onToggleSelect={toggleSelect}
          onDelete={deleteRecord}
          onUpdate={updateRecord}
        />
      </div>

      {/* Paginação fixa no rodapé */}
      <div className="shrink-0">
        <PaginationControls
          currentPage={currentPage}
          totalPages={totalPages}
          recordsPerPage={recordsPerPage}
          totalRecords={filteredData.length}
          onPageChange={setCurrentPage}
          onRecordsPerPageChange={changeRecordsPerPage}
        />
      </div>
    </motion.div>
  );
}

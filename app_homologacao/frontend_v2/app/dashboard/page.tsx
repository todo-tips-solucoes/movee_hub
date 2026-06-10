'use client';

import { Suspense, useEffect, useCallback } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { useEnvioMassa } from '@/hooks/use-envio-massa';
import { useProcessStatus } from '@/hooks/use-process-status';
import { StatsCards } from '@/components/stats-cards';
import { ActionBar } from '@/components/action-bar';
import { Filters } from '@/components/filters';
import { DataTable } from '@/components/data-table';
import { PaginationControls } from '@/components/pagination-controls';
import { EmpresaSelector, useGrupoEscopo } from '@/components/empresa-selector';
import { toast } from 'sonner';
import { motion } from 'framer-motion';

// ─── Inner client component (precisa de Suspense porque usa useSearchParams) ──

function DashboardClient() {
  const searchParams = useSearchParams();
  const router = useRouter();

  // ─── Escopo de filiais ───────────────────────────────────────────────────────
  const { empresas, defaultId, loading: escopoLoading } = useGrupoEscopo();

  // Lê empresa_id do query param; null = ainda não resolvido
  const paramRaw = searchParams.get('empresa_id');
  const empresaId: number | null = paramRaw !== null ? Number(paramRaw) : null;

  // Quando o endpoint de escopo retornar o default e ainda não houver param,
  // grava o default na URL (sem push de histórico)
  useEffect(() => {
    if (!escopoLoading && defaultId !== null && empresaId === null) {
      const params = new URLSearchParams(searchParams.toString());
      params.set('empresa_id', String(defaultId));
      router.replace(`/dashboard?${params.toString()}`);
    }
  }, [escopoLoading, defaultId, empresaId, router, searchParams]);

  // Troca de filial: atualiza URL (substitui histórico, sem push)
  const handleEmpresaChange = useCallback(
    (id: number) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set('empresa_id', String(id));
      router.replace(`/dashboard?${params.toString()}`);
    },
    [router, searchParams],
  );

  // ─── Dados de movimento ─────────────────────────────────────────────────────
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
  } = useEnvioMassa(empresaId ?? undefined);

  const { isActive, isLoading: processLoading, startProcess, stopProcess } = useProcessStatus({
    onRefresh: fetchData,
  });

  // Fetch inicial + refetch ao trocar empresa_id
  // empresaId já é propagado ao hook (tarefa 2.4); fetchData reflete a filial corrente.
  useEffect(() => {
    fetchData();
  }, [fetchData]); // fetchData muda quando empresaId muda (dep no hook)

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
      {/* Seção fixa: seletor de filial (só quando escopo > 1) + stats + actions + filters */}
      <div className="shrink-0 space-y-4">
        {/* Seletor de filial — visível apenas quando o grupo tem > 1 empresa (2.5 formaliza) */}
        {empresas.length > 1 && (
          <EmpresaSelector
            value={empresaId}
            onChange={handleEmpresaChange}
            disabled={loading}
          />
        )}

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

// ─── Page export — Suspense obrigatório para useSearchParams no App Router ─────
// https://nextjs.org/docs/app/api-reference/functions/use-search-params

export default function DashboardPage() {
  return (
    <Suspense>
      <DashboardClient />
    </Suspense>
  );
}

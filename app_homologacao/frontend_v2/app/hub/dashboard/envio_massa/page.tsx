'use client';

// hub-envio-massa (S8) FASE 5 (tasks.md 5.1) — rota `/hub/dashboard/envio_massa`.
//
// Reaproveita 100% os componentes/hooks do painel legado (`app/dashboard/
// page.tsx` + `app/dashboard/validacao-xml/page.tsx`) — nenhuma mudança de
// rede nova: o proxy `/api/*` já repassa cookies (Princípio III), e os 11
// endpoints legados que este módulo consome já ganharam os middlewares
// `hubEnvioMassaClaimsBridge`/`hubEnvioMassaRequirePermission` na FASE 3.
//
// Diferenças deliberadas frente a `app/dashboard/page.tsx`:
//   1. SEM `EmpresaSelector`/`useGrupoEscopo` — esses resolvem escopo
//      multi-filial do modelo LEGADO (grupo/matriz/filiais, query param
//      `empresa_id`). No hub, o escopo é a `entidade_ativa` da sessão
//      (troca de entidade é global, via EntitySwitcher do shell — S3), e o
//      backend já resolve `req.user.empresaId = entidade_ativa` dentro de
//      `hubEnvioMassaClaimsBridge` ANTES do handler rodar. Por isso os
//      hooks são chamados SEM override de empresaId (`useEnvioMassa()`) —
//      `resolveEmpresaAlvo` (routes/grupo.js) cai no caso 1
//      ("sem preferência de empresa → usa a do token") e retorna
//      exatamente `entidade_ativa`.
//   2. Guard FR-004 (SEM_ENTIDADE_ATIVA, clarify block-001/dec-010, opção
//      B): checado ANTES de montar qualquer componente reaproveitado, via
//      `entidadeAtiva` já disponível em `useHubAuth()` (mesmo `/me` que
//      resolve a claim usada pelo backend) — sinal síncrono e confiável,
//      sem depender de parsear `error.code` de dentro dos hooks legados
//      (`useEnvioMassa`/`useProcessStatus` engolem erros internamente,
//      `catch { setData([]) }`; mudar esse comportamento tocaria os hooks,
//      o que a tarefa 5.1.2 explicitamente pede para NÃO fazer — "hooks
//      tal como estão"). Contrato equivalente: nenhuma tela deste módulo
//      renderiza sem `entidade_ativa`, redirecionando para
//      `/selecionar-entidade` (mesma rota do shell, sem UI nova).
//   3. Inclui `XmlValidationCard` (hoje em `/dashboard/validacao-xml`,
//      rota separada no legado) como seção adicional da MESMA página —
//      tasks.md 5.1.2 pede a reutilização deste componente aqui.
//
// `app/dashboard/page.tsx` (legado) permanece 100% inalterado (FR-018) —
// nenhum import daqui toca aquele arquivo.
//
// Ref: docs/specs/hub-envio-massa/spec.md FR-004; contracts/claims-adapter.md;
// tasks.md FASE 5.

import { Suspense, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useHubAuth } from '@/contexts/hub-auth-context';
import { useEnvioMassa } from '@/hooks/use-envio-massa';
import { useProcessStatus } from '@/hooks/use-process-status';
import { StatsCards } from '@/components/stats-cards';
import { ActionBar } from '@/components/action-bar';
import { Filters } from '@/components/filters';
import { DataTable } from '@/components/data-table';
import { PaginationControls } from '@/components/pagination-controls';
import { XmlValidationCard } from '@/components/xml-validation-card';
import { toast } from 'sonner';
import { motion } from 'framer-motion';

export const SELECIONAR_ENTIDADE_ROUTE = '/selecionar-entidade';

function EnvioMassaSkeleton() {
  return (
    <div className="space-y-4">
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
      <div className="h-14 rounded-lg border bg-card animate-pulse" />
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

function EnvioMassaClient() {
  const { entidadeAtiva, carregando: carregandoAuth } = useHubAuth();
  const router = useRouter();

  // Guard FR-004 (diferença 2 do cabeçalho): sem entidade ativa, nenhuma
  // chamada aos hooks legados chega a ser útil — redireciona direto.
  useEffect(() => {
    if (!carregandoAuth && entidadeAtiva === null) {
      router.replace(SELECIONAR_ENTIDADE_ROUTE);
    }
  }, [carregandoAuth, entidadeAtiva, router]);

  // empresaId=undefined: backend resolve pela claim entidade_ativa do
  // token (diferença 1 do cabeçalho) — nunca passamos o query param aqui.
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
    if (!carregandoAuth && entidadeAtiva !== null) {
      fetchData();
    }
  }, [carregandoAuth, entidadeAtiva, fetchData]);

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

  // Enquanto o guard acima decide (auth carregando OU sem entidade ativa,
  // prestes a redirecionar), não monta nenhum componente reaproveitado —
  // evita flash de tabela vazia/chamadas fadadas a 403.
  if (carregandoAuth || entidadeAtiva === null) {
    return <EnvioMassaSkeleton />;
  }

  if (loading && stats.total === 0) {
    return <EnvioMassaSkeleton />;
  }

  return (
    <motion.div
      className="flex flex-col gap-4"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.3 }}
    >
      <div className="shrink-0 space-y-4">
        <div className="flex items-center justify-between gap-3">
          <h1 className="font-display text-xl font-bold tracking-tight sm:text-2xl">Envio em Massa</h1>
          <span
            role="status"
            aria-live="polite"
            className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${
              isActive
                ? 'border-success/30 bg-success/10 text-success'
                : 'border-border bg-muted text-muted-foreground'
            }`}
          >
            <span
              className={`h-2 w-2 rounded-full ${isActive ? 'bg-success pulse-ring' : 'bg-muted-foreground/60'}`}
              aria-hidden="true"
            />
            {processLoading ? 'Atualizando…' : isActive ? 'Processando' : 'Parado'}
          </span>
        </div>

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

      <div className="min-h-[300px]">
        <DataTable
          data={paginatedData}
          selectedIds={selectedIds}
          onToggleSelectAll={toggleSelectAll}
          onToggleSelect={toggleSelect}
          onDelete={deleteRecord}
          onUpdate={updateRecord}
        />
      </div>

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

      {/* tasks.md 5.1.2 — validação de XML em lote, reaproveitada de
          app/dashboard/validacao-xml/page.tsx como seção desta mesma
          página (no legado é rota separada; no hub, tudo em
          /hub/dashboard/envio_massa). */}
      <div className="shrink-0">
        <XmlValidationCard />
      </div>
    </motion.div>
  );
}

export default function EnvioMassaHubPage() {
  return (
    <Suspense>
      <EnvioMassaClient />
    </Suspense>
  );
}

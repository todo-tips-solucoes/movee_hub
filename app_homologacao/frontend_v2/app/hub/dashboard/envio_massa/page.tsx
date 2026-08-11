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
//   3. (hub-uiux-refresh, 2026-08-05) o `XmlValidationCard` que a tasks.md
//      5.1.2 embutia aqui migrou para o módulo próprio
//      `/hub/dashboard/validacao_xml` (migration 0045).
//
// `app/dashboard/page.tsx` (legado) permanece 100% inalterado (FR-018) —
// nenhum import daqui toca aquele arquivo.
//
// Ref: docs/specs/hub-envio-massa/spec.md FR-004; contracts/claims-adapter.md;
// tasks.md FASE 5.

import { Suspense, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useHubAuth } from '@/contexts/hub-auth-context';
import { useEnvioMassa } from '@/hooks/use-envio-massa';
import { useProcessStatus } from '@/hooks/use-process-status';
import { StatsCards } from '@/components/stats-cards';
import { ActionBar } from '@/components/action-bar';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Filters } from '@/components/filters';
import { DataTable } from '@/components/data-table';
import { PaginationControls } from '@/components/pagination-controls';
import { PageHeader } from '@/components/hub/page-header';
import { DisparoRecibo } from '@/components/hub/disparo-recibo';
import { initialFilters, computeStats, formatDateBR, temFiltroAtivo } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { AlertCircle } from 'lucide-react';
import { toast } from 'sonner';
import { motion, useReducedMotion } from 'framer-motion';

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
  const reduzirMovimento = useReducedMotion();

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
    data,
    stats,
    filters,
    loading,
    erro,
    currentPage,
    recordsPerPage,
    totalPages,
    filteredData,
    ordem,
    alternarOrdem,
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
    limparSelecao,
  } = useEnvioMassa();

  // `disparoConcluido`/`dispensarRecibo`: impeccable rodada 6 (P1-2) — o hook
  // detecta a virada ativo → inativo e a tela só decide o que desenhar.
  const {
    isActive,
    isLoading: processLoading,
    startProcess,
    stopProcess,
    disparoConcluido,
    dispensarRecibo,
    statusIndisponivel,
  } = useProcessStatus({ onRefresh: fetchData });

  useEffect(() => {
    if (!carregandoAuth && entidadeAtiva !== null) {
      fetchData();
    }
  }, [carregandoAuth, entidadeAtiva, fetchData]);

  // impeccable harden 2026-08-06: iniciar o disparo é a ação de maior raio
  // de dano do produto (notifica motoristas reais) — confirmação com resumo
  // de impacto antes de startProcess, mesmo idioma do CloseMovementDialog.
  const [confirmarDisparo, setConfirmarDisparo] = useState(false);

  // impeccable rodada 6 (P2): os checkboxes marcavam linhas e nenhuma ação as
  // consultava — quem marcasse 12 e clicasse em "Iniciar" disparava para o
  // movimento inteiro. Agora a seleção define o escopo.
  //
  // `data` e não `paginatedData`: a seleção sobrevive à troca de página, então
  // contar só o que está na tela mentiria de novo, ao contrário.
  const selecionados = useMemo(
    () => data.filter((d) => selectedIds.has(d.id)),
    [data, selectedIds]
  );
  // O backend envia apenas quem está com `enviado === 'off'` (linha já enviada
  // não é reenviada). Este é o número que sai de verdade — é ele que a
  // confirmação mostra, não o total marcado.
  const selecionadosPendentes = useMemo(
    () => selecionados.filter((d) => d.enviado === 'off').length,
    [selecionados]
  );

  // impeccable rodada 7 (P1): o que ESTE disparo alcançou. Sem isto o recibo
  // lia o `stats` do movimento inteiro e um disparo para 12 selecionados
  // terminava anunciando "352 enviadas" — nenhum daqueles números descrevia o
  // que tinha acabado de acontecer. Guardado no start e não derivado da seleção
  // atual porque o operador pode desmarcar tudo enquanto o envio roda.
  const [escopoDisparo, setEscopoDisparo] = useState<Set<number> | null>(null);

  /**
   * Período do movimento aberto (impeccable rodada 7, P1). `dt_inicial`/
   * `dt_final` já vinham em cada linha desde o upload e não apareciam em lugar
   * nenhum — nem no confirm do fechamento, que perguntava "Fechar o movimento?"
   * sem nunca dizer QUAL. Quem roda um ciclo semanal em duas abas não tinha
   * como saber que semana estava lacrando.
   *
   * Min/max e não `data[0]`: nada garante que todas as linhas compartilhem o
   * mesmo intervalo, e mostrar o da primeira linha como se fosse do movimento
   * seria afirmar mais do que se sabe.
   */
  const periodo = useMemo(() => {
    const inicios = data.map((d) => d.dt_inicial).filter((v): v is string => !!v);
    const finais = data.map((d) => d.dt_final).filter((v): v is string => !!v);
    if (inicios.length === 0 || finais.length === 0) return null;
    const de = formatDateBR(inicios.reduce((a, b) => (a < b ? a : b)));
    const ate = formatDateBR(finais.reduce((a, b) => (a > b ? a : b)));
    return de && ate ? `${de} a ${ate}` : null;
  }, [data]);

  /** Números do recibo: só as linhas que o disparo alcançou, ou o movimento
   *  inteiro quando o disparo não teve escopo. */
  const statsDoRecibo = useMemo(
    () => (escopoDisparo ? computeStats(data.filter((d) => escopoDisparo.has(d.id))) : stats),
    [escopoDisparo, data, stats]
  );

  const handleStart = async () => {
    try {
      const ids = selecionados.map((d) => d.id);
      // Sem seleção, `startProcess` recebe lista vazia e omite o campo: a rota
      // volta ao comportamento histórico (movimento aberto inteiro).
      await startProcess(ids);
      setEscopoDisparo(ids.length ? new Set(ids) : null);
      // A seleção já cumpriu seu papel: o escopo está guardado acima. Mantê-la
      // marcada faria o próximo confirm aparecer desabilitado (todas enviadas)
      // sem nada explicando que era preciso desmarcar antes.
      limparSelecao();
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
      // impeccable rodada 8 (P3): esta era a única rota do hub sem container
      // nem padding — as outras aplicam `p-4 sm:p-6 lg:p-8`, e a largura
      // acompanha as demais telas de tabela larga.
      className="mx-auto flex w-full max-w-[96rem] flex-col gap-4 p-4 sm:p-6 lg:p-8"
      // uiux-hub F4: respeita prefers-reduced-motion — sem fade quando o
      // usuário pediu menos movimento (conteúdo legível imediatamente).
      initial={reduzirMovimento ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: reduzirMovimento ? 0 : 0.3 }}
    >
      <div className="shrink-0 space-y-4">
        <PageHeader
          titulo="Envio em Massa"
          subtitulo={
            periodo
              ? `Movimento aberto · ${periodo} — disparo de notificações e validação de notas.`
              : 'Disparo de notificações e validação de notas do movimento aberto.'
          }
        >
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
            {/* impeccable rodada 5 (P1): a pílula dizia só "Processando" — a
                ação de maior consequência do produto (notifica motoristas
                reais, leva minutos) tinha o feedback mais pobre da interface.
                Os dois números já existem no `stats` que a tela carrega; o
                polling de 13s do useProcessStatus já refaz o fetchData, então
                o contador anda sozinho sem nenhuma chamada nova. */}
            {/* rodada 7: incerteza tem rótulo próprio. Antes, poll com erro
                virava "Parado" — a tela afirmava um fato que não sabia. */}
            {processLoading
              ? 'Atualizando…'
              : statusIndisponivel
                ? 'Status indisponível — tentando de novo'
                : isActive
                  ? `Enviando — ${stats.msgEnviada} de ${stats.total}`
                  : 'Parado'}
          </span>
        </PageHeader>

        {disparoConcluido && (
          <DisparoRecibo
            stats={statsDoRecibo}
            escopo={escopoDisparo?.size}
            // Filtro limpo + "Com Erro": partir dos filtros atuais poderia
            // devolver zero linhas (ex.: "Enviados" ligado) e desmentir o
            // número que o próprio recibo acabou de mostrar.
            //
            // rodada 14 (h3): limpar continua certo pelo motivo acima — o que
            // estava errado era limpar EM SILÊNCIO. Quem montou nove filtros
            // perdia os nove sem aviso e sem volta. O toast só aparece quando
            // havia mesmo algo a perder; sem filtro ativo, nada foi descartado
            // e um aviso seria ruído.
            onVerErros={() => {
              const anteriores = filters;
              updateFilters({ ...initialFilters, sucesso: 'yes' });
              if (temFiltroAtivo(anteriores)) {
                toast('Filtros substituídos para mostrar as linhas com erro.', {
                  action: { label: 'Desfazer', onClick: () => updateFilters(anteriores) },
                });
              }
            }}
            onDispensar={dispensarRecibo}
          />
        )}

        <StatsCards stats={stats} onFiltrar={updateFilters} indisponivel={erro !== null} />

        <ActionBar
          isActive={isActive}
          isProcessLoading={processLoading}
          onStart={() => setConfirmarDisparo(true)}
          onStop={handleStop}
          onUpload={uploadFile}
          onExportCSV={exportCSV}
          onDownloadXML={downloadXML}
          onCloseMovement={closeMovement}
          stats={stats}
          // impeccable rodada 7 (P1): o número do botão é o que SAI, não o que
          // está marcado — a r6 mandava `.length` aqui e `selecionadosPendentes`
          // para o diálogo, então marcar 12 com 5 já enviadas produzia
          // "Disparar para 12" na barra e "Disparar para 5" no confirm. Dois
          // números para a mesma ação é a mesma mentira que os checkboxes
          // contavam antes de terem destino.
          selecionados={selecionadosPendentes}
          selecionadosMarcados={selecionados.length}
          periodo={periodo}
          dadosIndisponiveis={erro !== null}
          onLimparSelecao={limparSelecao}
        />

        <Filters
          filters={filters}
          onChange={updateFilters}
          onReset={resetFilters}
        />
      </div>

      <div className="min-h-[300px]">
        {/* impeccable rodada 7 (P1): mesmo bloco de erro das outras 9 telas do
            hub. Sem ele, um 500 aqui era desenhado como "movimento vazio". */}
        {erro ? (
          <div
            role="alert"
            className="flex flex-col items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-10 text-center"
          >
            <AlertCircle className="size-8 text-destructive" aria-hidden="true" />
            <p className="text-sm font-medium text-destructive">{erro}</p>
            <Button size="sm" variant="outline" className="min-h-11 sm:min-h-8" onClick={fetchData}>
              Tentar novamente
            </Button>
          </div>
        ) : (
        <DataTable
          data={paginatedData}
          ordem={ordem}
          onOrdenar={alternarOrdem}
          selectedIds={selectedIds}
          onToggleSelectAll={toggleSelectAll}
          onToggleSelect={toggleSelect}
          onDelete={deleteRecord}
          onUpdate={updateRecord}
        />
        )}
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

      {/* hub-uiux-refresh (2026-08-05): a validação de XML em lote saiu
          desta página e virou módulo próprio do menu —
          /hub/dashboard/validacao_xml (migration 0045). */}

      <AlertDialog open={confirmarDisparo} onOpenChange={setConfirmarDisparo}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {selecionados.length > 0
                ? `Disparar para ${selecionadosPendentes} dos ${selecionados.length} selecionados?`
                : 'Iniciar envio em massa?'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {selecionados.length > 0 ? (
                // Com seleção, o número que importa é o que sai de verdade. Dizer
                // "12 selecionados" quando 5 já receberam seria a mesma mentira
                // que os checkboxes contavam antes de terem destino.
                <>
                  Você marcou {selecionados.length} registro
                  {selecionados.length === 1 ? '' : 's'}
                  {selecionados.length - selecionadosPendentes > 0 && (
                    <>
                      , mas {selecionados.length - selecionadosPendentes}{' '}
                      {selecionados.length - selecionadosPendentes === 1
                        ? 'já recebeu mensagem e será pulado'
                        : 'já receberam mensagem e serão pulados'}
                    </>
                  )}
                  .{' '}
                  {selecionadosPendentes === 0
                    ? 'Não há nada a enviar nessa seleção.'
                    : `A notificação sai para ${selecionadosPendentes} motorista${
                        selecionadosPendentes === 1 ? '' : 's'
                      }. O restante do movimento não é tocado.`}
                </>
              ) : erro !== null ? (
                // impeccable rodada 11 (P0): uma falha de carga zera `stats`, e o
                // texto abaixo descreveria como "0 registros" um movimento de 340
                // linhas — sobre a ação que MANDA MENSAGEM para gente de verdade.
                // É a mesma trava que o fechamento já tem desde a rodada 7; faltava
                // aqui, onde o efeito sai do sistema e não volta.
                <>
                  <strong className="text-destructive">
                    Os dados do movimento não puderam ser carregados
                  </strong>{' '}
                  — os números acima não valem. Recarregue a lista antes de disparar: sem eles não
                  dá para saber para quantos motoristas a mensagem sairia.
                </>
              ) : (
                <>
                  O processamento dispara as notificações do movimento aberto para os motoristas.
                  Neste momento o movimento tem {stats.total} registro
                  {stats.total === 1 ? '' : 's'}, {stats.msgEnviada} já com mensagem enviada e{' '}
                  {stats.total - stats.msgEnviada} ainda sem envio.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmarDisparo(false);
                handleStart();
              }}
              // Seleção inteira já enviada: não há disparo a confirmar. Lista que
              // falhou ao carregar (r11): idem — sem seleção, confirmar aqui
              // dispararia para o movimento ABERTO INTEIRO sobre números falsos.
              disabled={erro !== null || (selecionados.length > 0 && selecionadosPendentes === 0)}
              className="bg-success text-success-foreground hover:bg-success/90"
            >
              {selecionados.length > 0 ? `Disparar para ${selecionadosPendentes}` : 'Iniciar envio'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
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

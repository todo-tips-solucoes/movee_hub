'use client';

// adiantamento-motorista — app/hub/dashboard/adiantamentos/[id]/page.tsx
// (tasks.md 7.3.2/7.3.3/7.3.5, H02): detalhe da solicitação — cálculo, conta
// mascarada, timeline de eventos, histórico de lotes e as ações de transição
// (rejeitar/recalcular/encerrar/atualizar-conta/reprocessar/encerrar sem
// pagamento). Botão só aparece quando (a) o status atual é o único de onde a
// RPC aceita a transição (mesmo gate de routes/hub-adiantamentos.js — ver
// `PODE_*` abaixo) E (b) a entidade ativa tem a permissão que a rota exige.
//
// Divergência do protótipo H02: o card "Motorista" do mock mostra CNPJ da
// conta do app e um texto de confirmação de vínculo — `SolicitacaoDetalhe`
// real só carrega `motorista.entregadorId`/`motorista.nome`
// (adiantamento-dto.js#mapSolicitacaoResumo). Mostrado só o que existe
// (Constitution VI); o resto fica de fora, não fabricado.
//
// Ref: docs/specs/adiantamento-motorista/contracts/hub-api.md §Solicitações;
// prototipo H02.

import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { AlertCircle, ArrowLeft, Ban, Calculator, CreditCard, RefreshCw, RotateCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ListSkeleton } from '@/components/hub/table-skeleton';
import { AdiantamentoStatusBadge, rotuloStatusAdiantamento } from '@/components/hub/status-badge';
import {
  AdiantamentoAcaoDialog,
  useAdiantamentoAcaoDialog,
} from '@/components/hub/adiantamento-acao-dialog';
import {
  EncerrarFalhaDialog,
  useEncerrarFalhaDialog,
} from '@/components/hub/adiantamento-encerrar-falha';
import { useHubAuth } from '@/contexts/hub-auth-context';
import {
  AdiantamentosApiError,
  obterSolicitacao,
  type SolicitacaoDetalhe,
} from '@/lib/hub/adiantamentos-api';
import { LARGURA_DETALHE } from '@/lib/hub/larguras';
import { formatBRL, formatDateBR } from '@/lib/utils';

// Mesmo gate de status das RPCs `hub_adiantamento_*` (infra/hub/migrations/
// 0067_adiantamento_funcoes.sql) — cada `IF v_sol.status <> '...' THEN RAISE
// EXCEPTION 'TRANSICAO_INVALIDA'` vira uma linha aqui, para a UI nunca
// oferecer um botão que a rota recusaria.
const PODE_REJEITAR = new Set(['LIBERADA', 'AGUARDANDO_PRODUCAO']);
const PODE_RECALCULAR = new Set(['AGUARDANDO_PRODUCAO']);
const PODE_ENCERRAR = new Set(['AGUARDANDO_PRODUCAO']);
const PODE_ATUALIZAR_CONTA = new Set(['LIBERADA']);
const PODE_REPROCESSAR = new Set(['FALHOU']);
const PODE_ENCERRAR_FALHA = new Set(['FALHOU']);

function useSolicitacaoDetalhe(id: number) {
  const [detalhe, setDetalhe] = useState<SolicitacaoDetalhe | null>(null);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);

  const buscar = useCallback(async () => {
    setCarregando(true);
    setErro(null);
    try {
      const d = await obterSolicitacao(id);
      setDetalhe(d);
      return d;
    } catch (e) {
      setErro(e instanceof AdiantamentosApiError ? e.message : 'Não foi possível carregar a solicitação.');
      return null;
    } finally {
      setCarregando(false);
    }
  }, [id]);

  useEffect(() => {
    buscar();
  }, [buscar]);

  return { detalhe, carregando, erro, refetch: buscar };
}

function LinhaChaveValor({ chave, valor }: { chave: string; valor: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 text-sm">
      <dt className="text-muted-foreground">{chave}</dt>
      <dd className="text-right font-medium">{valor}</dd>
    </div>
  );
}

export default function AdiantamentoDetalhePage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = Number(params?.id);
  const { detalhe, carregando, erro, refetch } = useSolicitacaoDetalhe(id);
  const { permissoes } = useHubAuth();
  const podeGerenciar = permissoes.includes('adiantamentos.gerenciar');
  const podeReprocessar = permissoes.includes('adiantamentos.reprocessar');

  const acaoDialog = useAdiantamentoAcaoDialog({ id, onSucesso: () => refetch() });
  const encerrarFalhaDialog = useEncerrarFalhaDialog({ id, onSucesso: () => refetch() });

  const status = detalhe?.status ?? '';

  return (
    <div className={`mx-auto flex w-full ${LARGURA_DETALHE} flex-col gap-4 p-4 sm:p-6 lg:p-8`}>
      <Button
        variant="ghost"
        size="sm"
        className="w-fit min-h-11 gap-1.5 sm:min-h-8"
        onClick={() =>
          window.history.length > 1 ? router.back() : router.push('/hub/dashboard/adiantamentos')
        }
      >
        <ArrowLeft className="size-4" aria-hidden="true" />
        Voltar às solicitações
      </Button>

      {carregando && !detalhe ? (
        <ListSkeleton label="Carregando solicitação..." linhas={4} />
      ) : erro && !detalhe ? (
        <div role="alert" className="flex flex-col items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-10 text-center">
          <AlertCircle className="size-8 text-destructive" aria-hidden="true" />
          <p className="text-sm font-medium text-destructive">{erro}</p>
          <Button variant="outline" size="sm" className="min-h-11 sm:min-h-8" onClick={() => refetch()}>
            <RotateCw className="size-4" aria-hidden="true" />
            Tentar novamente
          </Button>
        </div>
      ) : detalhe ? (
        <>
          <Card>
            <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <CardTitle as="h1" className="font-mono text-lg">
                  {detalhe.integrationId}
                </CardTitle>
                <AdiantamentoStatusBadge status={detalhe.status} />
              </div>
              <div className="flex flex-wrap gap-2">
                {podeGerenciar && PODE_RECALCULAR.has(status) && (
                  <Button variant="outline" size="sm" className="min-h-11 gap-1.5 sm:min-h-8" onClick={() => acaoDialog.abrir('recalcular')}>
                    <Calculator className="size-4" aria-hidden="true" />
                    Recalcular
                  </Button>
                )}
                {podeGerenciar && PODE_ATUALIZAR_CONTA.has(status) && (
                  <Button variant="outline" size="sm" className="min-h-11 gap-1.5 sm:min-h-8" onClick={() => acaoDialog.abrir('atualizar-conta')}>
                    <CreditCard className="size-4" aria-hidden="true" />
                    Atualizar conta
                  </Button>
                )}
                {podeGerenciar && PODE_ENCERRAR.has(status) && (
                  <Button variant="outline" size="sm" className="min-h-11 gap-1.5 sm:min-h-8" onClick={() => acaoDialog.abrir('encerrar')}>
                    <Ban className="size-4" aria-hidden="true" />
                    Encerrar
                  </Button>
                )}
                {podeReprocessar && PODE_REPROCESSAR.has(status) && (
                  <Button variant="outline" size="sm" className="min-h-11 gap-1.5 sm:min-h-8" onClick={() => acaoDialog.abrir('reprocessar')}>
                    <RefreshCw className="size-4" aria-hidden="true" />
                    Reprocessar
                  </Button>
                )}
                {podeReprocessar && PODE_ENCERRAR_FALHA.has(status) && (
                  <Button variant="outline" size="sm" className="min-h-11 gap-1.5 sm:min-h-8" onClick={encerrarFalhaDialog.abrir}>
                    <Ban className="size-4" aria-hidden="true" />
                    Encerrar sem pagamento
                  </Button>
                )}
                {podeGerenciar && PODE_REJEITAR.has(status) && (
                  <Button variant="destructive" size="sm" className="min-h-11 gap-1.5 sm:min-h-8" onClick={() => acaoDialog.abrir('rejeitar')}>
                    <Ban className="size-4" aria-hidden="true" />
                    Rejeitar
                  </Button>
                )}
              </div>
            </CardHeader>
            <CardContent className="px-4">
              {detalhe.motivoStatus && (
                <p role="alert" className="mb-3 rounded-md bg-destructive/10 px-3 py-2 text-sm font-medium text-destructive">
                  {detalhe.motivoStatus}
                </p>
              )}
              <dl className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <LinhaChaveValor chave="Motorista" valor={detalhe.motorista.nome ?? '—'} />
                <LinhaChaveValor chave="Data da solicitação" valor={formatDateBR(detalhe.dataSolicitacao)} />
                <LinhaChaveValor chave="Data da produção" valor={formatDateBR(detalhe.dataProducao)} />
                <LinhaChaveValor chave="Valor líquido" valor={<span className="font-mono">{formatBRL(detalhe.valorLiquido)}</span>} />
                <LinhaChaveValor chave="Lote" valor={detalhe.loteId ?? '—'} />
              </dl>
            </CardContent>
          </Card>

          <div className="grid gap-4 sm:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle as="h2" className="text-base">
                  Cálculo
                </CardTitle>
              </CardHeader>
              <CardContent className="px-4">
                {detalhe.calculo ? (
                  <dl className="flex flex-col gap-1.5">
                    <LinhaChaveValor chave="Produção" valor={<span className="font-mono">{formatBRL(detalhe.calculo.producao ?? '0')}</span>} />
                    <LinhaChaveValor chave="Percentual" valor={detalhe.calculo.percentual !== null ? `${detalhe.calculo.percentual}%` : '—'} />
                    <LinhaChaveValor chave="Bruto" valor={<span className="font-mono">{formatBRL(detalhe.calculo.bruto ?? '0')}</span>} />
                    <LinhaChaveValor chave="Taxa" valor={<span className="font-mono">− {formatBRL(detalhe.calculo.taxa ?? '0')}</span>} />
                    <LinhaChaveValor chave="Líquido" valor={<span className="font-mono font-semibold">{formatBRL(detalhe.calculo.liquido)}</span>} />
                    <p className="mt-1 text-xs text-muted-foreground">
                      Fonte: {detalhe.calculo.fonte ?? '—'} · versão {detalhe.calculo.versaoConfiguracao ?? '—'}
                      {detalhe.calculo.calculadoEm ? ` · calculado em ${formatDateBR(detalhe.calculo.calculadoEm)}` : ''}
                    </p>
                  </dl>
                ) : (
                  <p className="text-sm text-muted-foreground">Ainda não calculado.</p>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle as="h2" className="text-base">
                  Conta de destino
                </CardTitle>
              </CardHeader>
              <CardContent className="px-4">
                {detalhe.contaMascarada ? (
                  <dl className="flex flex-col gap-1.5">
                    <LinhaChaveValor chave="Banco" valor={detalhe.contaMascarada.banco} />
                    <LinhaChaveValor chave="Agência" valor={<span className="font-mono">{detalhe.contaMascarada.agencia}</span>} />
                    <LinhaChaveValor chave="Conta" valor={<span className="font-mono">{detalhe.contaMascarada.contaMascarada}</span>} />
                    <LinhaChaveValor chave="Tipo" valor={detalhe.contaMascarada.tipoConta === 'CORRENTE' ? 'Corrente' : 'Poupança'} />
                    <LinhaChaveValor chave="Titular" valor={detalhe.contaMascarada.titularNome} />
                    <LinhaChaveValor chave="Documento" valor={<span className="font-mono">{detalhe.contaMascarada.documentoMascarado}</span>} />
                  </dl>
                ) : (
                  <p className="text-sm text-muted-foreground">Sem conta vinculada no momento da solicitação.</p>
                )}
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle as="h2" className="text-base">
                Eventos
              </CardTitle>
            </CardHeader>
            <CardContent className="px-4">
              {detalhe.eventos.length === 0 ? (
                <p className="text-sm text-muted-foreground">Nenhum evento registrado ainda.</p>
              ) : (
                <ol className="flex flex-col gap-3">
                  {detalhe.eventos.map((evento, i) => (
                    <li key={i} className="flex items-start gap-3 text-sm">
                      <span className="mt-1 size-2 shrink-0 rounded-full bg-primary" aria-hidden="true" />
                      <div>
                        <p className="font-medium">{rotuloStatusAdiantamento(evento.statusPara)}</p>
                        <p className="text-xs text-muted-foreground">
                          {formatDateBR(evento.ocorridoEm)} · {evento.atorTipo}
                          {evento.motivo ? ` · ${evento.motivo}` : ''}
                        </p>
                      </div>
                    </li>
                  ))}
                </ol>
              )}
            </CardContent>
          </Card>

          {detalhe.lotes.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle as="h2" className="text-base">
                  Histórico de lotes
                </CardTitle>
              </CardHeader>
              <CardContent className="px-4">
                <ul className="flex flex-col gap-2 text-sm">
                  {detalhe.lotes.map((lote) => (
                    <li key={lote.id} className="flex items-center justify-between gap-2">
                      <span className="font-mono">{lote.numero}</span>
                      <span className="text-muted-foreground">{lote.status}</span>
                      <span className="font-mono">{formatBRL(lote.valorTotal)}</span>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}
        </>
      ) : null}

      <AdiantamentoAcaoDialog d={acaoDialog} />
      <EncerrarFalhaDialog d={encerrarFalhaDialog} />
    </div>
  );
}

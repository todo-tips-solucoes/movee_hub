'use client';

// adiantamento-motorista — app/hub/dashboard/adiantamentos/contas/[id]/page.tsx
// (tasks.md 7.5.2, H07): revisão dedicada de UMA conta bancária — dado
// COMPLETO (`completo=true`, permissão `adiantamentos.contas_revisar`,
// auditado como `conta_bancaria.visualizada` pelo próprio backend, FR-019) e
// confirmação explícita do entregador vinculado (FR-018,
// data-model.md: "Aprovar exige entregador_confirmado_id = entregador_id").
//
// Divergência do protótipo H07: o mock mostra lado a lado "conta aprovada
// hoje" vs "nova solicitação" e o texto "Vínculo automático por nome
// (similaridade 0,96)". Não existe endpoint que devolva a conta aprovada
// atual do mesmo entregador para comparação, nem a API guarda
// score/data de um vínculo automático — mostrado só o que
// `GET /contas/:id?completo=true` de fato devolve (Constitution VI).
//
// Ref: docs/specs/adiantamento-motorista/contracts/hub-api.md §Contas
// bancárias; spec.md US3/FR-018/FR-019; data-model.md; prototipo H07.

import { useCallback, useEffect, useId, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { AlertCircle, ArrowLeft, Ban, Eye, Loader2, Verified } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ListSkeleton } from '@/components/hub/table-skeleton';
import { ContaStatusBadge } from '@/components/hub/status-badge';
import {
  AdiantamentosApiError,
  aprovarConta,
  obterContaCompleta,
  rejeitarConta,
  type ContaCompletaAdiantamento,
} from '@/lib/hub/adiantamentos-api';
import { LARGURA_DETALHE } from '@/lib/hub/larguras';
import { formatDateBR } from '@/lib/utils';

const MOTIVO_MAX = 500;

function useContaCompleta(id: number) {
  const [conta, setConta] = useState<ContaCompletaAdiantamento | null>(null);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);

  const buscar = useCallback(async () => {
    setCarregando(true);
    setErro(null);
    try {
      const c = await obterContaCompleta(id);
      setConta(c);
      return c;
    } catch (e) {
      setErro(
        e instanceof AdiantamentosApiError && e.status === 403
          ? 'Você não tem permissão para revisar dados bancários completos.'
          : e instanceof AdiantamentosApiError
            ? e.message
            : 'Não foi possível carregar a conta bancária.'
      );
      return null;
    } finally {
      setCarregando(false);
    }
  }, [id]);

  useEffect(() => {
    buscar();
  }, [buscar]);

  return { conta, carregando, erro, refetch: buscar };
}

function LinhaChaveValor({ chave, valor }: { chave: string; valor: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 text-sm">
      <dt className="text-muted-foreground">{chave}</dt>
      <dd className="text-right font-medium">{valor}</dd>
    </div>
  );
}

export default function AdiantamentoContaDetalhePage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = Number(params?.id);
  const { conta, carregando, erro, refetch } = useContaCompleta(id);

  const [confirmado, setConfirmado] = useState(false);
  const [aprovando, setAprovando] = useState(false);
  const [rejeitando, setRejeitando] = useState(false);
  const [dialogRejeitar, setDialogRejeitar] = useState(false);
  const [motivo, setMotivo] = useState('');
  const motivoInputId = useId();

  const podeAprovar = conta?.status === 'PENDENTE';

  const aprovar = useCallback(async () => {
    if (!conta || !confirmado) return;
    setAprovando(true);
    try {
      await aprovarConta(conta.id, conta.entregadorVinculado.entregadorId);
      toast.success('Conta aprovada.');
      refetch();
    } catch (e) {
      toast.error(e instanceof AdiantamentosApiError ? e.message : 'Não foi possível aprovar a conta.');
    } finally {
      setAprovando(false);
    }
  }, [conta, confirmado, refetch]);

  const rejeitar = useCallback(async () => {
    if (!conta || motivo.trim().length < 3) return;
    setRejeitando(true);
    try {
      await rejeitarConta(conta.id, motivo.trim());
      toast.success('Conta rejeitada. O motorista foi notificado.');
      setDialogRejeitar(false);
      setMotivo('');
      refetch();
    } catch (e) {
      toast.error(e instanceof AdiantamentosApiError ? e.message : 'Não foi possível rejeitar a conta.');
    } finally {
      setRejeitando(false);
    }
  }, [conta, motivo, refetch]);

  return (
    <div className={`mx-auto flex w-full ${LARGURA_DETALHE} flex-col gap-4 p-4 sm:p-6 lg:p-8`}>
      <Button
        variant="ghost"
        size="sm"
        className="w-fit min-h-11 gap-1.5 sm:min-h-8"
        onClick={() =>
          window.history.length > 1 ? router.back() : router.push('/hub/dashboard/adiantamentos/contas')
        }
      >
        <ArrowLeft className="size-4" aria-hidden="true" />
        Voltar às contas bancárias
      </Button>

      {carregando && !conta ? (
        <ListSkeleton label="Carregando conta bancária..." linhas={4} />
      ) : erro && !conta ? (
        <div role="alert" className="flex flex-col items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-10 text-center">
          <AlertCircle className="size-8 text-destructive" aria-hidden="true" />
          <p className="text-sm font-medium text-destructive">{erro}</p>
          <Button variant="outline" size="sm" className="min-h-11 sm:min-h-8" onClick={() => refetch()}>
            Tentar novamente
          </Button>
        </div>
      ) : conta ? (
        <>
          <div role="status" className="flex items-center gap-2 rounded-md bg-warning/10 px-3 py-2 text-sm text-warning-strong">
            <Eye className="size-4 shrink-0" aria-hidden="true" />
            Dados completos visíveis — esta visualização fica registrada na auditoria (FR-019).
          </div>

          <Card>
            <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <CardTitle as="h1" className="text-lg">
                  {conta.titularNome}
                </CardTitle>
                <ContaStatusBadge status={conta.status} />
              </div>
              {podeAprovar && (
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="destructive"
                    size="sm"
                    className="min-h-11 gap-1.5 sm:min-h-8"
                    onClick={() => setDialogRejeitar(true)}
                  >
                    <Ban className="size-4" aria-hidden="true" />
                    Rejeitar
                  </Button>
                  <Button
                    size="sm"
                    className="min-h-11 gap-1.5 sm:min-h-8"
                    disabled={!confirmado || aprovando}
                    onClick={aprovar}
                  >
                    {aprovando && <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden="true" />}
                    <Verified className="size-4" aria-hidden="true" />
                    Aprovar conta
                  </Button>
                </div>
              )}
            </CardHeader>
            <CardContent className="px-4">
              {conta.motivoRejeicao && (
                <p role="alert" className="mb-3 rounded-md bg-destructive/10 px-3 py-2 text-sm font-medium text-destructive">
                  {conta.motivoRejeicao}
                </p>
              )}
              <dl className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <LinhaChaveValor chave="Documento" valor={<span className="font-mono">{conta.titularDocumento}</span>} />
                <LinhaChaveValor chave="Banco" valor={conta.banco} />
                <LinhaChaveValor chave="Agência" valor={<span className="font-mono">{conta.agencia}</span>} />
                <LinhaChaveValor
                  chave="Conta"
                  valor={<span className="font-mono">{conta.conta}-{conta.contaDigito}</span>}
                />
                <LinhaChaveValor chave="Tipo" valor={conta.tipoConta === 'CORRENTE' ? 'Conta Corrente' : 'Poupança'} />
                <LinhaChaveValor
                  chave="Chave PIX"
                  valor={conta.chavePixTipo ? `${conta.chavePixTipo} · ${conta.chavePix ?? '—'}` : '—'}
                />
                <LinhaChaveValor chave="E-mail para comprovante" valor={conta.emailComprovante ?? '—'} />
                <LinhaChaveValor chave="Origem" valor={conta.origem === 'CARGA_INICIAL' ? 'Carga inicial' : 'App'} />
                <LinhaChaveValor chave="Enviada em" valor={formatDateBR(conta.solicitadaEm)} />
                {conta.revisadaEm && <LinhaChaveValor chave="Revisada em" valor={formatDateBR(conta.revisadaEm)} />}
              </dl>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle as="h2" className="text-base">
                Confirme o entregador
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3 px-4">
              <p className="text-sm">{conta.entregadorVinculado.nome ?? `Entregador #${conta.entregadorVinculado.entregadorId}`}</p>
              {podeAprovar ? (
                <label className="flex items-start gap-2 text-sm">
                  <Checkbox
                    checked={confirmado}
                    onCheckedChange={(v) => setConfirmado(v === true)}
                    aria-label="Confirmo que a conta pertence ao motorista deste entregador"
                  />
                  <span>Confirmo que a conta pertence ao motorista deste entregador.</span>
                </label>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Esta conta já foi revisada e não está mais pendente de confirmação.
                </p>
              )}
            </CardContent>
          </Card>

          {conta.alertas.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle as="h2" className="text-base">
                  Alertas
                </CardTitle>
              </CardHeader>
              <CardContent className="px-4">
                <ul className="flex list-inside list-disc flex-col gap-1 text-sm text-warning-strong">
                  {conta.alertas.map((a) => (
                    <li key={a}>{a}</li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}
        </>
      ) : null}

      <Dialog open={dialogRejeitar} onOpenChange={(open) => !rejeitando && setDialogRejeitar(open)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rejeitar dados bancários?</DialogTitle>
            <DialogDescription>
              A conta aprovada atual (se houver) continua ativa. O motorista recebe o motivo e pode corrigir
              e reenviar.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between">
              <label htmlFor={`${motivoInputId}-motivo`} className="text-sm font-medium">
                Motivo (obrigatório)
              </label>
              <span className="text-xs text-muted-foreground">{motivo.length}/{MOTIVO_MAX}</span>
            </div>
            <textarea
              id={`${motivoInputId}-motivo`}
              value={motivo}
              maxLength={MOTIVO_MAX}
              disabled={rejeitando}
              onChange={(e) => setMotivo(e.target.value)}
              rows={3}
              placeholder="Explique o motivo — o motorista pode ver este texto."
              className="w-full rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50 md:text-sm dark:bg-input/30"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" className="min-h-11 sm:min-h-8" disabled={rejeitando} onClick={() => setDialogRejeitar(false)}>
              Voltar
            </Button>
            <Button
              variant="destructive"
              className="min-h-11 sm:min-h-8"
              disabled={motivo.trim().length < 3 || rejeitando}
              onClick={rejeitar}
            >
              {rejeitando && <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden="true" />}
              Rejeitar alteração
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

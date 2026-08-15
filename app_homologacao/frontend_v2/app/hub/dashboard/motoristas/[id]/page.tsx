'use client';

// hub-motoristas (S5) FASE 7 task 7.1.1 — rota
// `/hub/dashboard/motoristas/[id]`: detalhe + indicadores + edição de
// nome/ativo + painel de vínculo (sugestões/busca manual/confirmação,
// task 7.2) + desvínculo com confirmação (task 7.2.4).
//
// Controles de edição 100% ocultos para quem não tem `motoristas.editar`
// (FR-005/SC-006/task 7.1.2) — o backend já é fail-closed (403), esta tela
// só evita expor a affordance a quem não pode usá-la.
//
// Ref: docs/specs/hub-motoristas/contracts/motoristas-api.md
// §GET /motoristas/:id, §PATCH /motoristas/:id,
// §GET /motoristas/:id/sugestoes, §DELETE /motoristas/:id/vinculo,
// quickstart Cenários 1-9/12.

import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { toast } from 'sonner';
import {
  AlertCircle,
  ArrowLeft,
  Check,
  Link2,
  Link2Off,
  Loader2,
  Pencil,
  RotateCw,
  X,
} from 'lucide-react';
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
import { Badge } from '@/components/ui/badge';
import { AtivoBadge } from '@/components/hub/status-badge';
import { CopyableUuid } from '@/components/hub/copyable-uuid';
import { ListSkeleton } from '@/components/hub/table-skeleton';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { useHubAuth } from '@/contexts/hub-auth-context';
import { useVinculoMotoristaDialog, VinculoMotoristaDialog } from '@/components/hub/vinculo-motorista-dialog';
import {
  CredencialMotoristaAcoes,
  CredencialMotoristaDialogs,
  useCredencialMotoristaDialog,
} from '@/components/hub/credencial-motorista-dialog';
import { AtividadesMotoristaSection, useAtividadesMotorista } from '@/components/hub/atividades-motorista-section';
import {
  desvincularMotorista,
  editarMotorista,
  obterMotorista,
  obterSugestoes,
  MotoristaApiError,
} from '@/lib/hub/motoristas-api';
import type { AtividadesPaginadas, MotoristaDetalhe } from '@/lib/hub/motoristas-dto';
import { formatDateBR } from '@/lib/utils';

const ATIVIDADES_VAZIAS: AtividadesPaginadas = { items: [], total: 0, offset: 0, limit: 20 };

/** Lógica isolada do JSX (mesmo padrão de `useImportacaoPolling`/`usePerfil`). */
export function useMotoristaDetalhe(id: number) {
  const [detalhe, setDetalhe] = useState<MotoristaDetalhe | null>(null);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);

  const buscar = useCallback(async () => {
    setCarregando(true);
    setErro(null);
    try {
      const resposta = await obterMotorista(id);
      setDetalhe(resposta);
      return resposta;
    } catch (e) {
      setErro(e instanceof MotoristaApiError ? e.message : 'Não foi possível carregar o motorista.');
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

export default function MotoristaDetalhePage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = Number(params?.id);
  const { permissoes } = useHubAuth();
  const podeEditar = permissoes.includes('motoristas.editar');
  // FASE 5 (task 5.5) — gestão de credencial de acesso ao app do motorista
  // visível/acionável SOMENTE com `motoristas.credencial` (permissão
  // distinta de `motoristas.editar`, seed 0044) — mesmo padrão de
  // `podeEditar` acima.
  const podeCredencial = permissoes.includes('motoristas.credencial');

  const { detalhe, carregando, erro, refetch } = useMotoristaDetalhe(id);

  // Edição de nome/ativo (7.1.1 + FR-004)
  const [editando, setEditando] = useState(false);
  const [nomeEdicao, setNomeEdicao] = useState('');
  const [ativoEdicao, setAtivoEdicao] = useState(true);
  const [salvando, setSalvando] = useState(false);
  const [erroEdicao, setErroEdicao] = useState<string | null>(null);

  const iniciarEdicao = useCallback(() => {
    if (!detalhe) return;
    setNomeEdicao(detalhe.nome);
    setAtivoEdicao(detalhe.ativo);
    setErroEdicao(null);
    setEditando(true);
  }, [detalhe]);

  const cancelarEdicao = useCallback(() => {
    setEditando(false);
    setErroEdicao(null);
  }, []);

  const salvarEdicao = useCallback(async () => {
    if (!detalhe) return;
    if (nomeEdicao.trim().length === 0) {
      setErroEdicao('O nome não pode ficar vazio.');
      return;
    }
    setSalvando(true);
    setErroEdicao(null);
    try {
      const body: { nome?: string; ativo?: boolean } = {};
      if (nomeEdicao.trim() !== detalhe.nome) body.nome = nomeEdicao.trim();
      if (ativoEdicao !== detalhe.ativo) body.ativo = ativoEdicao;
      if (Object.keys(body).length > 0) {
        await editarMotorista(id, body);
        await refetch();
        toast.success('Alterações salvas.');
      }
      setEditando(false);
    } catch (e) {
      setErroEdicao(e instanceof MotoristaApiError ? e.message : 'Falha ao salvar as alterações.');
    } finally {
      setSalvando(false);
    }
  }, [detalhe, nomeEdicao, ativoEdicao, id, refetch]);

  // Sugestões (pré-carregadas p/ o diálogo de vínculo — task 7.2.1)
  const [sugestoes, setSugestoes] = useState<{
    items: import('@/lib/hub/motoristas-dto').ContaCandidata[];
    entidadeElegivel: boolean;
  }>({ items: [], entidadeElegivel: false });

  useEffect(() => {
    if (!podeEditar || !Number.isFinite(id)) return;
    obterSugestoes(id)
      .then(setSugestoes)
      .catch(() => setSugestoes({ items: [], entidadeElegivel: false }));
  }, [id, podeEditar, detalhe?.vinculo?.contaMotoristaId]);

  const vinculoDialog = useVinculoMotoristaDialog({
    entregadorId: id,
    sugestoesIniciais: sugestoes.items,
    entidadeElegivel: sugestoes.entidadeElegivel,
    onVinculado: () => {
      refetch();
      toast.success('Conta de acesso vinculada.');
    },
  });

  // Credencial de acesso ao app (task 5.5) — mesmo padrão de vinculoDialog
  // acima: hook isolado do JSX, `onAtualizado` re-busca o detalhe (reflete
  // `vinculo.ativo` novo) + feedback de sucesso.
  const credencialDialog = useCredencialMotoristaDialog({
    entregadorId: id,
    onAtualizado: () => {
      refetch();
      toast.success('Credencial atualizada.');
    },
  });

  // FASE 6 (tasks.md 6.5) — seção "Atividades" read-only. Reinicia (volta à
  // 1ª página) sempre que o detalhe é buscado de novo (edição/vínculo/
  // credencial), mesmo padrão de qualquer lista que depende de um estado
  // que pode ter mudado por fora.
  const atividadesState = useAtividadesMotorista(id, detalhe?.atividades ?? ATIVIDADES_VAZIAS);
  useEffect(() => {
    if (detalhe) atividadesState.reiniciar(detalhe.atividades);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detalhe]);

  // Desvínculo com confirmação (task 7.2.4)
  const [confirmandoDesvinculo, setConfirmandoDesvinculo] = useState(false);
  const [desvinculando, setDesvinculando] = useState(false);
  const [erroDesvinculo, setErroDesvinculo] = useState<string | null>(null);

  const confirmarDesvinculo = useCallback(async () => {
    setDesvinculando(true);
    setErroDesvinculo(null);
    try {
      await desvincularMotorista(id);
      await refetch();
      setConfirmandoDesvinculo(false);
      toast.success('Conta de acesso desvinculada.');
    } catch (e) {
      setErroDesvinculo(e instanceof MotoristaApiError ? e.message : 'Falha ao desvincular a conta.');
    } finally {
      setDesvinculando(false);
    }
  }, [id, refetch]);

  if (!Number.isFinite(id)) {
    return (
      <div className="mx-auto max-w-3xl p-4 sm:p-6">
        <p role="alert" className="text-sm font-medium text-destructive">
          Identificador de motorista inválido.
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 p-4 sm:p-6 lg:p-8">
      <Button
        variant="ghost"
        size="sm"
        className="w-fit min-h-11 gap-1.5 sm:min-h-8"
        // impeccable r22 (P1): `push` do caminho nu descartava a query que o
        // `useFiltrosUrl` da lista tinha acabado de escrever — o botão chamado
        // "Voltar à lista" era o único caminho que NÃO devolvia a lista como
        // estava. `back()` volta à entrada anterior do histórico, que é a lista
        // com filtro, página e rolagem. O `push` fica como saída para quem
        // abriu o detalhe direto (link colado, aba nova): aí não há a que voltar.
        onClick={() =>
          window.history.length > 1
            ? router.back()
            : router.push('/hub/dashboard/motoristas')
        }
      >
        <ArrowLeft className="size-4" aria-hidden="true" />
        Voltar à lista
      </Button>

      {carregando && !detalhe ? (
        <ListSkeleton label="Carregando motorista..." linhas={4} />
      ) : erro && !detalhe ? (
        <div
          role="alert"
          className="flex flex-col items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-10 text-center"
        >
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
              {editando ? (
                <div className="flex flex-1 flex-col gap-1">
                  <label htmlFor="motorista-edicao-nome" className="text-xs text-muted-foreground">
                    Nome
                  </label>
                  <Input
                    id="motorista-edicao-nome"
                    value={nomeEdicao}
                    onChange={(e) => setNomeEdicao(e.target.value)}
                    disabled={salvando}
                    className="h-11 sm:h-9"
                  />
                </div>
              ) : (
                <CardTitle as="h1" className="text-lg">
                  {detalhe.nome}
                </CardTitle>
              )}
              <div className="flex items-center gap-2">
                <AtivoBadge ativo={detalhe.ativo} />
                {detalhe.nomeEditadoManualmente && <Badge variant="secondary">Nome editado manualmente</Badge>}
              </div>
            </CardHeader>
            <CardContent className="flex flex-col gap-3 px-4">
              {/* uuid copiável (FR-016, task 4.1.2/4.1.3) — identificador
                  canônico da planilha de origem, imutável (nunca editável
                  nesta tela). */}
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span>Identificador:</span>
                <CopyableUuid value={detalhe.idExterno} label={`Copiar identificador de ${detalhe.nome}`} />
              </div>

              {editando && (
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox checked={ativoEdicao} onCheckedChange={(v) => setAtivoEdicao(v === true)} disabled={salvando} />
                  Ativo
                </label>
              )}

              {erroEdicao && (
                <p role="alert" className="flex items-center gap-2 rounded-md bg-destructive/10 px-3 py-2 text-sm font-medium text-destructive">
                  <AlertCircle className="size-4 shrink-0" aria-hidden="true" />
                  {erroEdicao}
                </p>
              )}

              {podeEditar && (
                <div className="flex flex-wrap gap-2">
                  {editando ? (
                    <>
                      <Button size="sm" className="min-h-11 sm:min-h-8" disabled={salvando} onClick={salvarEdicao}>
                        {salvando ? (
                          <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden="true" />
                        ) : (
                          <Check className="size-4" aria-hidden="true" />
                        )}
                        Salvar
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="min-h-11 sm:min-h-8"
                        disabled={salvando}
                        onClick={cancelarEdicao}
                      >
                        <X className="size-4" aria-hidden="true" />
                        Cancelar
                      </Button>
                    </>
                  ) : (
                    <Button size="sm" variant="outline" className="min-h-11 sm:min-h-8" onClick={iniciarEdicao}>
                      <Pencil className="size-4" aria-hidden="true" />
                      Editar
                    </Button>
                  )}
                </div>
              )}

              <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
                <div>
                  <p className="text-xs text-muted-foreground">Lançamentos de faturamento</p>
                  <p className="font-mono">{detalhe.resumo.totalFaturamento}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Turnos de performance</p>
                  <p className="font-mono">{detalhe.resumo.totalPerformance}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Atividade mais recente</p>
                  <p>{formatDateBR(detalhe.resumo.dataMaisRecente) || '-'}</p>
                </div>
              </div>

              {detalhe.areas.length > 0 && (
                <div>
                  <p className="text-xs text-muted-foreground">Áreas (subpraças)</p>
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    {detalhe.areas.map((a) => (
                      <Badge key={a.subpraca} variant="outline" title={formatDateBR(a.dataMaisRecente) || undefined}>
                        {a.subpraca}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle as="h2" className="text-base">
                Conta de acesso vinculada
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3 px-4">
              {detalhe.vinculo ? (
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3">
                  <div>
                    <p className="font-medium">{detalhe.vinculo.nome}</p>
                    <p className="font-mono text-xs text-muted-foreground">{detalhe.vinculo.cnpjPrestadorMascarado}</p>
                  </div>
                  {podeEditar && (
                    <div className="flex gap-2">
                      <Button size="sm" variant="outline" className="min-h-11 sm:min-h-8" onClick={() => vinculoDialog.setOpen(true)}>
                        <Link2 className="size-4" aria-hidden="true" />
                        Trocar
                      </Button>
                      <Button
                        size="sm"
                        variant="destructive"
                        className="min-h-11 sm:min-h-8"
                        onClick={() => setConfirmandoDesvinculo(true)}
                      >
                        <Link2Off className="size-4" aria-hidden="true" />
                        Desvincular
                      </Button>
                    </div>
                  )}
                </div>
              ) : (
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-dashed p-3">
                  <p className="text-sm text-muted-foreground">Nenhuma conta de acesso vinculada.</p>
                  {podeEditar && (
                    <Button size="sm" className="min-h-11 sm:min-h-8" onClick={() => vinculoDialog.setOpen(true)}>
                      <Link2 className="size-4" aria-hidden="true" />
                      Vincular
                    </Button>
                  )}
                </div>
              )}

              {erroDesvinculo && (
                <p role="alert" className="flex items-center gap-2 rounded-md bg-destructive/10 px-3 py-2 text-sm font-medium text-destructive">
                  <AlertCircle className="size-4 shrink-0" aria-hidden="true" />
                  {erroDesvinculo}
                </p>
              )}
            </CardContent>
          </Card>

          {podeCredencial && (
            <Card>
              <CardHeader>
                <CardTitle as="h2" className="text-base">
                  Credencial de acesso
                </CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-3 px-4">
                {detalhe.vinculo ? (
                  <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3">
                    <div>
                      <p className="text-sm text-muted-foreground">
                        Situação da credencial:{' '}
                        <span className={detalhe.vinculo.ativo ? 'font-medium text-success' : 'font-medium text-destructive'}>
                          {detalhe.vinculo.ativo ? 'ativa' : 'desativada'}
                        </span>
                      </p>
                    </div>
                    <CredencialMotoristaAcoes state={credencialDialog} credencialAtiva={detalhe.vinculo.ativo} />
                  </div>
                ) : (
                  <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-dashed p-3">
                    <p className="text-sm text-muted-foreground">Nenhuma credencial de acesso criada.</p>
                    <CredencialMotoristaAcoes state={credencialDialog} credencialAtiva={null} />
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {/* FASE 6 (tasks.md 6.5) — read-only, visível a qualquer usuário
              com `motoristas.consultar` (sem exigir permissão de escrita —
              FR-020/FR-022), mesmo padrão de acesso do resto do detalhe. */}
          <AtividadesMotoristaSection carregandoDetalhe={carregando && !detalhe} state={atividadesState} />

          {podeCredencial && <CredencialMotoristaDialogs state={credencialDialog} />}

          {podeEditar && <VinculoMotoristaDialog state={vinculoDialog} />}

          {podeEditar && (
            <AlertDialog open={confirmandoDesvinculo} onOpenChange={setConfirmandoDesvinculo}>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Desvincular conta de acesso</AlertDialogTitle>
                  <AlertDialogDescription>
                    Tem certeza que deseja desvincular esta conta de {detalhe.nome}? A pessoa perde acesso ao app
                    motorista até que outra conta seja vinculada.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel disabled={desvinculando}>Cancelar</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={confirmarDesvinculo}
                    disabled={desvinculando}
                    className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  >
                    {desvinculando && <Loader2 className="mr-2 size-4 motion-safe:animate-spin" aria-hidden="true" />}
                    Desvincular
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
        </>
      ) : null}
    </div>
  );
}

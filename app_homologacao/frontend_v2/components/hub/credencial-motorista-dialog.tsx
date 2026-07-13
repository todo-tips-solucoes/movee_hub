'use client';

// hub-motorista-canonico FASE 5 (task 5.5) — gestão de credencial de acesso
// ao app do motorista no detalhe do Entregador. Ações visíveis/acionáveis
// SOMENTE com a permissão `motoristas.credencial` — a página-mãe
// (`app/hub/dashboard/motoristas/[id]/page.tsx`) decide a visibilidade
// (mesmo padrão de `podeEditar` para `motoristas.editar`); este componente
// não repete o gate, só assume que só é renderizado quando permitido.
//
// 3 fluxos, cada um com seu próprio diálogo controlado (mesmo padrão de
// `vinculo-motorista-dialog.tsx`/`motorista-detalhe-dialog.tsx` — hook
// `useXDialog` isolado do JSX):
//   1. Criar credencial — form (`cnpjPrestador` + `senhaInicial` opcional).
//      Em caso de sucesso com senha AUTO-gerada (nenhuma `senhaInicial`
//      enviada), revela `senhaTemporaria` num 2º passo do MESMO diálogo —
//      o backend nunca a persiste em claro nem a devolve de novo depois
//      desta resposta (contracts §POST /credencial).
//   2. Redefinir senha — confirmação destrutiva (AlertDialog: invalida a
//      senha atual IMEDIATAMENTE, FR-019) -> revela `tokenDefinicao` (60
//      min, uso único) num diálogo separado.
//   3. Ativar/Desativar — toggle com confirmação destrutiva (mesmo padrão
//      já usado no detalhe para "Desvincular"), independente da situação
//      do motorista (FR-015/FR-018).
//
// Ref: docs/specs/hub-motorista-canonico/contracts/api-motorista-canonico.md
// §WS-C Credencial, tasks.md FASE 5 (5.5).

import { useCallback, useState } from 'react';
import { AlertCircle, KeyRound, Loader2, Power, ShieldCheck } from 'lucide-react';
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
import { Button } from '@/components/ui/button';
import { CopyableUuid } from '@/components/hub/copyable-uuid';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  atualizarCredencial,
  criarCredencial,
  resetSenhaCredencial,
  MotoristaApiError,
} from '@/lib/hub/motoristas-api';

export interface UseCredencialMotoristaDialogArgs {
  entregadorId: number;
  /** Chamado após QUALQUER ação bem-sucedida (criar/reset/ativar-desativar)
   * — a página-mãe re-busca o detalhe para refletir o novo estado
   * (`vinculo.ativo`, FASE 5 task 5.5). */
  onAtualizado: () => void;
}

type PassoCriar = 'form' | 'revelar';

/** Lógica isolada do JSX (mesmo padrão de `useVinculoMotoristaDialog`). */
export function useCredencialMotoristaDialog({ entregadorId, onAtualizado }: UseCredencialMotoristaDialogArgs) {
  // --- 1. criar ---
  const [criarOpen, setCriarOpenState] = useState(false);
  const [criarPasso, setCriarPasso] = useState<PassoCriar>('form');
  const [cnpjPrestador, setCnpjPrestador] = useState('');
  const [senhaInicial, setSenhaInicial] = useState('');
  const [criando, setCriando] = useState(false);
  const [erroCriar, setErroCriar] = useState<string | null>(null);
  const [senhaRevelada, setSenhaRevelada] = useState<string | null>(null);

  const setCriarOpen = useCallback((next: boolean) => {
    setCriarOpenState(next);
    if (!next) {
      setCnpjPrestador('');
      setSenhaInicial('');
      setErroCriar(null);
      setCriarPasso('form');
      setSenhaRevelada(null);
    }
  }, []);

  const abrirCriar = useCallback(() => setCriarOpen(true), [setCriarOpen]);

  const confirmarCriar = useCallback(async () => {
    if (!cnpjPrestador.trim()) {
      setErroCriar('Informe o CNPJ do prestador.');
      return;
    }
    if (senhaInicial && senhaInicial.length < 8) {
      setErroCriar('A senha inicial precisa ter pelo menos 8 caracteres.');
      return;
    }
    setCriando(true);
    setErroCriar(null);
    try {
      const resposta = await criarCredencial(entregadorId, {
        cnpjPrestador: cnpjPrestador.trim(),
        ...(senhaInicial.trim() ? { senhaInicial: senhaInicial.trim() } : {}),
      });
      onAtualizado();
      if (resposta.senhaTemporaria) {
        setSenhaRevelada(resposta.senhaTemporaria);
        setCriarPasso('revelar');
      } else {
        setCriarOpen(false);
      }
    } catch (e) {
      setErroCriar(e instanceof MotoristaApiError ? e.message : 'Falha ao criar a credencial.');
    } finally {
      setCriando(false);
    }
  }, [cnpjPrestador, senhaInicial, entregadorId, onAtualizado, setCriarOpen]);

  // --- 2. redefinir senha (reset) ---
  const [resetConfirmOpen, setResetConfirmOpen] = useState(false);
  const [resetando, setResetando] = useState(false);
  const [erroReset, setErroReset] = useState<string | null>(null);
  const [tokenRevelado, setTokenRevelado] = useState<string | null>(null);

  const confirmarReset = useCallback(async () => {
    setResetando(true);
    setErroReset(null);
    try {
      const resposta = await resetSenhaCredencial(entregadorId);
      onAtualizado();
      setResetConfirmOpen(false);
      setTokenRevelado(resposta.tokenDefinicao);
    } catch (e) {
      setErroReset(e instanceof MotoristaApiError ? e.message : 'Falha ao redefinir a senha.');
    } finally {
      setResetando(false);
    }
  }, [entregadorId, onAtualizado]);

  const fecharTokenRevelado = useCallback(() => setTokenRevelado(null), []);

  // --- 3. ativar/desativar ---
  const [ativarDesativarOpen, setAtivarDesativarOpen] = useState(false);
  const [ativoAlvo, setAtivoAlvo] = useState(true);
  const [alterandoSituacao, setAlterandoSituacao] = useState(false);
  const [erroSituacao, setErroSituacao] = useState<string | null>(null);

  const abrirAtivarDesativar = useCallback((ativoAtual: boolean) => {
    setAtivoAlvo(!ativoAtual);
    setErroSituacao(null);
    setAtivarDesativarOpen(true);
  }, []);

  const confirmarAtivarDesativar = useCallback(async () => {
    setAlterandoSituacao(true);
    setErroSituacao(null);
    try {
      await atualizarCredencial(entregadorId, { ativo: ativoAlvo });
      onAtualizado();
      setAtivarDesativarOpen(false);
    } catch (e) {
      setErroSituacao(e instanceof MotoristaApiError ? e.message : 'Falha ao alterar a situação da credencial.');
    } finally {
      setAlterandoSituacao(false);
    }
  }, [entregadorId, ativoAlvo, onAtualizado]);

  return {
    // criar
    criarOpen, setCriarOpen, criarPasso, cnpjPrestador, setCnpjPrestador,
    senhaInicial, setSenhaInicial, criando, erroCriar, senhaRevelada,
    abrirCriar, confirmarCriar,
    // reset
    resetConfirmOpen, setResetConfirmOpen, resetando, erroReset,
    tokenRevelado, confirmarReset, fecharTokenRevelado,
    // ativar/desativar
    ativarDesativarOpen, setAtivarDesativarOpen, ativoAlvo, alterandoSituacao, erroSituacao,
    abrirAtivarDesativar, confirmarAtivarDesativar,
  };
}

export interface CredencialMotoristaDialogsProps {
  state: ReturnType<typeof useCredencialMotoristaDialog>;
}

/** Os 4 diálogos (criar/revelar-senha, reset-confirmar, revelar-token,
 * ativar-desativar-confirmar) — controlados 100% pelo `state`, sem
 * `Trigger` embutido (a página-mãe decide quando abrir cada um, mesmo
 * padrão de `VinculoMotoristaDialog`). */
export function CredencialMotoristaDialogs({ state: v }: CredencialMotoristaDialogsProps) {
  return (
    <>
      {/* 1. Criar credencial (form -> revelar senha auto-gerada) */}
      <Dialog open={v.criarOpen} onOpenChange={v.setCriarOpen}>
        <DialogContent className="sm:max-w-md">
          {v.criarPasso === 'form' ? (
            <>
              <DialogHeader>
                <DialogTitle>Criar credencial de acesso</DialogTitle>
                <DialogDescription>
                  Informe o CNPJ do prestador usado para login no app. Deixe a senha em branco para o sistema gerar
                  uma senha temporária.
                </DialogDescription>
              </DialogHeader>

              <div className="flex flex-col gap-3">
                <div className="flex flex-col gap-1">
                  <label htmlFor="credencial-cnpj" className="text-sm font-medium text-foreground">
                    CNPJ do prestador
                  </label>
                  <Input
                    id="credencial-cnpj"
                    value={v.cnpjPrestador}
                    onChange={(e) => v.setCnpjPrestador(e.target.value)}
                    placeholder="00.000.000/0000-00"
                    disabled={v.criando}
                    className="h-11 sm:h-9"
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <label htmlFor="credencial-senha-inicial" className="text-sm font-medium text-foreground">
                    Senha inicial (opcional)
                  </label>
                  <Input
                    id="credencial-senha-inicial"
                    type="text"
                    value={v.senhaInicial}
                    onChange={(e) => v.setSenhaInicial(e.target.value)}
                    placeholder="Mín. 8 caracteres — em branco gera automaticamente"
                    disabled={v.criando}
                    className="h-11 sm:h-9"
                  />
                </div>
                {v.erroCriar && (
                  <p role="alert" className="flex items-center gap-2 rounded-md bg-destructive/10 px-3 py-2 text-sm font-medium text-destructive">
                    <AlertCircle className="size-4 shrink-0" aria-hidden="true" />
                    {v.erroCriar}
                  </p>
                )}
              </div>

              <DialogFooter>
                <Button variant="outline" className="min-h-11 sm:min-h-8" disabled={v.criando} onClick={() => v.setCriarOpen(false)}>
                  Cancelar
                </Button>
                <Button className="min-h-11 sm:min-h-8" disabled={v.criando} onClick={v.confirmarCriar}>
                  {v.criando && <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden="true" />}
                  Criar credencial
                </Button>
              </DialogFooter>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>Credencial criada</DialogTitle>
                <DialogDescription>
                  Esta senha temporária é exibida UMA ÚNICA vez — copie e repasse à pessoa motorista agora.
                </DialogDescription>
              </DialogHeader>

              {v.senhaRevelada && (
                <div className="flex items-center gap-2 rounded-md border bg-muted/40 p-3">
                  <ShieldCheck className="size-5 shrink-0 text-primary" aria-hidden="true" />
                  <CopyableUuid value={v.senhaRevelada} label="Copiar senha temporária" className="text-sm" />
                </div>
              )}

              <DialogFooter>
                <Button className="min-h-11 sm:min-h-8" onClick={() => v.setCriarOpen(false)}>
                  Concluído
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* 2a. Redefinir senha — confirmação destrutiva */}
      <AlertDialog open={v.resetConfirmOpen} onOpenChange={v.setResetConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Redefinir senha da credencial</AlertDialogTitle>
            <AlertDialogDescription>
              A senha atual é invalidada IMEDIATAMENTE. Um token de definição de nova senha será gerado — válido por
              60 minutos e de uso único.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {v.erroReset && (
            <p role="alert" className="flex items-center gap-2 rounded-md bg-destructive/10 px-3 py-2 text-sm font-medium text-destructive">
              <AlertCircle className="size-4 shrink-0" aria-hidden="true" />
              {v.erroReset}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={v.resetando}>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={v.confirmarReset}
              disabled={v.resetando}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {v.resetando && <Loader2 className="mr-2 size-4 motion-safe:animate-spin" aria-hidden="true" />}
              Redefinir senha
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* 2b. Token de definição revelado (60 min, uso único) */}
      <Dialog open={!!v.tokenRevelado} onOpenChange={(next) => !next && v.fecharTokenRevelado()}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Token de definição de senha</DialogTitle>
            <DialogDescription>
              Exibido UMA ÚNICA vez — expira em 60 minutos e só pode ser usado uma vez. Repasse à pessoa motorista
              por fora do sistema (não existe canal de e-mail do app motorista).
            </DialogDescription>
          </DialogHeader>
          {v.tokenRevelado && (
            <div className="flex items-center gap-2 rounded-md border bg-muted/40 p-3">
              <KeyRound className="size-5 shrink-0 text-primary" aria-hidden="true" />
              <CopyableUuid value={v.tokenRevelado} label="Copiar token de definição de senha" className="text-sm" />
            </div>
          )}
          <DialogFooter>
            <Button className="min-h-11 sm:min-h-8" onClick={v.fecharTokenRevelado}>
              Concluído
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 3. Ativar/Desativar — confirmação destrutiva (mesmo padrão de "Desvincular") */}
      <AlertDialog open={v.ativarDesativarOpen} onOpenChange={v.setAtivarDesativarOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{v.ativoAlvo ? 'Ativar credencial' : 'Desativar credencial'}</AlertDialogTitle>
            <AlertDialogDescription>
              {v.ativoAlvo
                ? 'A pessoa motorista volta a conseguir fazer login no app com esta credencial.'
                : 'A pessoa motorista perde o acesso ao app imediatamente até esta credencial ser reativada. A situação do motorista (Entregador) NÃO é afetada.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {v.erroSituacao && (
            <p role="alert" className="flex items-center gap-2 rounded-md bg-destructive/10 px-3 py-2 text-sm font-medium text-destructive">
              <AlertCircle className="size-4 shrink-0" aria-hidden="true" />
              {v.erroSituacao}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={v.alterandoSituacao}>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={v.confirmarAtivarDesativar}
              disabled={v.alterandoSituacao}
              className={v.ativoAlvo ? undefined : 'bg-destructive text-destructive-foreground hover:bg-destructive/90'}
            >
              {v.alterandoSituacao && <Loader2 className="mr-2 size-4 motion-safe:animate-spin" aria-hidden="true" />}
              {v.ativoAlvo ? 'Ativar' : 'Desativar'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

export interface CredencialMotoristaAcoesProps {
  state: ReturnType<typeof useCredencialMotoristaDialog>;
  /** `null` = sem credencial vinculada ainda (só "Criar credencial" faz
   * sentido); `boolean` = estado atual da credencial existente. */
  credencialAtiva: boolean | null;
}

/** Botões de ação — a página-mãe posiciona (ex.: dentro do card "Conta de
 * acesso vinculada"). Separado dos diálogos para o caller controlar o
 * layout sem duplicar a lógica de estado. */
export function CredencialMotoristaAcoes({ state: v, credencialAtiva }: CredencialMotoristaAcoesProps) {
  if (credencialAtiva === null) {
    return (
      <Button size="sm" variant="outline" className="min-h-11 sm:min-h-8" onClick={v.abrirCriar}>
        <ShieldCheck className="size-4" aria-hidden="true" />
        Criar credencial
      </Button>
    );
  }
  return (
    <div className="flex flex-wrap gap-2">
      <Button size="sm" variant="outline" className="min-h-11 sm:min-h-8" onClick={() => v.setResetConfirmOpen(true)}>
        <KeyRound className="size-4" aria-hidden="true" />
        Redefinir senha
      </Button>
      <Button
        size="sm"
        variant={credencialAtiva ? 'destructive' : 'outline'}
        className="min-h-11 sm:min-h-8"
        onClick={() => v.abrirAtivarDesativar(credencialAtiva)}
      >
        <Power className="size-4" aria-hidden="true" />
        {credencialAtiva ? 'Desativar credencial' : 'Ativar credencial'}
      </Button>
    </div>
  );
}

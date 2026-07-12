'use client';

// hub-motoristas (S5) FASE 7 task 7.2 — diálogo de vínculo: sugestões
// automáticas (FR-007) + busca manual (FR-009) + confirmação humana
// explícita OBRIGATÓRIA antes de `POST .../vinculo` (FR-008) — nenhum
// outro fluxo do sistema chama o endpoint implicitamente.
//
// Estrutura em 2 passos dentro do mesmo `Dialog` (shadcn/Base UI), mesmo
// espírito de `components/hub/import-wizard.tsx` (`useImportWizard`
// isolado do JSX): passo "buscar" (sugestões + busca manual) → passo
// "confirmar" (resumo da conta escolhida + ação explícita). `jaVinculadoA`
// não bloqueia a listagem (SC-003) — só mostra aviso; o `409` do backend é
// quem de fato recusa um conflito real (task 7.2.3).
//
// Ref: docs/specs/hub-motoristas/contracts/motoristas-api.md
// §GET /motoristas/:id/sugestoes, §GET /motoristas/contas-elegiveis,
// §POST /motoristas/:id/vinculo, quickstart Cenários 5/6/7.

import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, Loader2, Search, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
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
  buscarContasElegiveis,
  vincularMotorista,
  MotoristaApiError,
} from '@/lib/hub/motoristas-api';
import type { ContaCandidata, OrigemVinculo } from '@/lib/hub/motoristas-dto';

type Passo = 'buscar' | 'confirmar';

export interface UseVinculoMotoristaDialogArgs {
  entregadorId: number;
  /** Sugestões já carregadas pela página-mãe (evita round-trip duplicado —
   * a página de detalhe já busca `/sugestoes` para exibir preview). */
  sugestoesIniciais: ContaCandidata[];
  entidadeElegivel: boolean;
  onVinculado: (vinculo: { contaMotoristaId: number; nome: string; cnpjPrestadorMascarado: string }) => void;
}

/** Lógica isolada do JSX (mesmo padrão de `useImportWizard`). */
export function useVinculoMotoristaDialog({
  entregadorId,
  sugestoesIniciais,
  entidadeElegivel,
  onVinculado,
}: UseVinculoMotoristaDialogArgs) {
  const [open, setOpenState] = useState(false);
  const [passo, setPasso] = useState<Passo>('buscar');
  const [termo, setTermo] = useState('');
  const [resultadosBusca, setResultadosBusca] = useState<ContaCandidata[]>([]);
  const [buscando, setBuscando] = useState(false);
  const [erroBusca, setErroBusca] = useState<string | null>(null);
  const [selecionado, setSelecionado] = useState<{ conta: ContaCandidata; origem: OrigemVinculo } | null>(null);
  const [confirmando, setConfirmando] = useState(false);
  const [erroConfirmar, setErroConfirmar] = useState<string | null>(null);

  const reset = useCallback(() => {
    setPasso('buscar');
    setTermo('');
    setResultadosBusca([]);
    setErroBusca(null);
    setSelecionado(null);
    setConfirmando(false);
    setErroConfirmar(null);
  }, []);

  const setOpen = useCallback(
    (next: boolean) => {
      setOpenState(next);
      if (!next) reset();
    },
    [reset]
  );

  const buscar = useCallback(
    async (q: string) => {
      if (q.trim().length < 2) {
        setResultadosBusca([]);
        setErroBusca(null);
        return;
      }
      setBuscando(true);
      setErroBusca(null);
      try {
        const resposta = await buscarContasElegiveis({ entregadorId, q: q.trim() });
        setResultadosBusca(resposta.items);
      } catch (e) {
        setErroBusca(e instanceof MotoristaApiError ? e.message : 'Não foi possível buscar contas.');
        setResultadosBusca([]);
      } finally {
        setBuscando(false);
      }
    },
    [entregadorId]
  );

  const setTermoBusca = useCallback((q: string) => {
    setTermo(q);
  }, []);

  const escolher = useCallback((conta: ContaCandidata, origem: OrigemVinculo) => {
    setSelecionado({ conta, origem });
    setErroConfirmar(null);
    setPasso('confirmar');
  }, []);

  const voltarParaBusca = useCallback(() => {
    setPasso('buscar');
    setErroConfirmar(null);
  }, []);

  const confirmar = useCallback(async () => {
    if (!selecionado) return;
    setConfirmando(true);
    setErroConfirmar(null);
    try {
      const resultado = await vincularMotorista(entregadorId, selecionado.conta.contaMotoristaId, selecionado.origem);
      onVinculado(resultado.vinculo);
      setOpen(false);
    } catch (e) {
      setErroConfirmar(
        e instanceof MotoristaApiError ? e.message : 'Falha ao vincular a conta. Tente novamente.'
      );
    } finally {
      setConfirmando(false);
    }
  }, [selecionado, entregadorId, onVinculado, setOpen]);

  return {
    open,
    setOpen,
    passo,
    termo,
    setTermoBusca,
    buscar,
    resultadosBusca,
    buscando,
    erroBusca,
    sugestoesIniciais,
    entidadeElegivel,
    selecionado,
    escolher,
    voltarParaBusca,
    confirmar,
    confirmando,
    erroConfirmar,
  };
}

function CandidatoItem({
  conta,
  onEscolher,
}: {
  conta: ContaCandidata;
  onEscolher: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onEscolher}
        className="flex w-full flex-col gap-1 rounded-md border p-3 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <div className="flex items-center justify-between gap-2">
          <span className="font-medium">{conta.nome}</span>
          {typeof conta.similaridade === 'number' && (
            <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
              {Math.round(conta.similaridade * 100)}% similar
            </span>
          )}
        </div>
        <span className="font-mono text-xs text-muted-foreground">{conta.cnpjPrestadorMascarado}</span>
        {conta.jaVinculadoA && (
          <span className="flex items-center gap-1 text-xs font-medium text-warning-strong">
            <AlertTriangle className="size-3.5 shrink-0" aria-hidden="true" />
            Já vinculada a {conta.jaVinculadoA.nome}
          </span>
        )}
      </button>
    </li>
  );
}

export interface VinculoMotoristaDialogProps {
  state: ReturnType<typeof useVinculoMotoristaDialog>;
}

/** Controlado 100% por `state.open`/`state.setOpen` — sem `DialogTrigger`
 * embutido; a página-mãe decide quando abrir (ex.: botão "Vincular"),
 * mesmo padrão de controle explícito já usado para os outros diálogos do
 * detalhe (edição, desvínculo). */
export function VinculoMotoristaDialog({ state: v }: VinculoMotoristaDialogProps) {
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      v.buscar(v.termo);
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- só refaz debounce quando o termo muda
  }, [v.termo]);

  return (
    <Dialog open={v.open} onOpenChange={v.setOpen}>
      <DialogContent className="sm:max-w-lg">
        {v.passo === 'buscar' ? (
          <>
            <DialogHeader>
              <p className="text-xs font-medium text-muted-foreground">Passo 1 de 2 — buscar conta</p>
              <DialogTitle>Vincular conta de acesso</DialogTitle>
              <DialogDescription>
                Escolha uma conta sugerida por semelhança de nome ou busque manualmente.
              </DialogDescription>
            </DialogHeader>

            <div className="flex flex-col gap-4">
              {!v.entidadeElegivel ? (
                <p role="status" className="rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground">
                  Nenhuma conta elegível neste contexto (entidade fora do grupo habilitado).
                </p>
              ) : (
                <>
                  <div className="flex flex-col gap-2">
                    <h3 className="text-sm font-medium text-foreground">Sugestões automáticas</h3>
                    {v.sugestoesIniciais.length === 0 ? (
                      <p className="text-sm text-muted-foreground">Nenhuma sugestão encontrada por semelhança de nome.</p>
                    ) : (
                      <ul className="flex max-h-52 flex-col gap-1.5 overflow-y-auto">
                        {v.sugestoesIniciais.map((c) => (
                          <CandidatoItem key={c.contaMotoristaId} conta={c} onEscolher={() => v.escolher(c, 'sugestao')} />
                        ))}
                      </ul>
                    )}
                  </div>

                  <div className="flex flex-col gap-2">
                    <label htmlFor="motoristas-vinculo-busca" className="text-sm font-medium text-foreground">
                      Busca manual
                    </label>
                    <div className="relative">
                      <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
                      <Input
                        id="motoristas-vinculo-busca"
                        value={v.termo}
                        onChange={(e) => v.setTermoBusca(e.target.value)}
                        placeholder="Buscar por nome (mín. 2 caracteres)..."
                        className="h-11 pl-8 sm:h-9"
                      />
                    </div>
                    {v.buscando ? (
                      <p role="status" className="flex items-center gap-1.5 text-sm text-muted-foreground">
                        <Loader2 className="size-3.5 motion-safe:animate-spin" aria-hidden="true" />
                        Buscando...
                      </p>
                    ) : v.erroBusca ? (
                      <p role="alert" className="text-sm text-destructive">
                        {v.erroBusca}
                      </p>
                    ) : v.resultadosBusca.length > 0 ? (
                      <ul className="flex max-h-52 flex-col gap-1.5 overflow-y-auto">
                        {v.resultadosBusca.map((c) => (
                          <CandidatoItem
                            key={c.contaMotoristaId}
                            conta={c}
                            onEscolher={() => v.escolher(c, 'busca_manual')}
                          />
                        ))}
                      </ul>
                    ) : v.termo.trim().length >= 2 ? (
                      <p className="text-sm text-muted-foreground">Nenhuma conta encontrada para este termo.</p>
                    ) : null}
                  </div>
                </>
              )}
            </div>

            <DialogFooter>
              <Button variant="outline" className="min-h-11 sm:min-h-8" onClick={() => v.setOpen(false)}>
                Cancelar
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <p className="text-xs font-medium text-muted-foreground">Passo 2 de 2 — confirmar</p>
              <DialogTitle>Confirmar vínculo</DialogTitle>
              <DialogDescription>Esta ação substitui um vínculo existente, se houver (FR-013).</DialogDescription>
            </DialogHeader>

            {v.selecionado && (
              <div className="flex flex-col gap-3 rounded-md border p-3">
                <div className="flex items-center gap-2">
                  <ShieldCheck className="size-5 shrink-0 text-primary" aria-hidden="true" />
                  <div>
                    <p className="font-medium">{v.selecionado.conta.nome}</p>
                    <p className="font-mono text-xs text-muted-foreground">
                      {v.selecionado.conta.cnpjPrestadorMascarado}
                    </p>
                  </div>
                </div>
                {v.selecionado.conta.jaVinculadoA && (
                  <p className="flex items-center gap-1.5 text-sm font-medium text-warning-strong">
                    <AlertTriangle className="size-4 shrink-0" aria-hidden="true" />
                    Atenção: já vinculada a {v.selecionado.conta.jaVinculadoA.nome}. Vincular aqui será recusado
                    pelo sistema se essa outra pessoa continuar vinculada a ela.
                  </p>
                )}
              </div>
            )}

            {v.erroConfirmar && (
              <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm font-medium text-destructive">
                {v.erroConfirmar}
              </p>
            )}

            <DialogFooter>
              <Button variant="outline" className="min-h-11 sm:min-h-8" disabled={v.confirmando} onClick={v.voltarParaBusca}>
                Voltar
              </Button>
              <Button className="min-h-11 sm:min-h-8" disabled={v.confirmando} onClick={v.confirmar}>
                {v.confirmando && <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden="true" />}
                Confirmar vínculo
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

export default VinculoMotoristaDialog;

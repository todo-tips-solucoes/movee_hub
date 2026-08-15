'use client';

// hub-auditoria-admin (S9) FASE 5.3 task 5.3.3 — sub-rota
// `/hub/dashboard/usuarios/papeis`: matriz papel×permissão via checkboxes
// (FR-010). Quando `podeEditar:false` (admin_entidade), os checkboxes ficam
// DESABILITADOS — NÃO ocultos, o admin_entidade precisa VER a matriz, só
// não editar. Toggle refletido imediatamente na célula (admin_plataforma —
// Cenário 6) e tratamento de `409 OPERACAO_BLOQUEADA` (guard anti-lockout)
// sem quebrar a tela.
//
// Ref: docs/specs/hub-auditoria-admin/contracts/papeis-api.md,
// spec.md FR-010/FR-016, quickstart.md Cenário 6.

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { AlertCircle, ShieldAlert } from 'lucide-react';
import { PageHeader } from '@/components/hub/page-header';
import { ListSkeleton } from '@/components/hub/table-skeleton';
import { Checkbox, CHECKBOX_ALVO_44 } from '@/components/ui/checkbox';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Button } from '@/components/ui/button';
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
import { labelPapel } from '@/components/hub/entity-switcher';
import { useHubAuth } from '@/contexts/hub-auth-context';
import { AdminApiError, alternarPapelPermissao, listarPapeisMatriz } from '@/lib/hub/admin-api';
import type { MatrizCelula, PapeisMatrizResponse, PermissaoCatalogo } from '@/lib/hub/admin-dto';
import { ehAltoImpacto, modulosComListar, rotuloPermissao } from '@/lib/hub/rotulo-permissao';
import { LARGURA_LISTA } from '@/lib/hub/larguras';

function chave(papelId: number, permissaoId: number): string {
  return `${papelId}:${permissaoId}`;
}

function usePapeisMatriz() {
  const [dados, setDados] = useState<PapeisMatrizResponse | null>(null);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [erroToggle, setErroToggle] = useState<string | null>(null);
  const [celulasEmSalvamento, setCelulasEmSalvamento] = useState<Set<string>>(new Set());

  const buscar = useCallback(async () => {
    setCarregando(true);
    setErro(null);
    try {
      const resposta = await listarPapeisMatriz();
      setDados(resposta);
    } catch (e) {
      setErro(e instanceof AdminApiError ? e.message : 'Não foi possível carregar a matriz de papéis.');
      setDados(null);
    } finally {
      setCarregando(false);
    }
  }, []);

  useEffect(() => {
    buscar();
  }, [buscar]);

  const matrizSet = useMemo(() => {
    const s = new Set<string>();
    (dados?.matriz ?? []).forEach((m: MatrizCelula) => s.add(chave(m.papelId, m.permissaoId)));
    return s;
  }, [dados]);

  // impeccable rodada 2 (P2): o toggle persiste célula a célula no clique — o
  // "Desfazer" do toast reaplica o valor anterior pelo MESMO fluxo (novo
  // request, otimista + rollback inclusos). Ref porque `alternar` precisa
  // referenciar a si mesma dentro do onClick da action.
  const alternarRef = useRef<((papelId: number, permissaoId: number, proximo: boolean) => Promise<void>) | null>(null);

  const alternar = useCallback(
    async (papelId: number, permissaoId: number, proximo: boolean) => {
      const k = chave(papelId, permissaoId);
      setErroToggle(null);
      setCelulasEmSalvamento((prev) => new Set(prev).add(k));
      // Otimista: reflete a mudança na UI imediatamente (Cenário 6).
      setDados((prev) => {
        if (!prev) return prev;
        const matriz = proximo
          ? [...prev.matriz, { papelId, permissaoId }]
          : prev.matriz.filter((m) => !(m.papelId === papelId && m.permissaoId === permissaoId));
        return { ...prev, matriz };
      });
      try {
        await alternarPapelPermissao(papelId, permissaoId, proximo);
        toast.success(proximo ? 'Permissão concedida.' : 'Permissão removida.', {
          action: {
            label: 'Desfazer',
            onClick: () => {
              void alternarRef.current?.(papelId, permissaoId, !proximo);
            },
          },
        });
      } catch (e) {
        // Reverte a mudança otimista e explica o motivo — sem quebrar a tela
        // (contracts/papeis-api.md, guard anti-lockout `409 OPERACAO_BLOQUEADA`).
        setDados((prev) => {
          if (!prev) return prev;
          const matriz = !proximo
            ? [...prev.matriz, { papelId, permissaoId }]
            : prev.matriz.filter((m) => !(m.papelId === papelId && m.permissaoId === permissaoId));
          return { ...prev, matriz };
        });
        setErroToggle(e instanceof AdminApiError ? e.message : 'Não foi possível alterar a permissão.');
      } finally {
        setCelulasEmSalvamento((prev) => {
          const next = new Set(prev);
          next.delete(k);
          return next;
        });
      }
    },
    []
  );

  useEffect(() => {
    alternarRef.current = alternar;
  }, [alternar]);

  return { dados, matrizSet, carregando, erro, erroToggle, celulasEmSalvamento, alternar, refetch: buscar };
}

/**
 * Agrupa as permissões por módulo, na MESMA ordem em que os módulos aparecem
 * na navegação (`GET /me`), e com o nome de lá. Módulo que o usuário não tem
 * — ou permissão sem módulo — cai num grupo final identificado pelo código:
 * a matriz nunca esconde uma linha por não saber traduzi-la.
 */
function agruparPorModulo(
  permissoes: PermissaoCatalogo[],
  modulos: { codigo: string; nome: string }[]
): { codigo: string; nome: string; permissoes: PermissaoCatalogo[] }[] {
  const porCodigo = new Map<string, PermissaoCatalogo[]>();
  for (const p of permissoes) {
    const chave = p.modulo ?? 'outros';
    const lista = porCodigo.get(chave);
    if (lista) lista.push(p);
    else porCodigo.set(chave, [p]);
  }

  const ordenados: { codigo: string; nome: string; permissoes: PermissaoCatalogo[] }[] = [];
  for (const m of modulos) {
    const lista = porCodigo.get(m.codigo);
    if (!lista) continue;
    ordenados.push({ codigo: m.codigo, nome: m.nome, permissoes: lista });
    porCodigo.delete(m.codigo);
  }
  // O que sobrou: sem nome legível disponível, mas visível assim mesmo.
  for (const [codigo, lista] of porCodigo) {
    ordenados.push({ codigo, nome: codigo, permissoes: lista });
  }
  return ordenados;
}

/** Revogação de alto impacto aguardando confirmação (impeccable r22). */
interface RevogacaoPendente {
  papelId: number;
  permissaoId: number;
  rotuloPermissaoTexto: string;
  codigo: string;
  nomePapel: string;
}

export default function PapeisMatrizPage() {
  const h = usePapeisMatriz();
  const { modulos } = useHubAuth();
  const [confirmarRevogacao, setConfirmarRevogacao] = useState<RevogacaoPendente | null>(null);

  const grupos = useMemo(
    () => agruparPorModulo(h.dados?.permissoes ?? [], modulos),
    [h.dados, modulos]
  );
  // Quais módulos têm lista própria — desempata o `consultar`, que significa
  // "abrir um item" onde há `listar` e "entrar no módulo" onde não há.
  const modulosListaveis = useMemo(
    () => modulosComListar((h.dados?.permissoes ?? []).map((p) => p.codigo)),
    [h.dados]
  );

  return (
    <div className={`mx-auto flex ${LARGURA_LISTA} flex-col gap-4 p-4 sm:p-6 lg:p-8`}>
      <PageHeader
        titulo="Papéis e permissões"
        subtitulo="Catálogo fixo de papéis (nenhum papel novo pode ser criado). Marque/desmarque a célula para conceder ou remover uma permissão do papel."
      />

      {h.dados && !h.dados.podeEditar && (
        <div className="flex items-center gap-2 rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm text-warning-strong">
          <ShieldAlert className="size-4 shrink-0" aria-hidden="true" />
          <p>Modo somente leitura — apenas o administrador da plataforma pode alterar a matriz.</p>
        </div>
      )}

      {h.erroToggle && (
        <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          {h.erroToggle}
        </div>
      )}

      {h.carregando ? (
        <ListSkeleton label="Carregando matriz de papéis..." linhas={8} />
      ) : h.erro || !h.dados ? (
        <div
          role="alert"
          className="flex flex-col items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-10 text-center"
        >
          <AlertCircle className="size-8 text-destructive" aria-hidden="true" />
          <p className="text-sm font-medium text-destructive">{h.erro ?? 'Erro ao carregar.'}</p>
          <Button size="sm" variant="outline" className="min-h-11 sm:min-h-8" onClick={h.refetch}>
            Tentar novamente
          </Button>
        </div>
      ) : (
        <div className="rounded-lg border">
          {/* impeccable r22 (P2): a matriz tem 2054px de altura a 1440 e o
              cabeçalho rolava para fora junto com ela — de "ADMIN" para baixo,
              marcava-se caixa sem saber mais qual das quatro colunas é qual, a
              ~600px do rótulo da linha. Agora o container tem altura máxima e o
              cabeçalho gruda nele. O `overflow-x-auto` que estava neste `div`
              era duplicado: o próprio `Table` já tem o dele. */}
          <Table containerClassName="max-h-[calc(100vh-18rem)] overflow-auto">
            <TableHeader>
              <TableRow>
                {/* `sticky` no `<th>` e não no `<thead>`: com
                    `border-collapse: collapse` (preflight do Tailwind) o
                    thead grudado perde as bordas. */}
                <TableHead className="sticky top-0 z-20 bg-card">Permissão</TableHead>
                {h.dados.papeis.map((p) => (
                  <TableHead key={p.id} className="sticky top-0 z-20 bg-card text-center">
                    {labelPapel(p.nome)}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {grupos.map((grupo) => (
                <Fragment key={grupo.codigo}>
                  {/* impeccable rodada 10 (A7): 34 linhas planas viravam uma
                      parede de códigos. O agrupamento usa o nome do módulo
                      vindo do `/me` — o mesmo que nomeia a navegação. */}
                  <TableRow className="hover:bg-transparent">
                    <TableHead
                      colSpan={1 + h.dados!.papeis.length}
                      className="h-9 bg-muted/50 text-xs font-semibold uppercase tracking-wide text-muted-foreground"
                    >
                      {grupo.nome}
                    </TableHead>
                  </TableRow>
                  {grupo.permissoes.map((permissao) => (
                <TableRow key={permissao.id}>
                  <TableCell className="whitespace-nowrap text-sm">
                    {/* O rótulo é para quem CONCEDE; o código, para quem dá
                        suporte e para quem lê a auditoria — os dois ficam. */}
                    <span className="font-medium">
                      {rotuloPermissao(permissao.codigo, modulosListaveis.has(grupo.codigo))}
                    </span>
                    {ehAltoImpacto(permissao.codigo) && (
                      <span className="ml-1.5 rounded-full bg-warning/15 px-1.5 py-0.5 text-[0.6875rem] font-medium text-warning-strong">
                        alto impacto
                      </span>
                    )}
                    <span className="ml-1.5 font-mono text-xs text-muted-foreground">
                      {permissao.codigo}
                    </span>
                  </TableCell>
                  {h.dados!.papeis.map((papel) => {
                    const k = chave(papel.id, permissao.id);
                    const marcado = h.matrizSet.has(k);
                    const salvando = h.celulasEmSalvamento.has(k);
                    return (
                      <TableCell key={papel.id} className="text-center">
                        {/* impeccable rodada 9 (P2): a caixa mede 16x16 — o
                            menor alvo do hub, 132 deles nesta matriz, e é aqui
                            que se concede permissão. A caixa segue 16px (a
                            densidade da matriz é o que a torna legível); quem
                            cresce até 44 é a área tocável ao redor, e só no
                            mobile.
                            r12: o span reserva o espaço, mas quem RECEBE o
                            toque é o `after:` do Checkbox — sem
                            CHECKBOX_ALVO_44 a área real era 40x32. */}
                        <span className="inline-flex h-11 w-11 items-center justify-center md:h-6 md:w-6">
                          <Checkbox
                            className={CHECKBOX_ALVO_44}
                            // impeccable r22 (P2): o nome acessível era o
                            // CÓDIGO enquanto quem enxerga lia o rótulo humano
                            // — duas verdades sobre o mesmo controle, 132
                            // vezes, e o leitor de tela ficava com a pior.
                            // Agora vem o mesmo rótulo da célula; o código fica
                            // no fim, para quem dá suporte, e "alto impacto"
                            // entra no nome porque na tela ele é uma etiqueta
                            // visível ao lado do rótulo.
                            aria-label={[
                              rotuloPermissao(permissao.codigo, modulosListaveis.has(grupo.codigo)),
                              ehAltoImpacto(permissao.codigo) ? '(alto impacto)' : '',
                              `para ${labelPapel(papel.nome)}`,
                              `— ${permissao.codigo}`,
                            ]
                              .filter(Boolean)
                              .join(' ')}
                            checked={marcado}
                            disabled={!h.dados!.podeEditar || salvando}
                            onCheckedChange={(v) => {
                              // impeccable r22 (P2): revogar permissão de alto
                              // impacto tira acesso de gente — a mesma classe
                              // de perda que `admin/page.tsx` já confirma antes
                              // de desabilitar um módulo. A etiqueta "alto
                              // impacto" sinalizava o risco e não mudava
                              // comportamento nenhum: era um clique, e a
                              // mitigação era um toast que passa. Conceder
                              // segue direto — quem amplia acesso não precisa
                              // ser interrompido.
                              if (v !== true && ehAltoImpacto(permissao.codigo)) {
                                setConfirmarRevogacao({
                                  papelId: papel.id,
                                  permissaoId: permissao.id,
                                  rotuloPermissaoTexto: rotuloPermissao(
                                    permissao.codigo,
                                    modulosListaveis.has(grupo.codigo)
                                  ),
                                  codigo: permissao.codigo,
                                  nomePapel: labelPapel(papel.nome),
                                });
                                return;
                              }
                              h.alternar(papel.id, permissao.id, v === true);
                            }}
                          />
                        </span>
                      </TableCell>
                    );
                  })}
                </TableRow>
                  ))}
                </Fragment>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <AlertDialog
        open={confirmarRevogacao !== null}
        onOpenChange={(aberto) => !aberto && setConfirmarRevogacao(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Remover &quot;{confirmarRevogacao?.rotuloPermissaoTexto}&quot; do papel{' '}
              {confirmarRevogacao?.nomePapel}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Todas as pessoas com o papel {confirmarRevogacao?.nomePapel} perdem essa permissão
              imediatamente, em todas as entidades. A permissão{' '}
              <span className="font-mono">{confirmarRevogacao?.codigo}</span> está marcada como de
              alto impacto. Você pode conceder de volta a qualquer momento.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={() => {
                if (confirmarRevogacao) {
                  h.alternar(confirmarRevogacao.papelId, confirmarRevogacao.permissaoId, false);
                }
                setConfirmarRevogacao(null);
              }}
            >
              Remover permissão
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

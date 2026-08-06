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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { AlertCircle, ShieldAlert } from 'lucide-react';
import { PageHeader } from '@/components/hub/page-header';
import { ListSkeleton } from '@/components/hub/table-skeleton';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { labelPapel } from '@/components/hub/entity-switcher';
import { AdminApiError, alternarPapelPermissao, listarPapeisMatriz } from '@/lib/hub/admin-api';
import type { MatrizCelula, PapeisMatrizResponse } from '@/lib/hub/admin-dto';

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

export default function PapeisMatrizPage() {
  const h = usePapeisMatriz();

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4 p-4 sm:p-6 lg:p-8">
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
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Permissão</TableHead>
                {h.dados.papeis.map((p) => (
                  <TableHead key={p.id} className="text-center">
                    {labelPapel(p.nome)}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {h.dados.permissoes.map((permissao) => (
                <TableRow key={permissao.id}>
                  <TableCell className="whitespace-nowrap text-sm">
                    <span className="font-medium">{permissao.codigo}</span>
                    {permissao.modulo && (
                      <span className="ml-1.5 text-xs text-muted-foreground">({permissao.modulo})</span>
                    )}
                  </TableCell>
                  {h.dados!.papeis.map((papel) => {
                    const k = chave(papel.id, permissao.id);
                    const marcado = h.matrizSet.has(k);
                    const salvando = h.celulasEmSalvamento.has(k);
                    return (
                      <TableCell key={papel.id} className="text-center">
                        <Checkbox
                          aria-label={`${permissao.codigo} para ${labelPapel(papel.nome)}`}
                          checked={marcado}
                          disabled={!h.dados!.podeEditar || salvando}
                          onCheckedChange={(v) => h.alternar(papel.id, permissao.id, v === true)}
                        />
                      </TableCell>
                    );
                  })}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

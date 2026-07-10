'use client';

// hub-auditoria-admin (S9) FASE 5.4 — rota `/hub/dashboard/admin`: seletor
// de entidade + matriz de módulos habilitados/desabilitados (toggle),
// acessível SOMENTE a quem tem `admin.gerenciar` — a própria navegação já
// não expõe o item para quem não tem o módulo `admin` habilitado (seed
// 0038). Toda a rota (leitura e escrita) é exclusiva do admin_plataforma
// (FR-017/dec-009) — o backend (`routes/hub-admin.js`) responde
// `403 PERMISSAO_NEGADA` para qualquer outro papel, mesmo que a tela
// chegue a renderizar por engano de nav.
//
// Como não existe endpoint de "listar todas as entidades com nome" no hub
// (achado de `components/hub/entity-switcher.tsx` — a tabela "Empresa"
// mora fora do banco do hub, sem nome amigável disponível aqui), o
// seletor é um campo numérico de ID de entidade — mesma limitação já
// documentada e aceita em `entity-switcher.tsx` (dec-010 daquela feature).
//
// Ref: docs/specs/hub-auditoria-admin/contracts/admin-modulos-api.md,
// spec.md FR-007/FR-008/FR-013/FR-017, quickstart.md Cenário 7.

import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, RotateCw, Settings2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useHubAuth } from '@/contexts/hub-auth-context';
import { AdminApiError, alternarModuloEntidade, listarModulosDaEntidade } from '@/lib/hub/admin-api';
import type { ModuloEntidadeItem } from '@/lib/hub/admin-dto';

function useModulosDaEntidade(entidadeIdInicial: number) {
  const [entidadeIdInput, setEntidadeIdInput] = useState(String(entidadeIdInicial || ''));
  const [entidadeId, setEntidadeId] = useState<number | null>(entidadeIdInicial || null);
  const [modulos, setModulos] = useState<ModuloEntidadeItem[]>([]);
  const [carregando, setCarregando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [erroToggle, setErroToggle] = useState<string | null>(null);
  const [emSalvamento, setEmSalvamento] = useState<Set<string>>(new Set());

  const buscar = useCallback(async (id: number) => {
    setCarregando(true);
    setErro(null);
    setErroToggle(null);
    try {
      const resposta = await listarModulosDaEntidade(id);
      setModulos(resposta.modulos);
    } catch (e) {
      setErro(e instanceof AdminApiError ? e.message : 'Não foi possível carregar os módulos desta entidade.');
      setModulos([]);
    } finally {
      setCarregando(false);
    }
  }, []);

  useEffect(() => {
    if (entidadeId !== null) buscar(entidadeId);
  }, [entidadeId, buscar]);

  const consultar = useCallback(() => {
    const parsed = Number(entidadeIdInput);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      setErro('Informe um ID de entidade válido.');
      return;
    }
    setEntidadeId(parsed);
  }, [entidadeIdInput]);

  const alternar = useCallback(
    async (codigo: string, proximo: boolean) => {
      if (entidadeId === null) return;
      setErroToggle(null);
      setEmSalvamento((prev) => new Set(prev).add(codigo));
      setModulos((prev) => prev.map((m) => (m.codigo === codigo ? { ...m, habilitado: proximo } : m)));
      try {
        await alternarModuloEntidade(entidadeId, codigo, proximo);
      } catch (e) {
        setModulos((prev) => prev.map((m) => (m.codigo === codigo ? { ...m, habilitado: !proximo } : m)));
        setErroToggle(e instanceof AdminApiError ? e.message : 'Não foi possível alterar o módulo.');
      } finally {
        setEmSalvamento((prev) => {
          const next = new Set(prev);
          next.delete(codigo);
          return next;
        });
      }
    },
    [entidadeId]
  );

  return {
    entidadeIdInput,
    setEntidadeIdInput,
    entidadeId,
    consultar,
    modulos,
    carregando,
    erro,
    erroToggle,
    emSalvamento,
    alternar,
    refetch: () => entidadeId !== null && buscar(entidadeId),
  };
}

export default function AdminModulosPage() {
  const { entidadeAtiva } = useHubAuth();
  const h = useModulosDaEntidade(entidadeAtiva ?? 0);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 p-4 sm:p-6 lg:p-8">
      <div>
        <h1 className="font-heading text-xl font-semibold text-foreground sm:text-2xl">Administração da plataforma</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Habilite ou desabilite módulos por entidade. O efeito é imediato: o usuário afetado perde/recupera acesso
          sem precisar logar novamente.
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-2 rounded-lg border bg-card p-3">
        <div className="flex flex-col gap-1">
          <Label htmlFor="admin-entidade-id">ID da entidade</Label>
          <Input
            id="admin-entidade-id"
            type="number"
            min={1}
            value={h.entidadeIdInput}
            onChange={(e) => h.setEntidadeIdInput(e.target.value)}
            className="h-11 w-40 sm:h-9"
          />
        </div>
        <Button size="sm" className="min-h-11 sm:min-h-8" onClick={h.consultar}>
          Consultar
        </Button>
      </div>

      {h.erroToggle && (
        <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          {h.erroToggle}
        </div>
      )}

      {h.carregando ? (
        <div role="status" className="flex flex-col items-center gap-2 rounded-lg border p-10 text-muted-foreground">
          <RotateCw className="size-6 animate-spin" aria-hidden="true" />
          <p className="text-sm">Carregando módulos...</p>
        </div>
      ) : h.erro ? (
        <div
          role="alert"
          className="flex flex-col items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-10 text-center"
        >
          <AlertCircle className="size-8 text-destructive" aria-hidden="true" />
          <p className="text-sm font-medium text-destructive">{h.erro}</p>
          <Button size="sm" variant="outline" onClick={h.refetch}>
            Tentar novamente
          </Button>
        </div>
      ) : h.entidadeId === null ? (
        <div
          role="status"
          className="flex flex-col items-center gap-2 rounded-lg border border-dashed p-10 text-center text-muted-foreground"
        >
          <Settings2 className="size-10 opacity-30" aria-hidden="true" />
          <p className="font-medium">Informe um ID de entidade para começar</p>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {h.modulos.map((m) => (
            <div key={m.moduloId} className="flex items-center justify-between gap-3 rounded-lg border p-3">
              <div>
                <p className="font-medium">{m.nome}</p>
                <p className="text-xs text-muted-foreground">{m.codigo}</p>
              </div>
              <Button
                size="sm"
                variant={m.habilitado ? 'default' : 'outline'}
                disabled={h.emSalvamento.has(m.codigo)}
                onClick={() => h.alternar(m.codigo, !m.habilitado)}
              >
                {m.habilitado ? 'Habilitado' : 'Desabilitado'}
              </Button>
            </div>
          ))}
          {h.modulos.length === 0 && (
            <p className="text-sm text-muted-foreground">Nenhum módulo cadastrado na plataforma.</p>
          )}
        </div>
      )}
    </div>
  );
}

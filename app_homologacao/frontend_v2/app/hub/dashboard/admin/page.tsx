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
// seletor trabalha por ID de entidade. uiux-hub F3: o campo numérico cru
// virou um combobox (Popover+Command, idioma do EmpresaSelector legado)
// com histórico local das últimas entidades consultadas — o admin não
// precisa mais decorar IDs entre sessões.
//
// Ref: docs/specs/hub-auditoria-admin/contracts/admin-modulos-api.md,
// spec.md FR-007/FR-008/FR-013/FR-017, quickstart.md Cenário 7.

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { AlertCircle, Building2, ChevronsUpDown, History, Search, Settings2 } from 'lucide-react';
import { PageHeader } from '@/components/hub/page-header';
import { EmptyState } from '@/components/hub/empty-state';
import { ListSkeleton } from '@/components/hub/table-skeleton';
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
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Switch } from '@/components/ui/switch';
import { useHubAuth } from '@/contexts/hub-auth-context';
import { AdminApiError, alternarModuloEntidade, listarModulosDaEntidade } from '@/lib/hub/admin-api';
import type { ModuloEntidadeItem } from '@/lib/hub/admin-dto';

const HISTORICO_KEY = 'hub_admin_entidades_recentes';
const HISTORICO_MAX = 8;

/** Histórico local (localStorage) de IDs consultados — fail-safe: qualquer
 * erro de storage (modo privado, quota) degrada para lista vazia. */
export function lerHistorico(): number[] {
  try {
    const bruto = window.localStorage.getItem(HISTORICO_KEY);
    if (!bruto) return [];
    const lista = JSON.parse(bruto);
    return Array.isArray(lista) ? lista.filter((n) => Number.isInteger(n) && n > 0) : [];
  } catch {
    return [];
  }
}

export function gravarHistorico(id: number): number[] {
  const novo = [id, ...lerHistorico().filter((n) => n !== id)].slice(0, HISTORICO_MAX);
  try {
    window.localStorage.setItem(HISTORICO_KEY, JSON.stringify(novo));
  } catch {
    // storage indisponível — histórico só desta sessão de página
  }
  return novo;
}

function useModulosDaEntidade(entidadeIdInicial: number) {
  const [entidadeId, setEntidadeId] = useState<number | null>(entidadeIdInicial || null);
  const [entidadeNome, setEntidadeNome] = useState<string | null>(null);
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
      setEntidadeNome(resposta.entidadeNome);
    } catch (e) {
      setErro(e instanceof AdminApiError ? e.message : 'Não foi possível carregar os módulos desta entidade.');
      setModulos([]);
      setEntidadeNome(null);
    } finally {
      setCarregando(false);
    }
  }, []);

  useEffect(() => {
    if (entidadeId !== null) buscar(entidadeId);
  }, [entidadeId, buscar]);

  const alternar = useCallback(
    async (codigo: string, proximo: boolean) => {
      if (entidadeId === null) return;
      setErroToggle(null);
      setEmSalvamento((prev) => new Set(prev).add(codigo));
      setModulos((prev) => prev.map((m) => (m.codigo === codigo ? { ...m, habilitado: proximo } : m)));
      try {
        await alternarModuloEntidade(entidadeId, codigo, proximo);
        toast.success(proximo ? `Módulo ${codigo} habilitado.` : `Módulo ${codigo} desabilitado.`);
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
    entidadeId,
    entidadeNome,
    setEntidadeId,
    modulos,
    carregando,
    erro,
    erroToggle,
    emSalvamento,
    alternar,
    refetch: () => entidadeId !== null && buscar(entidadeId),
  };
}

/** Combobox de entidade: digita um ID OU escolhe uma consultada recentemente. */
function EntidadeCombobox({
  entidadeId,
  entidadeNome,
  onSelecionar,
}: {
  entidadeId: number | null;
  /** Nome resolvido pelo backend após carregar a entidade — null antes/na falha. */
  entidadeNome?: string | null;
  onSelecionar: (id: number) => void;
}) {
  const [aberto, setAberto] = useState(false);
  const [busca, setBusca] = useState('');
  const [historico, setHistorico] = useState<number[]>([]);

  // Carrega o histórico ao ABRIR (evento, não efeito): localStorage só existe
  // no cliente e assim a lista vem sempre fresca a cada abertura.
  const aoAbrirFechar = (v: boolean) => {
    setAberto(v);
    if (v) setHistorico(lerHistorico());
  };

  const buscaNumerica = /^\d+$/.test(busca.trim()) ? Number(busca.trim()) : null;
  const recentesFiltrados = historico.filter((id) => !busca.trim() || String(id).includes(busca.trim()));

  const selecionar = (id: number) => {
    setHistorico(gravarHistorico(id));
    onSelecionar(id);
    setAberto(false);
    setBusca('');
  };

  return (
    <Popover open={aberto} onOpenChange={aoAbrirFechar}>
      <PopoverTrigger
        render={
          <Button
            variant="outline"
            size="sm"
            role="combobox"
            aria-expanded={aberto}
            aria-label="Selecionar entidade"
            className="min-h-11 w-full justify-between gap-1.5 sm:min-h-9 sm:w-[240px]"
          />
        }
      >
        <span className="flex items-center gap-1.5 truncate">
          <Building2 className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          {entidadeId !== null
            ? entidadeNome
              ? `${entidadeNome} (#${entidadeId})`
              : `Entidade #${entidadeId}`
            : 'Selecionar entidade...'}
        </span>
        <ChevronsUpDown className="size-3.5 shrink-0 opacity-50" aria-hidden="true" />
      </PopoverTrigger>
      <PopoverContent className="w-[280px] p-0" align="start">
        <Command onInputValueChange={(q: string) => setBusca(q)}>
          <CommandInput placeholder="Digite o ID da entidade..." aria-label="ID da entidade" />
          <CommandList>
            {buscaNumerica === null && recentesFiltrados.length === 0 && (
              <CommandEmpty>Digite um ID numérico de entidade.</CommandEmpty>
            )}
            {buscaNumerica !== null && (
              <CommandItem
                value={`consultar-${buscaNumerica}`}
                onClick={() => selecionar(buscaNumerica)}
                className="cursor-pointer"
              >
                <Search className="mr-2 size-4 shrink-0 text-primary" aria-hidden="true" />
                Consultar entidade #{buscaNumerica}
              </CommandItem>
            )}
            {recentesFiltrados.map((id) => (
              <CommandItem
                key={id}
                value={`recente-${id}`}
                onClick={() => selecionar(id)}
                className="cursor-pointer"
              >
                <History className="mr-2 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                Entidade #{id}
                <span className="ml-auto text-xs text-muted-foreground">recente</span>
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

export default function AdminModulosPage() {
  const { entidadeAtiva } = useHubAuth();
  const h = useModulosDaEntidade(entidadeAtiva ?? 0);
  // Desabilitar módulo é ação de alto impacto ("usuário perde acesso
  // imediatamente") — exige confirmação. Habilitar é direto.
  const [confirmandoDesabilitar, setConfirmandoDesabilitar] = useState<ModuloEntidadeItem | null>(null);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 p-4 sm:p-6 lg:p-8">
      <PageHeader
        titulo="Administração da plataforma"
        subtitulo="Habilite ou desabilite módulos por entidade. O efeito é imediato: o usuário afetado perde/recupera acesso sem precisar logar novamente."
      />

      <div className="flex flex-wrap items-end gap-2 rounded-lg border bg-card p-3">
        <div className="flex w-full flex-col gap-1 sm:w-auto">
          <Label id="admin-entidade-label">Entidade</Label>
          <EntidadeCombobox entidadeId={h.entidadeId} entidadeNome={h.entidadeNome} onSelecionar={h.setEntidadeId} />
        </div>
      </div>

      {h.erroToggle && (
        <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          {h.erroToggle}
        </div>
      )}

      {h.carregando ? (
        <ListSkeleton label="Carregando módulos..." linhas={5} />
      ) : h.erro ? (
        <div
          role="alert"
          className="flex flex-col items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-10 text-center"
        >
          <AlertCircle className="size-8 text-destructive" aria-hidden="true" />
          <p className="text-sm font-medium text-destructive">{h.erro}</p>
          <Button size="sm" variant="outline" className="min-h-11 sm:min-h-8" onClick={h.refetch}>
            Tentar novamente
          </Button>
        </div>
      ) : h.entidadeId === null ? (
        <EmptyState
          icone={Settings2}
          titulo="Selecione uma entidade para começar"
          dica="Digite o ID no seletor acima ou escolha uma consultada recentemente."
        />
      ) : (
        <div className="flex flex-col gap-2">
          {h.modulos.map((m) => (
            <div key={m.moduloId} className="flex items-center justify-between gap-3 rounded-lg border p-3">
              <div>
                <p className="font-medium">{m.nome}</p>
                <p className="text-xs text-muted-foreground">{m.codigo}</p>
              </div>
              <label className="flex min-h-11 cursor-pointer items-center gap-2 sm:min-h-8">
                <span className="text-xs text-muted-foreground">
                  {m.habilitado ? 'Habilitado' : 'Desabilitado'}
                </span>
                <Switch
                  aria-label={`Módulo ${m.nome} ${m.habilitado ? 'habilitado' : 'desabilitado'}`}
                  checked={m.habilitado}
                  disabled={h.emSalvamento.has(m.codigo)}
                  onCheckedChange={(checked) => {
                    if (checked) {
                      h.alternar(m.codigo, true);
                    } else {
                      // O Switch é controlado (checked={m.habilitado}) — negar
                      // aqui não muda nada visualmente até a confirmação.
                      setConfirmandoDesabilitar(m);
                    }
                  }}
                />
              </label>
            </div>
          ))}
          {h.modulos.length === 0 && (
            <p className="text-sm text-muted-foreground">Nenhum módulo cadastrado na plataforma.</p>
          )}
        </div>
      )}

      <AlertDialog
        open={confirmandoDesabilitar !== null}
        onOpenChange={(v) => !v && setConfirmandoDesabilitar(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Desabilitar módulo</AlertDialogTitle>
            <AlertDialogDescription>
              Desabilitar o módulo {confirmandoDesabilitar?.nome} da entidade #{h.entidadeId}? O efeito é
              imediato: os usuários desta entidade perdem o acesso ao módulo sem precisar logar novamente.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Voltar</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (confirmandoDesabilitar) h.alternar(confirmandoDesabilitar.codigo, false);
                setConfirmandoDesabilitar(null);
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Desabilitar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

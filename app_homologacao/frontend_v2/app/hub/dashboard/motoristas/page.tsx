'use client';

// hub-motoristas (S5) FASE 7 task 7.1.1 — rota `/hub/dashboard/motoristas`:
// lista paginada com filtros server-side (nome/ativo/área/vínculo).
//
// Mesmo molde de `.../importacoes/page.tsx` (task 7.1.1 exige reusar o
// padrão): hook de filtro/paginação local (state puro, sem sync de URL —
// convenção observada na S4), cards no mobile + `Table` no desktop, filtros
// inline em `<select>`/`<Input>` do shadcn. Sem componente `<DataTable>`
// genérico — não existe no hub (só no legado `/dashboard`).
//
// Ref: docs/specs/hub-motoristas/plan.md §Plano por fases item 7,
// contracts/motoristas-api.md §GET /motoristas.

import { Suspense, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import { AlertCircle, ChevronRight, Loader2, Plus, Truck, UploadCloud } from 'lucide-react';
import { Button, buttonVariants } from '@/components/ui/button';
import { FilterBar } from '@/components/hub/filter-bar';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useHubAuth } from '@/contexts/hub-auth-context';
import { LARGURA_LISTA } from '@/lib/hub/larguras';
import { PageHeader } from '@/components/hub/page-header';
import { EmptyState } from '@/components/hub/empty-state';
import { SelectFiltro } from '@/components/hub/select-filtro';
import { ListSkeleton } from '@/components/hub/table-skeleton';
import { AtivoBadge, VinculoBadge } from '@/components/hub/status-badge';
import { CopyableUuid } from '@/components/hub/copyable-uuid';
import { MotoristaDetalheDialog, useMotoristaDetalheDialog } from '@/components/hub/motorista-detalhe-dialog';
import { PaginationControls } from '@/components/pagination-controls';
import { criarMotorista, listarAreasMotoristas, listarMotoristas, MotoristaApiError, type ColunaMotoristas } from '@/lib/hub/motoristas-api';
import { isUuidValido, type MotoristaListItem } from '@/lib/hub/motoristas-dto';
import { proximaOrdenacao } from '@/lib/utils';
import { CabecalhoOrdenavel } from '@/components/hub/cabecalho-ordenavel';
import { useDebounce } from '@/hooks/use-debounce';
import { useFiltrosUrl } from '@/hooks/use-filtros-url';

const PAGE_SIZE = 20;

export interface MotoristasFiltros {
  nome: string;
  ativo: '' | 'true' | 'false';
  area: string;
  comVinculo: '' | 'true' | 'false';
  // rodada 16: a ordenação viaja junto dos filtros — assim herda a URL (r14) e
  // sobrevive a recarregar e a compartilhar o link, sem mecânica própria.
  ordenarPor: '' | ColunaMotoristas;
  direcao: '' | 'asc' | 'desc';
}

const FILTROS_INICIAIS: MotoristasFiltros = {
  nome: '',
  ativo: '',
  area: '',
  comVinculo: '',
  ordenarPor: '',
  direcao: '',
};

/** Lógica isolada do JSX (mesmo padrão de `useImportacoesHistorico`). */
export function useMotoristasLista() {
  // rodada 14 (h3): filtro e página passam a viver na URL — é o que faz
  // "Voltar à lista" devolver a lista como estava (ver `use-filtros-url.ts`).
  const {
    filtros,
    page,
    setFiltros,
    setPage,
    limpar: resetFiltros,
  } = useFiltrosUrl<MotoristasFiltros>(FILTROS_INICIAIS);
  const [items, setItems] = useState<MotoristaListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);

  // impeccable rodada 2 (P2): antes era 1 fetch por tecla no campo de nome —
  // o debounce espera a digitação assentar (DEBOUNCE_MS=300 do combobox).
  const filtrosDebounced = useDebounce(filtros, 300);

  const buscar = useCallback(async () => {
    setCarregando(true);
    setErro(null);
    try {
      const resposta = await listarMotoristas({
        nome: filtrosDebounced.nome || undefined,
        ativo: filtrosDebounced.ativo === '' ? undefined : filtrosDebounced.ativo === 'true',
        area: filtrosDebounced.area || undefined,
        comVinculo: filtrosDebounced.comVinculo === '' ? undefined : filtrosDebounced.comVinculo === 'true',
        ordenarPor: filtrosDebounced.ordenarPor || undefined,
        direcao: filtrosDebounced.direcao || undefined,
        page,
        pageSize: PAGE_SIZE,
      });
      setItems(resposta.items);
      setTotal(resposta.total);
    } catch (e) {
      setErro(e instanceof MotoristaApiError ? e.message : 'Não foi possível carregar a lista de motoristas.');
      setItems([]);
      setTotal(0);
    } finally {
      setCarregando(false);
    }
  }, [filtrosDebounced, page]);

  useEffect(() => {
    buscar();
  }, [buscar]);

  const totalPaginas = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // rodada 16: traduz "clicaram no cabeçalho X" para o par
  // ordenarPor/direcao dos filtros. `''` nos dois campos = ordem padrão do
  // backend (nome.asc), que é o terceiro estado do ciclo.
  const ordem = filtros.ordenarPor
    ? { coluna: filtros.ordenarPor, direcao: (filtros.direcao || 'asc') as 'asc' | 'desc' }
    : null;
  const alternarOrdem = useCallback(
    (coluna: ColunaMotoristas) => {
      const proxima = proximaOrdenacao(
        filtros.ordenarPor ? { coluna: filtros.ordenarPor, direcao: (filtros.direcao || 'asc') as 'asc' | 'desc' } : null,
        coluna
      );
      setFiltros({ ordenarPor: proxima?.coluna ?? '', direcao: proxima?.direcao ?? '' });
    },
    [filtros.ordenarPor, filtros.direcao, setFiltros]
  );

  return {
    filtros,
    setFiltros,
    ordem,
    alternarOrdem,
    resetFiltros,
    page,
    setPage,
    totalPaginas,
    items,
    total,
    carregando,
    erro,
    refetch: buscar,
  };
}

// FASE 4 (task 4.3.1) — cadastro manual de motorista: nome + idExterno
// (uuid), ambos obrigatórios, validação de formato no cliente ANTES de
// submeter (nunca a única linha de defesa — o backend revalida sempre via
// `validarCriacaoMotorista`). Mesmo molde de `CriarUsuarioDialog`
// (app/hub/dashboard/usuarios/page.tsx) — Dialog (não Sheet) para criação,
// idioma F3.
interface ErrosCamposCriarMotorista {
  nome?: string;
  idExterno?: string;
}

interface CriarMotoristaDialogProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onCriado: () => void;
}

function CriarMotoristaDialog({ open, onOpenChange, onCriado }: CriarMotoristaDialogProps) {
  const [nome, setNome] = useState('');
  const [idExterno, setIdExterno] = useState('');
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [errosCampo, setErrosCampo] = useState<ErrosCamposCriarMotorista>({});

  useEffect(() => {
    if (open) {
      setNome('');
      setIdExterno('');
      setErro(null);
      setErrosCampo({});
    }
  }, [open]);

  const submit = useCallback(async () => {
    const erros: ErrosCamposCriarMotorista = {};
    if (!nome.trim()) erros.nome = 'Informe o nome.';
    if (!idExterno.trim()) {
      erros.idExterno = 'Informe o identificador (uuid) da planilha de origem.';
    } else if (!isUuidValido(idExterno)) {
      erros.idExterno = 'Formato de identificador (uuid) inválido.';
    }
    setErrosCampo(erros);
    const primeiroInvalido = (['nome', 'idExterno'] as const).find((c) => erros[c]);
    if (primeiroInvalido) {
      document.getElementById(`novo-motorista-${primeiroInvalido}`)?.focus();
      return;
    }
    setSalvando(true);
    setErro(null);
    try {
      await criarMotorista({ nome: nome.trim(), idExterno: idExterno.trim() });
      onCriado();
      onOpenChange(false);
      toast.success('Motorista cadastrado.');
    } catch (e) {
      if (e instanceof MotoristaApiError && e.codigo === 'uuid_duplicado') {
        setErrosCampo({ idExterno: e.message });
        document.getElementById('novo-motorista-idExterno')?.focus();
      } else if (e instanceof MotoristaApiError && e.codigo === 'uuid_invalido') {
        setErrosCampo({ idExterno: e.message });
        document.getElementById('novo-motorista-idExterno')?.focus();
      } else {
        setErro(e instanceof MotoristaApiError ? e.message : 'Não foi possível cadastrar o motorista.');
      }
    } finally {
      setSalvando(false);
    }
  }, [nome, idExterno, onCriado, onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Novo motorista</DialogTitle>
          <DialogDescription>
            O identificador (uuid) é o mesmo usado na planilha de origem — é ele que correlaciona este motorista às
            importações de faturamento e performance.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <Label htmlFor="novo-motorista-nome">Nome</Label>
            <Input
              id="novo-motorista-nome"
              value={nome}
              onChange={(e) => setNome(e.target.value)}
              disabled={salvando}
              aria-invalid={!!errosCampo.nome}
              aria-describedby={errosCampo.nome ? 'novo-motorista-nome-erro' : undefined}
            />
            {errosCampo.nome && (
              <p id="novo-motorista-nome-erro" role="alert" className="text-xs text-destructive">
                {errosCampo.nome}
              </p>
            )}
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="novo-motorista-idExterno">Identificador (uuid)</Label>
            <Input
              id="novo-motorista-idExterno"
              value={idExterno}
              onChange={(e) => setIdExterno(e.target.value)}
              disabled={salvando}
              className="font-mono"
              placeholder="00000000-0000-0000-0000-000000000000"
              aria-invalid={!!errosCampo.idExterno}
              aria-describedby={errosCampo.idExterno ? 'novo-motorista-idExterno-erro' : 'novo-motorista-idExterno-ajuda'}
            />
            {errosCampo.idExterno ? (
              <p id="novo-motorista-idExterno-erro" role="alert" className="text-xs text-destructive">
                {errosCampo.idExterno}
              </p>
            ) : (
              <p id="novo-motorista-idExterno-ajuda" className="text-xs text-muted-foreground">
                Mesmo uuid (&quot;id da pessoa entregadora&quot;) da planilha de faturamento/performance.
              </p>
            )}
          </div>
          {erro && (
            <p role="alert" className="text-sm text-destructive">
              {erro}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={salvando}>
            Cancelar
          </Button>
          <Button onClick={submit} disabled={salvando}>
            {salvando && <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden="true" />}
            {salvando ? 'Cadastrando...' : 'Cadastrar motorista'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function MotoristasConteudo() {
  const { permissoes } = useHubAuth();
  const podeConsultar = permissoes.includes('motoristas.consultar');
  const podeEditar = permissoes.includes('motoristas.editar');
  // impeccable r22 (P2): a saída oferecida no estado vazio depende do módulo
  // que o papel realmente alcança — ver o `EmptyState` mais abaixo.
  const podeImportar = permissoes.includes('importacoes.consultar');
  const h = useMotoristasLista();
  // impeccable r22 (P2): decide a saída do estado vazio (ver `EmptyState`).
  // Ordenação não é filtro: ordenar uma lista vazia não é o que a esvaziou, e
  // oferecer "Limpar filtros" ali mandaria o operador limpar o que não existe.
  const temFiltroAtivo = Object.entries(h.filtros).some(
    ([chave, valor]) => chave !== 'ordenarPor' && chave !== 'direcao' && valor !== ''
  );
  const [criarAberto, setCriarAberto] = useState(false);
  // uiux-hub pós-F4: o filtro "Área" deixou de ser texto livre — as opções
  // vêm de GET /motoristas/areas (subpraças distintas do escopo). Falha na
  // carga degrada para só "Todas" (o filtro fica inerte, a lista não quebra).
  const [areasOpcoes, setAreasOpcoes] = useState<string[]>([]);
  useEffect(() => {
    let ativo = true;
    listarAreasMotoristas()
      .then((areas) => { if (ativo) setAreasOpcoes(areas); })
      .catch(() => { if (ativo) setAreasOpcoes([]); });
    return () => { ativo = false; };
  }, []);
  // uiux-hub pós-F4: na tabela desktop, tanto a linha quanto a ação "Detalhes"
  // abrem o detalhe em modal (mesmos campos do legado); a página completa
  // segue acessível pelo rodapé do modal e pelos cards mobile.
  const detalheDialog = useMotoristaDetalheDialog();

  return (
    <div className={`mx-auto flex w-full ${LARGURA_LISTA} flex-col gap-4 p-4 sm:p-6 lg:p-8`}>
      <PageHeader
        titulo="Motoristas"
        subtitulo="Pessoas entregadoras conhecidas pelas importações de faturamento e performance."
      >
        {podeEditar && (
          <Button size="sm" className="min-h-11 gap-1.5 sm:min-h-8" onClick={() => setCriarAberto(true)}>
            <Plus className="size-4" aria-hidden="true" />
            Novo motorista
          </Button>
        )}
      </PageHeader>

      {/* Filtros */}
      <FilterBar
        onClear={h.resetFiltros}
        filtrosAtivos={Object.values(h.filtros).filter((v) => v !== '').length}
      >
        <div className="flex flex-col gap-1">
          <label htmlFor="motoristas-filtro-nome" className="text-xs text-muted-foreground">
            Nome
          </label>
          <Input
            id="motoristas-filtro-nome"
            value={h.filtros.nome}
            onChange={(e) => h.setFiltros({ nome: e.target.value })}
            placeholder="Buscar por nome..."
            className="h-11 sm:h-9"
          />
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="motoristas-filtro-ativo" className="text-xs text-muted-foreground">
            Situação
          </label>
          <SelectFiltro
            id="motoristas-filtro-ativo"
            ariaLabel="Situação"
            value={h.filtros.ativo}
            onChange={(v) => h.setFiltros({ ativo: v as MotoristasFiltros['ativo'] })}
            opcoes={[
              { value: '', label: 'Todas' },
              { value: 'true', label: 'Ativo' },
              { value: 'false', label: 'Inativo' },
            ]}
          />
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="motoristas-filtro-area" className="text-xs text-muted-foreground">
            Área (subpraça)
          </label>
          <SelectFiltro
            id="motoristas-filtro-area"
            ariaLabel="Área (subpraça)"
            value={h.filtros.area}
            onChange={(area) => h.setFiltros({ area })}
            opcoes={[
              { value: '', label: 'Todas' },
              ...areasOpcoes.map((area) => ({ value: area, label: area })),
            ]}
          />
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="motoristas-filtro-vinculo" className="text-xs text-muted-foreground">
            Vínculo
          </label>
          <SelectFiltro
            id="motoristas-filtro-vinculo"
            ariaLabel="Vínculo"
            value={h.filtros.comVinculo}
            onChange={(v) => h.setFiltros({ comVinculo: v as MotoristasFiltros['comVinculo'] })}
            opcoes={[
              { value: '', label: 'Todos' },
              { value: 'true', label: 'Vinculado' },
              { value: 'false', label: 'Sem vínculo' },
            ]}
          />
        </div>
      </FilterBar>

      {/* Conteúdo */}
      {h.carregando ? (
        <ListSkeleton label="Carregando motoristas..." />
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
      ) : h.items.length === 0 ? (
        <EmptyState
          icone={Truck}
          titulo="Nenhum motorista encontrado"
          dica={
            temFiltroAtivo
              ? 'Nenhum motorista corresponde aos filtros atuais.'
              : 'Os motoristas aparecem aqui depois de uma importação de planilha.'
          }
        >
          {temFiltroAtivo ? (
            <Button
              size="sm"
              variant="outline"
              className="min-h-11 sm:min-h-8"
              onClick={h.resetFiltros}
            >
              Limpar filtros
            </Button>
          ) : (
            podeImportar && (
              <Link
                href="/hub/dashboard/importacoes"
                className={buttonVariants({
                  size: 'sm',
                  className: 'min-h-11 gap-1.5 sm:min-h-8',
                })}
              >
                <UploadCloud className="size-4" aria-hidden="true" />
                Ir para Importações
              </Link>
            )
          )}
        </EmptyState>
      ) : (
        <>
          {/* Mobile card layout */}
          <div className="flex flex-col gap-2 md:hidden">
            {h.items.map((item) => (
              <Link
                key={item.id}
                href={podeConsultar ? `/hub/dashboard/motoristas/${item.id}` : '#'}
                aria-disabled={!podeConsultar}
                className="rounded-lg border p-3 hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">{item.nome}</span>
                  <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <AtivoBadge ativo={item.ativo} />
                  <VinculoBadge vinculado={item.comVinculo} />
                </div>
                {/* uuid copiável (FR-016, task 4.3.2) — stopPropagation para o
                    clique no botão de copiar não navegar para o detalhe (o
                    card inteiro é um <Link>). */}
                <div className="mt-2" onClick={(e) => e.stopPropagation()}>
                  <CopyableUuid value={item.idExterno} label={`Copiar identificador de ${item.nome}`} />
                </div>
                {item.areas.length > 0 && (
                  <p className="mt-2 truncate text-xs text-muted-foreground">{item.areas.join(', ')}</p>
                )}
              </Link>
            ))}
          </div>

          {/* Desktop table */}
          <div className="hidden rounded-lg border md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <CabecalhoOrdenavel coluna="nome" rotulo="Nome" ordem={h.ordem} onOrdenar={h.alternarOrdem} />
                  <TableHead>Identificador</TableHead>
                  <CabecalhoOrdenavel coluna="ativo" rotulo="Situação" ordem={h.ordem} onOrdenar={h.alternarOrdem} />
                  <TableHead>Vínculo</TableHead>
                  <CabecalhoOrdenavel coluna="area" rotulo="Áreas" ordem={h.ordem} onOrdenar={h.alternarOrdem} />
                  <TableHead className="text-right">Ações</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {h.items.map((item) => (
                  <TableRow
                    key={item.id}
                    className={podeConsultar ? 'cursor-pointer hover:bg-muted/50' : undefined}
                    onClick={podeConsultar ? () => detalheDialog.abrir(item.id) : undefined}
                  >
                    <TableCell className="font-medium">{item.nome}</TableCell>
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      <CopyableUuid value={item.idExterno} label={`Copiar identificador de ${item.nome}`} />
                    </TableCell>
                    <TableCell>
                      <AtivoBadge ativo={item.ativo} />
                    </TableCell>
                    <TableCell>
                      <VinculoBadge vinculado={item.comVinculo} />
                    </TableCell>
                    <TableCell className="max-w-[260px] truncate text-sm text-muted-foreground">
                      {item.areas.join(', ') || '-'}
                    </TableCell>
                    <TableCell className="text-right">
                      {podeConsultar ? (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            detalheDialog.abrir(item.id);
                          }}
                          className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
                        >
                          Detalhes
                          <ChevronRight className="size-3.5" aria-hidden="true" />
                        </button>
                      ) : (
                        <span className="text-sm text-muted-foreground">-</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          {/* Paginação — idioma único do produto (impeccable rodada 4, h4). */}
          <PaginationControls
            currentPage={h.page}
            totalPages={h.totalPaginas}
            recordsPerPage={PAGE_SIZE}
            totalRecords={h.total}
            onPageChange={h.setPage}
          />

          <MotoristaDetalheDialog state={detalheDialog} />
        </>
      )}

      {podeEditar && (
        <CriarMotoristaDialog open={criarAberto} onOpenChange={setCriarAberto} onCriado={h.refetch} />
      )}
    </div>
  );
}

// rodada 14: `useFiltrosUrl` usa `useSearchParams`, e o Next reprova o
// prerender de página sem boundary ("should be wrapped in a suspense
// boundary"). O fallback é o mesmo esqueleto que a tela já usa enquanto
// carrega — nada novo aparece para quem olha.
export default function MotoristasPage() {
  return (
    <Suspense>
      <MotoristasConteudo />
    </Suspense>
  );
}

'use client';

/**
 * Tela /dashboard/motoristas
 * CRUD da base curada de motoristas (tabela "Motorista").
 *
 * Feature: cadastro-motorista-base-validada (frente C)
 * Backend: /api/admin/motoristas (auth de empresa; escopo derivado de EnvioMassa).
 *
 * Paginação: client-side, espelhando a tela EnvioMassa (componente
 *   PaginationControls; busca + fatiamento em memória; rodapé fixo num layout
 *   de altura cheia md:h-full).
 *
 * Regras de UI (decisões §6):
 *   - Edita apenas nome e ativo (§6.5: CNPJ é imutável — é a chave/identidade).
 *   - "Resetar senha" devolve o motorista ao pré-cadastro (§6.6: senha=NULL;
 *     ele refaz o /register no app).
 *   - "Desativar" é exclusão lógica (§6.7: ativo=false; login do app negado).
 *   - Status "Cadastrado" = já definiu senha; "Pré-cadastro" = veio do upload.
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { Pencil, KeyRound, Power, PowerOff, Loader2, Search, Truck } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { PaginationControls } from '@/components/pagination-controls';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
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

/* ------------------------------------------------------------------ */
/* Tipos                                                                */
/* ------------------------------------------------------------------ */

interface Motorista {
  id: number;
  cnpj_prestador: string;
  nome: string;
  ativo: boolean;
  cadastrado: boolean;
  created_at: string;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                              */
/* ------------------------------------------------------------------ */

function maskCNPJ(value: string): string {
  const d = (value || '').replace(/\D/g, '');
  if (d.length !== 14) return value;
  return d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
}

async function readError(res: Response): Promise<string> {
  const body = await res.json().catch(() => ({}));
  return body.error || body.message || `Erro ${res.status}`;
}

/* ------------------------------------------------------------------ */
/* Página                                                              */
/* ------------------------------------------------------------------ */

export default function MotoristasPage() {
  const [motoristas, setMotoristas] = useState<Motorista[]>([]);
  const [loading, setLoading] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [busca, setBusca] = useState('');

  /* ---- paginação (client-side, igual à EnvioMassa) ---- */
  const [currentPage, setCurrentPage] = useState(1);
  const [recordsPerPage, setRecordsPerPage] = useState<number | 'all'>(100);

  /* ---- editar (Dialog) ---- */
  const [editAlvo, setEditAlvo] = useState<Motorista | null>(null);
  const [editNome, setEditNome] = useState('');
  const [editAtivo, setEditAtivo] = useState(true);
  const [editSalvando, setEditSalvando] = useState(false);

  /* ---- resetar senha (AlertDialog) ---- */
  const [resetAlvo, setResetAlvo] = useState<Motorista | null>(null);
  const [resetando, setResetando] = useState(false);

  /* ---- desativar (AlertDialog) ---- */
  const [desativarAlvo, setDesativarAlvo] = useState<Motorista | null>(null);
  const [desativando, setDesativando] = useState(false);

  /* ---------------------------------------------------------------- */
  /* Carga — busca a base completa do escopo; filtro/paginação em memória */
  const carregar = useCallback(async () => {
    setLoading(true);
    setErro(null);
    try {
      const res = await fetch('/api/admin/motoristas', { credentials: 'include' });
      if (!res.ok) {
        setErro(await readError(res));
        setMotoristas([]);
        return;
      }
      const data = await res.json();
      setMotoristas(data.motoristas || []);
    } catch {
      setErro('Falha ao carregar motoristas. Verifique sua conexão.');
      setMotoristas([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    carregar();
  }, [carregar]);

  /* ---- filtro (busca por nome/CNPJ) em memória ---- */
  const filtrados = useMemo(() => {
    const q = busca.trim().toLowerCase();
    if (!q) return motoristas;
    const qDigits = q.replace(/\D/g, '');
    return motoristas.filter(
      (m) =>
        (m.nome && m.nome.toLowerCase().includes(q)) ||
        (qDigits.length > 0 && m.cnpj_prestador.includes(qDigits)),
    );
  }, [motoristas, busca]);

  /* ---- paginação (mesma lógica do hook useEnvioMassa) ---- */
  const totalPages = useMemo(
    () => (recordsPerPage === 'all' ? 1 : Math.max(1, Math.ceil(filtrados.length / recordsPerPage))),
    [filtrados.length, recordsPerPage],
  );

  const paginados = useMemo(() => {
    if (recordsPerPage === 'all') return filtrados;
    const start = (currentPage - 1) * recordsPerPage;
    return filtrados.slice(start, start + recordsPerPage);
  }, [filtrados, currentPage, recordsPerPage]);

  // Clamp: se a página atual saiu do range (após filtrar/remover), volta ao limite
  useEffect(() => {
    if (currentPage > totalPages) setCurrentPage(totalPages);
  }, [currentPage, totalPages]);

  const onBuscaChange = (v: string) => {
    setBusca(v);
    setCurrentPage(1);
  };

  const changeRecordsPerPage = (value: number | 'all') => {
    setRecordsPerPage(value);
    setCurrentPage(1);
  };

  /* ---- editar ---- */
  const abrirEditar = (m: Motorista) => {
    setEditAlvo(m);
    setEditNome(m.nome || '');
    setEditAtivo(m.ativo);
  };

  const salvarEdicao = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editAlvo) return;
    if (!editNome.trim()) {
      toast.error('Informe o nome do motorista.');
      return;
    }
    setEditSalvando(true);
    try {
      const res = await fetch(`/api/admin/motoristas/${editAlvo.id}`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nome: editNome.trim(), ativo: editAtivo }),
      });
      if (!res.ok) {
        toast.error(await readError(res));
        return;
      }
      toast.success('Motorista atualizado.');
      setEditAlvo(null);
      await carregar();
    } catch {
      toast.error('Falha ao salvar. Tente novamente.');
    } finally {
      setEditSalvando(false);
    }
  };

  /* ---- resetar senha ---- */
  const confirmarReset = async () => {
    if (!resetAlvo) return;
    setResetando(true);
    try {
      const res = await fetch(`/api/admin/motoristas/${resetAlvo.id}/reset-senha`, {
        method: 'POST',
        credentials: 'include',
      });
      if (!res.ok) {
        toast.error(await readError(res));
        return;
      }
      toast.success('Senha resetada. O motorista deve refazer o cadastro no app.');
      setResetAlvo(null);
      await carregar();
    } catch {
      toast.error('Falha ao resetar senha. Tente novamente.');
    } finally {
      setResetando(false);
    }
  };

  /* ---- desativar (soft delete) ---- */
  const confirmarDesativar = async () => {
    if (!desativarAlvo) return;
    setDesativando(true);
    try {
      const res = await fetch(`/api/admin/motoristas/${desativarAlvo.id}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!res.ok) {
        toast.error(await readError(res));
        return;
      }
      toast.success('Motorista desativado.');
      setDesativarAlvo(null);
      await carregar();
    } catch {
      toast.error('Falha ao desativar. Tente novamente.');
    } finally {
      setDesativando(false);
    }
  };

  /* ---- reativar (PUT ativo:true) ---- */
  const reativar = async (m: Motorista) => {
    try {
      const res = await fetch(`/api/admin/motoristas/${m.id}`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ativo: true }),
      });
      if (!res.ok) {
        toast.error(await readError(res));
        return;
      }
      toast.success('Motorista reativado.');
      await carregar();
    } catch {
      toast.error('Falha ao reativar. Tente novamente.');
    }
  };

  /* ---------------------------------------------------------------- */
  return (
    <div className="flex flex-col gap-4 md:h-full">
      {/* Cabeçalho + busca (fixos) */}
      <div className="shrink-0 space-y-4">
        <div className="flex flex-col gap-1">
          <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
            <Truck className="h-6 w-6 text-primary" />
            Motoristas
          </h1>
          <p className="text-sm text-muted-foreground">
            Base de motoristas habilitados a se cadastrar no app. Os motoristas são
            incluídos automaticamente pela importação do movimento.
          </p>
        </div>

        <div className="relative max-w-sm">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={busca}
            onChange={(e) => onBuscaChange(e.target.value)}
            placeholder="Buscar por nome ou CNPJ…"
            className="pl-9"
            aria-label="Buscar motoristas"
          />
        </div>
      </div>

      {/* Área central — tabela ocupa o espaço restante e rola internamente */}
      <div className="min-h-[200px] md:flex-1 md:min-h-0">
        {loading ? (
          <div className="flex h-full items-center justify-center py-16">
            <Loader2 className="h-6 w-6 animate-spin text-primary" />
          </div>
        ) : erro ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {erro}
          </div>
        ) : filtrados.length === 0 ? (
          <div className="rounded-md border border-dashed px-4 py-12 text-center text-sm text-muted-foreground">
            {busca.trim()
              ? 'Nenhum motorista encontrado para a busca.'
              : 'Nenhum motorista na base ainda. Importe um movimento para popular a lista.'}
          </div>
        ) : (
          <div className="rounded-md border overflow-auto md:h-full">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Nome</TableHead>
                  <TableHead>CNPJ</TableHead>
                  <TableHead>Cadastro</TableHead>
                  <TableHead>Situação</TableHead>
                  <TableHead className="text-right">Ações</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {paginados.map((m) => (
                  <TableRow key={m.id} className={m.ativo ? '' : 'opacity-60'}>
                    <TableCell className="font-medium">{m.nome || '—'}</TableCell>
                    <TableCell className="tabular-nums">{maskCNPJ(m.cnpj_prestador)}</TableCell>
                    <TableCell>
                      {m.cadastrado ? (
                        <Badge variant="default">Cadastrado</Badge>
                      ) : (
                        <Badge variant="secondary">Pré-cadastro</Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      {m.ativo ? (
                        <Badge variant="outline">Ativo</Badge>
                      ) : (
                        <Badge variant="destructive">Inativo</Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => abrirEditar(m)}
                          aria-label={`Editar ${m.nome}`}
                          title="Editar"
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => setResetAlvo(m)}
                          disabled={!m.cadastrado}
                          aria-label={`Resetar senha de ${m.nome}`}
                          title={m.cadastrado ? 'Resetar senha' : 'Sem senha definida'}
                        >
                          <KeyRound className="h-4 w-4" />
                        </Button>
                        {m.ativo ? (
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => setDesativarAlvo(m)}
                            aria-label={`Desativar ${m.nome}`}
                            title="Desativar"
                            className="text-destructive hover:text-destructive"
                          >
                            <PowerOff className="h-4 w-4" />
                          </Button>
                        ) : (
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => reativar(m)}
                            aria-label={`Reativar ${m.nome}`}
                            title="Reativar"
                          >
                            <Power className="h-4 w-4" />
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>

      {/* Paginação fixa no rodapé (igual à EnvioMassa) */}
      {!loading && !erro && filtrados.length > 0 && (
        <div className="shrink-0">
          <PaginationControls
            currentPage={currentPage}
            totalPages={totalPages}
            recordsPerPage={recordsPerPage}
            totalRecords={filtrados.length}
            onPageChange={setCurrentPage}
            onRecordsPerPageChange={changeRecordsPerPage}
          />
        </div>
      )}

      {/* Dialog: editar motorista */}
      <Dialog open={editAlvo !== null} onOpenChange={(o) => { if (!o) setEditAlvo(null); }}>
        <DialogContent>
          <form onSubmit={salvarEdicao}>
            <DialogHeader>
              <DialogTitle>Editar motorista</DialogTitle>
              <DialogDescription>
                O CNPJ ({editAlvo ? maskCNPJ(editAlvo.cnpj_prestador) : ''}) é a
                identidade do motorista e não pode ser alterado.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4 py-4">
              <div className="space-y-2">
                <Label htmlFor="edit-nome">Nome</Label>
                <Input
                  id="edit-nome"
                  value={editNome}
                  onChange={(e) => setEditNome(e.target.value)}
                  autoComplete="off"
                  required
                />
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={editAtivo}
                  onChange={(e) => setEditAtivo(e.target.checked)}
                  className="h-4 w-4 rounded border-input"
                />
                Motorista ativo (pode acessar o app)
              </label>
            </div>

            <DialogFooter className="gap-2 sm:gap-0">
              <button
                type="button"
                onClick={() => setEditAlvo(null)}
                disabled={editSalvando}
                className="inline-flex min-h-[44px] items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
              >
                Cancelar
              </button>
              <button
                type="submit"
                disabled={editSalvando}
                className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-md bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {editSalvando && <Loader2 className="h-4 w-4 animate-spin" />}
                Salvar alterações
              </button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* AlertDialog: resetar senha */}
      <AlertDialog open={resetAlvo !== null} onOpenChange={(o) => { if (!o) setResetAlvo(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Resetar senha</AlertDialogTitle>
            <AlertDialogDescription>
              {resetAlvo
                ? `Isto remove a senha de "${resetAlvo.nome}". Ele voltará ao estado de pré-cadastro e precisará se cadastrar novamente no app para definir uma nova senha. Nenhuma senha temporária é gerada.`
                : ''}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={resetando}>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => { e.preventDefault(); confirmarReset(); }}
              disabled={resetando}
            >
              {resetando && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Resetar senha
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* AlertDialog: desativar */}
      <AlertDialog open={desativarAlvo !== null} onOpenChange={(o) => { if (!o) setDesativarAlvo(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Desativar motorista</AlertDialogTitle>
            <AlertDialogDescription>
              {desativarAlvo
                ? `"${desativarAlvo.nome}" deixará de conseguir acessar o app. O registro e o histórico são preservados — você pode reativá-lo depois.`
                : ''}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={desativando}>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => { e.preventDefault(); confirmarDesativar(); }}
              disabled={desativando}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {desativando && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Desativar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

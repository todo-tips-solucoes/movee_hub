'use client';

// hub-auditoria-admin (S9) FASE 5.2 task 5.2.3/5.2.4 — rota
// `/hub/dashboard/usuarios`: lista com busca, criação (usuário + 1º
// vínculo), edição (nome/ativo/senha — CHK033: "desativar" é SEMPRE um
// toggle `ativo`, NUNCA um botão excluir/DELETE) e gestão de vínculos
// (criar vínculo, trocar papel/ativo de vínculo existente).
//
// Mesmo molde de `.../faturamento/page.tsx` para lista/paginação; diálogos
// no molde de `components/hub/vinculo-motorista-dialog.tsx` (hook isolado
// do JSX). Papéis vêm de `listarPapeisMatriz()` (lib/hub/admin-api.ts,
// FASE 5.3) — reuso do catálogo fixo (dec-008), sem endpoint próprio.
//
// Ref: docs/specs/hub-auditoria-admin/contracts/usuarios-api.md,
// spec.md FR-009, quickstart.md Cenário 5.

import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, Plus, RotateCw, UserCog, Users as UsersIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useHubAuth } from '@/contexts/hub-auth-context';
import { listarPapeisMatriz } from '@/lib/hub/admin-api';
import type { PapelCatalogo } from '@/lib/hub/admin-dto';
import {
  criarUsuario,
  criarVinculo,
  editarUsuario,
  editarVinculo,
  isStrongPassword,
  listarUsuarios,
  UsuariosApiError,
} from '@/lib/hub/usuarios-api';
import type { UsuarioListItem, UsuarioVinculo } from '@/lib/hub/usuarios-dto';

const PAGE_SIZE = 20;

/** Lógica de lista isolada do JSX (mesmo padrão de `useFaturamentoLista`). */
function useUsuariosLista() {
  const [busca, setBusca] = useState('');
  const [page, setPage] = useState(1);
  const [usuarios, setUsuarios] = useState<UsuarioListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);

  const buscar = useCallback(async () => {
    setCarregando(true);
    setErro(null);
    try {
      const resposta = await listarUsuarios({ busca: busca || undefined, page, pageSize: PAGE_SIZE });
      setUsuarios(resposta.usuarios);
      setTotal(resposta.total);
    } catch (e) {
      setErro(e instanceof UsuariosApiError ? e.message : 'Não foi possível carregar os usuários.');
      setUsuarios([]);
      setTotal(0);
    } finally {
      setCarregando(false);
    }
  }, [busca, page]);

  useEffect(() => {
    buscar();
  }, [buscar]);

  const totalPaginas = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return { busca, setBusca: (v: string) => { setBusca(v); setPage(1); }, page, setPage, totalPaginas, usuarios, total, carregando, erro, refetch: buscar };
}

function usePapeisCatalogo() {
  const [papeis, setPapeis] = useState<PapelCatalogo[]>([]);
  useEffect(() => {
    listarPapeisMatriz()
      .then((r) => setPapeis(r.papeis))
      .catch(() => setPapeis([]));
  }, []);
  return papeis;
}

interface CriarUsuarioDialogProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  entidadeAtiva: number;
  papeis: PapelCatalogo[];
  onCriado: () => void;
}

function CriarUsuarioDialog({ open, onOpenChange, entidadeAtiva, papeis, onCriado }: CriarUsuarioDialogProps) {
  const [nome, setNome] = useState('');
  const [email, setEmail] = useState('');
  const [senha, setSenha] = useState('');
  const [papelId, setPapelId] = useState<string>('');
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setNome('');
      setEmail('');
      setSenha('');
      setPapelId(papeis[0] ? String(papeis[0].id) : '');
      setErro(null);
    }
  }, [open, papeis]);

  const submit = useCallback(async () => {
    if (!nome.trim() || !email.trim() || !papelId) {
      setErro('Preencha nome, e-mail e papel.');
      return;
    }
    if (!isStrongPassword(senha)) {
      setErro('A senha precisa de 6+ caracteres, 1 maiúscula e 1 número.');
      return;
    }
    setSalvando(true);
    setErro(null);
    try {
      await criarUsuario({
        nome: nome.trim(),
        email: email.trim(),
        senha,
        vinculo: { entidadeId: entidadeAtiva, papelId: Number(papelId) },
      });
      onCriado();
      onOpenChange(false);
    } catch (e) {
      setErro(e instanceof UsuariosApiError ? e.message : 'Não foi possível criar o usuário.');
    } finally {
      setSalvando(false);
    }
  }, [nome, email, senha, papelId, entidadeAtiva, onCriado, onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Novo usuário</DialogTitle>
          <DialogDescription>Cria o usuário e já vincula com um papel na sua entidade.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <Label htmlFor="novo-usuario-nome">Nome</Label>
            <Input id="novo-usuario-nome" value={nome} onChange={(e) => setNome(e.target.value)} disabled={salvando} />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="novo-usuario-email">E-mail</Label>
            <Input
              id="novo-usuario-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={salvando}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="novo-usuario-senha">Senha inicial</Label>
            <Input
              id="novo-usuario-senha"
              type="password"
              value={senha}
              onChange={(e) => setSenha(e.target.value)}
              disabled={salvando}
            />
            <p className="text-xs text-muted-foreground">Mínimo 6 caracteres, 1 letra maiúscula e 1 número.</p>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="novo-usuario-papel">Papel</Label>
            <select
              id="novo-usuario-papel"
              value={papelId}
              onChange={(e) => setPapelId(e.target.value)}
              disabled={salvando}
              className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
            >
              {papeis.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.nome}
                </option>
              ))}
            </select>
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
            {salvando ? 'Criando...' : 'Criar usuário'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface EditarUsuarioDialogProps {
  usuario: UsuarioListItem | null;
  onOpenChange: (v: boolean) => void;
  entidadeAtiva: number;
  papeis: PapelCatalogo[];
  onSalvo: () => void;
}

function EditarUsuarioDialog({ usuario, onOpenChange, entidadeAtiva, papeis, onSalvo }: EditarUsuarioDialogProps) {
  const [nome, setNome] = useState('');
  const [ativo, setAtivo] = useState(true);
  const [novaSenha, setNovaSenha] = useState('');
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [novoVinculoPapelId, setNovoVinculoPapelId] = useState<string>('');
  const [vinculos, setVinculos] = useState<UsuarioVinculo[]>([]);

  useEffect(() => {
    if (usuario) {
      setNome(usuario.nome);
      setAtivo(usuario.ativo);
      setNovaSenha('');
      setErro(null);
      setVinculos(usuario.vinculos);
      setNovoVinculoPapelId(papeis[0] ? String(papeis[0].id) : '');
    }
  }, [usuario, papeis]);

  const salvarDados = useCallback(async () => {
    if (!usuario) return;
    if (novaSenha && !isStrongPassword(novaSenha)) {
      setErro('A nova senha precisa de 6+ caracteres, 1 maiúscula e 1 número.');
      return;
    }
    setSalvando(true);
    setErro(null);
    try {
      await editarUsuario(usuario.id, {
        nome: nome.trim() || undefined,
        ativo,
        senha: novaSenha || undefined,
      });
      onSalvo();
    } catch (e) {
      setErro(e instanceof UsuariosApiError ? e.message : 'Não foi possível salvar as alterações.');
    } finally {
      setSalvando(false);
    }
  }, [usuario, nome, ativo, novaSenha, onSalvo]);

  const alterarVinculo = useCallback(
    async (vinculo: UsuarioVinculo, patch: { papelId?: number; ativo?: boolean }) => {
      if (!usuario) return;
      setSalvando(true);
      setErro(null);
      try {
        const atualizado = await editarVinculo(usuario.id, vinculo.id, patch);
        setVinculos((prev) => prev.map((v) => (v.id === vinculo.id ? atualizado : v)));
        onSalvo();
      } catch (e) {
        setErro(e instanceof UsuariosApiError ? e.message : 'Não foi possível atualizar o vínculo.');
      } finally {
        setSalvando(false);
      }
    },
    [usuario, onSalvo]
  );

  const adicionarVinculo = useCallback(async () => {
    if (!usuario || !novoVinculoPapelId) return;
    setSalvando(true);
    setErro(null);
    try {
      const novo = await criarVinculo(usuario.id, { entidadeId: entidadeAtiva, papelId: Number(novoVinculoPapelId) });
      setVinculos((prev) => [...prev, novo]);
      onSalvo();
    } catch (e) {
      setErro(e instanceof UsuariosApiError ? e.message : 'Não foi possível criar o vínculo.');
    } finally {
      setSalvando(false);
    }
  }, [usuario, novoVinculoPapelId, entidadeAtiva, onSalvo]);

  const jaTemVinculoNaEntidade = vinculos.some((v) => v.entidadeId === entidadeAtiva);

  return (
    <Dialog open={usuario !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Editar usuário</DialogTitle>
          <DialogDescription>{usuario?.email}</DialogDescription>
        </DialogHeader>
        <div className="flex max-h-[60vh] flex-col gap-4 overflow-y-auto">
          <div className="flex flex-col gap-1">
            <Label htmlFor="editar-usuario-nome">Nome</Label>
            <Input id="editar-usuario-nome" value={nome} onChange={(e) => setNome(e.target.value)} disabled={salvando} />
          </div>
          <div className="flex items-center gap-2">
            <Checkbox
              id="editar-usuario-ativo"
              checked={ativo}
              onCheckedChange={(v) => setAtivo(v === true)}
              disabled={salvando}
            />
            <Label htmlFor="editar-usuario-ativo">Usuário ativo (desmarque para desativar — nunca há exclusão)</Label>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="editar-usuario-senha">Redefinir senha (opcional)</Label>
            <Input
              id="editar-usuario-senha"
              type="password"
              value={novaSenha}
              onChange={(e) => setNovaSenha(e.target.value)}
              placeholder="Deixe em branco para manter a atual"
              disabled={salvando}
            />
          </div>

          <div className="rounded-md border p-3">
            <p className="mb-2 text-sm font-medium">Vínculos</p>
            <div className="flex flex-col gap-2">
              {vinculos.map((v) => (
                <div key={v.id} className="flex flex-wrap items-center gap-2 rounded-md border p-2 text-sm">
                  <span className="min-w-0 flex-1">Entidade #{v.entidadeId}</span>
                  <select
                    aria-label={`Papel do vínculo ${v.id}`}
                    value={v.papelId ?? ''}
                    onChange={(e) => alterarVinculo(v, { papelId: Number(e.target.value) })}
                    disabled={salvando}
                    className="h-8 rounded-md border border-input bg-background px-2 text-xs"
                  >
                    {papeis.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.nome}
                      </option>
                    ))}
                  </select>
                  <label className="flex items-center gap-1 text-xs">
                    <Checkbox
                      checked={v.ativo}
                      onCheckedChange={(checked) => alterarVinculo(v, { ativo: checked === true })}
                      disabled={salvando}
                    />
                    Ativo
                  </label>
                </div>
              ))}
              {vinculos.length === 0 && <p className="text-xs text-muted-foreground">Nenhum vínculo visível.</p>}
            </div>

            {!jaTemVinculoNaEntidade && (
              <div className="mt-3 flex flex-wrap items-center gap-2 border-t pt-3">
                <span className="text-xs text-muted-foreground">Vincular à entidade atual (#{entidadeAtiva}):</span>
                <select
                  aria-label="Papel do novo vínculo"
                  value={novoVinculoPapelId}
                  onChange={(e) => setNovoVinculoPapelId(e.target.value)}
                  disabled={salvando}
                  className="h-8 rounded-md border border-input bg-background px-2 text-xs"
                >
                  {papeis.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.nome}
                    </option>
                  ))}
                </select>
                <Button size="sm" variant="outline" onClick={adicionarVinculo} disabled={salvando}>
                  <Plus className="size-3.5" aria-hidden="true" />
                  Vincular
                </Button>
              </div>
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
            Fechar
          </Button>
          <Button onClick={salvarDados} disabled={salvando}>
            {salvando ? 'Salvando...' : 'Salvar dados'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function UsuariosPage() {
  const { entidadeAtiva } = useHubAuth();
  const h = useUsuariosLista();
  const papeis = usePapeisCatalogo();
  const [criarAberto, setCriarAberto] = useState(false);
  const [editando, setEditando] = useState<UsuarioListItem | null>(null);

  const entidade = entidadeAtiva ?? 0;

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-4 p-4 sm:p-6 lg:p-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-heading text-xl font-semibold text-foreground sm:text-2xl">Usuários</h1>
          <p className="mt-1 text-sm text-muted-foreground">Gestão de usuários, vínculos e papéis da sua entidade.</p>
        </div>
        <Button size="sm" className="min-h-11 gap-1.5 sm:min-h-8" onClick={() => setCriarAberto(true)}>
          <Plus className="size-4" aria-hidden="true" />
          Novo usuário
        </Button>
      </div>

      <div className="flex flex-col gap-1">
        <Label htmlFor="usuarios-busca" className="sr-only">
          Buscar por nome ou e-mail
        </Label>
        <Input
          id="usuarios-busca"
          value={h.busca}
          onChange={(e) => h.setBusca(e.target.value)}
          placeholder="Buscar por nome ou e-mail..."
          className="h-11 sm:h-9"
        />
      </div>

      {h.carregando ? (
        <div role="status" className="flex flex-col items-center gap-2 rounded-lg border p-10 text-muted-foreground">
          <RotateCw className="size-6 animate-spin" aria-hidden="true" />
          <p className="text-sm">Carregando usuários...</p>
        </div>
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
      ) : h.usuarios.length === 0 ? (
        <div
          role="status"
          className="flex flex-col items-center gap-2 rounded-lg border border-dashed p-10 text-center text-muted-foreground"
        >
          <UsersIcon className="size-10 opacity-30" aria-hidden="true" />
          <p className="font-medium">Nenhum usuário encontrado</p>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {h.usuarios.map((u) => (
            <div key={u.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{u.nome}</span>
                  {!u.ativo && (
                    <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                      Inativo
                    </span>
                  )}
                </div>
                <p className="truncate text-xs text-muted-foreground">{u.email}</p>
                <p className="text-xs text-muted-foreground">
                  {u.vinculos.map((v) => v.papel ?? '—').join(', ') || 'Sem vínculo visível'}
                </p>
              </div>
              <Button size="sm" variant="outline" onClick={() => setEditando(u)}>
                <UserCog className="size-4" aria-hidden="true" />
                Editar
              </Button>
            </div>
          ))}

          <div className="flex items-center justify-between gap-2 pt-2 text-sm text-muted-foreground">
            <span>
              Página {h.page} de {h.totalPaginas} — {h.total} usuário{h.total === 1 ? '' : 's'}
            </span>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" disabled={h.page <= 1} onClick={() => h.setPage(h.page - 1)}>
                Anterior
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={h.page >= h.totalPaginas}
                onClick={() => h.setPage(h.page + 1)}
              >
                Próxima
              </Button>
            </div>
          </div>
        </div>
      )}

      <CriarUsuarioDialog
        open={criarAberto}
        onOpenChange={setCriarAberto}
        entidadeAtiva={entidade}
        papeis={papeis}
        onCriado={h.refetch}
      />
      <EditarUsuarioDialog
        usuario={editando}
        onOpenChange={(v) => !v && setEditando(null)}
        entidadeAtiva={entidade}
        papeis={papeis}
        onSalvo={h.refetch}
      />
    </div>
  );
}

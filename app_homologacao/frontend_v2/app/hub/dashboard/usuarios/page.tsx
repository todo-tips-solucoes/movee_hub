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
import { toast } from 'sonner';
import { AlertCircle, Loader2, Plus, UserCog, Users as UsersIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/hub/page-header';
import { EmptyState } from '@/components/hub/empty-state';
import { FilterBar } from '@/components/hub/filter-bar';
import { ListSkeleton } from '@/components/hub/table-skeleton';
import { AtivoBadge } from '@/components/hub/status-badge';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { useHubAuth } from '@/contexts/hub-auth-context';
import { labelPapel } from '@/components/hub/entity-switcher';
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

/** Select de papel do design system (uiux-hub F3 — substitui os <select>
 * nativos; gotcha Base UI: o Root precisa de `items` para exibir o rótulo). */
function PapelSelect({
  id,
  ariaLabel,
  value,
  onChange,
  papeis,
  disabled,
  className,
}: {
  id?: string;
  ariaLabel?: string;
  value: string;
  onChange: (v: string) => void;
  papeis: PapelCatalogo[];
  disabled?: boolean;
  className?: string;
}) {
  const items = papeis.map((p) => ({ value: String(p.id), label: labelPapel(p.nome) }));
  return (
    <Select
      items={items}
      value={value}
      onValueChange={(v: string | null) => {
        if (v !== null) onChange(v);
      }}
      disabled={disabled}
    >
      <SelectTrigger id={id} aria-label={ariaLabel} className={className ?? 'w-full'}>
        <SelectValue placeholder="Selecionar papel" />
      </SelectTrigger>
      <SelectContent>
        {items.map((item) => (
          <SelectItem key={item.value} value={item.value}>
            {item.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

interface ErrosCamposCriar {
  nome?: string;
  email?: string;
  senha?: string;
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
  // uiux-hub F3: validação inline — erro perto do campo, não agregado no rodapé.
  const [errosCampo, setErrosCampo] = useState<ErrosCamposCriar>({});

  useEffect(() => {
    if (open) {
      setNome('');
      setEmail('');
      setSenha('');
      setPapelId(papeis[0] ? String(papeis[0].id) : '');
      setErro(null);
      setErrosCampo({});
    }
  }, [open, papeis]);

  const submit = useCallback(async () => {
    const erros: ErrosCamposCriar = {};
    if (!nome.trim()) erros.nome = 'Informe o nome.';
    if (!email.trim()) erros.email = 'Informe o e-mail.';
    if (!isStrongPassword(senha)) erros.senha = 'A senha precisa de 6+ caracteres, 1 maiúscula e 1 número.';
    setErrosCampo(erros);
    const primeiroInvalido = (['nome', 'email', 'senha'] as const).find((c) => erros[c]);
    if (primeiroInvalido) {
      document.getElementById(`novo-usuario-${primeiroInvalido}`)?.focus();
      return;
    }
    if (!papelId) {
      setErro('Selecione um papel.');
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
      toast.success('Usuário criado.');
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
            <Input
              id="novo-usuario-nome"
              value={nome}
              onChange={(e) => setNome(e.target.value)}
              disabled={salvando}
              aria-invalid={!!errosCampo.nome}
              aria-describedby={errosCampo.nome ? 'novo-usuario-nome-erro' : undefined}
            />
            {errosCampo.nome && (
              <p id="novo-usuario-nome-erro" role="alert" className="text-xs text-destructive">
                {errosCampo.nome}
              </p>
            )}
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="novo-usuario-email">E-mail</Label>
            <Input
              id="novo-usuario-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={salvando}
              aria-invalid={!!errosCampo.email}
              aria-describedby={errosCampo.email ? 'novo-usuario-email-erro' : undefined}
            />
            {errosCampo.email && (
              <p id="novo-usuario-email-erro" role="alert" className="text-xs text-destructive">
                {errosCampo.email}
              </p>
            )}
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="novo-usuario-senha">Senha inicial</Label>
            <Input
              id="novo-usuario-senha"
              type="password"
              value={senha}
              onChange={(e) => setSenha(e.target.value)}
              disabled={salvando}
              aria-invalid={!!errosCampo.senha}
              aria-describedby={errosCampo.senha ? 'novo-usuario-senha-erro' : 'novo-usuario-senha-ajuda'}
            />
            {errosCampo.senha ? (
              <p id="novo-usuario-senha-erro" role="alert" className="text-xs text-destructive">
                {errosCampo.senha}
              </p>
            ) : (
              <p id="novo-usuario-senha-ajuda" className="text-xs text-muted-foreground">
                Mínimo 6 caracteres, 1 letra maiúscula e 1 número.
              </p>
            )}
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="novo-usuario-papel">Papel</Label>
            <PapelSelect
              id="novo-usuario-papel"
              value={papelId}
              onChange={setPapelId}
              papeis={papeis}
              disabled={salvando}
            />
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
  const [erroSenha, setErroSenha] = useState<string | null>(null);
  const [novoVinculoPapelId, setNovoVinculoPapelId] = useState<string>('');
  const [vinculos, setVinculos] = useState<UsuarioVinculo[]>([]);

  useEffect(() => {
    if (usuario) {
      setNome(usuario.nome);
      setAtivo(usuario.ativo);
      setNovaSenha('');
      setErro(null);
      setErroSenha(null);
      setVinculos(usuario.vinculos);
      setNovoVinculoPapelId(papeis[0] ? String(papeis[0].id) : '');
    }
  }, [usuario, papeis]);

  const salvarDados = useCallback(async () => {
    if (!usuario) return;
    if (novaSenha && !isStrongPassword(novaSenha)) {
      // uiux-hub F3: erro inline junto do campo + foco, não no rodapé.
      setErroSenha('A nova senha precisa de 6+ caracteres, 1 maiúscula e 1 número.');
      document.getElementById('editar-usuario-senha')?.focus();
      return;
    }
    setErroSenha(null);
    setSalvando(true);
    setErro(null);
    try {
      await editarUsuario(usuario.id, {
        nome: nome.trim() || undefined,
        ativo,
        senha: novaSenha || undefined,
      });
      onSalvo();
      toast.success('Alterações salvas.');
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
        toast.success('Vínculo atualizado.');
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
      toast.success('Vínculo criado.');
    } catch (e) {
      setErro(e instanceof UsuariosApiError ? e.message : 'Não foi possível criar o vínculo.');
    } finally {
      setSalvando(false);
    }
  }, [usuario, novoVinculoPapelId, entidadeAtiva, onSalvo]);

  const jaTemVinculoNaEntidade = vinculos.some((v) => v.entidadeId === entidadeAtiva);

  return (
    /* uiux-hub F3: Sheet lateral em vez de Dialog — o conteúdo (dados +
       vínculos + papéis) era grande demais para um modal com scroll interno;
       mesmo padrão do detalhe de auditoria. */
    <Sheet open={usuario !== null} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-md">
        <SheetHeader>
          <SheetTitle>Editar usuário</SheetTitle>
          <SheetDescription>{usuario?.email}</SheetDescription>
        </SheetHeader>
        <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-4">
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
              aria-invalid={!!erroSenha}
              aria-describedby={erroSenha ? 'editar-usuario-senha-erro' : undefined}
            />
            {erroSenha && (
              <p id="editar-usuario-senha-erro" role="alert" className="text-xs text-destructive">
                {erroSenha}
              </p>
            )}
          </div>

          <div className="rounded-md border p-3">
            <p className="mb-2 text-sm font-medium">Vínculos</p>
            <div className="flex flex-col gap-2">
              {vinculos.map((v) => (
                <div key={v.id} className="flex flex-wrap items-center gap-2 rounded-md border p-2 text-sm">
                  <span className="min-w-0 flex-1">Entidade #{v.entidadeId}</span>
                  <PapelSelect
                    ariaLabel={`Papel do vínculo ${v.id}`}
                    value={v.papelId !== null ? String(v.papelId) : ''}
                    onChange={(papel) => alterarVinculo(v, { papelId: Number(papel) })}
                    papeis={papeis}
                    disabled={salvando}
                    className="h-11 w-[150px] text-xs sm:h-8"
                  />
                  <label className="flex min-h-11 items-center gap-1 text-xs sm:min-h-8">
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
                <PapelSelect
                  ariaLabel="Papel do novo vínculo"
                  value={novoVinculoPapelId}
                  onChange={setNovoVinculoPapelId}
                  papeis={papeis}
                  disabled={salvando}
                  className="h-11 w-[150px] text-xs sm:h-8"
                />
                <Button size="sm" variant="outline" className="min-h-11 sm:min-h-8" onClick={adicionarVinculo} disabled={salvando}>
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
        <SheetFooter className="flex-row justify-end gap-2 border-t">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={salvando}>
            Fechar
          </Button>
          <Button onClick={salvarDados} disabled={salvando}>
            {salvando && <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden="true" />}
            {salvando ? 'Salvando...' : 'Salvar dados'}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
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
      <PageHeader titulo="Usuários" subtitulo="Gestão de usuários, vínculos e papéis da sua entidade.">
        <Button size="sm" className="min-h-11 gap-1.5 sm:min-h-8" onClick={() => setCriarAberto(true)}>
          <Plus className="size-4" aria-hidden="true" />
          Novo usuário
        </Button>
      </PageHeader>

      <FilterBar
        gridClassName="grid-cols-1"
        onClear={() => h.setBusca('')}
        filtrosAtivos={h.busca ? 1 : 0}
      >
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
      </FilterBar>

      {h.carregando ? (
        <ListSkeleton label="Carregando usuários..." />
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
        <EmptyState
          icone={UsersIcon}
          titulo="Nenhum usuário encontrado"
          dica="Ajuste a busca ou crie um novo usuário."
        >
          <Button size="sm" className="min-h-11 gap-1.5 sm:min-h-8" onClick={() => setCriarAberto(true)}>
            <Plus className="size-4" aria-hidden="true" />
            Novo usuário
          </Button>
        </EmptyState>
      ) : (
        <div className="flex flex-col gap-2">
          {h.usuarios.map((u) => (
            <div key={u.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{u.nome}</span>
                  {!u.ativo && <AtivoBadge ativo={false} />}
                </div>
                <p className="truncate text-xs text-muted-foreground">{u.email}</p>
                <p className="text-xs text-muted-foreground">
                  {u.vinculos.map((v) => (v.papel ? labelPapel(v.papel) : '—')).join(', ') ||
                    'Sem vínculo visível'}
                </p>
              </div>
              <Button size="sm" variant="outline" className="min-h-11 sm:min-h-8" onClick={() => setEditando(u)}>
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
              <Button
                size="sm"
                variant="outline"
                className="min-h-11 sm:min-h-8"
                disabled={h.page <= 1}
                onClick={() => h.setPage(h.page - 1)}
              >
                Anterior
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="min-h-11 sm:min-h-8"
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

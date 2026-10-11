// repasse-saldo-minimo F2 (tasks.md 2.4.6, contracts/hub-usuarios-trava.md
// "Tela de Usuários") — o seletor de papel da tela de Usuários esconde os
// papéis restritos (admin_plataforma, financeiro_aprovador) de quem não é
// admin_plataforma. Mesmo molde de
// app/hub/dashboard/adiantamentos/contas/page.test.tsx.
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';
import { UsuariosApiError } from '@/lib/hub/usuarios-api';
import UsuariosPage from './page';

const mockUseHubAuth = vi.fn();
const mockListarUsuarios = vi.fn();
const mockListarPapeisMatriz = vi.fn();
const mockCriarUsuario = vi.fn();
const mockReenviarConvite = vi.fn();
const mockReenviarLote = vi.fn();

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

vi.mock('@/contexts/hub-auth-context', () => ({
  useHubAuth: () => mockUseHubAuth(),
}));

vi.mock('@/lib/hub/usuarios-api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/hub/usuarios-api')>('@/lib/hub/usuarios-api');
  return {
    ...actual,
    listarUsuarios: (...args: unknown[]) => mockListarUsuarios(...args),
    criarUsuario: (...args: unknown[]) => mockCriarUsuario(...args),
    reenviarConvite: (...args: unknown[]) => mockReenviarConvite(...args),
    reenviarConvitesEmLote: (...args: unknown[]) => mockReenviarLote(...args),
  };
});

vi.mock('@/lib/hub/admin-api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/hub/admin-api')>('@/lib/hub/admin-api');
  return {
    ...actual,
    listarPapeisMatriz: (...args: unknown[]) => mockListarPapeisMatriz(...args),
  };
});

// Catálogo com o papel restrito listado ANTES do não-restrito — se o
// componente não filtrar, `papeis[0]` (default do seletor no diálogo "Novo
// usuário") é o restrito e o gatilho do Select exibe seu rótulo.
const PAPEIS_CATALOGO = [
  { id: 2, nome: 'admin_plataforma', escopo: 'plataforma', isSistema: true },
  { id: 1, nome: 'operador', escopo: 'entidade', isSistema: true },
];

describe('UsuariosPage — seletor de papel x papéis restritos', () => {
  beforeEach(() => {
    mockUseHubAuth.mockReset();
    mockListarUsuarios.mockReset();
    mockListarPapeisMatriz.mockReset();
    mockListarUsuarios.mockResolvedValue({ usuarios: [], total: 0, page: 1, pageSize: 20 });
    mockListarPapeisMatriz.mockResolvedValue({
      papeis: PAPEIS_CATALOGO, permissoes: [], matriz: [], podeEditar: false,
    });
  });

  it('admin_entidade (sem admin.gerenciar): o default do seletor pula o papel restrito', async () => {
    mockUseHubAuth.mockReturnValue({ entidadeAtiva: 6, permissoes: ['usuarios.gerenciar'] });
    render(<UsuariosPage />);

    await waitFor(() => expect(screen.getByText('Nenhum usuário encontrado')).toBeInTheDocument());
    screen.getAllByRole('button', { name: /Novo usuário/i })[0].click();

    await waitFor(() => expect(screen.getByText('Operador')).toBeInTheDocument());
    expect(screen.queryByText('Administrador da plataforma')).not.toBeInTheDocument();
  });

  it('admin_plataforma (com admin.gerenciar): o papel restrito continua disponível', async () => {
    mockUseHubAuth.mockReturnValue({ entidadeAtiva: 6, permissoes: ['usuarios.gerenciar', 'admin.gerenciar'] });
    render(<UsuariosPage />);

    await waitFor(() => expect(screen.getByText('Nenhum usuário encontrado')).toBeInTheDocument());
    screen.getAllByRole('button', { name: /Novo usuário/i })[0].click();

    await waitFor(() => expect(screen.getByText('Administrador da plataforma')).toBeInTheDocument());
  });
});

// hub-convite-senha (2026-09-29) — quem cria o usuário não define senha por
// ele: o servidor manda um link por e-mail. O que estes casos protegem é a
// consequência visível disso — nenhum `senha` sai no payload, e o operador
// fica sabendo quando o e-mail NÃO saiu (senão ele espera uma mensagem que
// nunca chegou e o usuário novo fica sem acesso, sem ninguém perceber).
describe('UsuariosPage — convite por e-mail ao criar usuário', () => {
  async function abrirEPreencher() {
    mockUseHubAuth.mockReturnValue({ entidadeAtiva: 6, permissoes: ['usuarios.gerenciar'] });
    render(<UsuariosPage />);
    await waitFor(() => expect(screen.getByText('Nenhum usuário encontrado')).toBeInTheDocument());
    screen.getAllByRole('button', { name: /Novo usuário/i })[0].click();
    await waitFor(() => expect(screen.getByLabelText('Nome')).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText('Nome'), { target: { value: 'Ana Financeiro' } });
    fireEvent.change(screen.getByLabelText('E-mail'), { target: { value: 'ana@exemplo.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Criar usuário' }));
  }

  beforeEach(() => {
    mockUseHubAuth.mockReset();
    mockListarUsuarios.mockReset();
    mockListarPapeisMatriz.mockReset();
    mockCriarUsuario.mockReset();
    vi.mocked(toast.success).mockReset();
    vi.mocked(toast.warning).mockReset();
    mockListarUsuarios.mockResolvedValue({ usuarios: [], total: 0, page: 1, pageSize: 20 });
    mockListarPapeisMatriz.mockResolvedValue({
      papeis: [{ id: 3, nome: 'financeiro', escopo: 'entidade', isSistema: true }],
      permissoes: [], matriz: [], podeEditar: false,
    });
  });

  it('não existe campo de senha e o payload vai sem senha', async () => {
    mockCriarUsuario.mockResolvedValue({
      id: 9, nome: 'Ana Financeiro', email: 'ana@exemplo.com', vinculos: [], conviteEnviado: true,
    });
    await abrirEPreencher();

    await waitFor(() => expect(mockCriarUsuario).toHaveBeenCalledTimes(1));
    const payload = mockCriarUsuario.mock.calls[0][0];
    expect(payload).not.toHaveProperty('senha');
    expect(payload).toMatchObject({ nome: 'Ana Financeiro', email: 'ana@exemplo.com' });
    expect(screen.queryByLabelText(/senha/i)).not.toBeInTheDocument();
    await waitFor(() =>
      expect(vi.mocked(toast.success).mock.calls[0][0]).toContain('ana@exemplo.com')
    );
  });

  it('e-mail não enviado vira aviso, não sucesso silencioso', async () => {
    mockCriarUsuario.mockResolvedValue({
      id: 9, nome: 'Ana Financeiro', email: 'ana@exemplo.com', vinculos: [], conviteEnviado: false,
    });
    await abrirEPreencher();

    await waitFor(() => expect(toast.warning).toHaveBeenCalledTimes(1));
    expect(toast.success).not.toHaveBeenCalled();
  });
});

// O selo e o botão existem para uma pergunta só: "quem está esperando o link,
// e como mando de novo?". Se o selo não aparecer, ninguém reenvia; se o botão
// não chamar a rota, o admin acha que mandou e não mandou.
describe('UsuariosPage — senha pendente e reenvio do link', () => {
  const USUARIO = (extra: Record<string, unknown> = {}) => ({
    id: 7, nome: 'Ana Financeiro', email: 'ana@exemplo.com', ativo: true,
    linkSenhaPendente: true,
    nuncaAcessou: false,
    vinculos: [{ id: 1, entidadeId: 6, entidadeNome: 'Movee', papelId: 3, papel: 'financeiro', ativo: true }],
    ...extra,
  });

  beforeEach(() => {
    mockUseHubAuth.mockReset();
    mockListarUsuarios.mockReset();
    mockListarPapeisMatriz.mockReset();
    mockReenviarConvite.mockReset();
    vi.mocked(toast.success).mockReset();
    vi.mocked(toast.error).mockReset();
    mockUseHubAuth.mockReturnValue({ entidadeAtiva: 6, permissoes: ['usuarios.gerenciar'] });
    mockListarPapeisMatriz.mockResolvedValue({ papeis: [], permissoes: [], matriz: [], podeEditar: false });
  });

  it('quem tem link pendente aparece marcado, e o botão reenvia', async () => {
    mockListarUsuarios.mockResolvedValue({ usuarios: [USUARIO()], total: 1, page: 1, pageSize: 20 });
    mockReenviarConvite.mockResolvedValue(undefined);
    render(<UsuariosPage />);

    await waitFor(() => expect(screen.getByText('Ana Financeiro')).toBeInTheDocument());
    expect(screen.getByText('Senha pendente')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Reenviar link/i }));
    await waitFor(() => expect(mockReenviarConvite).toHaveBeenCalledWith(7));
    // O aviso precisa dizer que o link anterior morreu — quem reenvia por
    // engano tem de saber que invalidou o que a pessoa já tinha em mãos.
    await waitFor(() => expect(vi.mocked(toast.success).mock.calls[0][0]).toMatch(/deixou de valer/i));
  });

  it('sem link pendente o selo some e o botão muda de rótulo', async () => {
    mockListarUsuarios.mockResolvedValue({
      usuarios: [USUARIO({ linkSenhaPendente: false })], total: 1, page: 1, pageSize: 20,
    });
    render(<UsuariosPage />);

    await waitFor(() => expect(screen.getByText('Ana Financeiro')).toBeInTheDocument());
    expect(screen.queryByText('Senha pendente')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Enviar link de senha/i })).toBeInTheDocument();
  });

  // Fatos diferentes: o selo "Nunca acessou" depende só de nuncaAcessou, não
  // do link; e conta inativa não ganha selo (não há ação possível).
  it('"Nunca acessou" aparece só para ativo sem login, independente do link', async () => {
    mockListarUsuarios.mockResolvedValue({
      usuarios: [
        USUARIO({ id: 1, nome: 'Sem Login', linkSenhaPendente: false, nuncaAcessou: true }),
        USUARIO({ id: 2, nome: 'Com Login', linkSenhaPendente: true, nuncaAcessou: false }),
        USUARIO({ id: 3, nome: 'Inativo', ativo: false, linkSenhaPendente: false, nuncaAcessou: true }),
      ],
      total: 3, page: 1, pageSize: 20,
    });
    render(<UsuariosPage />);
    await waitFor(() => expect(screen.getByText('Sem Login')).toBeInTheDocument());
    expect(screen.getAllByText('Nunca acessou')).toHaveLength(1);
  });

  it('falha no envio vira erro visível, não sucesso silencioso', async () => {
    mockListarUsuarios.mockResolvedValue({ usuarios: [USUARIO()], total: 1, page: 1, pageSize: 20 });
    mockReenviarConvite.mockRejectedValue(new UsuariosApiError(502, 'O e-mail não pôde ser enviado agora.', 'EMAIL_NAO_ENVIADO'));
    render(<UsuariosPage />);

    await waitFor(() => expect(screen.getByText('Ana Financeiro')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /Reenviar link/i }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
    expect(toast.success).not.toHaveBeenCalled();
  });
});

// Reenvio em lote: cada envio mata o link anterior, então o que a tela diz
// (quantos e-mails, quem foi pulado) tem de bater com o que o servidor faz.
describe('UsuariosPage — reenvio em lote', () => {
  const U = (id: number, extra: Record<string, unknown> = {}) => ({
    id, nome: `Pessoa ${id}`, email: `p${id}@x.com`, ativo: true,
    linkSenhaPendente: false, nuncaAcessou: false,
    vinculos: [{ id, entidadeId: 6, entidadeNome: 'Movee', papelId: 3, papel: 'financeiro', ativo: true }],
    ...extra,
  });
  const lista = (usuarios: unknown[]) => mockListarUsuarios.mockResolvedValue({ usuarios, total: usuarios.length, page: 1, pageSize: 100 });

  beforeEach(() => {
    mockUseHubAuth.mockReset();
    mockListarUsuarios.mockReset();
    mockListarPapeisMatriz.mockReset();
    mockReenviarLote.mockReset();
    vi.mocked(toast.success).mockReset();
    vi.mocked(toast.error).mockReset();
    vi.mocked(toast.warning).mockReset();
    mockUseHubAuth.mockReturnValue({ entidadeAtiva: 6, permissoes: ['usuarios.gerenciar'] });
    mockListarPapeisMatriz.mockResolvedValue({ papeis: [], permissoes: [], matriz: [], podeEditar: false });
  });

  it('seleção manual: só ativo tem caixa, barra mostra a contagem e envia os ids marcados', async () => {
    lista([U(1), U(2), U(3, { ativo: false })]);
    mockReenviarLote.mockResolvedValue({
      enviados: 1, pulados: 1,
      resultado: [{ usuarioId: 1, status: 'enviado' }, { usuarioId: 2, status: 'pulado', motivo: 'USUARIO_INATIVO' }],
    });
    render(<UsuariosPage />);
    await waitFor(() => expect(screen.getByText('Pessoa 1')).toBeInTheDocument());

    expect(screen.queryByRole('checkbox', { name: 'Selecionar Pessoa 3' })).not.toBeInTheDocument();
    expect(screen.queryByText(/selecionados?$/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('checkbox', { name: 'Selecionar Pessoa 1' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Selecionar Pessoa 2' }));
    expect(screen.getByRole('status')).toHaveTextContent('2 selecionados');

    fireEvent.click(screen.getByRole('button', { name: /Reenviar convite/i }));
    await waitFor(() => expect(mockReenviarLote).toHaveBeenCalledWith([1, 2]));
    // relatório por usuário, com o motivo do pulo
    await waitFor(() => expect(screen.getByText('Conta desativada')).toBeInTheDocument());
    expect(screen.getByText('Enviado')).toBeInTheDocument();
    // a seleção é limpa depois do envio
    expect(screen.queryByText(/selecionados?$/)).not.toBeInTheDocument();
  });

  it('"Limpar seleção" zera a barra', async () => {
    lista([U(1)]);
    render(<UsuariosPage />);
    await waitFor(() => expect(screen.getByText('Pessoa 1')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('checkbox', { name: 'Selecionar Pessoa 1' }));
    fireEvent.click(screen.getByRole('button', { name: /Limpar seleção/i }));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('acima de 50 selecionados o botão desabilita COM a razão visível', async () => {
    lista(Array.from({ length: 51 }, (_, i) => U(i + 1)));
    render(<UsuariosPage />);
    await waitFor(() => expect(screen.getByText('Pessoa 1')).toBeInTheDocument());
    for (let i = 1; i <= 50; i += 1) fireEvent.click(screen.getByLabelText(`Selecionar Pessoa ${i}`));
    expect(screen.getByRole('button', { name: /Reenviar convite/i })).toBeEnabled();

    fireEvent.click(screen.getByLabelText('Selecionar Pessoa 51'));
    expect(screen.getByRole('button', { name: /Reenviar convite/i })).toBeDisabled();
    expect(screen.getByText(/Máximo de 50 por envio — desmarque 1/)).toBeInTheDocument();
  }, 20000);

  it('"a todos os pendentes": confirma com o N real e avisa que invalida os links', async () => {
    lista([U(1, { linkSenhaPendente: true }), U(2, { linkSenhaPendente: true }), U(3), U(4, { ativo: false, linkSenhaPendente: true })]);
    mockReenviarLote.mockResolvedValue({
      enviados: 2, pulados: 0,
      resultado: [{ usuarioId: 1, status: 'enviado' }, { usuarioId: 2, status: 'enviado' }],
    });
    render(<UsuariosPage />);
    await waitFor(() => expect(screen.getByText('Pessoa 1')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Reenviar a todos os pendentes \(2\)/ }));
    expect(screen.getByText(/invalida os links atuais e envia 2 e-mails/)).toBeInTheDocument();
    // abrir o diálogo não envia nada
    expect(mockReenviarLote).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /Enviar 2 e-mails/ }));
    await waitFor(() => expect(mockReenviarLote).toHaveBeenCalledWith([1, 2]));
  });

  it('sem pendentes o botão "a todos" não aparece', async () => {
    lista([U(1)]);
    render(<UsuariosPage />);
    await waitFor(() => expect(screen.getByText('Pessoa 1')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /a todos os pendentes/ })).not.toBeInTheDocument();
  });
});

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

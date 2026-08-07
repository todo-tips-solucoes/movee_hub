// impeccable rodada 4 — o comportamento que justifica este componente existir
// é a DEGRADAÇÃO: em importações o papel `operador` não tem `usuarios.gerenciar`,
// e o filtro precisa continuar funcionando pelo ID cru em vez de quebrar.
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UsuarioCombobox } from './usuario-combobox';
import { HubApiError } from '@/lib/hub/api';

const mockListarUsuarios = vi.fn();

vi.mock('@/lib/hub/usuarios-api', () => ({
  listarUsuarios: (...args: unknown[]) => mockListarUsuarios(...args),
}));

/** O gatilho é o PRIMEIRO combobox; com o popover aberto, o campo de busca do
 * Command também expõe `role="combobox"` (Base UI). */
function gatilho() {
  return screen.getAllByRole('combobox')[0];
}

const USUARIOS = [
  { id: 17, nome: 'Ana Prado', email: 'ana@exemplo.com', ativo: true, vinculos: [] },
  { id: 42, nome: 'Bruno Lima', email: 'bruno@exemplo.com', ativo: true, vinculos: [] },
];

function respostaOk() {
  return { usuarios: USUARIOS, total: 2, page: 1, pageSize: 100 };
}

async function abrir() {
  fireEvent.click(gatilho());
  await waitFor(() => expect(mockListarUsuarios).toHaveBeenCalled());
}

describe('UsuarioCombobox', () => {
  beforeEach(() => {
    mockListarUsuarios.mockReset();
  });

  it('não busca nada antes de ser aberto (tela não paga por filtro que ninguém usa)', () => {
    render(<UsuarioCombobox value="" onChange={vi.fn()} />);
    expect(mockListarUsuarios).not.toHaveBeenCalled();
  });

  it('ao abrir, lista as pessoas por nome e e-mail', async () => {
    mockListarUsuarios.mockResolvedValue(respostaOk());
    render(<UsuarioCombobox value="" onChange={vi.fn()} />);
    await abrir();

    expect(await screen.findByText('Ana Prado')).toBeInTheDocument();
    expect(screen.getByText('ana@exemplo.com')).toBeInTheDocument();
    expect(screen.getByText('Bruno Lima')).toBeInTheDocument();
  });

  it('selecionar devolve o ID como string (formato que os filtros já usam)', async () => {
    const onChange = vi.fn();
    mockListarUsuarios.mockResolvedValue(respostaOk());
    render(<UsuarioCombobox value="" onChange={onChange} />);
    await abrir();

    fireEvent.click(await screen.findByText('Bruno Lima'));
    expect(onChange).toHaveBeenCalledWith('42');
  });

  it('com valor selecionado, o gatilho mostra o nome em vez do número', async () => {
    mockListarUsuarios.mockResolvedValue(respostaOk());
    render(<UsuarioCombobox value="17" onChange={vi.fn()} />);
    await abrir();
    await screen.findByText('ana@exemplo.com');

    expect(gatilho()).toHaveTextContent('Ana Prado');
  });

  it('valor vindo de fora com a lista ainda não carregada mostra #id, não vazio', () => {
    mockListarUsuarios.mockResolvedValue(respostaOk());
    render(<UsuarioCombobox value="99" onChange={vi.fn()} />);
    expect(gatilho()).toHaveTextContent('#99');
  });

  // O caso que decidiu o desenho do componente.
  it('403: degrada para campo de ID numérico, e o filtro continua utilizável', async () => {
    const onChange = vi.fn();
    mockListarUsuarios.mockRejectedValue(new HubApiError(403, 'Permissão negada', 'PERMISSAO_NEGADA'));
    render(<UsuarioCombobox value="" onChange={onChange} />);
    await abrir();

    // O combobox some e dá lugar ao input numérico de antes.
    await waitFor(() => expect(screen.queryAllByRole('combobox')).toHaveLength(0));
    const campo = screen.getByRole('spinbutton');
    fireEvent.change(campo, { target: { value: '17' } });
    expect(onChange).toHaveBeenCalledWith('17');
  });

  it('403: não insiste na rota negada a cada abertura', async () => {
    mockListarUsuarios.mockRejectedValue(new HubApiError(403, 'Permissão negada', 'PERMISSAO_NEGADA'));
    render(<UsuarioCombobox value="" onChange={vi.fn()} />);
    await abrir();
    await waitFor(() => expect(screen.getByRole('spinbutton')).toBeInTheDocument());

    expect(mockListarUsuarios).toHaveBeenCalledTimes(1);
  });

  // Erro que NÃO é de permissão não deve degradar em silêncio — some com o
  // combobox seria esconder uma falha transitória de rede.
  it('erro de rede: mantém o combobox e explica, sem virar campo de ID', async () => {
    mockListarUsuarios.mockRejectedValue(new HubApiError(500, 'Erro interno'));
    render(<UsuarioCombobox value="" onChange={vi.fn()} />);
    await abrir();

    expect(await screen.findByRole('alert')).toHaveTextContent('Digite o ID do usuário.');
    expect(gatilho()).toBeInTheDocument();
  });
});

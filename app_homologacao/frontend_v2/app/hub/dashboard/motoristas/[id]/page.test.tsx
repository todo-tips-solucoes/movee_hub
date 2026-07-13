// hub-motoristas (S5) FASE 7 task 7.1.1/7.1.2/7.2.4 — detalhe: indicadores,
// gate de permissão (edição/vínculo ocultos sem motoristas.editar), edição
// de nome/ativo, painel de vínculo (estado com/sem conta) e desvínculo com
// confirmação.
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import MotoristaDetalhePage from './page';
import { MotoristaApiError } from '@/lib/hub/motoristas-api';

const mockUseHubAuth = vi.fn();
const mockObterMotorista = vi.fn();
const mockEditarMotorista = vi.fn();
const mockObterSugestoes = vi.fn();
const mockDesvincularMotorista = vi.fn();
const mockCriarCredencial = vi.fn();
const mockResetSenhaCredencial = vi.fn();
const mockAtualizarCredencial = vi.fn();
const mockPush = vi.fn();

vi.mock('@/contexts/hub-auth-context', () => ({
  useHubAuth: () => mockUseHubAuth(),
}));

vi.mock('next/navigation', () => ({
  useParams: () => ({ id: '1' }),
  useRouter: () => ({ push: mockPush }),
}));

vi.mock('@/lib/hub/motoristas-api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/hub/motoristas-api')>('@/lib/hub/motoristas-api');
  return {
    ...actual,
    obterMotorista: (...args: unknown[]) => mockObterMotorista(...args),
    editarMotorista: (...args: unknown[]) => mockEditarMotorista(...args),
    obterSugestoes: (...args: unknown[]) => mockObterSugestoes(...args),
    desvincularMotorista: (...args: unknown[]) => mockDesvincularMotorista(...args),
    criarCredencial: (...args: unknown[]) => mockCriarCredencial(...args),
    resetSenhaCredencial: (...args: unknown[]) => mockResetSenhaCredencial(...args),
    atualizarCredencial: (...args: unknown[]) => mockAtualizarCredencial(...args),
  };
});

const DETALHE_SEM_VINCULO = {
  id: 1,
  nome: 'Fulano da Silva',
  idExterno: '11111111-1111-1111-1111-111111111111',
  ativo: true,
  nomeEditadoManualmente: false,
  areas: [{ subpraca: 'Zona Sul', dataMaisRecente: '2026-07-01' }],
  resumo: { totalFaturamento: 42, totalPerformance: 30, dataMaisRecente: '2026-07-01' },
  vinculo: null,
  // FASE 6 (tasks.md 6.4/6.5) — seção "Atividades" (histórico read-only).
  atividades: { items: [], total: 0, offset: 0, limit: 20 },
};

const DETALHE_COM_VINCULO = {
  ...DETALHE_SEM_VINCULO,
  vinculo: { contaMotoristaId: 7, nome: 'Fulano da Silva', cnpjPrestadorMascarado: '12.***.***/0001-**', ativo: true },
};

const DETALHE_COM_VINCULO_CREDENCIAL_DESATIVADA = {
  ...DETALHE_SEM_VINCULO,
  vinculo: { contaMotoristaId: 7, nome: 'Fulano da Silva', cnpjPrestadorMascarado: '12.***.***/0001-**', ativo: false },
};

function withPermissoes(permissoes: string[]) {
  mockUseHubAuth.mockReturnValue({ permissoes });
}

describe('MotoristaDetalhePage', () => {
  beforeEach(() => {
    mockUseHubAuth.mockReset();
    mockObterMotorista.mockReset();
    mockEditarMotorista.mockReset();
    mockObterSugestoes.mockReset();
    mockDesvincularMotorista.mockReset();
    mockCriarCredencial.mockReset();
    mockResetSenhaCredencial.mockReset();
    mockAtualizarCredencial.mockReset();
    mockObterSugestoes.mockResolvedValue({ items: [], entidadeElegivel: true });
    withPermissoes(['motoristas.consultar', 'motoristas.editar']);
  });

  it('mostra indicadores e áreas do detalhe', async () => {
    mockObterMotorista.mockResolvedValueOnce(DETALHE_SEM_VINCULO);
    render(<MotoristaDetalhePage />);

    await waitFor(() => expect(screen.getByText('Fulano da Silva')).toBeInTheDocument());
    expect(screen.getByText('42')).toBeInTheDocument();
    expect(screen.getByText('30')).toBeInTheDocument();
    expect(screen.getByText('Zona Sul')).toBeInTheDocument();
  });

  it('identificador (uuid) copiável aparece no detalhe (FR-016, task 4.1.2/4.1.3)', async () => {
    mockObterMotorista.mockResolvedValueOnce(DETALHE_SEM_VINCULO);
    render(<MotoristaDetalhePage />);

    await waitFor(() => expect(screen.getByText(DETALHE_SEM_VINCULO.idExterno)).toBeInTheDocument());
    expect(
      screen.getByRole('button', { name: `Copiar identificador de ${DETALHE_SEM_VINCULO.nome}` })
    ).toBeInTheDocument();
  });

  it('sem vínculo: mostra estado vazio + botão Vincular (com permissão)', async () => {
    mockObterMotorista.mockResolvedValueOnce(DETALHE_SEM_VINCULO);
    render(<MotoristaDetalhePage />);

    await waitFor(() => expect(screen.getByText('Nenhuma conta de acesso vinculada.')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /Vincular/ })).toBeInTheDocument();
  });

  it('com vínculo: mostra a conta vinculada + botões Trocar/Desvincular', async () => {
    mockObterMotorista.mockResolvedValueOnce(DETALHE_COM_VINCULO);
    render(<MotoristaDetalhePage />);

    await waitFor(() => expect(screen.getByText('12.***.***/0001-**')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /Trocar/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Desvincular/ })).toBeInTheDocument();
  });

  it('gate de permissão (FR-005/SC-006): sem motoristas.editar, nenhum controle de edição/vínculo aparece', async () => {
    withPermissoes(['motoristas.consultar']);
    mockObterMotorista.mockResolvedValueOnce(DETALHE_COM_VINCULO);
    render(<MotoristaDetalhePage />);

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Fulano da Silva' })).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /Editar/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Trocar/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Desvincular/ })).not.toBeInTheDocument();
    expect(mockObterSugestoes).not.toHaveBeenCalled();
  });

  it('edição de nome: salva via PATCH e re-busca o detalhe', async () => {
    mockObterMotorista
      .mockResolvedValueOnce(DETALHE_SEM_VINCULO)
      .mockResolvedValueOnce({ ...DETALHE_SEM_VINCULO, nome: 'Novo Nome', nomeEditadoManualmente: true });
    mockEditarMotorista.mockResolvedValueOnce({ ...DETALHE_SEM_VINCULO, nome: 'Novo Nome' });
    render(<MotoristaDetalhePage />);

    await waitFor(() => expect(screen.getByRole('button', { name: /Editar/ })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /Editar/ }));

    const input = screen.getByLabelText('Nome');
    fireEvent.change(input, { target: { value: 'Novo Nome' } });
    fireEvent.click(screen.getByRole('button', { name: /Salvar/ }));

    await waitFor(() => expect(mockEditarMotorista).toHaveBeenCalledWith(1, { nome: 'Novo Nome' }));
  });

  it('edição: nome vazio mostra erro sem chamar a API', async () => {
    mockObterMotorista.mockResolvedValueOnce(DETALHE_SEM_VINCULO);
    render(<MotoristaDetalhePage />);

    await waitFor(() => expect(screen.getByRole('button', { name: /Editar/ })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /Editar/ }));
    fireEvent.change(screen.getByLabelText('Nome'), { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: /Salvar/ }));

    await waitFor(() => expect(screen.getByText('O nome não pode ficar vazio.')).toBeInTheDocument());
    expect(mockEditarMotorista).not.toHaveBeenCalled();
  });

  it('desvincular: exige confirmação (AlertDialog) antes de chamar a API', async () => {
    mockObterMotorista
      .mockResolvedValueOnce(DETALHE_COM_VINCULO)
      .mockResolvedValueOnce(DETALHE_SEM_VINCULO);
    mockDesvincularMotorista.mockResolvedValueOnce(undefined);
    render(<MotoristaDetalhePage />);

    await waitFor(() => expect(screen.getByRole('button', { name: /Desvincular/ })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /Desvincular/ }));

    // Nenhuma chamada disparada só ao clicar no gatilho — exige confirmação explícita (FR-008 mesmo espírito).
    expect(mockDesvincularMotorista).not.toHaveBeenCalled();

    const confirmButtons = screen.getAllByRole('button', { name: /Desvincular/ });
    fireEvent.click(confirmButtons[confirmButtons.length - 1]);

    await waitFor(() => expect(mockDesvincularMotorista).toHaveBeenCalledWith(1));
  });

  it('erro ao desvincular mostra mensagem sem quebrar a tela', async () => {
    mockObterMotorista.mockResolvedValue(DETALHE_COM_VINCULO);
    mockDesvincularMotorista.mockRejectedValueOnce(new MotoristaApiError(500, 'Falha ao desvincular.'));
    render(<MotoristaDetalhePage />);

    await waitFor(() => expect(screen.getByRole('button', { name: /Desvincular/ })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /Desvincular/ }));
    const confirmButtons = screen.getAllByRole('button', { name: /Desvincular/ });
    fireEvent.click(confirmButtons[confirmButtons.length - 1]);

    await waitFor(() => expect(screen.getByText('Falha ao desvincular.')).toBeInTheDocument());
  });

  // FASE 5 (task 5.5.3) — gestão de credencial de acesso: gate de permissão
  // (`motoristas.credencial`, DISTINTA de `motoristas.editar`) + fluxo
  // criar -> resetar -> desativar com feedback de sucesso/erro.
  describe('Credencial de acesso (task 5.5)', () => {
    it('gate de permissão: SEM motoristas.credencial (mesmo COM motoristas.editar), a seção de credencial não aparece', async () => {
      withPermissoes(['motoristas.consultar', 'motoristas.editar']);
      mockObterMotorista.mockResolvedValueOnce(DETALHE_COM_VINCULO);
      render(<MotoristaDetalhePage />);

      await waitFor(() => expect(screen.getByRole('heading', { name: 'Fulano da Silva' })).toBeInTheDocument());
      expect(screen.queryByRole('heading', { name: 'Credencial de acesso' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Criar credencial/ })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Redefinir senha/ })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Desativar credencial/ })).not.toBeInTheDocument();
    });

    it('COM motoristas.credencial, sem credencial ainda: mostra "Criar credencial"', async () => {
      withPermissoes(['motoristas.consultar', 'motoristas.credencial']);
      mockObterMotorista.mockResolvedValueOnce(DETALHE_SEM_VINCULO);
      render(<MotoristaDetalhePage />);

      await waitFor(() => expect(screen.getByRole('heading', { name: 'Credencial de acesso' })).toBeInTheDocument());
      expect(screen.getByText('Nenhuma credencial de acesso criada.')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Criar credencial/ })).toBeInTheDocument();
    });

    it('COM motoristas.credencial, credencial ATIVA: mostra "Redefinir senha" e "Desativar credencial"', async () => {
      withPermissoes(['motoristas.consultar', 'motoristas.credencial']);
      mockObterMotorista.mockResolvedValueOnce(DETALHE_COM_VINCULO);
      render(<MotoristaDetalhePage />);

      await waitFor(() => expect(screen.getByRole('heading', { name: 'Credencial de acesso' })).toBeInTheDocument());
      expect(screen.getByText('ativa')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Redefinir senha/ })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Desativar credencial/ })).toBeInTheDocument();
    });

    it('COM motoristas.credencial, credencial DESATIVADA: mostra "Ativar credencial"', async () => {
      withPermissoes(['motoristas.consultar', 'motoristas.credencial']);
      mockObterMotorista.mockResolvedValueOnce(DETALHE_COM_VINCULO_CREDENCIAL_DESATIVADA);
      render(<MotoristaDetalhePage />);

      await waitFor(() => expect(screen.getByRole('heading', { name: 'Credencial de acesso' })).toBeInTheDocument());
      expect(screen.getByText('desativada')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Ativar credencial/ })).toBeInTheDocument();
    });

    it('fluxo criar -> resetar -> desativar, com feedback de sucesso a cada passo (re-busca o detalhe)', async () => {
      withPermissoes(['motoristas.consultar', 'motoristas.credencial']);
      mockObterMotorista
        .mockResolvedValueOnce(DETALHE_SEM_VINCULO) // carga inicial
        .mockResolvedValueOnce(DETALHE_COM_VINCULO) // após criar
        .mockResolvedValueOnce(DETALHE_COM_VINCULO) // após resetar (credencial continua ativa)
        .mockResolvedValueOnce(DETALHE_COM_VINCULO_CREDENCIAL_DESATIVADA); // após desativar
      mockCriarCredencial.mockResolvedValueOnce({
        id: 7, cnpjPrestador: '12.***.***/0001-**', ativo: true, senhaTemporaria: 'SenhaTemp123',
      });
      mockResetSenhaCredencial.mockResolvedValueOnce({ ok: true, tokenDefinicao: 'a'.repeat(64) });
      mockAtualizarCredencial.mockResolvedValueOnce({ id: 7, ativo: false });

      render(<MotoristaDetalhePage />);

      // 1. Criar credencial
      await waitFor(() => expect(screen.getByRole('button', { name: /Criar credencial/ })).toBeInTheDocument());
      fireEvent.click(screen.getByRole('button', { name: /Criar credencial/ }));
      fireEvent.change(screen.getByLabelText('CNPJ do prestador'), { target: { value: '12345678000195' } });
      fireEvent.click(screen.getByRole('button', { name: 'Criar credencial' }));
      await waitFor(() => expect(mockCriarCredencial).toHaveBeenCalledWith(1, { cnpjPrestador: '12345678000195' }));
      await waitFor(() => expect(screen.getByText('SenhaTemp123')).toBeInTheDocument());
      fireEvent.click(screen.getByRole('button', { name: 'Concluído' }));

      // 2. Redefinir senha
      await waitFor(() => expect(screen.getByRole('button', { name: /Redefinir senha/ })).toBeInTheDocument());
      fireEvent.click(screen.getByRole('button', { name: /Redefinir senha/ }));
      fireEvent.click(screen.getByRole('button', { name: 'Redefinir senha' }));
      await waitFor(() => expect(mockResetSenhaCredencial).toHaveBeenCalledWith(1));
      await waitFor(() => expect(screen.getByText('a'.repeat(64))).toBeInTheDocument());
      fireEvent.click(screen.getByRole('button', { name: 'Concluído' }));

      // 3. Desativar
      await waitFor(() => expect(screen.getByRole('button', { name: /Desativar credencial/ })).toBeInTheDocument());
      fireEvent.click(screen.getByRole('button', { name: /Desativar credencial/ }));
      const confirmButtons = screen.getAllByRole('button', { name: 'Desativar' });
      fireEvent.click(confirmButtons[confirmButtons.length - 1]);
      await waitFor(() => expect(mockAtualizarCredencial).toHaveBeenCalledWith(1, { ativo: false }));

      // Re-busca o detalhe a cada passo (feedback de sucesso = estado atualizado na tela).
      expect(mockObterMotorista).toHaveBeenCalledTimes(4);
    });

    it('erro ao criar credencial mostra mensagem sem quebrar a tela', async () => {
      withPermissoes(['motoristas.consultar', 'motoristas.credencial']);
      mockObterMotorista.mockResolvedValueOnce(DETALHE_SEM_VINCULO);
      mockCriarCredencial.mockRejectedValueOnce(new MotoristaApiError(409, 'Este motorista (ou este CNPJ) já tem uma credencial de acesso vinculada.'));
      render(<MotoristaDetalhePage />);

      await waitFor(() => expect(screen.getByRole('button', { name: /Criar credencial/ })).toBeInTheDocument());
      fireEvent.click(screen.getByRole('button', { name: /Criar credencial/ }));
      fireEvent.change(screen.getByLabelText('CNPJ do prestador'), { target: { value: '12345678000195' } });
      fireEvent.click(screen.getByRole('button', { name: 'Criar credencial' }));

      await waitFor(() =>
        expect(screen.getByText('Este motorista (ou este CNPJ) já tem uma credencial de acesso vinculada.')).toBeInTheDocument()
      );
    });
  });
});

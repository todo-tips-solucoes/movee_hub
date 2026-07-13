// hub-motorista-canonico FASE 5 (task 5.5.3) — criar credencial (senha
// auto-gerada revelada uma vez), redefinir senha (token revelado uma vez) e
// ativar/desativar, com feedback de sucesso/erro. Mesmo padrão de
// `vinculo-motorista-dialog.test.tsx` (Harness com o hook + os diálogos).
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CredencialMotoristaAcoes,
  CredencialMotoristaDialogs,
  useCredencialMotoristaDialog,
} from './credencial-motorista-dialog';
import { MotoristaApiError } from '@/lib/hub/motoristas-api';

const mockCriarCredencial = vi.fn();
const mockResetSenhaCredencial = vi.fn();
const mockAtualizarCredencial = vi.fn();

vi.mock('@/lib/hub/motoristas-api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/hub/motoristas-api')>('@/lib/hub/motoristas-api');
  return {
    ...actual,
    criarCredencial: (...args: unknown[]) => mockCriarCredencial(...args),
    resetSenhaCredencial: (...args: unknown[]) => mockResetSenhaCredencial(...args),
    atualizarCredencial: (...args: unknown[]) => mockAtualizarCredencial(...args),
  };
});

function Harness({
  credencialAtiva,
  onAtualizado = vi.fn(),
}: {
  credencialAtiva: boolean | null;
  onAtualizado?: () => void;
}) {
  const state = useCredencialMotoristaDialog({ entregadorId: 1, onAtualizado });
  return (
    <>
      <CredencialMotoristaAcoes state={state} credencialAtiva={credencialAtiva} />
      <CredencialMotoristaDialogs state={state} />
    </>
  );
}

describe('CredencialMotoristaDialogs', () => {
  beforeEach(() => {
    mockCriarCredencial.mockReset();
    mockResetSenhaCredencial.mockReset();
    mockAtualizarCredencial.mockReset();
  });

  it('criar credencial (senha AUTO-gerada): chama a API só com cnpjPrestador e revela a senha temporária', async () => {
    mockCriarCredencial.mockResolvedValueOnce({
      id: 9, cnpjPrestador: '12.***.***/0001-**', ativo: true, senhaTemporaria: 'SenhaTemp123',
    });
    const onAtualizado = vi.fn();
    render(<Harness credencialAtiva={null} onAtualizado={onAtualizado} />);

    fireEvent.click(screen.getByRole('button', { name: /Criar credencial/ }));
    fireEvent.change(screen.getByLabelText('CNPJ do prestador'), { target: { value: '12345678000195' } });
    fireEvent.click(screen.getByRole('button', { name: 'Criar credencial' }));

    await waitFor(() =>
      expect(mockCriarCredencial).toHaveBeenCalledWith(1, { cnpjPrestador: '12345678000195' })
    );
    expect(onAtualizado).toHaveBeenCalled();
    // Revela a senha temporária (passo 2 do mesmo diálogo) — visível uma vez.
    await waitFor(() => expect(screen.getByText('SenhaTemp123')).toBeInTheDocument());
  });

  it('criar credencial com senhaInicial explícita: NÃO revela senha (o caller já a definiu)', async () => {
    mockCriarCredencial.mockResolvedValueOnce({ id: 9, cnpjPrestador: '12.***.***/0001-**', ativo: true });
    render(<Harness credencialAtiva={null} />);

    fireEvent.click(screen.getByRole('button', { name: /Criar credencial/ }));
    fireEvent.change(screen.getByLabelText('CNPJ do prestador'), { target: { value: '12345678000195' } });
    fireEvent.change(screen.getByLabelText(/Senha inicial/), { target: { value: 'SenhaExplicita1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Criar credencial' }));

    await waitFor(() =>
      expect(mockCriarCredencial).toHaveBeenCalledWith(1, { cnpjPrestador: '12345678000195', senhaInicial: 'SenhaExplicita1' })
    );
    // Diálogo fecha direto (sem passo de revelação) — "Credencial criada" não aparece.
    await waitFor(() => expect(screen.queryByText('Credencial criada')).not.toBeInTheDocument());
  });

  it('criar credencial: erro da API mostra mensagem sem quebrar a tela', async () => {
    mockCriarCredencial.mockRejectedValueOnce(new MotoristaApiError(409, 'Este motorista já tem uma credencial de acesso vinculada.'));
    render(<Harness credencialAtiva={null} />);

    fireEvent.click(screen.getByRole('button', { name: /Criar credencial/ }));
    fireEvent.change(screen.getByLabelText('CNPJ do prestador'), { target: { value: '12345678000195' } });
    fireEvent.click(screen.getByRole('button', { name: 'Criar credencial' }));

    await waitFor(() =>
      expect(screen.getByText('Este motorista já tem uma credencial de acesso vinculada.')).toBeInTheDocument()
    );
  });

  it('criar credencial: CNPJ vazio mostra erro sem chamar a API', async () => {
    render(<Harness credencialAtiva={null} />);
    fireEvent.click(screen.getByRole('button', { name: /Criar credencial/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Criar credencial' }));

    await waitFor(() => expect(screen.getByText('Informe o CNPJ do prestador.')).toBeInTheDocument());
    expect(mockCriarCredencial).not.toHaveBeenCalled();
  });

  it('redefinir senha: exige confirmação (AlertDialog) e revela o token de definição', async () => {
    mockResetSenhaCredencial.mockResolvedValueOnce({ ok: true, tokenDefinicao: 'a'.repeat(64) });
    const onAtualizado = vi.fn();
    render(<Harness credencialAtiva={true} onAtualizado={onAtualizado} />);

    fireEvent.click(screen.getByRole('button', { name: /Redefinir senha/ }));
    // Nenhuma chamada disparada só ao clicar no gatilho.
    expect(mockResetSenhaCredencial).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Redefinir senha' }));

    await waitFor(() => expect(mockResetSenhaCredencial).toHaveBeenCalledWith(1));
    expect(onAtualizado).toHaveBeenCalled();
    await waitFor(() => expect(screen.getByText('a'.repeat(64))).toBeInTheDocument());
  });

  it('redefinir senha: erro da API mostra mensagem sem quebrar a tela', async () => {
    mockResetSenhaCredencial.mockRejectedValueOnce(new MotoristaApiError(404, 'Este motorista ainda não tem uma credencial de acesso criada.'));
    render(<Harness credencialAtiva={true} />);

    fireEvent.click(screen.getByRole('button', { name: /Redefinir senha/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Redefinir senha' }));

    await waitFor(() =>
      expect(screen.getByText('Este motorista ainda não tem uma credencial de acesso criada.')).toBeInTheDocument()
    );
  });

  it('desativar credencial: exige confirmação e chama atualizarCredencial({ativo:false})', async () => {
    mockAtualizarCredencial.mockResolvedValueOnce({ id: 1, ativo: false });
    const onAtualizado = vi.fn();
    render(<Harness credencialAtiva={true} onAtualizado={onAtualizado} />);

    fireEvent.click(screen.getByRole('button', { name: /Desativar credencial/ }));
    expect(mockAtualizarCredencial).not.toHaveBeenCalled();

    const confirmButtons = screen.getAllByRole('button', { name: 'Desativar' });
    fireEvent.click(confirmButtons[confirmButtons.length - 1]);

    await waitFor(() => expect(mockAtualizarCredencial).toHaveBeenCalledWith(1, { ativo: false }));
    expect(onAtualizado).toHaveBeenCalled();
  });

  it('ativar credencial: chama atualizarCredencial({ativo:true})', async () => {
    mockAtualizarCredencial.mockResolvedValueOnce({ id: 1, ativo: true });
    render(<Harness credencialAtiva={false} />);

    fireEvent.click(screen.getByRole('button', { name: /Ativar credencial/ }));
    const confirmButtons = screen.getAllByRole('button', { name: 'Ativar' });
    fireEvent.click(confirmButtons[confirmButtons.length - 1]);

    await waitFor(() => expect(mockAtualizarCredencial).toHaveBeenCalledWith(1, { ativo: true }));
  });

  it('ativar/desativar: erro da API mostra mensagem sem quebrar a tela', async () => {
    mockAtualizarCredencial.mockRejectedValueOnce(new MotoristaApiError(403, 'Você não tem permissão para esta ação.'));
    render(<Harness credencialAtiva={true} />);

    fireEvent.click(screen.getByRole('button', { name: /Desativar credencial/ }));
    const confirmButtons = screen.getAllByRole('button', { name: 'Desativar' });
    fireEvent.click(confirmButtons[confirmButtons.length - 1]);

    await waitFor(() => expect(screen.getByText('Você não tem permissão para esta ação.')).toBeInTheDocument());
  });
});

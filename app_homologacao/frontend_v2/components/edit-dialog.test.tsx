// corrigir-movimento (5.1.4): a tela nunca diz "sucesso" sem gravação confirmada.
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { EditDialog } from './edit-dialog';
import { ApiError } from '@/lib/api-client';
import type { EnvioMassa } from '@/types';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
import { toast } from 'sonner';

const REG = { id: 7, number: '001', nome: 'Ana', valor: 100, cnpj_prestador: '12345678000199' } as unknown as EnvioMassa;

function abrir(onSave: (id: number, d: Record<string, unknown>) => Promise<unknown>) {
  render(<EditDialog open onOpenChange={vi.fn()} record={REG} onSave={onSave} />);
}
function mudarValor(v: string) {
  fireEvent.change(screen.getByLabelText('Valor'), { target: { value: v } });
}

describe('EditDialog — correção de valor', () => {
  it('valor alterado exige motivo: Salvar fica desabilitado até preenchê-lo', () => {
    abrir(vi.fn());
    mudarValor('150,00');
    expect(screen.getByRole('button', { name: /Salvar/ })).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Motivo da correção/), { target: { value: 'erro de digitação' } });
    expect(screen.getByRole('button', { name: /Salvar/ })).toBeEnabled();
  });

  it('envia valor e motivo ao salvar', async () => {
    const onSave = vi.fn().mockResolvedValue({ resultado: 'atualizado', mensagem_ajustada: true });
    abrir(onSave);
    mudarValor('150,00');
    fireEvent.change(screen.getByLabelText(/Motivo da correção/), { target: { value: 'erro de digitação' } });
    fireEvent.click(screen.getByRole('button', { name: /Salvar/ }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0][1]).toMatchObject({ valor: '150,00', motivo: 'erro de digitação' });
  });

  it('409 por nota enviada: diz que NÃO alterou e nunca anuncia sucesso', async () => {
    const onSave = vi.fn().mockRejectedValue(new ApiError('Erro 409', 409, [], { resultado: 'pulado_nota_enviada' }));
    vi.mocked(toast.success).mockClear();
    abrir(onSave);
    mudarValor('150,00');
    fireEvent.change(screen.getByLabelText(/Motivo da correção/), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: /Salvar/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/nota enviada.*NÃO foi alterado/);
    expect(toast.success).not.toHaveBeenCalled();
    expect(screen.queryByText('Valor corrigido')).toBeNull();
  });

  it('valor corrigido mas mensagem não ajustada: mostra o aviso e mantém o diálogo aberto', async () => {
    const onSave = vi.fn().mockResolvedValue({ resultado: 'atualizado', mensagem_ajustada: false, aviso: 'revise o texto antes de enviar.' });
    abrir(onSave);
    mudarValor('150,00');
    fireEvent.change(screen.getByLabelText(/Motivo da correção/), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: /Salvar/ }));
    expect(await screen.findByRole('status')).toHaveTextContent(/revise o texto antes de enviar/);
  });

  it('inalterado: informa que nada mudou, sem anunciar correção', async () => {
    const onSave = vi.fn().mockResolvedValue({ resultado: 'inalterado' });
    abrir(onSave);
    mudarValor('150,00');
    fireEvent.change(screen.getByLabelText(/Motivo da correção/), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: /Salvar/ }));
    expect(await screen.findByRole('status')).toHaveTextContent(/nada foi alterado/);
  });

  it('resposta 200 sem desfecho reconhecível não vira sucesso', async () => {
    const onSave = vi.fn().mockResolvedValue({ message: 'Registro atualizado com sucesso!' });
    abrir(onSave);
    mudarValor('150,00');
    fireEvent.change(screen.getByLabelText(/Motivo da correção/), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: /Salvar/ }));
    expect(await screen.findByRole('status')).toHaveTextContent(/sem confirmar o desfecho/);
  });
});

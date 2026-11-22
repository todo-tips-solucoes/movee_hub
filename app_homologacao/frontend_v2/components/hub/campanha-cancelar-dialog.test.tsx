// campanhas do motorista (W3a) — cancelar exige motivo (5..500).

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CampanhaCancelarDialog } from './campanha-cancelar-dialog';
import { CampanhaApiError } from '@/lib/hub/campanhas-api';

function abrir(onCancelar = vi.fn().mockResolvedValue(undefined)) {
  render(<CampanhaCancelarDialog open onOpenChange={() => {}} nome="Rei do Jantar" onCancelar={onCancelar} />);
  return onCancelar;
}
const botao = () => screen.getByRole('button', { name: 'Cancelar campanha' });
const campo = () => screen.getByLabelText(/Motivo/);

describe('CampanhaCancelarDialog', () => {
  it('motivo vazio ou com menos de 5 caracteres mantém o botão desabilitado', () => {
    abrir();
    expect(botao()).toBeDisabled();
    fireEvent.change(campo(), { target: { value: 'abcd' } });
    expect(botao()).toBeDisabled();
    fireEvent.change(campo(), { target: { value: '     ' } });
    expect(botao()).toBeDisabled();
  });

  it('com 5+ caracteres envia o motivo aparado', async () => {
    const onCancelar = abrir();
    fireEvent.change(campo(), { target: { value: '  Prêmio errado  ' } });
    expect(botao()).toBeEnabled();
    fireEvent.click(botao());
    await waitFor(() => expect(onCancelar).toHaveBeenCalledWith('Prêmio errado'));
  });

  it('erro da API aparece', async () => {
    abrir(vi.fn().mockRejectedValue(new CampanhaApiError(409, 'A situação da campanha mudou', 'CAMPANHA_SITUACAO_INVALIDA')));
    fireEvent.change(campo(), { target: { value: 'Prêmio errado' } });
    fireEvent.click(botao());
    expect(await screen.findByRole('alert')).toHaveTextContent('A situação da campanha mudou');
  });
});

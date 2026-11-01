// Alterar CNPJ da conta vinculada (frente motorista-cadastro-hub F3): máscara, 14 dígitos,
// chamada só com dígitos, e a mensagem do 409 orientando "Trocar" (vocabulário da tela).
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AlterarCnpjMotoristaDialog,
  mascararCnpjDigitado,
  useAlterarCnpjMotoristaDialog,
} from './alterar-cnpj-motorista-dialog';
import { MotoristaApiError } from '@/lib/hub/motoristas-api';
import { parseTrocarCnpjResponse } from '@/lib/hub/motoristas-dto';

const mockTrocar = vi.fn();

vi.mock('@/lib/hub/motoristas-api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/hub/motoristas-api')>('@/lib/hub/motoristas-api');
  return { ...actual, trocarCnpjCredencial: (...args: unknown[]) => mockTrocar(...args) };
});

function Harness({ onAlterado = vi.fn() }: { onAlterado?: (r: unknown) => void }) {
  const state = useAlterarCnpjMotoristaDialog({ entregadorId: 1, onAlterado });
  return (
    <>
      <button onClick={() => state.setOpen(true)}>abrir</button>
      <AlterarCnpjMotoristaDialog state={state} />
    </>
  );
}

const abrir = () => fireEvent.click(screen.getByRole('button', { name: 'abrir' }));
const confirmar = () => screen.getAllByRole('button', { name: 'Alterar CNPJ' }).at(-1)!;

describe('AlterarCnpjMotoristaDialog', () => {
  beforeEach(() => mockTrocar.mockReset());

  it('mascara o que o usuário digita e só habilita com 14 dígitos', () => {
    render(<Harness />);
    abrir();
    const input = screen.getByLabelText('CNPJ do prestador') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '6922222200010' } });
    expect(input.value).toBe('69.222.222/0001-0');
    expect(confirmar()).toBeDisabled();
    expect(screen.getByText(/13\/14/)).toBeInTheDocument();
    fireEvent.change(input, { target: { value: '69.222.222/0001-09' } });
    expect(confirmar()).not.toBeDisabled();
    expect(mockTrocar).not.toHaveBeenCalled();
  });

  it('sucesso: chama a API só com dígitos, entrega a resposta e fecha', async () => {
    const resp = { id: 7, cnpjPrestador: '69.***.***/0001-**', movimentosMigrados: 2, inalterado: false, contaBancariaPjDesatualizada: false };
    mockTrocar.mockResolvedValueOnce(resp);
    const onAlterado = vi.fn();
    render(<Harness onAlterado={onAlterado} />);
    abrir();
    fireEvent.change(screen.getByLabelText('CNPJ do prestador'), { target: { value: '69222222000109' } });
    fireEvent.click(confirmar());
    await waitFor(() => expect(mockTrocar).toHaveBeenCalledWith(1, { cnpjPrestador: '69222222000109' }));
    await waitFor(() => expect(onAlterado).toHaveBeenCalledWith(resp));
    await waitFor(() => expect(screen.queryByLabelText('CNPJ do prestador')).not.toBeInTheDocument());
  });

  it('409: mostra a mensagem que orienta usar Trocar e mantém o diálogo aberto', async () => {
    mockTrocar.mockRejectedValueOnce(
      new MotoristaApiError(409, 'Este CNPJ já pertence a outra conta de acesso. Para usar essa conta, use Trocar em “Conta de acesso vinculada”.', 'CONFLITO', 'cnpj_ja_cadastrado')
    );
    const onAlterado = vi.fn();
    render(<Harness onAlterado={onAlterado} />);
    abrir();
    fireEvent.change(screen.getByLabelText('CNPJ do prestador'), { target: { value: '69222222000109' } });
    fireEvent.click(confirmar());
    expect(await screen.findByRole('alert')).toHaveTextContent(/use Trocar/);
    expect(onAlterado).not.toHaveBeenCalled();
    expect(screen.getByLabelText('CNPJ do prestador')).toBeInTheDocument();
  });
});

describe('mensagem real do 409 (mapa de motivos da API)', () => {
  it('motivo cnpj_ja_cadastrado vira o texto que orienta Trocar, sem passar pelo CONFLITO genérico de vínculo', async () => {
    const real = await vi.importActual<typeof import('@/lib/hub/motoristas-api')>('@/lib/hub/motoristas-api');
    const fetchOriginal = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ erro: 'CONFLITO', motivo: 'cnpj_ja_cadastrado' }), {
        status: 409,
        headers: { 'Content-Type': 'application/json' },
      })
    );
    try {
      await expect(real.trocarCnpjCredencial(1, { cnpjPrestador: '69222222000109' })).rejects.toThrow(/use Trocar/);
    } finally {
      globalThis.fetch = fetchOriginal;
    }
  });
});

describe('mascararCnpjDigitado / parseTrocarCnpjResponse', () => {
  it('máscara completa e parcial', () => {
    expect(mascararCnpjDigitado('69222222000109')).toBe('69.222.222/0001-09');
    expect(mascararCnpjDigitado('692')).toBe('69.2');
  });
  it('parser: exige id; defaults seguros para o resto', () => {
    expect(parseTrocarCnpjResponse({ id: 3 })).toEqual({
      id: 3, cnpjPrestador: '', movimentosMigrados: 0, inalterado: false, contaBancariaPjDesatualizada: false,
    });
    expect(() => parseTrocarCnpjResponse({})).toThrow(TypeError);
  });
});

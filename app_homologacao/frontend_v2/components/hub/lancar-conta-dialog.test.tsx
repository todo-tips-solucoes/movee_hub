// Lançamento de conta pelo operador — a única porta para conta PESSOA FÍSICA
// desde 2026-10-05, quando o app passou a aceitar só CNPJ do próprio titular.
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { LancarContaDialog, mascararDocumento } from './lancar-conta-dialog';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const buscarEntregadores = vi.fn();
const lancarConta = vi.fn();
vi.mock('@/lib/hub/adiantamentos-api', () => ({
  buscarEntregadores: (...a: unknown[]) => buscarEntregadores(...a),
  lancarConta: (...a: unknown[]) => lancarConta(...a),
}));

const ENTREGADOR = { id: 42, nome: 'Fulano de Tal', documentoMascarado: '**.***.***/0001-81', temContaAprovada: false };

function abrir() {
  return render(<LancarContaDialog aberto onFechar={vi.fn()} onLancada={vi.fn()} />);
}

async function escolherMotorista() {
  fireEvent.change(screen.getByLabelText('Motorista'), { target: { value: 'Fulano' } });
  fireEvent.click(await screen.findByText('Fulano de Tal'));
}

function preencherBanco() {
  fireEvent.change(screen.getByLabelText('CPF ou CNPJ do titular'), { target: { value: '12345678909' } });
  fireEvent.change(screen.getByLabelText('Banco (código)'), { target: { value: '260' } });
  fireEvent.change(screen.getByLabelText('Agência'), { target: { value: '0001' } });
  fireEvent.change(screen.getByLabelText('Conta'), { target: { value: '123456' } });
  fireEvent.change(screen.getByLabelText('Dígito'), { target: { value: '7' } });
}

beforeEach(() => {
  buscarEntregadores.mockReset().mockResolvedValue([ENTREGADOR]);
  lancarConta.mockReset().mockResolvedValue({ id: 900, status: 'APROVADA', titularTipo: 'PF' });
});

describe('máscara de documento', () => {
  it('formata CPF e CNPJ conforme o tamanho', () => {
    expect(mascararDocumento('12345678909')).toBe('123.456.789-09');
    expect(mascararDocumento('11222333000181')).toBe('11.222.333/0001-81');
  });

  it('ignora o que não é dígito e não estoura 14', () => {
    expect(mascararDocumento('abc112.223-33/0001810000')).toBe('11.222.333/0001-81');
  });
});

describe('LancarContaDialog', () => {
  it('busca com menos de 3 caracteres não vai à API', async () => {
    abrir();
    fireEvent.change(screen.getByLabelText('Motorista'), { target: { value: 'Fu' } });
    await new Promise((r) => setTimeout(r, 400));
    expect(buscarEntregadores).not.toHaveBeenCalled();
  });

  it('não deixa lançar sem escolher o motorista', async () => {
    abrir();
    preencherBanco();
    fireEvent.change(screen.getByLabelText('Nome do titular'), { target: { value: 'Fulano' } });
    expect(screen.getByRole('button', { name: 'Lançar conta' })).toBeDisabled();
  });

  it('envia SEMPRE como conta corrente — poupança não é opção na tela', async () => {
    abrir();
    await escolherMotorista();
    preencherBanco();
    fireEvent.click(screen.getByRole('button', { name: 'Lançar conta' }));
    await waitFor(() => expect(lancarConta).toHaveBeenCalled());
    expect(lancarConta.mock.calls[0][0]).toMatchObject({
      entregadorId: 42,
      titularDocumento: '12345678909', // só dígitos, sem a máscara
      tipoConta: 'CORRENTE',
    });
    // a tela AVISA sobre poupança (na descrição e no rodapé), mas não oferece
    // o campo — é o que garante que ninguém escolhe o que o backend recusaria
    expect(screen.getAllByText(/poupan[çc]a/i).length).toBeGreaterThan(0);
    expect(screen.queryByLabelText(/tipo de conta/i)).toBeNull();
  });

  it('o CAMPO mostra o documento mascarado enquanto a pessoa digita', () => {
    // testar só a função pura não bastava: o controle negativo mostrou que
    // trocar `value={mascararDocumento(documento)}` por `value={documento}`
    // passava despercebido
    abrir();
    const campo = screen.getByLabelText('CPF ou CNPJ do titular') as HTMLInputElement;
    fireEvent.change(campo, { target: { value: '11222333000181' } });
    expect(campo.value).toBe('11.222.333/0001-81');
  });

  it('pré-preenche o titular com o nome do motorista escolhido', async () => {
    abrir();
    await escolherMotorista();
    expect((screen.getByLabelText('Nome do titular') as HTMLInputElement).value).toBe('Fulano de Tal');
  });

  it('quando o backend recusa, mostra QUAL campo', async () => {
    const { toast } = await import('sonner');
    const erro = Object.assign(new Error('Dados inválidos'), { motivo: 'bancoCodigo' });
    lancarConta.mockRejectedValue(erro);
    abrir();
    await escolherMotorista();
    preencherBanco();
    fireEvent.click(screen.getByRole('button', { name: 'Lançar conta' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(String((toast.error as ReturnType<typeof vi.fn>).mock.calls[0][0])).toMatch(/código do banco/);
  });

  it('mostra quando o motorista não tem CNPJ no cadastro', async () => {
    buscarEntregadores.mockResolvedValue([{ ...ENTREGADOR, documentoMascarado: null }]);
    abrir();
    fireEvent.change(screen.getByLabelText('Motorista'), { target: { value: 'Fulano' } });
    expect(await screen.findByText(/sem CNPJ no cadastro/)).toBeInTheDocument();
  });
});

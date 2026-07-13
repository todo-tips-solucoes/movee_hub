// hub-motorista-canonico (FASE 6) — seção "Atividades" do detalhe do
// motorista (tasks.md 6.5.4): renderização do histórico, estado vazio,
// ausência de controles de edição na lista, e paginação "carregar mais"
// (task 6.4.3 do lado do cliente).
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AtividadesMotoristaSection, useAtividadesMotorista } from './atividades-motorista-section';
import { MotoristaApiError } from '@/lib/hub/motoristas-api';
import type { Atividade, AtividadesPaginadas } from '@/lib/hub/motoristas-dto';

const mockObterMotorista = vi.fn();

vi.mock('@/lib/hub/motoristas-api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/hub/motoristas-api')>('@/lib/hub/motoristas-api');
  return {
    ...actual,
    obterMotorista: (...args: unknown[]) => mockObterMotorista(...args),
  };
});

const ATIVIDADE_1: Atividade = { tipo: 'faturamento', data: '2026-07-02', descricao: 'Entrega X', valor: 42.5 };
const ATIVIDADE_2: Atividade = { tipo: 'validacao_nf', data: '2026-07-01', descricao: '12345', valor: 320.5 };

function Harness({ atividadesIniciais, carregandoDetalhe = false }: {
  atividadesIniciais: AtividadesPaginadas;
  carregandoDetalhe?: boolean;
}) {
  const state = useAtividadesMotorista(1, atividadesIniciais);
  return <AtividadesMotoristaSection carregandoDetalhe={carregandoDetalhe} state={state} />;
}

describe('AtividadesMotoristaSection', () => {
  it('estado vazio claro quando não há atividades (task 6.5.2, sem erro)', () => {
    render(<Harness atividadesIniciais={{ items: [], total: 0, offset: 0, limit: 20 }} />);
    expect(screen.getByText('Nenhuma atividade registrada')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('renderiza o histórico com tipo, data, descrição e valor', () => {
    render(<Harness atividadesIniciais={{ items: [ATIVIDADE_1, ATIVIDADE_2], total: 2, offset: 0, limit: 20 }} />);
    expect(screen.getByText('Faturamento')).toBeInTheDocument();
    expect(screen.getByText('Validação de NF')).toBeInTheDocument();
    expect(screen.getByText('Entrega X')).toBeInTheDocument();
    expect(screen.getByText('12345')).toBeInTheDocument();
    expect(screen.getByText('Mostrando 2 de 2 atividades.')).toBeInTheDocument();
  });

  it('ausência de controles de edição — lista 100% read-only (FR-022)', () => {
    render(<Harness atividadesIniciais={{ items: [ATIVIDADE_1], total: 1, offset: 0, limit: 20 }} />);
    // Único botão possível é "Carregar mais" (ausente aqui pois total===items.length);
    // nenhum botão de editar/excluir/ação deve existir na seção.
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('skeleton enquanto o detalhe carrega (task 6.5, mesmo padrão do resto da tela)', () => {
    render(<Harness atividadesIniciais={{ items: [], total: 0, offset: 0, limit: 20 }} carregandoDetalhe />);
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('"Carregar mais" busca a próxima página e ANEXA aos itens já exibidos (task 6.4.3)', async () => {
    const ATIVIDADE_3: Atividade = { tipo: 'performance', data: '2026-06-30', descricao: 'Manhã', valor: null };
    mockObterMotorista.mockResolvedValueOnce({
      atividades: { items: [ATIVIDADE_3], total: 3, offset: 2, limit: 20 },
    });

    render(<Harness atividadesIniciais={{ items: [ATIVIDADE_1, ATIVIDADE_2], total: 3, offset: 0, limit: 2 }} />);

    const botao = screen.getByRole('button', { name: /carregar mais/i });
    // Botão nativo — Tab/Enter/Espaço já funcionam sem JS extra (task 6.5.3).
    expect(botao.tagName).toBe('BUTTON');
    expect(botao).not.toHaveAttribute('aria-hidden');

    fireEvent.click(botao);

    await waitFor(() => expect(screen.getByText('Mostrando 3 de 3 atividades.')).toBeInTheDocument());
    expect(screen.getByText('Manhã')).toBeInTheDocument();
    // Itens anteriores permanecem (append, não substituição).
    expect(screen.getByText('Entrega X')).toBeInTheDocument();
    expect(mockObterMotorista).toHaveBeenCalledWith(1, { atividadesOffset: 2, atividadesLimit: 20 });
    // Sem mais itens -> botão desaparece.
    expect(screen.queryByRole('button', { name: /carregar mais/i })).not.toBeInTheDocument();
  });

  it('erro ao carregar mais mostra mensagem sem quebrar a lista já exibida', async () => {
    mockObterMotorista.mockRejectedValueOnce(new MotoristaApiError(500, 'Erro no servidor.'));

    render(<Harness atividadesIniciais={{ items: [ATIVIDADE_1], total: 2, offset: 0, limit: 1 }} />);
    fireEvent.click(screen.getByRole('button', { name: /carregar mais/i }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Erro no servidor.'));
    expect(screen.getByText('Entrega X')).toBeInTheDocument();
  });
});

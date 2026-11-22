// campanhas do motorista (W3a) — formulário: cobertura de pedidos < 95% deixa o
// indicador Pedidos desabilitado COM o número na tela; "Revisar e lançar" valida
// antes de gravar; com tudo certo grava e abre o diálogo de lançamento.

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CampanhaFormulario } from './campanha-formulario';
import { premioVazio, type FormularioCampanha } from '@/lib/hub/campanhas-form';
import type { OpcoesCampanha } from '@/lib/hub/campanhas-dto';

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, replace: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const mockOpcoes = vi.fn();
const mockCriar = vi.fn();
vi.mock('@/lib/hub/campanhas-api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/hub/campanhas-api')>('@/lib/hub/campanhas-api');
  return {
    ...actual,
    obterOpcoes: (...a: unknown[]) => mockOpcoes(...a),
    criarCampanha: (...a: unknown[]) => mockCriar(...a),
    atualizarCampanha: vi.fn(),
    lancarCampanha: vi.fn(),
    obterCampanha: vi.fn(),
    enviarFotoPremio: vi.fn(),
  };
});

const OPCOES_OK: OpcoesCampanha = {
  pracas: ['SAO PAULO', 'CAMPINAS'],
  turnos: ['JANTAR 18H-22H'],
  modais: ['MOTO', 'BICICLETA'],
  coberturaPedidos: 0.98,
  alcance: { rodaram: 212, semModal: 12 },
};

// Data bem no futuro: a regra "início >= hoje" não depende do relógio do CI.
const COMPLETO: FormularioCampanha = {
  nome: 'Rei do Jantar',
  descricao: '',
  dataInicio: '2099-01-10',
  dataFim: '2099-01-20',
  pracas: ['SAO PAULO'],
  turnos: null,
  modais: null,
  minTurnos: 5,
  pesos: { aceitacao: 50, conclusao: 50, tempo: 0, pedidos: 0 },
  cortes: { aceitacao: null, conclusao: null, tempo: null, pedidos: null },
  premios: [{ ...premioVazio(1), descricao: 'Bag térmica' }],
  avisar: true,
};

beforeEach(() => {
  mockOpcoes.mockReset();
  mockCriar.mockReset();
  push.mockReset();
});

describe('CampanhaFormulario', () => {
  it('cobertura < 95%: o indicador Pedidos fica desabilitado e o número aparece', async () => {
    mockOpcoes.mockResolvedValue({ ...OPCOES_OK, coberturaPedidos: 0.82 });
    render(<CampanhaFormulario campanhaId={null} inicial={COMPLETO} />);
    expect(await screen.findByText(/Cobertura do dado neste público: 82%/)).toBeInTheDocument();
    // o Checkbox do Base UI é um <span role=checkbox>: o estado é aria-disabled
    expect(screen.getByRole('checkbox', { name: 'Pedidos concluídos' })).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('checkbox', { name: 'Taxa de aceitação' })).not.toHaveAttribute('aria-disabled', 'true');
  });

  it('cobertura >= 95%: Pedidos pode ser marcado', async () => {
    mockOpcoes.mockResolvedValue(OPCOES_OK);
    render(<CampanhaFormulario campanhaId={null} inicial={COMPLETO} />);
    expect(await screen.findByText(/Cobertura do dado neste público: 98%/)).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Pedidos concluídos' })).not.toHaveAttribute('aria-disabled', 'true');
  });

  it('usa os rótulos da Performance nos 4 indicadores', async () => {
    mockOpcoes.mockResolvedValue(OPCOES_OK);
    render(<CampanhaFormulario campanhaId={null} inicial={COMPLETO} />);
    await screen.findByText(/Cobertura/);
    for (const r of ['Taxa de aceitação', 'Taxa de conclusão', 'Tempo disponível', 'Pedidos concluídos']) {
      expect(screen.getByRole('checkbox', { name: r })).toBeInTheDocument();
    }
  });

  it('mostra o alcance e o aviso de motoristas sem modal ao escolher um modal', async () => {
    mockOpcoes.mockResolvedValue(OPCOES_OK);
    render(<CampanhaFormulario campanhaId={null} inicial={{ ...COMPLETO, modais: ['MOTO'] }} />);
    expect(await screen.findByText(/212 motoristas rodaram/)).toBeInTheDocument();
    expect(screen.getByText(/12 motoristas desse público ainda não têm modal no cadastro e ficam de fora/)).toBeInTheDocument();
  });

  it('soma dos pesos fora de 100: badge de aviso e "Revisar e lançar" NÃO grava', async () => {
    mockOpcoes.mockResolvedValue(OPCOES_OK);
    render(<CampanhaFormulario campanhaId={null} inicial={{ ...COMPLETO, pesos: { aceitacao: 50, conclusao: 49, tempo: 0, pedidos: 0 } }} />);
    await screen.findByText(/Cobertura/);
    expect(screen.getByText('Soma dos pesos: 99%')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Revisar e lançar' }));
    expect(await screen.findByText(/hoje somam 99/)).toBeInTheDocument();
    expect(mockCriar).not.toHaveBeenCalled();
  });

  it('formulário válido: grava e abre o diálogo com o botão de lançar travado', async () => {
    mockOpcoes.mockResolvedValue(OPCOES_OK);
    mockCriar.mockResolvedValue(55);
    render(<CampanhaFormulario campanhaId={null} inicial={COMPLETO} />);
    await screen.findByText(/Cobertura/);
    fireEvent.click(screen.getByRole('button', { name: 'Revisar e lançar' }));
    await waitFor(() => expect(mockCriar).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole('button', { name: 'Lançar campanha' })).toBeDisabled();
  });

  it('"Salvar rascunho" grava sem abrir o diálogo e volta para a lista', async () => {
    mockOpcoes.mockResolvedValue(OPCOES_OK);
    mockCriar.mockResolvedValue(55);
    render(<CampanhaFormulario campanhaId={null} inicial={COMPLETO} />);
    await screen.findByText(/Cobertura/);
    fireEvent.click(screen.getByRole('button', { name: 'Salvar rascunho' }));
    await waitFor(() => expect(push).toHaveBeenCalledWith('/hub/dashboard/campanhas'));
    expect(screen.queryByRole('button', { name: 'Lançar campanha' })).not.toBeInTheDocument();
  });

  it('erro do servidor ao gravar aparece como mensagem acionável', async () => {
    const { CampanhaApiError } = await import('@/lib/hub/campanhas-api');
    mockOpcoes.mockResolvedValue(OPCOES_OK);
    mockCriar.mockRejectedValue(new CampanhaApiError(409, 'Esta entidade já tem 10 campanhas', 'TETO_CAMPANHAS_ATIVAS'));
    render(<CampanhaFormulario campanhaId={null} inicial={COMPLETO} />);
    await screen.findByText(/Cobertura/);
    fireEvent.click(screen.getByRole('button', { name: 'Salvar rascunho' }));
    expect(await screen.findByText(/Esta entidade já tem 10 campanhas/)).toBeInTheDocument();
  });
});

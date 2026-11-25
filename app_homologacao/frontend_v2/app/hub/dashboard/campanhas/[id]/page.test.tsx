// Detalhe da campanha — tipo "Melhor extrato" (PLANO-MELHOR-EXTRATO E8, tela 11):
// selo do tipo, 4 cards, tabela com turnos válidos/trabalhados/valor e abas sem
// "Abaixo do corte". A nota ponderada segue como era.

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import CampanhaDetalhePage from './page';
import { parseCampanhaDetalhe, parseRanking } from '@/lib/hub/campanhas-dto';
import { toast } from 'sonner';

// Router estável: um objeto novo a cada render refaria o `carregar` e desfaria a troca otimista.
const router = { push: vi.fn(), replace: vi.fn() };
vi.mock('next/navigation', () => ({
  useParams: () => ({ id: '9' }),
  useRouter: () => router,
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock('@/contexts/hub-auth-context', () => ({ useHubAuth: () => ({ permissoes: ['campanhas.gerir'] }) }));

const mockCampanha = vi.fn();
const mockRanking = vi.fn();
const mockVis = vi.fn();
vi.mock('@/lib/hub/campanhas-api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/hub/campanhas-api')>('@/lib/hub/campanhas-api');
  return {
    ...actual,
    obterCampanha: (...a: unknown[]) => mockCampanha(...a),
    obterRanking: (...a: unknown[]) => mockRanking(...a),
    obterVencedores: vi.fn().mockResolvedValue([]),
    baixarRankingCsv: vi.fn(),
    atualizarVisibilidadeCampanha: (...a: unknown[]) => mockVis(...a),
  };
});

const BASE = {
  id: 9,
  nome: 'Melhor extrato — 2ª quinzena',
  situacao: 'em_andamento',
  dataInicio: '2099-11-16',
  dataFim: '2099-11-30',
  pracas: ['SAO PAULO'],
  turnos: null,
  modais: null,
  minTurnos: 8,
  premiosPendentes: 0,
  dadosAte: '2099-11-21',
  descricao: '',
  premios: [],
  avisar: true,
};

const EXTRATO = {
  ...BASE,
  tipo: 'extrato',
  categorias: ['Corridas concluidas', 'familia:promocao'],
  minTurnosBase: 'validos',
  pesos: { aceitacao: 0, conclusao: 0, tempo: 0, pedidos: 0 },
  cortes: { aceitacao: 0.9, conclusao: null, tempo: 0.7, pedidos: null },
  contagem: { classificado: 2, abaixoCorte: 0, semMinimo: 1, semModal: 0, turnos: 29, turnosValidos: 22, valorCentavos: 330000 },
};

const LINHA = { modal: 'MOTO', aceitacao: null, conclusao: null, tempo: null, pedidos: null, nota: null, motivoCorte: [] };
const RANKING = {
  classificado: [
    { ...LINHA, posicao: 1, posicaoAnterior: 1, entregadorId: 1, nome: 'Marcos Vinícius Andrade', situacao: 'classificado', turnosValidos: 14, turnos: 15, valorCentavos: 203140 },
    { ...LINHA, posicao: 2, posicaoAnterior: 3, entregadorId: 2, nome: 'Juliana Pereira Lima', situacao: 'classificado', turnosValidos: 6, turnos: 10, valorCentavos: 96860 },
  ],
  sem_minimo: [
    { ...LINHA, posicao: null, posicaoAnterior: null, entregadorId: 3, nome: 'Rafael Souza', situacao: 'sem_minimo', turnosValidos: 2, turnos: 4, valorCentavos: 30000 },
  ],
};

beforeEach(() => {
  mockCampanha.mockReset();
  mockRanking.mockReset();
  mockVis.mockReset();
  mockRanking.mockImplementation((_id: number, situacao: keyof typeof RANKING) =>
    Promise.resolve(
      parseRanking({ itens: RANKING[situacao] ?? [], contagem: EXTRATO.contagem, pagina: 1, porPagina: 50 })
    )
  );
});

describe('detalhe — Melhor extrato', () => {
  it('selo do tipo, 4 cards com totais da contagem e regras do extrato', async () => {
    mockCampanha.mockResolvedValue(parseCampanhaDetalhe(EXTRATO));
    render(<CampanhaDetalhePage />);
    expect(await screen.findAllByText('Melhor extrato')).not.toHaveLength(0);
    expect(screen.getByText('Participantes')).toBeInTheDocument();
    expect(screen.getByText('Classificados', { selector: 'div,span,p,h3,h4' })).toBeInTheDocument();
    // vem de contagem: 22 de 29 → 75,9%; R$ 3.300,00
    await waitFor(() => expect(screen.getByText('75,9%')).toBeInTheDocument());
    expect(screen.getByText(/3\.300,00/)).toBeInTheDocument();
    // regras travadas
    expect(screen.getByText('Critério do turno')).toBeInTheDocument();
    expect(screen.getByText(/Taxa de aceitação ≥ 90%/)).toBeInTheDocument();
    expect(screen.getByText(/Promoção/)).toBeInTheDocument();
    expect(screen.getByText(/mín\. 8 turnos válidos/)).toBeInTheDocument();
  });

  it('tabela do extrato: colunas, valor em R$, variação; sem aba "Abaixo do corte"', async () => {
    mockCampanha.mockResolvedValue(parseCampanhaDetalhe(EXTRATO));
    render(<CampanhaDetalhePage />);
    expect(await screen.findByText('Marcos Vinícius Andrade')).toBeInTheDocument();
    for (const col of ['Pos.', 'Motorista', 'Turnos válidos', 'Trabalhados', 'Valor somado', 'Variação']) {
      expect(screen.getByRole('columnheader', { name: col })).toBeInTheDocument();
    }
    expect(screen.getByText(/2\.031,40/)).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /Abaixo do corte/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Nota' })).not.toBeInTheDocument();
    // Juliana subiu de 3º para 2º
    expect(screen.getByText('subiu')).toBeInTheDocument();
  });

  it('aba "Sem o mínimo" lista quem não chegou lá, sem posição', async () => {
    mockCampanha.mockResolvedValue(parseCampanhaDetalhe(EXTRATO));
    render(<CampanhaDetalhePage />);
    await screen.findByText('Marcos Vinícius Andrade');
    fireEvent.click(screen.getByRole('tab', { name: /Sem o mínimo · 1/ }));
    expect(await screen.findByText('Rafael Souza')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Sem modal · 0/ })).toBeInTheDocument();
  });
});

describe('detalhe — nota ponderada', () => {
  it('segue com os cards e colunas de sempre', async () => {
    mockCampanha.mockResolvedValue(
      parseCampanhaDetalhe({
        ...BASE,
        tipo: 'nota',
        pesos: { aceitacao: 50, conclusao: 50, tempo: 0, pedidos: 0 },
        cortes: { aceitacao: null, conclusao: null, tempo: null, pedidos: null },
        contagem: { classificado: 0, abaixoCorte: 0, semMinimo: 0, semModal: 0 },
        notaCorteTop10: null,
      })
    );
    mockRanking.mockResolvedValue(parseRanking({ itens: [], contagem: {}, pagina: 1, porPagina: 50 }));
    render(<CampanhaDetalhePage />);
    expect(await screen.findByText('Nota de corte do top 10')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Abaixo do corte/ })).toBeInTheDocument();
    expect(screen.getByText('Nota ponderada')).toBeInTheDocument();
  });
});

describe('detalhe — visibilidade no app', () => {
  const SW = { name: 'Motoristas veem esta campanha no app' };

  it('selo "Oculta no app" e liga o interruptor chamando a API', async () => {
    mockCampanha.mockResolvedValue(parseCampanhaDetalhe(EXTRATO));
    mockVis.mockResolvedValue({ id: 9, visivelApp: true });
    render(<CampanhaDetalhePage />);
    expect(await screen.findByText('Oculta no app')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('switch', SW));
    await waitFor(() => expect(screen.getByRole('switch', SW)).toHaveAttribute('aria-checked', 'true'));
    expect(mockVis.mock.calls).toEqual([[9, true]]);
    expect(await screen.findByText('Visível no app')).toBeInTheDocument();
  });

  it('API falha: reverte o interruptor e mostra toast de erro', async () => {
    mockCampanha.mockResolvedValue(parseCampanhaDetalhe(EXTRATO));
    mockVis.mockRejectedValue(new Error('boom'));
    render(<CampanhaDetalhePage />);
    await screen.findByText('Oculta no app');
    fireEvent.click(screen.getByRole('switch', SW));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(screen.getByRole('switch', SW)).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByText('Oculta no app')).toBeInTheDocument();
  });

  it('cancelada: sem interruptor', async () => {
    mockCampanha.mockResolvedValue(parseCampanhaDetalhe({ ...EXTRATO, situacao: 'cancelada', motivoCancelamento: 'x' }));
    render(<CampanhaDetalhePage />);
    await screen.findByText(/Motivo: x/);
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    expect(screen.queryByText('Oculta no app')).not.toBeInTheDocument();
    expect(screen.queryByText('Visível no app')).not.toBeInTheDocument();
  });
});

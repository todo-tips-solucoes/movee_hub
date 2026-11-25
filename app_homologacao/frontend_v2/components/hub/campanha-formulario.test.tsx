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
const mockCategorias = vi.fn();
vi.mock('@/lib/hub/campanhas-api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/hub/campanhas-api')>('@/lib/hub/campanhas-api');
  return {
    ...actual,
    obterOpcoes: (...a: unknown[]) => mockOpcoes(...a),
    criarCampanha: (...a: unknown[]) => mockCriar(...a),
    listarCategoriasCampanha: (...a: unknown[]) => mockCategorias(...a),
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
  tipo: 'nota',
  categorias: [],
  minTurnosBase: 'trabalhados',
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
  visivelApp: false,
};

const CATEGORIAS = [
  { descricao: 'Corridas concluidas', lancamentos: 41462, semMotoristaIdentificado: false, familia: null },
  { descricao: 'Valor por Hora Online', lancamentos: 21775, semMotoristaIdentificado: false, familia: null },
  { descricao: 'Promocao entregador', lancamentos: 11885, semMotoristaIdentificado: false, familia: 'familia:promocao' },
];

const EXTRATO: FormularioCampanha = {
  ...COMPLETO,
  tipo: 'extrato',
  minTurnosBase: 'validos',
  minTurnos: 8,
  pesos: { aceitacao: 0, conclusao: 0, tempo: 0, pedidos: 0 },
  cortes: { aceitacao: 0.9, conclusao: null, tempo: 0.7, pedidos: null },
  categorias: ['Corridas concluidas', 'familia:promocao'],
};

beforeEach(() => {
  mockOpcoes.mockReset();
  mockCriar.mockReset();
  mockCategorias.mockReset();
  mockCategorias.mockResolvedValue(CATEGORIAS);
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

  it('interruptor de visibilidade começa desligado e vai no corpo ao ligar', async () => {
    mockOpcoes.mockResolvedValue(OPCOES_OK);
    mockCriar.mockResolvedValue(55);
    render(<CampanhaFormulario campanhaId={null} inicial={COMPLETO} />);
    await screen.findByText(/Cobertura/);
    const sw = screen.getByRole('switch', { name: 'Motoristas veem esta campanha no app' });
    expect(sw).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(sw);
    expect(sw).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Salvar rascunho' }));
    await waitFor(() => expect(mockCriar).toHaveBeenCalledTimes(1));
    expect(mockCriar.mock.calls[0][0]).toMatchObject({ visivelApp: true });
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

  describe('tipo "Melhor extrato"', () => {
    it('nota (padrão): sem bloco de valor do turno e sem pedir categorias', async () => {
      mockOpcoes.mockResolvedValue(OPCOES_OK);
      render(<CampanhaFormulario campanhaId={null} inicial={COMPLETO} />);
      await screen.findByText(/Cobertura/);
      expect(screen.getByRole('radio', { name: /Nota ponderada/ })).toBeChecked();
      expect(screen.getByText('Soma dos pesos: 100%')).toBeInTheDocument();
      expect(screen.queryByText(/Valor do turno/)).not.toBeInTheDocument();
      expect(mockCategorias).not.toHaveBeenCalled();
    });

    it('trocar para extrato troca os blocos: sem peso, "Mínimo no turno", seletor de categorias, base do mínimo', async () => {
      mockOpcoes.mockResolvedValue(OPCOES_OK);
      render(<CampanhaFormulario campanhaId={null} inicial={COMPLETO} />);
      await screen.findByText(/Cobertura/);
      fireEvent.click(screen.getByRole('radio', { name: /Melhor extrato/ }));
      expect(screen.queryByText(/Soma dos pesos/)).not.toBeInTheDocument();
      expect(screen.queryByLabelText(/^Peso \(%\)/)).not.toBeInTheDocument();
      expect(screen.getByText('3. Critérios do turno (mínimo em cada turno)')).toBeInTheDocument();
      expect(screen.getByText('4. Valor do turno: categorias do faturamento')).toBeInTheDocument();
      expect(screen.getByText('5. Prêmios por faixa de posição')).toBeInTheDocument();
      expect(screen.getByRole('radio', { name: 'turnos válidos' })).toBeChecked();
      expect(screen.getByText(/3 dias depois do fim/)).toBeInTheDocument();
      // seletor: nenhuma marcada por padrão, família dobrada
      expect(await screen.findByText('0 de 3 selecionadas')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Promoção/ })).toBeInTheDocument();
    });

    it('extrato sem critério ou sem categoria: erro do cliente e nada é gravado', async () => {
      mockOpcoes.mockResolvedValue(OPCOES_OK);
      render(<CampanhaFormulario campanhaId={null} inicial={{ ...EXTRATO, cortes: { aceitacao: null, conclusao: null, tempo: null, pedidos: null }, categorias: [] }} />);
      await screen.findByText(/212 motoristas rodaram/);
      fireEvent.click(screen.getByRole('button', { name: 'Salvar rascunho' }));
      expect(await screen.findByText('Marque ao menos 1 critério e informe o mínimo no turno.')).toBeInTheDocument();
      expect(screen.getByText('Marque ao menos 1 categoria para compor o valor do turno.')).toBeInTheDocument();
      expect(mockCriar).not.toHaveBeenCalled();
    });

    it('extrato válido: o payload leva tipo, categorias, base e pesos zerados', async () => {
      mockOpcoes.mockResolvedValue(OPCOES_OK);
      mockCriar.mockResolvedValue(77);
      render(<CampanhaFormulario campanhaId={null} inicial={EXTRATO} />);
      await screen.findByText(/212 motoristas rodaram/);
      fireEvent.click(screen.getByRole('button', { name: 'Salvar rascunho' }));
      await waitFor(() => expect(mockCriar).toHaveBeenCalledTimes(1));
      const { formularioParaCorpo } = await import('@/lib/hub/campanhas-form');
      const corpo = formularioParaCorpo(mockCriar.mock.calls[0][0]);
      expect(corpo).toMatchObject({
        tipo: 'extrato',
        categorias: ['Corridas concluidas', 'familia:promocao'],
        minTurnosBase: 'validos',
        minTurnos: 8,
        pesos: { aceitacao: 0, conclusao: 0, tempo: 0, pedidos: 0 },
        cortes: { aceitacao: 0.9, conclusao: null, tempo: 0.7, pedidos: null },
      });
      expect(push).toHaveBeenCalledWith('/hub/dashboard/campanhas');
    });

    it('voltar para nota zera critérios e categorias (não vaza dado do extrato)', async () => {
      mockOpcoes.mockResolvedValue(OPCOES_OK);
      render(<CampanhaFormulario campanhaId={null} inicial={EXTRATO} />);
      await screen.findByText(/212 motoristas rodaram/);
      fireEvent.click(screen.getByRole('radio', { name: /Nota ponderada/ }));
      expect(screen.queryByText(/Valor do turno/)).not.toBeInTheDocument();
      expect(screen.getByText('Soma dos pesos: 0%')).toBeInTheDocument();
    });
  });
});

// adiantamento-motorista (FASE 7, tasks.md 7.4, H03-H05): formulário de
// configuração — carregamento, histórico, permissão de edição e o
// tratamento do conflito 409 VERSAO_DESATUALIZADA (FR-023/7.4.3: o
// formulário NUNCA perde o que foi digitado).
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ConfiguracoesAdiantamentoPage from './page';
import { AdiantamentosApiError } from '@/lib/hub/adiantamentos-api';

const mockObterConfiguracoes = vi.fn();
const mockSalvarConfiguracao = vi.fn();
const mockListarCategoriasProducao = vi.fn();
const mockUseHubAuth = vi.fn();

vi.mock('@/contexts/hub-auth-context', () => ({
  useHubAuth: () => mockUseHubAuth(),
}));

vi.mock('@/lib/hub/adiantamentos-api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/hub/adiantamentos-api')>('@/lib/hub/adiantamentos-api');
  return {
    ...actual,
    obterConfiguracoes: (...args: unknown[]) => mockObterConfiguracoes(...args),
    salvarConfiguracao: (...args: unknown[]) => mockSalvarConfiguracao(...args),
    listarCategoriasProducao: (...args: unknown[]) => mockListarCategoriasProducao(...args),
  };
});

const VIGENTE_BASE = {
  versao: 3, vigenteDesde: '2026-08-01', timezone: 'America/Sao_Paulo', diasHabilitados: [1, 2, 3, 4, 5],
  horarioAbertura: '06:00', horarioCorte: '11:00', percentual: 80, taxaFixa: '5.00',
  fonteProducao: 'importacao', categoriasProducao: ['corrida'], previsaoPagamentoTexto: 'D+1',
  descricaoPixModelo: 'Antecipação {nome}', apuracaoDiaInicio: 1, apuracaoDiasAteRepasse: 7, apuracaoDataBase: null,
  categoriasExtrato: null, descontoAdiantamentos: true, descontoDebitos: false, repasseVisivelApp: false,
  completa: true,
};

const RESPOSTA_BASE = {
  vigente: VIGENTE_BASE,
  historico: [{ versao: 3, vigenteDesde: '2026-08-01', criadoPor: { id: 1, nome: 'Financeiro' }, criadoEm: '2026-08-01', motivo: null }],
};

describe('ConfiguracoesAdiantamentoPage', () => {
  beforeEach(() => {
    mockObterConfiguracoes.mockReset();
    mockSalvarConfiguracao.mockReset();
    mockListarCategoriasProducao.mockReset();
    mockListarCategoriasProducao.mockResolvedValue({ itens: [] });
    mockUseHubAuth.mockReturnValue({ permissoes: ['adiantamentos.consultar', 'adiantamentos.configurar'] });
  });

  it('carrega e mostra a versão vigente e o histórico (7.4.2)', async () => {
    mockObterConfiguracoes.mockResolvedValueOnce(RESPOSTA_BASE);
    render(<ConfiguracoesAdiantamentoPage />);

    await waitFor(() => expect(screen.getByText(/Versão 3/)).toBeInTheDocument());
    expect(screen.getByText('v3')).toBeInTheDocument();
    expect(screen.getByText('Financeiro')).toBeInTheDocument();
  });

  it('sem configuração vigente ainda mostra o aviso de "A definir" (Q-B2/FR-025)', async () => {
    mockObterConfiguracoes.mockResolvedValueOnce({ vigente: null, historico: [] });
    render(<ConfiguracoesAdiantamentoPage />);
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Ainda não há configuração vigente'));
  });

  // 7.8.3: valores padrão dos interruptores conferem com o protótipo H14
  // (descontar adiantamentos ligado, débitos desligado, mostrar no app
  // desligado) — sem configuração vigente ainda (`vigente: null`).
  it('7.8.3: sem configuração vigente, os interruptores nascem no padrão do protótipo', async () => {
    mockObterConfiguracoes.mockResolvedValueOnce({ vigente: null, historico: [] });
    render(<ConfiguracoesAdiantamentoPage />);

    await waitFor(() => expect(screen.getByLabelText('Adiantamentos pagos (valor bruto)')).toBeChecked());
    expect(screen.getByLabelText('Débitos da EntreGô')).not.toBeChecked();
    expect(screen.getByLabelText('Mostrar a previsão do repasse no app do motorista')).not.toBeChecked();
  });

  it('sem a permissão "configurar" o formulário fica somente leitura (sem botão Salvar)', async () => {
    mockUseHubAuth.mockReturnValue({ permissoes: ['adiantamentos.consultar'] });
    mockObterConfiguracoes.mockResolvedValueOnce(RESPOSTA_BASE);
    render(<ConfiguracoesAdiantamentoPage />);
    await waitFor(() => expect(screen.getByText(/Versão 3/)).toBeInTheDocument());

    expect(screen.queryByRole('button', { name: /Salvar versão/ })).not.toBeInTheDocument();
    const fieldset = document.querySelector('fieldset');
    expect(fieldset).toBeDisabled();
  });

  it('7.4.3: salvar com versão desatualizada (409) mostra o aviso de conflito SEM perder o que foi digitado', async () => {
    mockObterConfiguracoes.mockResolvedValueOnce(RESPOSTA_BASE);
    mockSalvarConfiguracao.mockRejectedValueOnce(
      new AdiantamentosApiError(409, 'Os dados foram alterados por outra pessoa. Recarregue e tente novamente.', 'VERSAO_DESATUALIZADA')
    );
    render(<ConfiguracoesAdiantamentoPage />);
    await waitFor(() => expect(screen.getByText(/Versão 3/)).toBeInTheDocument());

    const previsao = screen.getByLabelText('Previsão de pagamento') as HTMLInputElement;
    fireEvent.change(previsao, { target: { value: 'depois das 18h' } });

    fireEvent.click(screen.getByRole('button', { name: /Salvar versão/ }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Os dados foram alterados por outra pessoa.'));
    // o texto digitado continua no campo — não foi resetado pelo conflito.
    expect(previsao.value).toBe('depois das 18h');
    expect(screen.getByRole('button', { name: 'Recarregar' })).toBeInTheDocument();
  });

  it('salvar com sucesso chama a API com os campos do form e atualiza a versão vigente', async () => {
    mockObterConfiguracoes.mockResolvedValueOnce(RESPOSTA_BASE);
    mockSalvarConfiguracao.mockResolvedValueOnce({ ...VIGENTE_BASE, versao: 4 });
    mockObterConfiguracoes.mockResolvedValueOnce({ ...RESPOSTA_BASE, vigente: { ...VIGENTE_BASE, versao: 4 } });
    render(<ConfiguracoesAdiantamentoPage />);
    await waitFor(() => expect(screen.getByText(/Versão 3/)).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Salvar versão/ }));

    await waitFor(() => expect(mockSalvarConfiguracao).toHaveBeenCalledWith(
      expect.objectContaining({ versaoEsperada: 3, horarioAbertura: '06:00', horarioCorte: '11:00' })
    ));
    await waitFor(() => expect(screen.getByText(/Versão 4/)).toBeInTheDocument());
  });

  it('0087: família vira um item só; marcá-la salva o TOKEN, e o valor já salvo fora da lista continua lá', async () => {
    mockListarCategoriasProducao.mockResolvedValue({
      itens: [
        { descricao: 'Promocao - Campanha w97', lancamentos: 38, semMotoristaIdentificado: false, familia: 'familia:promocao' },
        { descricao: 'Promocao - Campanha w96', lancamentos: 20, semMotoristaIdentificado: false, familia: 'familia:promocao' },
        { descricao: 'Promocao entregador', lancamentos: 16890, semMotoristaIdentificado: false, familia: null },
      ],
    });
    mockObterConfiguracoes.mockResolvedValue(RESPOSTA_BASE);
    mockSalvarConfiguracao.mockResolvedValueOnce({ ...VIGENTE_BASE, versao: 4 });
    render(<ConfiguracoesAdiantamentoPage />);

    const promo = await screen.findByRole('button', { name: /^Promoção/ });
    expect(promo).toHaveTextContent('2 campanhas');
    expect(screen.queryByRole('button', { name: /Campanha w97/ })).not.toBeInTheDocument();
    // 'corrida' está salva em VIGENTE_BASE mas não veio na lista: tem que aparecer para poder desmarcar.
    expect(screen.getByRole('button', { name: /^corrida/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText(/inclui também as campanhas que surgirem depois/)).toBeInTheDocument();

    fireEvent.click(promo);
    fireEvent.click(screen.getByRole('button', { name: /Salvar versão/ }));

    await waitFor(() => expect(mockSalvarConfiguracao).toHaveBeenCalledWith(
      expect.objectContaining({ categoriasProducao: ['corrida', 'familia:promocao'] })
    ));
  });

  it('0087: busca sem acento + "Marcar visíveis" marca só o que a busca achou', async () => {
    mockListarCategoriasProducao.mockResolvedValue({
      itens: [
        { descricao: 'Promocao - Campanha w97', lancamentos: 38, semMotoristaIdentificado: false, familia: 'familia:promocao' },
        { descricao: 'Gorjeta', lancamentos: 4312, semMotoristaIdentificado: false, familia: null },
      ],
    });
    mockObterConfiguracoes.mockResolvedValue({ ...RESPOSTA_BASE, vigente: { ...VIGENTE_BASE, categoriasProducao: [] } });
    render(<ConfiguracoesAdiantamentoPage />);
    await screen.findByRole('button', { name: /^Gorjeta/ });

    fireEvent.change(screen.getByRole('searchbox', { name: 'Buscar categoria' }), { target: { value: 'promocao' } });
    expect(screen.queryByRole('button', { name: /^Gorjeta/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Marcar visíveis' }));

    expect(screen.getByRole('button', { name: /^Promoção/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('1 de 2 selecionadas')).toBeInTheDocument();
  });

  it('repasse por dia da semana: carrega 3 dias como quarta e mostra a frase de confirmação', async () => {
    mockObterConfiguracoes.mockResolvedValueOnce({ ...RESPOSTA_BASE, vigente: { ...VIGENTE_BASE, apuracaoDiaInicio: 1, apuracaoDiasAteRepasse: 3 } });
    render(<ConfiguracoesAdiantamentoPage />);
    const sel = await screen.findByLabelText('Dia do repasse');
    expect(sel).toHaveValue('3');
    expect(screen.getByText('Janela de segunda a domingo · repasse na quarta, 3 dias após o fim.')).toBeInTheDocument();
  });

  it('repasse por dia da semana: escolher quarta salva 3; mudar o início depois MANTÉM a quarta', async () => {
    mockObterConfiguracoes.mockResolvedValueOnce({ ...RESPOSTA_BASE, vigente: { ...VIGENTE_BASE, apuracaoDiaInicio: 1, apuracaoDiasAteRepasse: 7 } });
    // Depois de salvar a página recarrega do servidor: o mock devolve o que foi salvo.
    const salva = { ...VIGENTE_BASE, versao: 4, apuracaoDiaInicio: 1, apuracaoDiasAteRepasse: 3 };
    mockSalvarConfiguracao.mockResolvedValue(salva);
    mockObterConfiguracoes.mockResolvedValue({ ...RESPOSTA_BASE, vigente: salva });
    render(<ConfiguracoesAdiantamentoPage />);
    fireEvent.change(await screen.findByLabelText('Dia do repasse'), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: /Salvar versão/ }));
    await waitFor(() => expect(mockSalvarConfiguracao).toHaveBeenLastCalledWith(
      expect.objectContaining({ apuracaoDiaInicio: 1, apuracaoDiasAteRepasse: 3 })
    ));

    // Janela passa a começar na TERÇA (termina na segunda): a quarta vira 2 dias.
    fireEvent.change(screen.getByLabelText(/Início da janela/), { target: { value: '2' } });
    expect(screen.getByLabelText('Dia do repasse')).toHaveValue('3');
    fireEvent.click(screen.getByRole('button', { name: /Salvar versão/ }));
    await waitFor(() => expect(mockSalvarConfiguracao).toHaveBeenLastCalledWith(
      expect.objectContaining({ apuracaoDiaInicio: 2, apuracaoDiasAteRepasse: 2 })
    ));
  });

  it('repasse por dia da semana: prazo salvo fora do padrão semanal (10 dias) NÃO é reescrito sem escolha', async () => {
    mockObterConfiguracoes.mockResolvedValueOnce({ ...RESPOSTA_BASE, vigente: { ...VIGENTE_BASE, apuracaoDiaInicio: 1, apuracaoDiasAteRepasse: 10 } });
    mockSalvarConfiguracao.mockResolvedValueOnce({ ...VIGENTE_BASE, versao: 4 });
    mockObterConfiguracoes.mockResolvedValueOnce({ ...RESPOSTA_BASE, vigente: { ...VIGENTE_BASE, versao: 4 } });
    render(<ConfiguracoesAdiantamentoPage />);
    expect(await screen.findByLabelText('Dia do repasse')).toHaveValue('');
    expect(screen.getByText(/Configuração atual: 10 dias após o fim/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Salvar versão/ }));
    await waitFor(() => expect(mockSalvarConfiguracao).toHaveBeenCalled());
    expect(mockSalvarConfiguracao.mock.calls[0][0].apuracaoDiasAteRepasse).toBeUndefined();
  });

  it('repasse por dia da semana: dia escolhido sem início da janela bloqueia o salvar', async () => {
    mockObterConfiguracoes.mockResolvedValueOnce({ ...RESPOSTA_BASE, vigente: { ...VIGENTE_BASE, apuracaoDiaInicio: null, apuracaoDiasAteRepasse: null } });
    render(<ConfiguracoesAdiantamentoPage />);
    fireEvent.change(await screen.findByLabelText('Dia do repasse'), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: /Salvar versão/ }));
    expect(await screen.findByText('Defina o início da janela para calcular o dia do repasse.')).toBeInTheDocument();
    expect(mockSalvarConfiguracao).not.toHaveBeenCalled();
  });

  it('validação client-side (descrição Pix sem "{nome}") bloqueia o salvar sem chamar a API', async () => {
    mockObterConfiguracoes.mockResolvedValueOnce(RESPOSTA_BASE);
    render(<ConfiguracoesAdiantamentoPage />);
    await waitFor(() => expect(screen.getByText(/Versão 3/)).toBeInTheDocument());

    const pix = screen.getByLabelText('Modelo da Descrição Pix');
    fireEvent.change(pix, { target: { value: 'Antecipação sem marcador' } });
    fireEvent.click(screen.getByRole('button', { name: /Salvar versão/ }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('{nome}'));
    expect(mockSalvarConfiguracao).not.toHaveBeenCalled();
  });
});

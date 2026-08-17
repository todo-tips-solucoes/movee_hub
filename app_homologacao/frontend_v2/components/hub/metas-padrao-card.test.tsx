// impeccable r24 — o card vive dentro de "Meu perfil", que é uma superfície
// central: os testes aqui guardam (1) que ele NUNCA derruba o modal e (2) que
// ele não deixa ninguém achar que mexe só na própria conta.
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MetasPadraoCard } from './metas-padrao-card';

const listarMetas = vi.fn();
vi.mock('@/lib/hub/performance-metas-api', async (orig) => ({
  ...(await orig<typeof import('@/lib/hub/performance-metas-api')>()),
  listarMetas: (...a: unknown[]) => listarMetas(...a),
}));

let permissoes: string[] | undefined = [];
vi.mock('@/contexts/hub-auth-context', () => ({
  useHubAuth: () => ({ permissoes }),
}));

beforeEach(() => {
  listarMetas.mockReset();
  listarMetas.mockResolvedValue([]);
  permissoes = ['performance.metas_gerenciar'];
});

describe('MetasPadraoCard', () => {
  it('sem a permissão, o card some (e não vira leitura inútil)', () => {
    permissoes = ['performance.consultar'];
    const { container } = render(<MetasPadraoCard />);
    expect(container).toBeEmptyDOMElement();
  });

  // Regressão: um contexto sem `permissoes` derrubava o modal "Meu perfil"
  // inteiro com "Cannot read properties of undefined".
  it('contexto sem permissoes não quebra — some, não explode', () => {
    permissoes = undefined;
    expect(() => render(<MetasPadraoCard />)).not.toThrow();
  });

  it('diz que o escopo é a ENTIDADE, não a conta pessoal', async () => {
    render(<MetasPadraoCard />);
    expect(await screen.findByText(/toda a entidade/)).toBeInTheDocument();
  });

  it('pré-preenche os patamares informados pelo operador, sem gravá-los', async () => {
    render(<MetasPadraoCard />);
    await waitFor(() => expect(listarMetas).toHaveBeenCalled());
    expect(await screen.findByLabelText(/Tempo disponível/)).toHaveValue('90');
    expect(screen.getByLabelText(/Taxa de aceitação/)).toHaveValue('90');
    expect(screen.getByLabelText(/Taxa de conclusão/)).toHaveValue('95');
    // Sugestão não é contrato: enquanto ninguém salva, nada é avaliado.
    expect(screen.getByText(/nenhum turno é avaliado até você salvar/)).toBeInTheDocument();
  });
});

// Lista de campanhas — coluna "App" (visibilidade no app do motorista).

import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import CampanhasPage from './page';
import { parseCampanhaItem } from '@/lib/hub/campanhas-dto';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/contexts/hub-auth-context', () => ({ useHubAuth: () => ({ permissoes: ['campanhas.gerir'] }) }));

const BASE = {
  situacao: 'em_andamento', dataInicio: '2099-11-16', dataFim: '2099-11-30', pracas: null, turnos: null, modais: null,
  minTurnos: 5, tipo: 'nota', premiosPendentes: 0, dadosAte: null,
  pesos: { aceitacao: 100, conclusao: 0, tempo: 0, pedidos: 0 },
  contagem: { classificado: 0, abaixoCorte: 0, semMinimo: 0, semModal: 0, turnos: 0, turnosValidos: 0, valorCentavos: 0 },
};
const mockListar = vi.fn();
vi.mock('@/lib/hub/campanhas-api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/hub/campanhas-api')>('@/lib/hub/campanhas-api');
  return { ...actual, listarCampanhas: (...a: unknown[]) => mockListar(...a) };
});

describe('lista de campanhas — coluna App', () => {
  it('mostra Visível/Oculta no app por campanha', async () => {
    mockListar.mockResolvedValue([
      parseCampanhaItem({ ...BASE, id: 1, nome: 'A', visivelApp: true }),
      parseCampanhaItem({ ...BASE, id: 2, nome: 'B', visivelApp: false }),
    ]);
    render(<CampanhasPage />);
    expect(await screen.findByRole('columnheader', { name: 'App' })).toBeInTheDocument();
    expect(screen.getByText('Visível no app')).toBeInTheDocument();
    expect(screen.getByText('Oculta no app')).toBeInTheDocument();
  });

  it('rascunho e cancelada mostram "—" em vez do selo', async () => {
    mockListar.mockResolvedValue([
      parseCampanhaItem({ ...BASE, id: 3, nome: 'R', situacao: 'rascunho', visivelApp: true }),
      parseCampanhaItem({ ...BASE, id: 4, nome: 'C', situacao: 'cancelada', visivelApp: true }),
    ]);
    render(<CampanhasPage />);
    await screen.findByRole('columnheader', { name: 'App' });
    expect(screen.queryByText('Visível no app')).not.toBeInTheDocument();
    expect(screen.queryByText('Oculta no app')).not.toBeInTheDocument();
    expect(screen.getAllByLabelText('não se aplica')).toHaveLength(2);
  });
});

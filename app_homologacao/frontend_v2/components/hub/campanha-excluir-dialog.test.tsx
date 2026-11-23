// campanhas do motorista — excluir rascunho exige confirmação e chama DELETE.

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CampanhaExcluirRascunho } from './campanha-excluir-dialog';
import { CampanhaApiError } from '@/lib/hub/campanhas-api';

const h = vi.hoisted(() => ({ chamadas: [] as number[], falha: null as Error | null }));
// função simples (não vi.fn): o spy de vitest marca a promessa rejeitada como não tratada
vi.mock('@/lib/hub/campanhas-api', async (orig) => ({
  ...(await orig<typeof import('@/lib/hub/campanhas-api')>()),
  excluirCampanha: async (id: number) => {
    h.chamadas.push(id);
    if (h.falha) throw h.falha;
  },
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn() } }));

const abrirGatilho = () => fireEvent.click(screen.getByRole('button', { name: /Excluir rascunho/ }));

describe('CampanhaExcluirRascunho', () => {
  beforeEach(() => {
    h.chamadas.length = 0;
    h.falha = null;
  });

  it('clicar no gatilho só abre a confirmação: nada é excluído', () => {
    render(<CampanhaExcluirRascunho id={7} nome="TESTE" onExcluida={() => {}} />);
    abrirGatilho();
    expect(screen.getByText(/não pode ser desfeita/)).toBeInTheDocument();
    expect(h.chamadas).toEqual([]);
  });

  it('confirmar chama DELETE com o id e avisa o chamador', async () => {
    const onExcluida = vi.fn();
    render(<CampanhaExcluirRascunho id={7} nome="TESTE" onExcluida={onExcluida} />);
    abrirGatilho();
    fireEvent.click(screen.getByRole('button', { name: 'Excluir definitivamente' }));
    await waitFor(() => expect(onExcluida).toHaveBeenCalled());
    expect(h.chamadas).toEqual([7]);
  });

  it('erro da API aparece e não avisa o chamador', async () => {
    h.falha = new CampanhaApiError(409, 'Campanha já lançada', 'CAMPANHA_IMUTAVEL');
    const onExcluida = vi.fn();
    render(<CampanhaExcluirRascunho id={7} nome="TESTE" onExcluida={onExcluida} />);
    abrirGatilho();
    fireEvent.click(screen.getByRole('button', { name: 'Excluir definitivamente' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Campanha já lançada');
    expect(onExcluida).not.toHaveBeenCalled();
  });
});

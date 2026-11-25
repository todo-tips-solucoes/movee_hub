// campanhas do motorista (W3a) — diálogo de lançamento: o botão só habilita
// com a caixa "Revisei tudo…" marcada; envia o `avisar` escolhido; erro do
// servidor aparece e destrava; clique duplo = 1 chamada.

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CampanhaLancarDialog } from './campanha-lancar-dialog';
import { CampanhaApiError } from '@/lib/hub/campanhas-api';
import { premioVazio, type FormularioCampanha } from '@/lib/hub/campanhas-form';

const FORM: FormularioCampanha = {
  tipo: 'nota',
  categorias: [],
  minTurnosBase: 'trabalhados',
  nome: 'Rei do Jantar — Novembro',
  descricao: 'Regras',
  dataInicio: '2026-11-10',
  dataFim: '2026-11-30',
  pracas: ['SAO PAULO'],
  turnos: ['JANTAR 18H-22H', 'JANTAR 18H00-21H59'],
  modais: ['MOTO'],
  minTurnos: 5,
  pesos: { aceitacao: 30, conclusao: 30, tempo: 20, pedidos: 20 },
  cortes: { aceitacao: 0.8, conclusao: 0.9, tempo: null, pedidos: null },
  premios: [{ ...premioVazio(1), descricao: 'Moto Honda CG 160' }],
  avisar: true,
  visivelApp: false,
};
const ALCANCE = { rodaram: 212, semModal: 12 };

function abrir(onLancar = vi.fn().mockResolvedValue(undefined), form = FORM) {
  render(<CampanhaLancarDialog open onOpenChange={() => {}} form={form} alcance={ALCANCE} onLancar={onLancar} />);
  return onLancar;
}
const botaoLancar = () => screen.getByRole('button', { name: 'Lançar campanha' });
const caixaConfirmo = () => screen.getByRole('checkbox', { name: /Revisei tudo/ });

describe('CampanhaLancarDialog', () => {
  it('mostra resumo completo e o aviso de imutabilidade', () => {
    abrir();
    expect(screen.getByText(/Lançar “Rei do Jantar — Novembro”\?/)).toBeInTheDocument();
    expect(screen.getByText(/não pode ser alterada/)).toBeInTheDocument();
    expect(screen.getByText(/10\/11 a 30\/11\/2026 \(21 dias\)/)).toBeInTheDocument();
    expect(screen.getByText('SAO PAULO')).toBeInTheDocument();
    expect(screen.getByText(/JANTAR 18H-22H, JANTAR 18H00-21H59/)).toBeInTheDocument();
    expect(screen.getByText(/12 sem modal no cadastro ficam de fora/)).toBeInTheDocument();
    expect(screen.getByText(/Taxa de aceitação 30% \(corte 80%\)/)).toBeInTheDocument();
    expect(screen.getByText(/1º lugar Moto Honda CG 160/)).toBeInTheDocument();
    expect(screen.getByText(/212 motoristas rodaram/)).toBeInTheDocument();
  });

  it('"Lançar campanha" fica desabilitado até marcar "Revisei tudo…"', () => {
    const onLancar = abrir();
    expect(botaoLancar()).toBeDisabled();
    fireEvent.click(botaoLancar());
    expect(onLancar).not.toHaveBeenCalled();
    fireEvent.click(caixaConfirmo());
    expect(botaoLancar()).toBeEnabled();
    fireEvent.click(caixaConfirmo());
    expect(botaoLancar()).toBeDisabled();
  });

  it('a caixa de avisar NÃO habilita o botão (só a confirmação)', () => {
    abrir();
    fireEvent.click(screen.getByRole('checkbox', { name: /Avisar os motoristas/ }));
    expect(botaoLancar()).toBeDisabled();
  });

  it('lança com o avisar marcado (padrão do formulário) e com o desmarcado', async () => {
    const onLancar = abrir();
    fireEvent.click(caixaConfirmo());
    fireEvent.click(botaoLancar());
    await waitFor(() => expect(onLancar).toHaveBeenCalledWith(true));
  });

  it('avisar desmarcado é repassado como false', async () => {
    const onLancar = abrir();
    fireEvent.click(screen.getByRole('checkbox', { name: /Avisar os motoristas/ }));
    fireEvent.click(caixaConfirmo());
    fireEvent.click(botaoLancar());
    await waitFor(() => expect(onLancar).toHaveBeenCalledWith(false));
  });

  it('clique duplo gera uma única chamada', async () => {
    let resolver: () => void = () => {};
    const onLancar = vi.fn(() => new Promise<void>((r) => { resolver = r; }));
    abrir(onLancar);
    fireEvent.click(caixaConfirmo());
    fireEvent.click(botaoLancar());
    fireEvent.click(botaoLancar());
    expect(onLancar).toHaveBeenCalledTimes(1);
    resolver();
  });

  it('erro do servidor aparece com a mensagem acionável e o botão volta a poder tentar', async () => {
    const onLancar = vi.fn().mockRejectedValue(new CampanhaApiError(422, 'Menos de 95% dos turnos…', 'PEDIDOS_SEM_COBERTURA'));
    abrir(onLancar);
    fireEvent.click(caixaConfirmo());
    fireEvent.click(botaoLancar());
    expect(await screen.findByRole('alert')).toHaveTextContent('Menos de 95% dos turnos');
    expect(botaoLancar()).toBeEnabled();
    fireEvent.click(botaoLancar());
    await waitFor(() => expect(onLancar).toHaveBeenCalledTimes(2));
  });

  it('praça/turno/modal null aparecem como "Todas/Todos"', () => {
    abrir(undefined, { ...FORM, pracas: null, turnos: null, modais: null });
    expect(screen.getByText('Todas as praças')).toBeInTheDocument();
    expect(screen.getByText(/Todos os turnos/)).toBeInTheDocument();
    expect(screen.getByText(/Todos os modais/)).toBeInTheDocument();
  });
});

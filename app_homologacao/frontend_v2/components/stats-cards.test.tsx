// impeccable rodada 8 (P2) — os cards de status viraram atalho de filtro.
//
// O que estes casos protegem não é o clique: é a HONESTIDADE do número. Um card
// só pode filtrar se o filtro que ele aplica reproduz exatamente a contagem que
// ele exibe. `computeStats` conta XML como
// `numnota && nota_ok && data_emissao && (!)erro_validacao`, enquanto os
// filtros `enviouNota`/`validacao` olham um campo só — ligar esses dois faria
// "XMLs Enviados: 40" abrir uma tabela com 55 linhas, que é o mesmo defeito de
// affordance mentirosa que as rodadas 6 e 7 vieram corrigir.
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { StatsCards } from './stats-cards';
import type { StatsData } from '@/types';

const STATS: StatsData = {
  total: 340,
  msgEnviada: 320,
  msgErro: 12,
  xmlEnviado: 40,
  xmlErro: 3,
};

describe('StatsCards — atalho de filtro', () => {
  it('sem onFiltrar, nenhum card é interativo (painel legado segue igual)', () => {
    render(<StatsCards stats={STATS} />);
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('mensagens com erro filtra pelo mesmo critério que contou', () => {
    const onFiltrar = vi.fn();
    render(<StatsCards stats={STATS} onFiltrar={onFiltrar} />);

    fireEvent.click(screen.getByRole('button', { name: /Mensagens com Erro/ }));
    expect(onFiltrar).toHaveBeenCalledTimes(1);
    // `sucesso: 'yes'` é `enviado === 'erro'` em applyFilters — exatamente o que
    // `computeStats` chama de msgErro.
    expect(onFiltrar.mock.calls[0][0]).toMatchObject({ sucesso: 'yes' });
  });

  it('mensagens enviadas idem', () => {
    const onFiltrar = vi.fn();
    render(<StatsCards stats={STATS} onFiltrar={onFiltrar} />);
    fireEvent.click(screen.getByRole('button', { name: /Mensagens Enviadas/ }));
    expect(onFiltrar.mock.calls[0][0]).toMatchObject({ enviado: 'yes' });
  });

  it('o card de total limpa os filtros em vez de somar mais um', () => {
    const onFiltrar = vi.fn();
    render(<StatsCards stats={STATS} onFiltrar={onFiltrar} />);
    fireEvent.click(screen.getByRole('button', { name: /Total de Registros/ }));
    expect(onFiltrar.mock.calls[0][0]).toMatchObject({
      enviado: 'all',
      sucesso: 'all',
      validacao: 'all',
      enviouNota: 'all',
    });
  });

  it('os cards de XML NÃO são clicáveis — o filtro não reproduz a contagem', () => {
    const onFiltrar = vi.fn();
    render(<StatsCards stats={STATS} onFiltrar={onFiltrar} />);
    expect(screen.queryByRole('button', { name: /XMLs Enviados/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /XMLs com Erro/ })).not.toBeInTheDocument();
    // Continuam visíveis como informação.
    expect(screen.getByText('XMLs Enviados')).toBeInTheDocument();
  });
});

// Central de Ajuda: a tela renderiza TUDO que o JSON tem (nenhum bloco some) e
// a busca/índice funcionam sobre o DOM.
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { conteudo } from '@/lib/hub/ajuda';
import AjudaPage from './page';

const blocos = conteudo.secoes.flatMap((s) => s.blocos);
const conta = (tipo: string) => blocos.filter((b) => b.bloco === tipo).length;

describe('AjudaPage', () => {
  it('um h1, um h2 por seção, e todos os blocos do JSON aparecem', () => {
    const { container } = render(<AjudaPage />);
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getAllByRole('heading', { level: 2 })).toHaveLength(27);
    expect(screen.getAllByRole('heading', { level: 3 })).toHaveLength(conta('subtitulo'));
    expect(container.querySelectorAll('table')).toHaveLength(conta('tabela'));
    // avisos: cada um carrega o rótulo textual do tipo, não só cor
    const avisos = blocos.filter((b) => b.bloco === 'aviso');
    expect(avisos.length).toBeGreaterThan(0);
    for (const rotulo of ['Importante', 'Atenção', 'Dica']) {
      const esperado = avisos.filter((a) => a.bloco === 'aviso' && ({ importante: 'Importante', atencao: 'Atenção', dica: 'Dica' })[a.tipo] === rotulo).length;
      expect(screen.queryAllByText(rotulo, { selector: 'span' })).toHaveLength(esperado);
    }
    // trilha: 6 passos numerados
    const trilha = blocos.find((b) => b.bloco === 'trilha');
    expect(trilha && trilha.bloco === 'trilha' && trilha.passos).toHaveLength(6);
    for (const p of trilha && trilha.bloco === 'trilha' ? trilha.passos : []) {
      expect(screen.getAllByText(p.titulo).length).toBeGreaterThan(0);
    }
  });

  it('tabelas têm cabeçalho real', () => {
    const { container } = render(<AjudaPage />);
    for (const t of container.querySelectorAll('table')) {
      expect(t.querySelectorAll('thead th').length).toBeGreaterThan(0);
    }
  });

  it('o índice (desktop e mobile) linka cada seção por âncora', () => {
    const { container } = render(<AjudaPage />);
    const navs = screen.getAllByRole('navigation', { hidden: true, name: /Índice/ });
    expect(navs).toHaveLength(2);
    for (const nav of navs) expect(within(nav).getAllByRole('link', { hidden: true })).toHaveLength(27);
    for (const s of conteudo.secoes) expect(container.querySelector(`section#${s.id}`)).not.toBeNull();
  });

  it('a busca filtra seções e índice; sem resultado, avisa; limpar volta tudo', () => {
    render(<AjudaPage />);
    const campo = screen.getByLabelText('Buscar no manual');
    fireEvent.change(campo, { target: { value: 'antecipacao' } });
    expect(screen.getAllByRole('heading', { level: 2 })).toHaveLength(2);
    expect(screen.getByRole('status')).toHaveTextContent('2 de 27 seções');
    fireEvent.change(campo, { target: { value: 'zzzinexistentezzz' } });
    expect(screen.queryAllByRole('heading', { level: 2 })).toHaveLength(0);
    expect(screen.getByText(/Nenhuma seção encontrada/)).toBeInTheDocument();
    fireEvent.change(campo, { target: { value: '' } });
    expect(screen.getAllByRole('heading', { level: 2 })).toHaveLength(27);
  });

  it('não injeta HTML: marcação do texto vira elemento só para negrito/código/link', () => {
    const { container } = render(<AjudaPage />);
    expect(container.querySelectorAll('script, style')).toHaveLength(0);
    expect(container.textContent).not.toMatch(/\*\*|\]\(#/);
  });
});

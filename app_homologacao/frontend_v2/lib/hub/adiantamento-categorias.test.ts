import { describe, expect, it } from 'vitest';
import { filtrarItensCategoria, montarItensCategoria } from './adiantamento-categorias';
import type { CategoriaProducao } from './adiantamentos-api';

const cat = (descricao: string, lancamentos: number, familia: string | null = null): CategoriaProducao => ({
  descricao, lancamentos, semMotoristaIdentificado: false, familia,
});

// Recorte real de produção (2026-09-21), só nomes de categoria.
const DISPONIVEIS = [
  cat('Corridas concluidas', 39199),
  cat('Promocao entregador', 16890),
  cat('Promocao - Destravou_Ganhou Elite w97 Franquias', 38, 'familia:promocao'),
  cat('Promocao - Dias Produtivos Franquias', 175, 'familia:promocao'),
  cat('MISSOES FRANQUIA ELITE', 263, 'familia:missoes'),
  cat('Gorjeta', 4312),
];

describe('montarItensCategoria', () => {
  it('dobra os membros de uma família num item só, com o token como chave e a soma dos lançamentos', () => {
    const itens = montarItensCategoria(DISPONIVEIS, []);
    const promo = itens.find((i) => i.chave === 'familia:promocao');
    expect(promo).toMatchObject({ rotulo: 'Promoção', lancamentos: 213, membros: 2, familia: true });
    expect(itens.filter((i) => i.rotulo.startsWith('Promocao -'))).toHaveLength(0);
  });

  it('"Promocao entregador" continua avulsa (não tem família)', () => {
    const itens = montarItensCategoria(DISPONIVEIS, []);
    expect(itens.find((i) => i.chave === 'Promocao entregador')).toMatchObject({ familia: false, membros: 1 });
  });

  it('ordena pelo volume de lançamentos, maior primeiro', () => {
    const itens = montarItensCategoria(DISPONIVEIS, []);
    expect(itens.map((i) => i.chave)).toEqual([
      'Corridas concluidas', 'Promocao entregador', 'Gorjeta', 'familia:missoes', 'familia:promocao',
    ]);
  });

  it('valor salvo que não está na lista continua visível (senão ficaria marcado sem poder desmarcar)', () => {
    const itens = montarItensCategoria(DISPONIVEIS, ['Categoria que sumiu']);
    expect(itens.at(-1)).toMatchObject({ chave: 'Categoria que sumiu', ausente: 'sem_lancamentos', lancamentos: 0 });
  });

  it('nome salvo antes das famílias, COM a família marcada: aparece como já coberto por ela', () => {
    const itens = montarItensCategoria(DISPONIVEIS, ['Promocao - Dias Produtivos Franquias', 'familia:promocao']);
    const avulso = itens.find((i) => i.chave === 'Promocao - Dias Produtivos Franquias');
    expect(avulso).toMatchObject({ ausente: 'dentro_de_familia', rotuloFamilia: 'Promoção' });
  });

  it('nome salvo antes das famílias, SEM a família marcada: NÃO pode dizer "já incluída" — é ele que mantém a categoria no cálculo', () => {
    // Achado da revisão do PR: o aviso "já incluída em Promoção" com a família
    // desmarcada levava o operador a desmarcar o nome, e a categoria saía do
    // cálculo em silêncio — exatamente a falha que a 0087 existe para evitar.
    const itens = montarItensCategoria(DISPONIVEIS, ['Promocao - Dias Produtivos Franquias']);
    const avulso = itens.find((i) => i.chave === 'Promocao - Dias Produtivos Franquias');
    expect(avulso).toMatchObject({ ausente: 'fora_da_familia', rotuloFamilia: 'Promoção', lancamentos: 175 });
  });

  it('token de família desconhecido cai no próprio token como rótulo, sem quebrar', () => {
    const itens = montarItensCategoria([cat('Nova X - 1', 3, 'familia:nova')], []);
    expect(itens[0]).toMatchObject({ chave: 'familia:nova', rotulo: 'familia:nova' });
  });
});

describe('filtrarItensCategoria', () => {
  const itens = montarItensCategoria(DISPONIVEIS, []);

  it('busca sem acento e sem caixa', () => {
    expect(filtrarItensCategoria(itens, 'promocao').map((i) => i.chave)).toEqual(['Promocao entregador', 'familia:promocao']);
    expect(filtrarItensCategoria(itens, 'MISSÕES').map((i) => i.chave)).toEqual(['familia:missoes']);
  });

  it('acha a família pelo nome de um membro', () => {
    expect(filtrarItensCategoria(itens, 'destravou').map((i) => i.chave)).toEqual(['familia:promocao']);
  });

  it('busca vazia devolve tudo', () => {
    expect(filtrarItensCategoria(itens, '  ')).toHaveLength(itens.length);
  });
});

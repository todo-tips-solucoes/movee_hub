import { describe, expect, it } from 'vitest';
import {
  CASOS_CASA_CATEGORIA, casaCategoria, dataLocalSP, descreverCategorias, filtrarItensCategoria, montarItensCategoria, restringirAoExtrato,
  trocarModo, validarTokensCategorias,
} from './adiantamento-categorias';
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

// F3: o que pode entrar na nota é sempre um subconjunto do extrato — a mesma
// regra do banco (`hub_adiantamento_categoria_casa`).
describe('restringirAoExtrato', () => {
  it('mantém o que está no extrato pelo nome exato e o que está pela família', () => {
    const r = restringirAoExtrato(DISPONIVEIS, ['Corridas concluidas', 'familia:promocao']);
    expect(r.map((c) => c.descricao)).toEqual([
      'Corridas concluidas',
      'Promocao - Destravou_Ganhou Elite w97 Franquias',
      'Promocao - Dias Produtivos Franquias',
    ]);
  });

  it('não oferece categoria fora do extrato — marcá-la não mudaria conta nenhuma', () => {
    const r = restringirAoExtrato(DISPONIVEIS, ['Corridas concluidas']);
    expect(r.map((c) => c.descricao)).toEqual(['Corridas concluidas']);
  });

  it('extrato vazio não oferece nada', () => {
    expect(restringirAoExtrato(DISPONIVEIS, [])).toEqual([]);
  });
});

describe('casaCategoria (espelho de hub_adiantamento_categoria_casa; mesma tabela do banco)', () => {
  it.each(CASOS_CASA_CATEGORIA)('$descricao / $familia / $lista -> $esperado', ({ descricao, familia, lista, esperado }) => {
    expect(casaCategoria(descricao, familia, lista)).toBe(esperado);
  });
});

describe('modo "todas"', () => {
  it('restringirAoExtrato: no modo todas a nota pode escolher tudo menos as exceções', () => {
    const r = restringirAoExtrato(DISPONIVEIS, ['modo:todas', 'Gorjeta']).map((c) => c.descricao);
    expect(r).toHaveLength(DISPONIVEIS.length - 1);
    expect(r).not.toContain('Gorjeta');
  });
  it('trocarModo para todas: Indicadores SEMPRE, mesmo com a lista vazia (carregando/falhou)', () => {
    expect(trocarModo('todas', [])).toEqual(['modo:todas', 'familia:indicador']);
  });
  it('trocarModo para todas: o que estava fora vira exceção (família, membro parcial, avulsa)', () => {
    const disp = [...DISPONIVEIS, cat('Percentual atingido de x', 1, 'familia:indicador')];
    // Promoção só por um membro; Missões fora; Corridas dentro; Promocao entregador e Gorjeta fora; Indicadores marcado
    const atual = ['Corridas concluidas', 'Promocao - Dias Produtivos Franquias', 'familia:indicador'];
    const r = trocarModo('todas', disp, atual);
    expect(r.slice(0, 2)).toEqual(['modo:todas', 'familia:indicador']);
    expect(r).toEqual(expect.arrayContaining(['familia:missoes', 'Promocao - Destravou_Ganhou Elite w97 Franquias', 'Promocao entregador', 'Gorjeta']));
    expect(r).not.toContain('Corridas concluidas');
    expect(r).not.toContain('familia:promocao');
    expect(r.filter((x) => x === 'familia:indicador')).toHaveLength(1);
    for (const c of disp.filter((c) => c.familia !== 'familia:indicador')) {
      expect(casaCategoria(c.descricao, c.familia, r)).toBe(casaCategoria(c.descricao, c.familia, atual));
    }
  });
  it('trocarModo ida e volta (marcadas → todas → marcadas) preserva o que entra, menos Indicadores', () => {
    const disp = [...DISPONIVEIS, cat('Percentual atingido de x', 1, 'familia:indicador')];
    for (const atual of [[], ['familia:promocao'], ['Corridas concluidas', 'Promocao - Dias Produtivos Franquias'], ['familia:missoes', 'Gorjeta', 'familia:indicador']]) {
      const volta = trocarModo('marcadas', disp, trocarModo('todas', disp, atual));
      for (const c of disp.filter((c) => c.familia !== 'familia:indicador')) {
        expect(casaCategoria(c.descricao, c.familia, volta)).toBe(casaCategoria(c.descricao, c.familia, atual));
      }
      expect(disp.filter((c) => c.familia === 'familia:indicador').some((c) => casaCategoria(c.descricao, c.familia, volta))).toBe(false);
    }
  });
  it('trocarModo para marcadas preserva o que entrava', () => {
    const disp = [...DISPONIVEIS, cat('Percentual atingido de x', 1, 'familia:indicador')];
    const r = trocarModo('marcadas', disp, ['modo:todas', 'familia:indicador', 'Gorjeta']);
    expect(r).toEqual(expect.arrayContaining(['familia:promocao', 'familia:missoes', 'Corridas concluidas', 'Promocao entregador']));
    expect(r).not.toContain('familia:indicador');
    expect(r).not.toContain('Gorjeta');
    // equivalência: o que casava antes casa depois
    for (const c of disp) expect(casaCategoria(c.descricao, c.familia, r)).toBe(casaCategoria(c.descricao, c.familia, ['modo:todas', 'familia:indicador', 'Gorjeta']));
  });
  it('trocarModo para marcadas: membro de família excetuado por nome sai e os demais entram por nome', () => {
    const atual = ['modo:todas', 'Promocao - Dias Produtivos Franquias'];
    const r = trocarModo('marcadas', DISPONIVEIS, atual);
    expect(r).not.toContain('familia:promocao');
    expect(r).toContain('Promocao - Destravou_Ganhou Elite w97 Franquias');
    for (const c of DISPONIVEIS) expect(casaCategoria(c.descricao, c.familia, r)).toBe(casaCategoria(c.descricao, c.familia, atual));
  });
  it('validarTokensCategorias recusa modo/família desconhecidos e modo duplicado', () => {
    expect(validarTokensCategorias(['modo:todas', 'familia:indicador', 'Gorjeta'])).toBeNull();
    expect(validarTokensCategorias(['modo:todas', 'modo:todas'])).toMatch(/duplicado/);
    expect(validarTokensCategorias(['modo:tudo'])).toMatch(/desconhecido/);
    expect(validarTokensCategorias(['familia:promoçao'])).toMatch(/desconhecida/);
  });
  it('descreverCategorias traduz tokens, nunca os mostra crus', () => {
    expect(descreverCategorias(['modo:todas', 'familia:indicador', 'Gorjeta'])).toBe('Todas, exceto: Indicadores, Gorjeta');
    expect(descreverCategorias(['modo:todas'])).toBe('Todas');
    expect(descreverCategorias(['familia:promocao', 'corrida'])).toBe('Promoção, corrida');
  });
});

describe('dataLocalSP', () => {
  it('data pura passa; ISO perto da meia-noite usa o dia de São Paulo', () => {
    expect(dataLocalSP('2026-11-23')).toBe('2026-11-23');
    expect(dataLocalSP('2026-11-24T01:00:00Z')).toBe('2026-11-23'); // 22h do dia 23 em SP
    expect(dataLocalSP('2026-11-23T22:00:00-03:00')).toBe('2026-11-23');
    expect(dataLocalSP('2026-11-24T03:00:00Z')).toBe('2026-11-24'); // 00h do dia 24 em SP
  });
});

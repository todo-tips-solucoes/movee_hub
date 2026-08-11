// impeccable rodada 14 (h3) — `temFiltroAtivo` decide se uma ação que
// SUBSTITUI os filtros precisa avisar. Errar para menos cala um aviso quando
// havia trabalho a perder; errar para mais enche a tela de aviso sobre nada.
import { describe, expect, it } from 'vitest';
import { initialFilters, ordenarDados, proximaOrdenacao, temFiltroAtivo } from './utils';
import type { EnvioMassa } from '@/types';

describe('temFiltroAtivo', () => {
  it('padrão intocado não conta como filtro ativo', () => {
    expect(temFiltroAtivo(initialFilters)).toBe(false);
  });

  it('campo de texto preenchido conta', () => {
    expect(temFiltroAtivo({ ...initialFilters, nome: 'silva' })).toBe(true);
  });

  it('select fora de "all" conta', () => {
    expect(temFiltroAtivo({ ...initialFilters, enviado: 'yes' })).toBe(true);
  });

  it('varre TODAS as chaves do padrão, não uma lista à parte', () => {
    // Um filtro novo em `initialFilters` precisa entrar na conta sozinho —
    // uma lista escrita à mão aqui envelheceria em silêncio.
    for (const chave of Object.keys(initialFilters) as (keyof typeof initialFilters)[]) {
      const alterado = { ...initialFilters, [chave]: 'valor-diferente' };
      expect(temFiltroAtivo(alterado), chave).toBe(true);
    }
  });
});

// impeccable rodada 15 (h7=2) — ordenação da tabela de envio em massa.
// A ordem é aplicada ao conjunto filtrado INTEIRO (a tela tem tudo no
// cliente); os casos abaixo travam as decisões que não são óbvias: nulo no
// fim, número comparado como número, texto com acento em pt-BR, e o terceiro
// clique devolvendo a ordem original.
describe('ordenarDados', () => {
  const linha = (over: Partial<EnvioMassa>): EnvioMassa =>
    ({
      id: 1,
      number: '001',
      nome: 'Ana',
      valor: 10,
      enviado: 'off',
      data_emissao: '2026-01-01',
      ...over,
    }) as EnvioMassa;

  it('sem ordenação, devolve o array como veio', () => {
    const dados = [linha({ id: 1 }), linha({ id: 2 })];
    expect(ordenarDados(dados, null)).toBe(dados);
  });

  it('não altera o array de origem (o filtrado é memoizado)', () => {
    const dados = [linha({ id: 1, valor: 30 }), linha({ id: 2, valor: 10 })];
    ordenarDados(dados, { coluna: 'valor', direcao: 'asc' });
    expect(dados.map((d) => d.id)).toEqual([1, 2]);
  });

  it('valor: compara como número, mesmo vindo string do backend legado', () => {
    const dados = [linha({ id: 1, valor: '9' }), linha({ id: 2, valor: '100' })];
    const asc = ordenarDados(dados, { coluna: 'valor', direcao: 'asc' });
    expect(asc.map((d) => d.id)).toEqual([1, 2]); // 9 < 100, não "100" < "9"
  });

  it('nome: respeita acento no alfabeto pt-BR', () => {
    const dados = [linha({ id: 1, nome: 'Zeca' }), linha({ id: 2, nome: 'Ângela' })];
    const asc = ordenarDados(dados, { coluna: 'nome', direcao: 'asc' });
    expect(asc.map((d) => d.id)).toEqual([2, 1]);
  });

  it('data de emissão: linha sem data vai para o FIM nos dois sentidos', () => {
    const dados = [
      linha({ id: 1, data_emissao: null }),
      linha({ id: 2, data_emissao: '2026-03-01' }),
      linha({ id: 3, data_emissao: '2026-01-01' }),
    ];
    expect(ordenarDados(dados, { coluna: 'data_emissao', direcao: 'asc' }).map((d) => d.id)).toEqual([3, 2, 1]);
    // Sem o tratamento explícito, o nulo apareceria no topo do decrescente e
    // pareceria "a data mais recente".
    expect(ordenarDados(dados, { coluna: 'data_emissao', direcao: 'desc' }).map((d) => d.id)).toEqual([2, 3, 1]);
  });
});

describe('proximaOrdenacao', () => {
  it('primeiro clique ordena crescente', () => {
    expect(proximaOrdenacao(null, 'valor')).toEqual({ coluna: 'valor', direcao: 'asc' });
  });

  it('segundo clique inverte', () => {
    expect(proximaOrdenacao({ coluna: 'valor', direcao: 'asc' }, 'valor')).toEqual({
      coluna: 'valor',
      direcao: 'desc',
    });
  });

  it('terceiro clique devolve a ordem original — é o caminho de volta', () => {
    expect(proximaOrdenacao({ coluna: 'valor', direcao: 'desc' }, 'valor')).toBeNull();
  });

  it('trocar de coluna recomeça em crescente', () => {
    expect(proximaOrdenacao({ coluna: 'valor', direcao: 'desc' }, 'nome')).toEqual({
      coluna: 'nome',
      direcao: 'asc',
    });
  });
});

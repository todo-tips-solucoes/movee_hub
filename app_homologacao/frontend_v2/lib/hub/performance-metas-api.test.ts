// impeccable r24 parte 2 — o que precisa de teste aqui é a FRONTEIRA DE
// UNIDADE entre o que a pessoa digita (porcentagem) e o que a API guarda
// (fração). Um erro por fator 100 nesta conversão não aparece na tela: a meta
// simplesmente aprova tudo ou reprova tudo.
import { describe, expect, it } from 'vitest';
import {
  chaveMeta,
  fracaoParaPercentual,
  leiturasDoRegistro,
  parseMeta,
  percentualParaFracao,
  validarPercentual,
} from './performance-metas-api';

describe('conversão percentual ↔ fração', () => {
  it('ida e volta preserva o valor em casos comuns', () => {
    for (const pct of [0, 50, 75, 85, 90, 99.5, 100]) {
      expect(fracaoParaPercentual(percentualParaFracao(pct))).toBe(pct);
    }
  });

  it('90 digitado vira 0.9, não 90', () => {
    expect(percentualParaFracao(90)).toBe(0.9);
  });

  it('0.8742 exibe como 87,4 e não como 0,87', () => {
    expect(fracaoParaPercentual(0.8742)).toBe(87.4);
  });
});

describe('validarPercentual', () => {
  it('aceita número simples e com vírgula', () => {
    expect(validarPercentual('90')).toBeNull();
    expect(validarPercentual('90,5')).toBeNull();
    expect(validarPercentual(' 100 ')).toBeNull();
  });

  it('recusa acima de 100 falando a língua de quem preenche', () => {
    expect(validarPercentual('150')).toMatch(/porcentagem/);
  });

  it('recusa vazio, texto e negativo', () => {
    expect(validarPercentual('')).toMatch(/Informe/);
    expect(validarPercentual('abc')).toMatch(/números/);
    expect(validarPercentual('-1')).toMatch(/negativa/);
  });
});

describe('chaveMeta', () => {
  it('caixa e espaços não criam cruzamentos distintos', () => {
    expect(chaveMeta(' SAO PAULO ', 'Almoco', 'aceitacao')).toBe(
      chaveMeta('sao paulo', 'ALMOCO', 'aceitacao')
    );
  });

  it('acento distingue, como no backend', () => {
    expect(chaveMeta('MOOCA', 'A', 'aceitacao')).not.toBe(chaveMeta('MOÓCA', 'A', 'aceitacao'));
  });
});

describe('leiturasDoRegistro', () => {
  it('tempo disponível vem em 0..100 e é convertido; as razões não', () => {
    const l = leiturasDoRegistro({
      corridasOfertadas: 30,
      corridasAceitas: 25,
      corridasCompletadas: 20,
      tempoDisponivelPct: '80.00',
    });
    expect(l.aceitacao).toBeCloseTo(25 / 30, 6);
    expect(l.conclusao).toBeCloseTo(20 / 25, 6);
    expect(l.tempo_disponivel).toBe(0.8);
  });

  it('sem denominador não há razão — null, nunca 0', () => {
    const l = leiturasDoRegistro({
      corridasOfertadas: 0,
      corridasAceitas: 0,
      corridasCompletadas: 0,
      tempoDisponivelPct: null,
    });
    expect(l.aceitacao).toBeNull();
    expect(l.conclusao).toBeNull();
    expect(l.tempo_disponivel).toBeNull();
  });
});

describe('parseMeta', () => {
  it('aceita valor como string decimal do PostgREST', () => {
    const m = parseMeta({
      id: 7,
      praca: 'SP',
      periodo: 'ALMOCO',
      indicador: 'tempo_disponivel',
      valor: '0.75',
      atualizadoEm: '2026-08-16T21:00:00Z',
    });
    expect(m.valor).toBe(0.75);
    expect(m.indicador).toBe('tempo_disponivel');
  });

  it('recusa indicador fora do enum em vez de propagar lixo para a tela', () => {
    expect(() => parseMeta({ id: 1, indicador: 'inventado', valor: '0.5' })).toThrow(TypeError);
  });
});

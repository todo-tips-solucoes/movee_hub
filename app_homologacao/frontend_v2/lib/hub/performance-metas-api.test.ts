// impeccable r24 parte 2 — o que precisa de teste aqui é a FRONTEIRA DE
// UNIDADE entre o que a pessoa digita (porcentagem) e o que a API guarda
// (fração). Um erro por fator 100 nesta conversão não aparece na tela: a meta
// simplesmente aprova tudo ou reprova tudo.
import { describe, expect, it } from 'vitest';
import {
  canonizarTexto,
  chaveMeta,
  fracaoParaPercentual,
  leiturasDoRegistro,
  parseMeta,
  percentualParaFracao,
  suspeitaDeUnidade,
  validarPercentual,
} from './performance-metas-api';

describe('conversão percentual ↔ fração', () => {
  // Antes esta suíte usava só valores de UMA casa decimal e assertava a
  // própria perda (`fracaoParaPercentual(0.8742) === 87.4`) como se fosse
  // correto — o teste passava por construção. A revisão adversarial mediu:
  // 9000 de 10001 percentuais de duas casas não sobreviviam à ida e volta.
  it('ida e volta preserva TODOS os percentuais de duas casas', () => {
    let perdidos = 0;
    for (let i = 0; i <= 10000; i++) {
      const pct = Math.round(i) / 100;
      if (fracaoParaPercentual(percentualParaFracao(pct)) !== pct) perdidos++;
    }
    expect(perdidos).toBe(0);
  });

  it('99,95% não vira 100% — o caso que transformava meta em perfeição obrigatória', () => {
    expect(percentualParaFracao(99.95)).toBe(0.9995);
    expect(fracaoParaPercentual(0.9995)).toBe(99.95);
  });

  it('90 digitado vira 0.9, não 90', () => {
    expect(percentualParaFracao(90)).toBe(0.9);
  });

  it('0.8742 exibe as duas casas: 87,42', () => {
    expect(fracaoParaPercentual(0.8742)).toBe(87.42);
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

describe('chaveMeta / canonizarTexto', () => {
  it('caixa e espaços não criam cruzamentos distintos', () => {
    expect(chaveMeta(' SAO PAULO ', 'Almoco', 'aceitacao')).toBe(
      chaveMeta('sao paulo', 'ALMOCO', 'aceitacao')
    );
  });

  it('espaço interno repetido também não', () => {
    expect(chaveMeta('SAO   PAULO', 'A', 'aceitacao')).toBe(chaveMeta('SAO PAULO', 'A', 'aceitacao'));
  });

  // O caso mudo: a mesma letra acentuada em NFD (planilha exportada no macOS)
  // e NFC é visualmente idêntica e diferente para `===`. Sem normalizar, a
  // meta era gravada, aparecia na lista e NUNCA marcava nada.
  it('NFC e NFD da mesma praça casam', () => {
    expect(chaveMeta('MOÓCA'.normalize('NFD'), 'A', 'aceitacao')).toBe(
      chaveMeta('MOÓCA'.normalize('NFC'), 'A', 'aceitacao')
    );
  });

  it('acento continua distinguindo praças de fato diferentes', () => {
    expect(chaveMeta('MOOCA', 'A', 'aceitacao')).not.toBe(chaveMeta('MOÓCA', 'A', 'aceitacao'));
  });

  it('a forma canônica é a MESMA que o backend grava (maiúscula)', () => {
    expect(canonizarTexto('  Sao   Paulo ')).toBe('SAO PAULO');
  });
});

describe('suspeitaDeUnidade', () => {
  it('0,9 (quem quis dizer 90%) levanta a pergunta', () => {
    expect(suspeitaDeUnidade(0.9)).toMatch(/menos de um por cento.*90%/);
  });

  it('valores normais não levantam nada', () => {
    for (const v of [1, 50, 90, 100]) expect(suspeitaDeUnidade(v)).toBeNull();
  });

  it('zero não é suspeito — é meta desligada, decisão legítima', () => {
    expect(suspeitaDeUnidade(0)).toBeNull();
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

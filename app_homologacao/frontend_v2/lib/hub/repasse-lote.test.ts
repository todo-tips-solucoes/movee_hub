import { describe, expect, it } from 'vitest';
import { LOTE_LIMITE_ITENS, acoesDoLote, agruparBloqueadas, avisoRecorte, mensagemErroGerar, montarCriacao, podeGerarLote, podeVerLotes, rotuloBloqueio } from './repasse-lote';
import type { RepasseLotePreviaBloqueada, RepasseLotePreviaResponse } from './adiantamentos-api';

const linha = (apuracaoId: number, entregadorId: number, valor = '10.00') => ({
  apuracaoId, entregadorId, motorista: `M${entregadorId}`, periodoInicio: '2026-10-05', periodoFim: '2026-10-11', valor,
});
const bloq = (entregadorId: number, motivo: string): RepasseLotePreviaBloqueada => ({ ...linha(1, entregadorId), motivo });

describe('rotuloBloqueio', () => {
  it.each(['JA_EM_LOTE', 'JA_PAGO_CONCILIADO', 'APURACAO_ABERTA', 'VALOR_INVALIDO', 'NOTA_REPROVADA', 'NOTA_PENDENTE', 'SEM_CONTA'])(
    '%s vira frase em português com instrução, nunca o código cru',
    (m) => {
      const r = rotuloBloqueio(m);
      expect(r.rotulo).not.toBe(m);
      expect(r.rotulo).not.toMatch(/_/);
      expect(r.acao.length).toBeGreaterThan(10);
    }
  );
  it('JA_PAGO_CONCILIADO tem o rótulo combinado', () => {
    expect(rotuloBloqueio('JA_PAGO_CONCILIADO').rotulo).toBe('Já pago fora da plataforma (conciliado)');
  });
  it('código desconhecido aparece cru, sem frase inventada', () => {
    expect(rotuloBloqueio('NOVO_MOTIVO')).toEqual({ rotulo: 'NOVO_MOTIVO', acao: '' });
  });
});

describe('agruparBloqueadas', () => {
  it('agrupa por motivo, na ordem de aparição', () => {
    const g = agruparBloqueadas([bloq(1, 'SEM_CONTA'), bloq(2, 'NOTA_PENDENTE'), bloq(3, 'SEM_CONTA')]);
    expect(g.map((x) => [x.motivo, x.linhas.length])).toEqual([['SEM_CONTA', 2], ['NOTA_PENDENTE', 1]]);
  });
});

describe('montarCriacao', () => {
  const previa: RepasseLotePreviaResponse = {
    aptas: [linha(7, 1, '10.50'), linha(7, 2, '20.00')], bloqueadas: [bloq(3, 'SEM_CONTA')],
    quantidadeApta: 2, totalApto: '30.50',
  };
  it('manda só as aptas, com quantidade, total e chave da prévia', () => {
    expect(montarCriacao(previa, 'uuid-1')).toEqual({
      apuracoes: [7, 7], entregadores: [1, 2],
      quantidadeEsperada: 2, totalEsperado: '30.50', chaveIdempotencia: 'uuid-1',
    });
  });
  it('sem aptas não há o que criar', () => {
    expect(montarCriacao({ ...previa, aptas: [], quantidadeApta: 0, totalApto: '0.00' }, 'k')).toBeNull();
  });
});

describe('permissões e status', () => {
  const todas = ['adiantamentos.exportar', 'adiantamentos.pagamento_confirmar', 'adiantamentos.reprocessar'];
  it('EXPORTADO com tudo: as quatro ações', () => {
    expect(acoesDoLote('EXPORTADO', todas)).toEqual({ baixar: true, cancelar: true, retorno: true, confirmar: true });
  });
  it('GERADO: baixa e cancela, mas ainda não confirma', () => {
    expect(acoesDoLote('GERADO', todas)).toEqual({ baixar: true, cancelar: true, retorno: false, confirmar: false });
  });
  it('CONCLUIDO: só baixa', () => {
    expect(acoesDoLote('CONCLUIDO', todas)).toEqual({ baixar: true, cancelar: false, retorno: false, confirmar: false });
  });
  it('CANCELADO: nada', () => {
    expect(acoesDoLote('CANCELADO', todas)).toEqual({ baixar: false, cancelar: false, retorno: false, confirmar: false });
  });
  it('cada permissão esconde só a sua ação', () => {
    expect(acoesDoLote('EXPORTADO', [])).toEqual({ baixar: false, cancelar: false, retorno: false, confirmar: false });
    expect(acoesDoLote('EXPORTADO', ['adiantamentos.exportar'])).toMatchObject({ baixar: true, cancelar: false, retorno: false });
    expect(acoesDoLote('EXPORTADO', ['adiantamentos.reprocessar'])).toMatchObject({ cancelar: true, baixar: false, confirmar: false });
    expect(acoesDoLote('EXPORTADO', ['adiantamentos.pagamento_confirmar'])).toMatchObject({ retorno: true, confirmar: true, cancelar: false });
  });
  it('gerar e ver têm permissão própria', () => {
    expect(podeGerarLote(['adiantamentos.lote_criar'])).toBe(true);
    expect(podeGerarLote(['adiantamentos.exportar'])).toBe(false);
    expect(podeVerLotes(['adiantamentos.pagamentos_consultar'])).toBe(true);
    expect(podeVerLotes([])).toBe(false);
  });
});

describe('teto do lote (recorte pelas apurações mais antigas)', () => {
  // apuração i começa no dia i: id maior = mais nova. Embaralhada de propósito.
  const dia = (i: number) => new Date(Date.UTC(2020, 0, 1 + i)).toISOString().slice(0, 10);
  // O id vai no sentido OPOSTO da data (a mais antiga tem o maior id): ordenar por id escolheria as novas.
  const aptas = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ ...linha(n - i, n - i, '1.50'), periodoInicio: dia(i) })).reverse();
  const previaDe = (n: number): RepasseLotePreviaResponse => ({
    aptas: aptas(n), bloqueadas: [], quantidadeApta: n, totalApto: (n * 1.5).toFixed(2),
  });

  it('5001 aptas: manda 5000, as mais antigas, com total e quantidade do recorte', () => {
    const c = montarCriacao(previaDe(5001), 'k')!;
    expect(LOTE_LIMITE_ITENS).toBe(5000);
    expect(c.apuracoes).toHaveLength(5000);
    expect(c.entregadores).toHaveLength(5000);
    expect(c.quantidadeEsperada).toBe(5000);
    expect(c.totalEsperado).toBe('7500.00');
    const ids = new Set(c.apuracoes);
    expect(ids.has(1)).toBe(false); // id 1 = a apuração MAIS NOVA: ficou de fora
    expect(ids.has(5001)).toBe(true); // id 5001 = a mais antiga
  });
  it('posicional: o par i do recorte continua sendo (apuração i, entregador i)', () => {
    const p = previaDe(5001);
    const c = montarCriacao(p, 'k')!;
    const par = new Map(p.aptas.map((a) => [a.apuracaoId, a.entregadorId]));
    c.apuracoes.forEach((a, i) => expect(c.entregadores[i]).toBe(par.get(a)));
  });
  it('corpo de 5000 pares cabe no express.json() global do backend (100 KB) — o formato de objetos não cabia', () => {
    const c = montarCriacao(previaDe(5001), '0b6f6a1e-1111-4222-8333-444455556666')!;
    expect(JSON.stringify(c).length).toBeLessThan(100 * 1024);
  });
  it('aviso diz quantas entram e quantas ficam', () => {
    const a = avisoRecorte(1, 5000)!;
    expect(a).toContain('5.000');
    expect(a).toMatch(/ficam 1 /);
    expect(a).toMatch(/outro lote/);
  });
  it('exatamente 5000: sem recorte, sem aviso, ordem intocada', () => {
    const p = previaDe(5000);
    const c = montarCriacao(p, 'k')!;
    expect(c.apuracoes).toHaveLength(5000);
    expect(c.apuracoes).toEqual(p.aptas.map((a) => a.apuracaoId));
    expect(c.totalEsperado).toBe('7500.00');
    expect(avisoRecorte(0, 5000)).toBeNull();
  });
  it('mensagem do 422 LOTE_ACIMA_DO_LIMITE fala do teto, não de "dados inválidos"', () => {
    const m = mensagemErroGerar('LOTE_ACIMA_DO_LIMITE')!;
    expect(m).toMatch(/no máximo 5\.000 pagamentos/);
    expect(m).not.toMatch(/inválid/i);
    expect(mensagemErroGerar('DADOS_INVALIDOS')).toBeNull();
    expect(mensagemErroGerar(undefined)).toBeNull();
  });
});

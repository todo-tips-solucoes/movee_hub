// campanhas do motorista (W3a) — validação do formulário (limites do
// CONTRATOS §4), unidades, seleção múltipla e textos. Todos os formulários de
// teste trazem TODOS os campos do contrato (stub incompleto é invisível ao tsc).

import { describe, expect, it } from 'vitest';
import {
  LIMITES,
  acaoDaSituacao,
  alternarSelecao,
  centavosParaReais,
  erroFoto,
  escopoTexto,
  formatCentavos,
  formatDiaMes,
  formatFracao,
  formatNota,
  formatPeriodo,
  formularioParaCorpo,
  formularioVazio,
  faixasSobrepostas,
  fechamentoExtrato,
  resumoCriterios,
  fracaoParaPercentual,
  hojeSP,
  pedidosBloqueado,
  percentualParaFracao,
  podeFecharAntecipado,
  premioVazio,
  reaisParaCentavos,
  resumoPesos,
  rotuloFaixa,
  somaPesos,
  validarFormulario,
  type FormularioCampanha,
  type PremioForm,
} from './campanhas-form';
import { TETO_CENTAVOS } from './lancamento-externo';

const HOJE = '2026-11-10';
const CTX = { hoje: HOJE, coberturaPedidos: 0.98, paraLancar: true };

function premio(parcial: Partial<PremioForm> = {}): PremioForm {
  return { ...premioVazio(1), descricao: 'Moto Honda CG 160', valorCentavos: 1_600_000, ...parcial };
}

function valido(parcial: Partial<FormularioCampanha> = {}): FormularioCampanha {
  return {
    tipo: 'nota',
    categorias: [],
    minTurnosBase: 'trabalhados',
    nome: 'Rei do Jantar — Novembro',
    descricao: 'Quem tiver a melhor nota leva os prêmios.',
    dataInicio: '2026-11-10',
    dataFim: '2026-11-30',
    pracas: ['SAO PAULO'],
    turnos: ['JANTAR 18H-22H'],
    modais: ['MOTO'],
    minTurnos: 5,
    pesos: { aceitacao: 30, conclusao: 30, tempo: 20, pedidos: 20 },
    cortes: { aceitacao: 0.8, conclusao: 0.9, tempo: null, pedidos: null },
    premios: [premio()],
    descarteTurnoMin: 5,
    dataPremio: '',
    avisar: true,
    visivelApp: false,
    ...parcial,
  };
}

describe('validarFormulario', () => {
  it('formulário completo e coerente: sem erros', () => {
    expect(validarFormulario(valido(), CTX)).toEqual({});
  });

  it('soma dos pesos 99 e 101 são recusadas; 100 passa', () => {
    const p99 = valido({ pesos: { aceitacao: 30, conclusao: 30, tempo: 20, pedidos: 19 } });
    const p101 = valido({ pesos: { aceitacao: 30, conclusao: 30, tempo: 20, pedidos: 21 } });
    expect(validarFormulario(p99, CTX).pesos).toMatch(/somar 100 \(hoje somam 99\)/);
    expect(validarFormulario(p101, CTX).pesos).toMatch(/hoje somam 101/);
    expect(validarFormulario(valido(), CTX).pesos).toBeUndefined();
  });

  it('peso fora de 0..100 ou não inteiro é recusado', () => {
    expect(validarFormulario(valido({ pesos: { aceitacao: 120, conclusao: -20, tempo: 0, pedidos: 0 } }), CTX).pesos).toMatch(/inteiro/);
    expect(validarFormulario(valido({ pesos: { aceitacao: 50.5, conclusao: 49.5, tempo: 0, pedidos: 0 } }), CTX).pesos).toMatch(/inteiro/);
  });

  it('faixa 2–3 sobreposta a 3–5 é recusada; 1–1, 2–3, 4–10 passa', () => {
    const sobre = valido({ premios: [premio({ posicaoDe: 2, posicaoAte: 3 }), premio({ posicaoDe: 3, posicaoAte: 5 })] });
    expect(validarFormulario(sobre, CTX).premios).toMatch(/sobrepostas/);
    const ok = valido({
      premios: [premio({ posicaoDe: 1, posicaoAte: 1 }), premio({ posicaoDe: 2, posicaoAte: 3 }), premio({ posicaoDe: 4, posicaoAte: 10 })],
    });
    expect(validarFormulario(ok, CTX)).toEqual({});
  });

  it('faixasSobrepostas independe da ordem de entrada', () => {
    expect(faixasSobrepostas([{ posicaoDe: 3, posicaoAte: 5 }, { posicaoDe: 2, posicaoAte: 3 }])).toBe(true);
    expect(faixasSobrepostas([{ posicaoDe: 4, posicaoAte: 5 }, { posicaoDe: 1, posicaoAte: 3 }])).toBe(false);
  });

  it('corte com peso 0 é recusado (CORTE_SEM_PESO); com peso > 0 passa', () => {
    const f = valido({
      pesos: { aceitacao: 50, conclusao: 50, tempo: 0, pedidos: 0 },
      cortes: { aceitacao: 0.8, conclusao: null, tempo: 0.9, pedidos: null },
    });
    const e = validarFormulario(f, CTX);
    expect(e['corte.tempo']).toMatch(/peso 0/);
    expect(e['corte.aceitacao']).toBeUndefined();
  });

  it('corte de taxa fora de 0..1 e corte de pedidos fora de 1..100000', () => {
    const e = validarFormulario(valido({ cortes: { aceitacao: 1.2, conclusao: -0.1, tempo: null, pedidos: 0 } }), CTX);
    expect(e['corte.aceitacao']).toBeDefined();
    expect(e['corte.conclusao']).toBeDefined();
    expect(e['corte.pedidos']).toBeDefined();
    expect(validarFormulario(valido({ cortes: { aceitacao: null, conclusao: null, tempo: null, pedidos: 100001 } }), CTX)['corte.pedidos']).toBeDefined();
    expect(validarFormulario(valido({ cortes: { aceitacao: null, conclusao: null, tempo: null, pedidos: 100000 } }), CTX)['corte.pedidos']).toBeUndefined();
  });

  it('corte ilegível (NaN) é recusado', () => {
    const e = validarFormulario(valido({ cortes: { aceitacao: Number.NaN, conclusao: null, tempo: null, pedidos: null } }), CTX);
    expect(e['corte.aceitacao']).toMatch(/inválido/);
  });

  it('nome: 2 caracteres recusa, 3 passa, 121 recusa', () => {
    expect(validarFormulario(valido({ nome: 'ab' }), CTX).nome).toBeDefined();
    expect(validarFormulario(valido({ nome: 'abc' }), CTX).nome).toBeUndefined();
    expect(validarFormulario(valido({ nome: 'x'.repeat(121) }), CTX).nome).toBeDefined();
    expect(validarFormulario(valido({ nome: '   ab   ' }), CTX).nome).toBeDefined();
  });

  it('descrição acima de 1000 recusa', () => {
    expect(validarFormulario(valido({ descricao: 'x'.repeat(1001) }), CTX).descricao).toBeDefined();
    expect(validarFormulario(valido({ descricao: 'x'.repeat(1000) }), CTX).descricao).toBeUndefined();
  });

  it('datas: fim antes do início; duração até 92 dias (93 recusa)', () => {
    expect(validarFormulario(valido({ dataInicio: '2026-11-10', dataFim: '2026-11-09' }), CTX).dataFim).toMatch(/antes do início/);
    // 10/11 + 91 dias = 09/02 → 92 dias corridos, inclusive: passa
    expect(validarFormulario(valido({ dataInicio: '2026-11-10', dataFim: '2027-02-09' }), CTX).dataFim).toBeUndefined();
    expect(validarFormulario(valido({ dataInicio: '2026-11-10', dataFim: '2027-02-10' }), CTX).dataFim).toMatch(/92 dias/);
    expect(validarFormulario(valido({ dataInicio: '', dataFim: '' }), CTX).dataInicio).toBeDefined();
  });

  it('lançar: início no passado é aceito (0133); só o fim no passado recusa, e só ao lançar', () => {
    expect(validarFormulario(valido({ dataInicio: '2026-11-09' }), CTX).dataInicio).toBeUndefined();
    const f = valido({ dataInicio: '2026-11-01', dataFim: '2026-11-09' });
    expect(validarFormulario(f, CTX).dataFim).toMatch(/fim precisa ser hoje ou depois/);
    expect(validarFormulario(f, { ...CTX, paraLancar: false }).dataFim).toBeUndefined();
    expect(validarFormulario(valido({ dataFim: HOJE }), CTX).dataFim).toBeUndefined();
  });

  it('descarte 0..60 inteiro; data do prêmio entre o início e fim + 365 dias (vazio vale)', () => {
    for (const v of [0, 5, 60]) expect(validarFormulario(valido({ descarteTurnoMin: v }), CTX).descarteTurnoMin).toBeUndefined();
    for (const v of [-1, 61, 2.5, Number.NaN]) expect(validarFormulario(valido({ descarteTurnoMin: v }), CTX).descarteTurnoMin).toBeDefined();
    for (const v of ['', '2026-11-10', '2026-12-05', '2027-11-30']) expect(validarFormulario(valido({ dataPremio: v }), CTX).dataPremio).toBeUndefined();
    for (const v of ['2026-11-09', '2027-12-01']) expect(validarFormulario(valido({ dataPremio: v }), CTX).dataPremio).toBeDefined();
  });

  it('nota aceita categorias (opcionais); extrato continua exigindo', () => {
    expect(validarFormulario(valido({ categorias: ['Bônus X'] }), CTX).categorias).toBeUndefined();
    const corpo = formularioParaCorpo(valido({ categorias: ['Bônus X'] }));
    expect(corpo.categorias).toEqual(['Bônus X']);
    expect(formularioParaCorpo(valido()).categorias).toBeNull();
  });

  it('mínimo de turnos 1..200', () => {
    expect(validarFormulario(valido({ minTurnos: 0 }), CTX).minTurnos).toBeDefined();
    expect(validarFormulario(valido({ minTurnos: 201 }), CTX).minTurnos).toBeDefined();
    expect(validarFormulario(valido({ minTurnos: 1 }), CTX).minTurnos).toBeUndefined();
    expect(validarFormulario(valido({ minTurnos: Number.NaN }), CTX).minTurnos).toBeDefined();
  });

  it('público: lista vazia ou com mais de 50 itens recusa; null (todas) passa', () => {
    expect(validarFormulario(valido({ pracas: [] }), CTX).pracas).toBeDefined();
    expect(validarFormulario(valido({ turnos: Array.from({ length: 51 }, (_, i) => `T${i}`) }), CTX).turnos).toBeDefined();
    expect(validarFormulario(valido({ pracas: null, turnos: null, modais: null }), CTX)).toEqual({});
  });

  it('pedidos com peso > 0 exige cobertura >= 95% (94% recusa com o número; 95% passa; sem dado recusa)', () => {
    const e94 = validarFormulario(valido(), { ...CTX, coberturaPedidos: 0.94 });
    expect(e94['pesos.pedidos']).toMatch(/94%/);
    expect(validarFormulario(valido(), { ...CTX, coberturaPedidos: 0.95 })['pesos.pedidos']).toBeUndefined();
    expect(validarFormulario(valido(), { ...CTX, coberturaPedidos: null })['pesos.pedidos']).toMatch(/Sem dado/);
    const semPedidos = valido({ pesos: { aceitacao: 40, conclusao: 40, tempo: 20, pedidos: 0 } });
    expect(validarFormulario(semPedidos, { ...CTX, coberturaPedidos: 0.5 })['pesos.pedidos']).toBeUndefined();
  });

  it('prêmios: 0 faixas e 21 faixas recusam; posição fora de 1..500 e até < de recusam', () => {
    expect(validarFormulario(valido({ premios: [] }), CTX).premios).toBeDefined();
    const muitas = Array.from({ length: 21 }, (_, i) => premio({ posicaoDe: i + 1, posicaoAte: i + 1 }));
    expect(validarFormulario(valido({ premios: muitas }), CTX).premios).toBeDefined();
    expect(validarFormulario(valido({ premios: [premio({ posicaoDe: 0, posicaoAte: 1 })] }), CTX)['premio.0.faixa']).toBeDefined();
    expect(validarFormulario(valido({ premios: [premio({ posicaoDe: 5, posicaoAte: 4 })] }), CTX)['premio.0.faixa']).toBeDefined();
    expect(validarFormulario(valido({ premios: [premio({ posicaoDe: 500, posicaoAte: 501 })] }), CTX)['premio.0.faixa']).toBeDefined();
    expect(validarFormulario(valido({ premios: [premio({ posicaoDe: 500, posicaoAte: 500 })] }), CTX)['premio.0.faixa']).toBeUndefined();
  });

  it('prêmio em dinheiro: valor obrigatório, de 1 centavo ao TETO do Lançamento externo (importado)', () => {
    expect(LIMITES.dinheiroMaxCentavos).toBe(TETO_CENTAVOS);
    const din = (v: number | null) => valido({ premios: [premio({ tipo: 'dinheiro', descricao: 'R$ 100', valorCentavos: v })] });
    expect(validarFormulario(din(null), CTX)['premio.0.valor']).toBeDefined();
    expect(validarFormulario(din(0), CTX)['premio.0.valor']).toBeDefined();
    expect(validarFormulario(din(TETO_CENTAVOS + 1), CTX)['premio.0.valor']).toBeDefined();
    expect(validarFormulario(din(TETO_CENTAVOS), CTX)['premio.0.valor']).toBeUndefined();
    expect(validarFormulario(din(1), CTX)['premio.0.valor']).toBeUndefined();
  });

  it('prêmio em objeto: valor opcional e SEM o teto do dinheiro', () => {
    const obj = (v: number | null) => valido({ premios: [premio({ tipo: 'objeto', valorCentavos: v })] });
    expect(validarFormulario(obj(null), CTX)['premio.0.valor']).toBeUndefined();
    expect(validarFormulario(obj(1_600_000), CTX)['premio.0.valor']).toBeUndefined();
    expect(validarFormulario(obj(0), CTX)['premio.0.valor']).toBeDefined();
  });

  it('descrição do prêmio: vazia ou > 200 recusa', () => {
    expect(validarFormulario(valido({ premios: [premio({ descricao: '  ' })] }), CTX)['premio.0.descricao']).toBeDefined();
    expect(validarFormulario(valido({ premios: [premio({ descricao: 'x'.repeat(201) })] }), CTX)['premio.0.descricao']).toBeDefined();
  });

  it('formulário vazio nunca passa (rede de segurança contra validador oco)', () => {
    expect(Object.keys(validarFormulario(formularioVazio(), CTX)).length).toBeGreaterThan(3);
  });
});

describe('pesos e cobertura', () => {
  it('somaPesos e pedidosBloqueado', () => {
    expect(somaPesos({ aceitacao: 10, conclusao: 20, tempo: 30, pedidos: 40 })).toBe(100);
    expect(pedidosBloqueado(0.9499)).toBe(true);
    expect(pedidosBloqueado(0.95)).toBe(false);
    expect(pedidosBloqueado(null)).toBe(true);
  });
});

describe('conversões de unidade (percentual × fração × centavos)', () => {
  it('percentual digitado vira fração de 4 casas; vírgula decimal; vazio = null', () => {
    expect(percentualParaFracao('80')).toBe(0.8);
    expect(percentualParaFracao('80,5')).toBe(0.805);
    expect(percentualParaFracao('0')).toBe(0);
    expect(percentualParaFracao('  ')).toBeNull();
    expect(percentualParaFracao('abc')).toBeNaN();
    // 9000% não pode passar despercebido: vira 90, que a validação recusa (> 1)
    expect(percentualParaFracao('9000')).toBe(90);
  });
  it('fração → texto em percentual, ida e volta', () => {
    expect(fracaoParaPercentual(0.805)).toBe('80,5');
    expect(fracaoParaPercentual(0.8)).toBe('80');
    expect(fracaoParaPercentual(null)).toBe('');
    expect(percentualParaFracao(fracaoParaPercentual(0.9123))).toBe(0.9123);
  });
  it('reais ↔ centavos', () => {
    expect(reaisParaCentavos('16000')).toBe(1_600_000);
    expect(reaisParaCentavos('1.600,50')).toBe(160_050);
    expect(reaisParaCentavos('0,1')).toBe(10);
    expect(reaisParaCentavos('100,50')).toBe(10050);
    expect(reaisParaCentavos('1.234,56')).toBe(123456);
    expect(reaisParaCentavos('1.234')).toBe(123400);
    // "100.50" (decimal americano) é RECUSADO: antes virava 1.005.000 centavos
    expect(reaisParaCentavos('100.50')).toBeNaN();
    expect(reaisParaCentavos('1.23,4')).toBeNaN();
    expect(reaisParaCentavos('1,234')).toBeNaN();
    expect(reaisParaCentavos('')).toBeNull();
    expect(reaisParaCentavos('x')).toBeNaN();
    expect(centavosParaReais(160_050)).toBe('1600,50');
    expect(centavosParaReais(null)).toBe('');
  });
});

describe('alternarSelecao ("Todas" = null)', () => {
  it('marca a partir de null, desmarca, e voltar ao vazio volta a null', () => {
    expect(alternarSelecao(null, 'MOTO')).toEqual(['MOTO']);
    expect(alternarSelecao(['MOTO'], 'CARRO')).toEqual(['MOTO', 'CARRO']);
    expect(alternarSelecao(['MOTO', 'CARRO'], 'MOTO')).toEqual(['CARRO']);
    expect(alternarSelecao(['MOTO'], 'MOTO')).toBeNull();
  });
});

describe('corpo do POST/PUT (CONTRATOS §7)', () => {
  it('só os campos do contrato: sem chave/id/foto da UI nos prêmios; textos aparados', () => {
    const corpo = formularioParaCorpo(valido({ nome: '  Rei do Jantar  ' }));
    expect(Object.keys(corpo).sort()).toEqual(
      ['avisar', 'categorias', 'cortes', 'dataFim', 'dataInicio', 'dataPremio', 'descarteTurnoMin', 'descricao', 'minTurnos', 'modais', 'nome', 'pesos', 'pracas', 'premios', 'tipo', 'turnos', 'visivelApp']
    );
    expect(corpo.nome).toBe('Rei do Jantar');
    expect(Object.keys(corpo.premios[0]).sort()).toEqual(['descricao', 'posicaoAte', 'posicaoDe', 'tipo', 'valorCentavos']);
  });

  it('edição de rascunho reenvia premios[].id das faixas existentes; faixa nova vai sem id', () => {
    const corpo = formularioParaCorpo(valido({ premios: [premio({ id: 31 }), premio({ id: null, posicaoDe: 2, posicaoAte: 2 })] }));
    expect(corpo.premios[0]).toMatchObject({ id: 31, posicaoDe: 1 });
    expect('id' in corpo.premios[1]).toBe(false);
  });
});

describe('formatação e textos', () => {
  it('notas, frações, datas, dinheiro', () => {
    expect(formatNota(97.3)).toBe('97,3');
    expect(formatNota(null)).toBe('—');
    expect(formatFracao(0.962)).toBe('96,2%');
    expect(formatFracao(null)).toBe('—');
    expect(formatDiaMes('2026-11-10')).toBe('10/11');
    expect(formatDiaMes('2026-11-10', true)).toBe('10/11/2026');
    expect(formatDiaMes('lixo')).toBe('—');
    expect(formatPeriodo('2026-11-10', '2026-11-30')).toBe('10/11 – 30/11');
    expect(formatCentavos(10_000).replace(/\s/g, ' ')).toBe('R$ 100,00');
  });
  it('rótulo de faixa', () => {
    expect(rotuloFaixa(1, 1)).toBe('1º lugar');
    expect(rotuloFaixa(2, 3)).toBe('2º e 3º');
    expect(rotuloFaixa(4, 10)).toBe('4º ao 10º');
    expect(rotuloFaixa(5, 5)).toBe('5º');
  });
  it('resumo de pesos omite peso 0 e mostra corte', () => {
    const t = resumoPesos({ aceitacao: 60, conclusao: 40, tempo: 0, pedidos: 0 }, { aceitacao: 0.8, conclusao: null, tempo: null, pedidos: null });
    expect(t).toBe('Taxa de aceitação 60% (corte 80%) · Taxa de conclusão 40%');
  });
  it('hojeSP usa o fuso de São Paulo (02:00 UTC ainda é o dia anterior lá)', () => {
    expect(hojeSP(new Date('2026-11-10T02:00:00Z'))).toBe('2026-11-09');
    expect(hojeSP(new Date('2026-11-10T12:00:00Z'))).toBe('2026-11-10');
  });
  it('foto: tipo e tamanho', () => {
    expect(erroFoto({ type: 'image/png', size: 512000 })).toBeNull();
    expect(erroFoto({ type: 'image/png', size: 512001 })).toMatch(/500 KB/);
    expect(erroFoto({ type: 'image/svg+xml', size: 10 })).toMatch(/JPEG, PNG ou WebP/);
  });
  it('ação da lista por situação', () => {
    expect(acaoDaSituacao('rascunho')).toEqual({ rotulo: 'Editar', editar: true });
    expect(acaoDaSituacao('em_andamento').rotulo).toBe('Acompanhar');
    expect(acaoDaSituacao('encerrada').rotulo).toBe('Ver vencedores');
    expect(acaoDaSituacao('cancelada')).toEqual({ rotulo: 'Ver', editar: false });
  });
  it('escopo por texto', () => {
    const base = { pracas: null, turnos: null, modais: null, minTurnos: 3, tipo: 'nota' as const, minTurnosBase: 'trabalhados' as const };
    expect(escopoTexto(base)).toBe('Todas as praças · todos os turnos · mín. 3 turnos');
    expect(escopoTexto({ ...base, pracas: ['SAO PAULO'], modais: ['MOTO'] })).toBe('SAO PAULO · todos os turnos · modal MOTO · mín. 3 turnos');
  });
});

describe('fechamento manual (CONTRATOS §3: apurando e hoje >= fim + 3)', () => {
  const fim = '2026-11-30';
  it('só em apurando e a partir do 3º dia depois do fim', () => {
    expect(podeFecharAntecipado('apurando', fim, '2026-12-02')).toBe(false);
    expect(podeFecharAntecipado('apurando', fim, '2026-12-03')).toBe(true);
    expect(podeFecharAntecipado('em_andamento', fim, '2026-12-05')).toBe(false);
    expect(podeFecharAntecipado('encerrada', fim, '2026-12-05')).toBe(false);
  });
});

describe('tipo "Melhor extrato"', () => {
  const extrato = (parcial: Partial<FormularioCampanha> = {}) =>
    valido({
      tipo: 'extrato',
      minTurnosBase: 'validos',
      categorias: ['Corridas concluidas'],
      pesos: { aceitacao: 0, conclusao: 0, tempo: 0, pedidos: 0 },
      cortes: { aceitacao: 0.9, conclusao: null, tempo: 0.7, pedidos: null },
      ...parcial,
    });

  it('válido sem pesos e sem exigir cobertura de pedidos', () => {
    expect(validarFormulario(extrato(), { ...CTX, coberturaPedidos: null })).toEqual({});
  });
  it('exige ao menos 1 critério e ao menos 1 categoria', () => {
    const e = validarFormulario(
      extrato({ cortes: { aceitacao: null, conclusao: null, tempo: null, pedidos: null }, categorias: [] }),
      CTX
    );
    expect(e.cortes).toMatch(/ao menos 1 critério/);
    expect(e.categorias).toMatch(/ao menos 1 categoria/);
  });
  it('mínimo no turno segue as faixas (0–100%; pedidos inteiro)', () => {
    expect(validarFormulario(extrato({ cortes: { aceitacao: 1.5, conclusao: null, tempo: null, pedidos: null } }), CTX)['corte.aceitacao']).toBeDefined();
    expect(validarFormulario(extrato({ cortes: { aceitacao: null, conclusao: null, tempo: null, pedidos: 2.5 } }), CTX)['corte.pedidos']).toBeDefined();
    expect(validarFormulario(extrato({ cortes: { aceitacao: null, conclusao: null, tempo: null, pedidos: 3 } }), CTX)).toEqual({});
  });
  it('mais de 60 categorias é recusado como no banco', () => {
    const muitas = Array.from({ length: LIMITES.categoriasMax + 1 }, (_, i) => `c${i}`);
    expect(validarFormulario(extrato({ categorias: muitas }), CTX).categorias).toMatch(/no máximo 60/);
  });
  it('corpo: extrato leva categorias/base e pesos 0; nota não leva categorias', () => {
    const c = formularioParaCorpo(extrato({ pesos: { aceitacao: 9, conclusao: 0, tempo: 0, pedidos: 0 } }));
    expect(c).toMatchObject({ tipo: 'extrato', categorias: ['Corridas concluidas'], minTurnosBase: 'validos', pesos: { aceitacao: 0, conclusao: 0, tempo: 0, pedidos: 0 } });
    const n = formularioParaCorpo(valido());
    expect(n.tipo).toBe('nota');
    expect(n.categorias).toBeNull();
    expect(n).not.toHaveProperty('minTurnosBase');
  });
  it('fecha sozinha 3 dias depois do fim; textos de critério e escopo', () => {
    expect(fechamentoExtrato('2026-11-30')).toBe('03/12');
    expect(fechamentoExtrato('')).toBeNull();
    expect(resumoCriterios({ aceitacao: 0.9, conclusao: null, tempo: 0.7, pedidos: 12 })).toBe(
      'Taxa de aceitação ≥ 90% · Tempo disponível ≥ 70% · Pedidos concluídos ≥ 12 pedidos'
    );
    expect(escopoTexto({ pracas: null, turnos: null, modais: null, minTurnos: 8, tipo: 'extrato', minTurnosBase: 'validos' })).toMatch(/mín\. 8 turnos válidos$/);
  });
});

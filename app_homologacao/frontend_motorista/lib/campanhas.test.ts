/**
 * Teste unitário — lib/campanhas.ts + lib/campanhas-api.ts (funções puras e cliente).
 *   node --experimental-strip-types --test lib/campanhas.test.ts
 *
 * Stubs com TODOS os campos obrigatórios do contrato (CONTRATOS.md §7).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  faltamPontos,
  textoStatusPremio,
  textoRodapePremio,
  ondeGanharMais,
  textoOndeGanhar,
  corridasParaVoltar,
  paraVoltar,
  variacaoPosicao,
  textoVariacao,
  contagemRegressiva,
  textoTermino,
  faixaRotulo,
  escolherCampanha,
  modoCard,
  textoComeca,
  estadoDoItem,
  estadoTela,
  foraDoTop10,
  turnosFaltantes,
  resumoPublico,
  fmt1,
  fmtPct,
  iniciais,
  textoCortes,
  textoDadosAte,
  ROTULO_INDICADOR,
} from './campanhas.ts';
import { fmtReais, textoMotivo, rotuloTurno, linhaTurno, rankingExtrato, textoTurnoValido } from './campanhas.ts';
import { readFileSync } from 'node:fs';
import type { LinhaTopExtrato, TurnoExtrato } from './campanhas-api.ts';
import { buscarCampanha, listarCampanhas, urlFotoPremio } from './campanhas-api.ts';
import type { CampanhaItem, CampanhaTela, MinhaLinha } from './campanhas-api.ts';

const eu = (o: Partial<MinhaLinha> = {}): MinhaLinha => ({
  situacao: 'classificado',
  posicao: 7,
  posicaoAnterior: 10,
  nota: 90.1,
  turnos: 18,
  leituras: { aceitacao: 0.882, conclusao: 0.958, tempo: 0.903, pedidos: 362 },
  notas: { aceitacao: 88.2, conclusao: 95.8, tempo: 90.3, pedidos: 87.9 },
  motivoCorte: [],
  notaHipotetica: null,
  posicaoHipotetica: null,
  ofertadas: 200,
  aceitas: 176,
  completadas: 169,
  acima: { nome: 'Aline R.', nota: 90.6 },
  premio: { tipo: 'dinheiro', descricao: 'R$ 100 no repasse' },
  entregueEm: null,
  ...o,
});

const tela = (o: Partial<CampanhaTela> = {}): CampanhaTela => ({
  campanha: {
    id: 12, nome: 'Rei do Jantar', descricao: 'd', situacao: 'em_andamento',
    dataInicio: '2026-11-10', dataFim: '2026-11-30', dataPremio: null, pracas: ['SAO PAULO'], turnos: ['JANTAR'], modais: ['MOTO'],
    minTurnos: 5, pesos: { aceitacao: 30, conclusao: 30, tempo: 20, pedidos: 20 },
    cortes: { aceitacao: 0.8, conclusao: 0.9, tempo: null, pedidos: null }, dadosAte: '2026-11-21', fechadaEm: null,
  },
  premios: [],
  eu: eu(),
  lider: { pedidos: 412 },
  top10: [{ posicao: 1, nome: 'Marcos V.', nota: 97.3, souEu: false }],
  ...o,
});

const AGORA = Date.parse('2026-11-22T10:00:00-03:00');

const item = (o: Partial<CampanhaItem> = {}): CampanhaItem => ({
  id: 1, nome: 'x', situacao: 'em_andamento', dataInicio: '2026-11-01', dataFim: '2026-11-30',
  minhaPosicao: null, minhaSituacao: null, naZonaPremio: false, ...o,
});

test('rótulos iguais aos da Performance', () => {
  assert.deepEqual(Object.values(ROTULO_INDICADOR), ['Taxa de aceitação', 'Taxa de conclusão', 'Tempo disponível', 'Pedidos concluídos']);
});

test('faltamPontos: 1 casa, empate 0, sem acima null', () => {
  assert.equal(faltamPontos(eu()), 0.5);
  assert.equal(fmt1(faltamPontos(eu())!), '0,5');
  assert.equal(faltamPontos(eu({ nota: 90.6 })), 0);
  assert.equal(fmt1(faltamPontos(eu({ nota: 90.6 }))!), '0,0');
  assert.equal(faltamPontos(eu({ acima: null })), null);
});

test('ondeGanharMais: maior peso×(100−nota), só peso>0', () => {
  const r = ondeGanharMais({ aceitacao: 30, conclusao: 30, tempo: 20, pedidos: 20 }, eu().notas, { pedidos: 412 });
  // 30×11.8=354 (aceitação) vence 30×4.2, 20×9.7, 20×12.1=242
  assert.deepEqual(r, { indicador: 'aceitacao', passo: 3 });
  const t = ondeGanharMais({ aceitacao: 0, conclusao: 0, tempo: 20, pedidos: 80 }, { aceitacao: 0, conclusao: 0, tempo: 90.3, pedidos: 50 }, null);
  assert.equal(t?.indicador, 'pedidos');
  assert.equal(t?.passo, null);
  assert.equal(textoOndeGanhar({ indicador: 'tempo', passo: 5 }), 'tempo disponível. Cada 5% a mais no tempo online soma 1 ponto na sua nota.');
  assert.equal(ondeGanharMais({ aceitacao: 100, conclusao: 0, tempo: 0, pedidos: 0 }, { aceitacao: 100, conclusao: null, tempo: null, pedidos: null }, null), null);
});

test('corridasParaVoltar: c=0.8 com 156/200 → 20 (sem erro de ponto flutuante)', () => {
  assert.equal(corridasParaVoltar('aceitacao', 0.8, { ofertadas: 200, aceitas: 156, completadas: 150 }), 20);
});

test('corridasParaVoltar: já acima, c>=1, tempo/pedidos, sem corte → null', () => {
  const e = { ofertadas: 200, aceitas: 176, completadas: 169 };
  assert.equal(corridasParaVoltar('aceitacao', 0.8, e), null);
  assert.equal(corridasParaVoltar('aceitacao', 1, e), null);
  assert.equal(corridasParaVoltar('tempo', 0.8, e), null);
  assert.equal(corridasParaVoltar('pedidos', 10, e), null);
  assert.equal(corridasParaVoltar('aceitacao', null, e), null);
});

test('corridasParaVoltar: conclusão usa completadas/aceitas', () => {
  // c=0.9, 80/100 concluídas → (90−80)/0.1 = 100
  assert.equal(corridasParaVoltar('conclusao', 0.9, { ofertadas: 120, aceitas: 100, completadas: 80 }), 100);
});

test('paraVoltar: aceitação com K; tempo/pedidos só distância', () => {
  const e = eu({
    situacao: 'abaixo_corte', posicao: null, nota: null, ofertadas: 200, aceitas: 156,
    leituras: { aceitacao: 0.78, conclusao: 0.974, tempo: 0.5, pedidos: 8 }, motivoCorte: ['aceitacao', 'tempo', 'pedidos'],
  });
  const r = paraVoltar(e, { aceitacao: 0.8, conclusao: 0.9, tempo: 0.7, pedidos: 10 });
  assert.deepEqual(r.map((x) => [x.indicador, x.corridas, x.falta]), [
    ['aceitacao', 20, 2],
    ['tempo', null, 20],
    ['pedidos', null, 2],
  ]);
  assert.deepEqual(paraVoltar(e, { aceitacao: null, conclusao: null, tempo: null, pedidos: null }), []);
});

test('variacaoPosicao', () => {
  assert.deepEqual(variacaoPosicao(10, 7), { tipo: 'subiu', delta: 3 });
  assert.deepEqual(variacaoPosicao(5, 7), { tipo: 'desceu', delta: 2 });
  assert.deepEqual(variacaoPosicao(7, 7), { tipo: 'manteve', delta: 0 });
  assert.deepEqual(variacaoPosicao(null, 7), { tipo: 'novo', delta: 0 });
  assert.equal(textoVariacao({ tipo: 'subiu', delta: 1 }), 'subiu 1 posição desde ontem');
  assert.equal(textoVariacao({ tipo: 'novo', delta: 0 }), 'novo no ranking');
});

test('contagemRegressiva: até 23:59:59 -03:00 do dataFim', () => {
  const agora = Date.parse('2026-11-22T09:37:00-03:00'); // faltam 8d 14h 22min 59s
  assert.deepEqual(contagemRegressiva('2026-11-30', agora), { dias: 8, horas: 14, minutos: 22, encerrou: false });
  assert.equal(textoTermino('2026-11-30', agora), 'termina em 8 dias');
  assert.equal(textoTermino('2026-11-23', Date.parse('2026-11-22T10:00:00-03:00')), 'termina em 1 dia');
  assert.equal(textoTermino('2026-11-22', agora), 'termina hoje');
  assert.equal(contagemRegressiva('2026-11-22', Date.parse('2026-11-23T00:00:00-03:00')).encerrou, true);
  // ainda é o último dia às 23:00 -03:00 (02:00 UTC do dia seguinte)
  assert.equal(contagemRegressiva('2026-11-22', Date.parse('2026-11-23T02:00:00Z')).encerrou, false);
});

test('faixaRotulo', () => {
  assert.equal(faixaRotulo(1, 1), '1º');
  assert.equal(faixaRotulo(2, 3), '2º e 3º');
  assert.equal(faixaRotulo(4, 10), '4º ao 10º');
});

test('escolherCampanha: 1) em andamento — melhor posição; sem posição, termina primeiro', () => {
  assert.equal(escolherCampanha([]), null);
  assert.equal(escolherCampanha([item({ situacao: 'cancelada' }), item({ situacao: 'rascunho' })]), null);
  const a = item({ id: 1, minhaPosicao: 9 });
  const b = item({ id: 2, minhaPosicao: 3 });
  const c = item({ id: 3, minhaPosicao: null, dataFim: '2026-11-25' });
  assert.equal(escolherCampanha([a, c, b], AGORA)?.id, 2);
  const d = item({ id: 4, dataFim: '2026-12-10' });
  assert.equal(escolherCampanha([d, c], AGORA)?.id, 3);
  // em andamento vence encerrada, agendada e apurando
  const enc = item({ id: 9, situacao: 'encerrada', minhaPosicao: 1, dataFim: '2026-11-20' });
  assert.equal(escolherCampanha([enc, item({ id: 8, situacao: 'agendada' }), d], AGORA)?.id, 4);
});

test('escolherCampanha: 2) encerrada com posição — dia 7 entra, dia 8 não', () => {
  // hoje (SP) = 2026-11-22
  const dia7 = item({ id: 1, situacao: 'encerrada', minhaPosicao: 2, dataFim: '2026-11-15' });
  const dia8 = item({ id: 2, situacao: 'encerrada', minhaPosicao: 2, dataFim: '2026-11-14' });
  const semPos = item({ id: 3, situacao: 'encerrada', minhaPosicao: null, dataFim: '2026-11-21' });
  assert.equal(escolherCampanha([dia7], AGORA)?.id, 1);
  assert.equal(escolherCampanha([dia8], AGORA), null);
  assert.equal(escolherCampanha([semPos], AGORA), null);
  assert.equal(escolherCampanha([dia8, dia7, semPos], AGORA)?.id, 1);
  // a mais recente vence
  const rec = item({ id: 4, situacao: 'encerrada', minhaPosicao: 5, dataFim: '2026-11-20' });
  assert.equal(escolherCampanha([dia7, rec], AGORA)?.id, 4);
  // encerrada com resultado vence agendada e apurando
  assert.equal(escolherCampanha([item({ id: 5, situacao: 'agendada' }), item({ id: 6, situacao: 'apurando' }), dia7], AGORA)?.id, 1);
});

test('escolherCampanha: 3) agendada; 4) apurando', () => {
  const ag = item({ id: 1, situacao: 'agendada', dataInicio: '2026-12-01', dataFim: '2026-12-20' });
  const ag2 = item({ id: 3, situacao: 'agendada', dataInicio: '2026-11-25', dataFim: '2026-12-30' });
  assert.equal(escolherCampanha([ag, ag2], AGORA)?.id, 3);
  const ap = item({ id: 2, situacao: 'apurando', dataFim: '2026-11-21' });
  assert.equal(escolherCampanha([ap, ag], AGORA)?.id, 1);
  assert.equal(escolherCampanha([ap], AGORA)?.id, 2);
  assert.equal(escolherCampanha([item({ situacao: 'encerrada', minhaPosicao: 1, dataFim: '2026-01-01' })], AGORA), null);
});

test('modoCard e textoComeca', () => {
  assert.equal(modoCard(item()), 'andamento');
  assert.equal(modoCard(item({ situacao: 'encerrada' })), 'resultado');
  assert.equal(modoCard(item({ situacao: 'agendada' })), 'agendada');
  assert.equal(modoCard(item({ situacao: 'apurando' })), 'apurando');
  assert.equal(textoComeca('2026-11-25', AGORA), 'Começa em 3 dias');
  assert.equal(textoComeca('2026-11-23', AGORA), 'Começa amanhã');
  assert.equal(textoComeca('2026-11-22', AGORA), 'Começa hoje');
});

test('estados do item e da tela', () => {
  assert.equal(estadoDoItem(item({ minhaSituacao: 'classificado', minhaPosicao: 7 })), 'classificado');
  assert.equal(estadoDoItem(item({ minhaSituacao: 'abaixo_corte' })), 'abaixo_corte');
  assert.equal(estadoDoItem(item({ minhaSituacao: 'sem_minimo' })), 'sem_minimo');
  assert.equal(estadoDoItem(item()), 'sem_linha');
  assert.equal(estadoTela(tela()), 'classificado');
  assert.equal(estadoTela(tela({ eu: null })), 'sem_linha');
  assert.equal(estadoTela(tela({ eu: eu({ situacao: 'abaixo_corte', posicao: null }) })), 'abaixo_corte');
  const enc = tela(); enc.campanha.situacao = 'encerrada';
  assert.equal(estadoTela(enc), 'encerrada');
});

test('foraDoTop10 e turnosFaltantes', () => {
  assert.equal(foraDoTop10(tela({ eu: eu({ posicao: 25 }) })), true);
  assert.equal(foraDoTop10(tela({ eu: eu({ posicao: 7 }), top10: [{ posicao: 7, nome: 'Você', nota: 90.1, souEu: true }] })), false);
  assert.equal(foraDoTop10(tela({ eu: null })), false);
  assert.equal(turnosFaltantes(5, 3), 2);
  assert.equal(turnosFaltantes(5, 9), 0);
});

test('formatação', () => {
  assert.equal(fmt1(90.06), '90,1');
  assert.equal(fmtPct(0.882), '88,2%');
  assert.equal(resumoPublico(tela().campanha), 'JANTAR · SAO PAULO · só moto · 10 a 30/11');
});

test('iniciais, textoCortes, textoDadosAte', () => {
  assert.equal(iniciais('Marcos V.'), 'MV');
  assert.equal(iniciais('Você'), 'V');
  assert.deepEqual(textoCortes(tela().campanha.cortes), ['Aceitação abaixo de 80% tira do ranking.', 'Conclusão abaixo de 90% tira do ranking.']);
  const agora = Date.parse('2026-11-22T10:00:00-03:00');
  assert.equal(textoDadosAte('2026-11-21', agora), 'Ranking com os dados até ontem (21/11)');
  assert.equal(textoDadosAte('2026-11-19', agora), 'Ranking com os dados até 19/11');
  assert.equal(textoDadosAte(null, agora), 'Ranking ainda não calculado');
});

test('cliente: lista, detalhe e URL da foto', async () => {
  const chamadas: string[] = [];
  (globalThis as unknown as Record<string, unknown>).fetch = async (input: unknown): Promise<Response> => {
    chamadas.push(String(input));
    const body = String(input).endsWith('/campanhas') ? { itens: [item()] } : tela();
    return { ok: true, status: 200, json: async () => body } as unknown as Response;
  };
  assert.equal((await listarCampanhas()).length, 1);
  assert.equal((await buscarCampanha(12)).campanha.id, 12);
  assert.deepEqual(chamadas, ['/api/motorista/campanhas', '/api/motorista/campanhas/12']);
  assert.equal(urlFotoPremio(12, 3), '/api/motorista/campanhas/12/premios/3/foto');
});

// ── Melhor extrato ───────────────────────────────────────────────────────

test('fmtReais: pt-BR com milhar e centavos', () => {
  assert.equal(fmtReais(128450), 'R$ 1.284,50');
  assert.equal(fmtReais(5), 'R$ 0,05');
  assert.equal(fmtReais(0), 'R$ 0,00');
  assert.equal(fmtReais(123456789), 'R$ 1.234.567,89');
});

test('textoMotivo: taxa, pedidos e leitura ausente', () => {
  assert.equal(textoMotivo({ criterio: 'tempo', lido: 0.65, minimo: 0.7 }), 'Tempo online 65% (mínimo 70%)');
  assert.equal(textoMotivo({ criterio: 'aceitacao', lido: 0.864, minimo: 0.9 }), 'Aceitação 86,4% (mínimo 90%)');
  assert.equal(textoMotivo({ criterio: 'pedidos', lido: 3, minimo: 5 }), 'Pedidos 3 (mínimo 5)');
  assert.equal(textoMotivo({ criterio: 'tempo', lido: null, minimo: 0.7 }), 'Tempo online sem leitura (mínimo 70%)');
  assert.equal(textoMotivo({ criterio: 'pedidos', lido: null, minimo: 5 }), 'Pedidos sem leitura (mínimo 5)');
  assert.equal(textoMotivo({ criterio: 'conclusao', lido: 0, minimo: 0.8 }), 'Conclusão 0% (mínimo 80%)');
});

test('rotuloTurno: dia da semana a partir da data', () => {
  assert.equal(rotuloTurno('2026-11-21', 'JANTAR 21H30-23H59'), 'Sáb 21/11 · JANTAR 21H30-23H59');
  assert.equal(rotuloTurno('lixo', 'X'), 'X');
});

const turno = (o: Partial<TurnoExtrato>): TurnoExtrato => ({
  data: '2026-11-20', turno: 'JANTAR', valido: true, temValor: true, valorCentavos: 14820, motivos: [], ...o,
});

test('linhaTurno: válido, inválido com motivo e valor, aguardando faturamento (E4)', () => {
  const v = linhaTurno(turno({}));
  assert.equal(v.estado, 'valido');
  assert.equal(v.valor, 'R$ 148,20');
  const i = linhaTurno(turno({ valido: false, valorCentavos: 12100, motivos: [{ criterio: 'tempo', lido: 0.65, minimo: 0.7 }, { criterio: 'pedidos', lido: 3, minimo: 5 }] }));
  assert.equal(i.estado, 'invalido');
  assert.equal(i.detalhe, 'Tempo online 65% (mínimo 70%) · Pedidos 3 (mínimo 5)');
  assert.equal(i.valor, 'R$ 121,00');
  // sem faturamento nunca é inválido, mesmo com valido=false e motivos
  const a = linhaTurno(turno({ valido: false, temValor: false, valorCentavos: 0, motivos: [{ criterio: 'tempo', lido: null, minimo: 0.7 }] }));
  assert.equal(a.estado, 'aguardando');
  assert.equal(a.detalhe, 'Aguardando faturamento');
  assert.equal(a.valor, '—');
});

test('rankingExtrato (X2): só posição e nome; nenhum valor em R$ nem campo de valor', () => {
  // O servidor não deveria mandar valor; se mandar por engano, não pode chegar à tela.
  const top = Array.from({ length: 10 }, (_, k) => ({
    posicao: k + 1, nomeAbreviado: `Motorista ${k + 1}.`, valorCentavos: 99900 + k, valor: 'R$ 999,00',
  })) as unknown as LinhaTopExtrato[];
  const r = rankingExtrato(top, 5);
  assert.deepEqual(r.podio.map((l) => l.posicao), [2, 1, 3]);
  assert.deepEqual(r.resto.map((l) => l.posicao), [4, 5, 6, 7, 8, 9, 10]);
  assert.equal(r.resto.find((l) => l.souEu)?.posicao, 5);
  const json = JSON.stringify(r);
  assert.doesNotMatch(json, /R\$|valor|centavos|99900/i);
  for (const l of [...r.podio, ...r.resto]) assert.deepEqual(Object.keys(l).sort(), ['nome', 'posicao', 'souEu']);
});

test('tela do extrato: pódio e top 10 não referenciam valor em R$ (guarda no fonte)', () => {
  const src = readFileSync(new URL('../components/campanha-extrato.tsx', import.meta.url), 'utf8');
  const bloco = src.slice(src.indexOf('function PodioExtrato'), src.indexOf('type CargaTurnos'));
  assert.ok(bloco.includes('<ol') && bloco.length > 500, 'guarda anti-oco: bloco do pódio/top 10 encontrado');
  assert.doesNotMatch(bloco, /fmtReais|valorCentavos|R\$|faltam/);
});

test('textoTurnoValido: lista só os cortes definidos', () => {
  assert.equal(textoTurnoValido({ aceitacao: 0.9, conclusao: null, tempo: 0.7, pedidos: null }), 'Turno válido: tempo online ≥ 70% e aceitação ≥ 90% no turno.');
  assert.match(textoTurnoValido({ aceitacao: null, conclusao: null, tempo: null, pedidos: 5 }), /pedidos ≥ 5/);
  assert.match(textoTurnoValido({ aceitacao: null, conclusao: null, tempo: null, pedidos: null }), /soma o valor/);
});

test('app não cita o total de motoristas (guarda no fonte, P6/P7)', () => {
  for (const f of ['../app/(app)/campanhas/[id]/page.tsx', '../components/campanha-extrato.tsx', '../components/card-campanha.tsx']) {
    const src = readFileSync(new URL(f, import.meta.url), 'utf8');
    assert.ok(src.includes('ordinal('), `guarda anti-oco: ${f} lido`);
    assert.ok(!/totalClassificados|item\.total/.test(src), f);
  }
});

test('0133: status e rodapé do prêmio com e sem data', () => {
  const f = (iso: string) => iso.slice(8, 10) + '/' + iso.slice(5, 7);
  assert.equal(textoStatusPremio('dinheiro', null, '2026-12-05', f), 'Pagamento previsto em 05/12');
  assert.equal(textoStatusPremio('objeto', null, '2026-12-05', f), 'Entrega prevista em 05/12');
  assert.equal(textoStatusPremio('dinheiro', null, null, f), 'Aparece no seu repasse');
  assert.equal(textoStatusPremio('objeto', null, null, f), 'A equipe Movee combina a entrega com você');
  assert.equal(textoStatusPremio('objeto', '2026-12-01', '2026-12-05', f), 'Entregue em 01/12');
  assert.match(textoRodapePremio('2026-12-05'), /entrega prevista em 05\/12.*pagamento previsto em 05\/12/);
  assert.match(textoRodapePremio(null), /combina a entrega/);
});

test('0133/C7: texto de dinheiro usa dataPagamento ?? dataPremio; objeto ignora dataPagamento', () => {
  const f = (iso: string) => iso.slice(8, 10) + '/' + iso.slice(5, 7);
  assert.equal(textoStatusPremio('dinheiro', null, '2026-12-05', f, '2026-12-06'), 'Pagamento previsto em 06/12');
  assert.equal(textoStatusPremio('dinheiro', null, '2026-12-05', f, null), 'Pagamento previsto em 05/12');
  assert.equal(textoStatusPremio('dinheiro', null, null, f, '2026-12-06'), 'Pagamento previsto em 06/12');
  assert.equal(textoStatusPremio('objeto', null, '2026-12-05', f, '2026-12-06'), 'Entrega prevista em 05/12');
});

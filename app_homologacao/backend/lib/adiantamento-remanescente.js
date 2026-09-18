/**
 * adiantamento-remanescente.js — helpers PUROS (sem I/O) de período de
 * apuração, cálculo do remanescente por entregador e serialização CSV do
 * módulo Adiantamento (tasks.md FASE 2, 2.4).
 *
 * Ref: Spec §FR-037, §FR-038, §FR-040, §FR-041; contracts/hub-api.md
 * §Repasse; PLANO.md §18 "Remanescente semanal" (R-15, R-16, D-09..D-12).
 */

'use strict';

const { escaparCelulaCsvInjection, quotarCelulaCsv } = require('./hub-csv');

function iso(d) {
  return d.toISOString().slice(0, 10);
}

/** Converte um valor decimal (string/number) para centavos inteiros — mesma
 * técnica de `validarPlanilhaTransfeera` (lib/adiantamento-transfeera-xlsx.js).
 * Arredondar na ENTRADA (antes de somar) evita que reduce()+toFixed(2) no fim
 * acumule erro de ponto flutuante (2.7.1, dec-063).
 *
 * NUNCA multiplica em ponto flutuante (dec-067, revisão onda-013): `Math.round(
 * Number(v) * 100)` só arredondava "meio para cima" (FR-010) por sorte do
 * binário — medido: `2.675` → 268 (certo) mas `1.005` → 100 e `8.165` → 816
 * (deveriam ser 101 e 817, pois `1.005 * 100 === 100.49999999999999`). Em vez
 * disso, separa sinal/parte inteira/casas decimais da representação decimal
 * (`String(valor)`) e decide o arredondamento olhando só a 3ª casa decimal: se
 * ela for `5`..`9` a magnitude sobe 1 centavo, senão trunca — equivalente a
 * "meio para cima" pois qualquer dígito seguinte só poderia aumentar o resto,
 * nunca diminuí-lo. Sinal aplicado por último (arredonda pela magnitude, igual
 * ao `round()` numeric do Postgres usado em `hub_adiantamento_processar`). */
function paraCentavos(valor) {
  const str = String(valor).trim();
  const casado = str.match(/^(-?)(\d+)(?:[.,](\d+))?$/);
  if (!casado) return Math.round(Number(valor) * 100); // fallback: formato não-decimal (ex.: notação científica)
  const [, sinal, inteiro, decimais = ''] = casado;
  const duasCasas = Number((decimais + '00').slice(0, 2));
  const terceiraCasa = decimais.charAt(2);
  const magnitude = Number(inteiro) * 100 + duasCasas + (terceiraCasa >= '5' ? 1 : 0);
  return sinal === '-' ? -magnitude : magnitude;
}

/** Formata centavos inteiros como string decimal de 2 casas por fatiamento
 * de string — nenhuma divisão de ponto flutuante entra na formatação
 * (2.7.1: "formatar a partir dos centavos"). */
function formatarCentavos(centavos) {
  const negativo = centavos < 0;
  const digitos = String(Math.abs(centavos)).padStart(3, '0');
  return `${negativo ? '-' : ''}${digitos.slice(0, -2)}.${digitos.slice(-2)}`;
}

/**
 * Período de apuração W (PLANO §18): 7 dias de calendário a partir de
 * `dataInicioISO`; `dataRepasse = fim + apuracao_dias_ate_repasse` dias.
 * Aritmética de calendário pura em UTC, sem dia útil/feriado — mesmo padrão
 * de `adiantamento-regras.js`.
 */
function calcularPeriodo(config, dataInicioISO) {
  const inicio = new Date(`${dataInicioISO}T00:00:00Z`);
  const fim = new Date(inicio);
  fim.setUTCDate(fim.getUTCDate() + 6);
  const dataRepasse = new Date(fim);
  dataRepasse.setUTCDate(dataRepasse.getUTCDate() + Number(config.apuracao_dias_ate_repasse || 0));
  return { inicio: iso(inicio), fim: iso(fim), dataRepasse: iso(dataRepasse) };
}

/** `dataISO` (`"AAAA-MM-DD"`) está dentro de `[periodo.inicio, periodo.fim]`
 * (inclusive) — comparação lexicográfica de string ISO, válida porque as
 * três datas têm o mesmo formato de largura fixa. */
function dataNoPeriodo(dataISO, periodo) {
  return dataISO >= periodo.inicio && dataISO <= periodo.fim;
}

/** Soma, em centavos inteiros, o valor BRUTO (D-11) dos adiantamentos pagos
 * cuja `data_producao` caia no período — um adiantamento entra no período da
 * sua PRÓPRIA `data_producao` (D-12), nunca da data de solicitação/pagamento;
 * os que caem fora da janela não entram na soma. Soma só em inteiros (2.7.1):
 * nenhum float é acumulado, por maior que seja a lista. */
function somaCentavosNoPeriodo(adiantamentosPagos, periodo) {
  return (adiantamentosPagos || [])
    .filter((a) => dataNoPeriodo(a.data_producao, periodo))
    .reduce((acc, a) => acc + paraCentavos(a.valor_bruto), 0);
}

/** Mesma soma que `somaCentavosNoPeriodo`, em reais (Number) — contrato
 * público preservado; a única divisão por 100 acontece aqui, uma vez, sobre
 * um inteiro já correto (nunca sobre uma soma de floats acumulada). */
function somaAdiantamentosNoPeriodo(adiantamentosPagos, periodo) {
  return somaCentavosNoPeriodo(adiantamentosPagos, periodo) / 100;
}

/**
 * Linha de remanescente por entregador (R-15/R-16, 2.4.1): créditos − (se
 * `desconto_adiantamentos`) bruto dos adiantamentos pagos com
 * `data_producao` no período − (se `desconto_debitos`) débitos. Negativo é
 * só SINALIZADO (`negativo:true`) — nunca transportado para a semana
 * seguinte (FR-040, 2.4.2); quem chama decide o que fazer com o alerta.
 *
 * Toda a aritmética roda em centavos inteiros (2.7.1); os `*Centavos` no
 * retorno (2.7.2) são a fonte de verdade para quem formata a string final —
 * evita reconverter por float (`Number(x).toFixed(2)`) o que já foi somado.
 */
function calcularLinhaRemanescente({ entregadorId, nome, creditos, adiantamentosPagos, debitos }, periodo, config) {
  const creditosCentavos = paraCentavos(creditos);
  const adiantamentosCentavos = config.desconto_adiantamentos ? somaCentavosNoPeriodo(adiantamentosPagos, periodo) : 0;
  const debitosCentavos = config.desconto_debitos ? paraCentavos(debitos || 0) : 0;
  const remanescenteCentavos = creditosCentavos - adiantamentosCentavos - debitosCentavos;
  return {
    entregadorId,
    nome,
    creditos: creditosCentavos / 100,
    adiantamentos: adiantamentosCentavos / 100,
    debitos: debitosCentavos / 100,
    remanescente: remanescenteCentavos / 100,
    negativo: remanescenteCentavos < 0,
    creditosCentavos,
    adiantamentosCentavos,
    debitosCentavos,
    remanescenteCentavos,
  };
}

// --- CSV (2.4.3) -------------------------------------------------------------

const CABECALHOS_CSV = ['Entregador', 'Créditos', 'Adiantamentos', 'Débitos', 'Remanescente'];

function celulaCsv(valor) {
  return quotarCelulaCsv(escaparCelulaCsvInjection(valor === null || valor === undefined ? '' : valor));
}

/** Formata um campo monetário da linha a partir dos centavos (2.7.1): usa o
 * `*Centavos` já calculado quando presente; senão reconverte via
 * `paraCentavos` (linhas de teste/fixture antigas, sem os campos novos) —
 * em ambos os casos a string sai de `formatarCentavos`, nunca de
 * `Number(x).toFixed(2)`. */
function celulaMoeda(linha, campo) {
  const centavos = linha[`${campo}Centavos`] ?? paraCentavos(linha[campo]);
  return celulaCsv(formatarCentavos(centavos));
}

/** CSV (RFC 4180 + proteção de injeção de fórmula, S5) das linhas de
 * remanescente — mesma dupla `escaparCelulaCsvInjection` + `quotarCelulaCsv`
 * usada em `routes/hub-faturamento.js`/`lib/hub-csv.js`. */
function serializarCsvRemanescente(linhas) {
  const cabecalho = CABECALHOS_CSV.join(',');
  const corpo = linhas.map((l) =>
    [celulaCsv(l.nome), celulaMoeda(l, 'creditos'), celulaMoeda(l, 'adiantamentos'), celulaMoeda(l, 'debitos'), celulaMoeda(l, 'remanescente')].join(','),
  );
  return [cabecalho, ...corpo].join('\r\n');
}

module.exports = {
  calcularPeriodo,
  dataNoPeriodo,
  somaAdiantamentosNoPeriodo,
  calcularLinhaRemanescente,
  serializarCsvRemanescente,
  paraCentavos,
  formatarCentavos,
};

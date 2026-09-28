// F4-B: decide o que vira movimento na EnvioMassa a partir de uma apuração
// FECHADA, e monta a linha. Lógica pura — sem banco, sem HTTP — porque é aqui
// que o dinheiro se reparte e um erro só apareceria na nota do motorista.
//
// A rota (routes/hub-adiantamentos.js) só busca os dados e aplica o resultado.

const { renderizarMensagem } = require('./adiantamento-mensagem');

/** Motivos de recusa. Cada um vira uma linha do relatório, com nome próprio:
 *  "não gerou" sem motivo obriga o operador a adivinhar. */
const MOTIVOS = {
  SEM_CNPJ: 'Motorista sem CNPJ no hub — não há como emitir nota.',
  SEM_DIVISAO: 'A apuração foi fechada antes de "entra na nota" ser configurado.',
  VALOR_ZERO: 'Base da nota é zero — nada a emitir.',
  JA_GERADO: 'O hub já gerou movimento para este motorista nesta apuração.',
  MOVIMENTO_ABERTO: 'O motorista já tem movimento aberto (provavelmente da planilha).',
  // F3/FR-014/FR-020: total (semana + saldo carregado) abaixo do piso mínimo
  // — a semana inteira fica retida e soma automaticamente ao próximo repasse.
  RETIDO: 'Saldo abaixo do mínimo — entra no próximo repasse.',
  // Issue #229: a planilha não conhece a retenção. Se já saiu movimento (aberto
  // OU fechado) cobrindo uma semana cujo valor passou para a frente, somar esse
  // saldo nesta nota emitiria o mesmo valor duas vezes.
  MOVIMENTO_LEGADO_EM_SEMANA_RETIDA:
    'Já existe movimento pelo método antigo cobrindo semana que passou para a próxima — resolva com o financeiro antes de gerar.',
};

/** timestamptz (ISO) ou 'YYYY-MM-DD' -> 'YYYY-MM-DD' no fuso do negócio. Sem
 *  isso um dt_final às 23:59 -03 viraria o dia seguinte em UTC. */
function dataLocal(v) {
  if (!v) return null;
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
}

/**
 * Issue #229 — quem vai receber agora um saldo carregado cujas semanas de
 * origem já tiveram movimento pelo método antigo.
 *
 * @param itens       itens da apuração que está gerando notas
 * @param historico   ApuracaoRepasseItem de apurações ANTERIORES, cada um com
 *                    {entregador_id, valor_pago, valor_transportado, remanescente, periodo_inicio, periodo_fim}
 * @param movimentos  EnvioMassa (qualquer mov_fechado) {id, cnpj_prestador, dt_inicial, dt_final}
 * @param contasPorEntregador  Map entregadorId -> {cnpjPrestador}
 * @param idsGeradosPeloHub  Set de EnvioMassa.id da trilha ApuracaoRepasseMovimento
 *                    — o que o próprio hub emitiu não é "método antigo" (e grava
 *                    dt_* como data pura, que em SP cairia no dia anterior e
 *                    cruzaria a semana de origem: falso bloqueio)
 * @returns {Set} entregadorIds a recusar
 *
 * As semanas de origem saem andando para trás a partir da semana anterior,
 * enquanto a semana transportou (`valor_pago = 0`, `valor_transportado > 0`).
 * Só as de remanescente >= 0 tiveram a produção carregada; a semana negativa
 * só preserva o saldo e emite a própria nota (dec-055), então não conta.
 */
function entregadoresComMovimentoEmSemanaRetida(itens, historico, movimentos, contasPorEntregador,
  idsGeradosPeloHub = new Set()) {
  const bloqueados = new Set();
  const comSaldo = itens.filter((i) => num(i.remanescente) >= 0
    && (num(i.saldo_anterior_nota) > 0 || num(i.saldo_anterior_fora) > 0));
  if (comSaldo.length === 0) return bloqueados;

  const historicoPor = new Map();
  for (const h of historico || []) {
    if (!historicoPor.has(h.entregador_id)) historicoPor.set(h.entregador_id, []);
    historicoPor.get(h.entregador_id).push(h);
  }
  const movimentosPor = new Map();
  for (const m of movimentos || []) {
    if (idsGeradosPeloHub.has(m.id)) continue;
    if (!movimentosPor.has(m.cnpj_prestador)) movimentosPor.set(m.cnpj_prestador, []);
    movimentosPor.get(m.cnpj_prestador).push({ ini: dataLocal(m.dt_inicial), fim: dataLocal(m.dt_final) });
  }

  for (const item of comSaldo) {
    const cnpj = contasPorEntregador.get(item.entregador_id)?.cnpjPrestador;
    const movs = cnpj ? movimentosPor.get(cnpj) : null;
    if (!movs || movs.length === 0) continue;

    const semanas = [];
    const linhas = [...(historicoPor.get(item.entregador_id) || [])]
      .sort((a, b) => (a.periodo_inicio < b.periodo_inicio ? 1 : -1));
    for (const h of linhas) {
      if (!(num(h.valor_pago) === 0 && num(h.valor_transportado) > 0)) break;
      if (num(h.remanescente) >= 0) semanas.push({ ini: h.periodo_inicio, fim: h.periodo_fim });
    }

    // Movimento sem data não prova nada — só bloqueia o que cruza a semana.
    const cruza = semanas.some((s) => movs.some((m) => m.ini && m.fim && m.ini <= s.fim && m.fim >= s.ini));
    if (cruza) bloqueados.add(item.entregador_id);
  }
  return bloqueados;
}

/** `500.00` (string ou número) -> número. Valores vêm do PostgREST como texto. */
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Decide, item a item, o que gerar.
 *
 * @param itens        linhas de ApuracaoRepasseItem (congeladas)
 * @param contasPorEntregador  Map entregadorId -> {cnpjPrestador, nome, telefone}
 * @param jaGerados    Set de entregadorId já registrados na trilha desta apuração
 * @param cnpjsComMovimentoAberto  Set de cnpj_prestador com movimento aberto na EnvioMassa
 * @param contexto     {cnpjTomador, idEmpresa, periodoInicio, periodoFim, mensagem1Modelo, mensagem2Modelo}
 * @param comMovimentoEmSemanaRetida  Set de entregadorId (issue #229) — ver
 *                     `entregadoresComMovimentoEmSemanaRetida`
 * @returns {{ aGerar: Array, recusados: Array }}
 */
function planejarGeracao(itens, contasPorEntregador, jaGerados, cnpjsComMovimentoAberto, contexto,
  comMovimentoEmSemanaRetida = new Set()) {
  const aGerar = [];
  const recusados = [];

  for (const item of itens) {
    const entregadorId = item.entregador_id;
    const conta = contasPorEntregador.get(entregadorId);
    const recusar = (motivo) => recusados.push({ entregadorId, nome: conta?.nome ?? null, motivo, detalhe: MOTIVOS[motivo] });

    // F3/FR-014/FR-020: item retido (0 < total < piso, remanescente>=0) nunca
    // gera nota nesta semana — o saldo já foi transportado pelo fechamento
    // (banco) e entra automaticamente no cálculo da semana seguinte.
    // `valor_pago` NULL = item pré-regra (Decision 7) — sem retenção.
    // `remanescente >= 0` casa com a MESMA formula de "retido" já usada pelo
    // SQL (`hub_adiantamento_repasse_congelado`/`_motorista_ultimo_fechado`,
    // migration 0098 linhas 438/497/670) — sem essa cláusula, uma semana com
    // remanescente NEGATIVO e saldo carregado (`valor_transportado =
    // saldo_anterior`, 0098:268) ficava presa como se estivesse "abaixo do
    // piso", quando na verdade nunca teve retenção nenhuma (dec-055/block-008).
    const retido = item.valor_pago !== null && item.valor_pago !== undefined
      && num(item.valor_pago) === 0 && num(item.valor_transportado) > 0
      && num(item.remanescente) >= 0;
    if (retido) { recusar('RETIDO'); continue; }

    if (!conta || !conta.cnpjPrestador) { recusar('SEM_CNPJ'); continue; }
    // `valor_nota` nulo = apuração fechada antes da F3 ser configurada. Não
    // inventar divisão: o congelado é a verdade do que foi apurado.
    if (item.valor_nota === null || item.valor_nota === undefined) { recusar('SEM_DIVISAO'); continue; }

    // F3/FR-020: item pago com saldo carregado de semana(s) anterior(es) soma
    // os componentes numa nota só — nunca gera nota extra por semana retida.
    // `saldo_anterior_nota`/`_fora` vêm NULL num item pré-regra; `num()`
    // trata como 0 e preserva o comportamento de hoje.
    //
    // Remanescente NEGATIVO é exceção (dec-055/block-008): o saldo carregado
    // não entra aqui porque a 0098 (linhas 279/284) o mantém intacto em
    // `transportado_nota`/`_fora` para a PRÓXIMA nota — somá-lo também nesta
    // duplicaria o valor quando ele finalmente for pago. A nota desta semana
    // negativa é só a produção nota-elegível dela mesma.
    const negativo = num(item.remanescente) < 0;
    const valor = num(item.valor_nota) + (negativo ? 0 : num(item.saldo_anterior_nota));
    const gorjeta = num(item.valor_fora_nota) + (negativo ? 0 : num(item.saldo_anterior_fora));
    if (valor <= 0) { recusar('VALOR_ZERO'); continue; }

    // A trilha vem antes da guarda de movimento aberto de propósito: se o hub
    // já gerou e o movimento foi fechado depois, o motivo certo é JA_GERADO,
    // não "pode gerar".
    if (jaGerados.has(entregadorId)) { recusar('JA_GERADO'); continue; }
    if (cnpjsComMovimentoAberto.has(conta.cnpjPrestador)) { recusar('MOVIMENTO_ABERTO'); continue; }
    if (comMovimentoEmSemanaRetida.has(entregadorId)) { recusar('MOVIMENTO_LEGADO_EM_SEMANA_RETIDA'); continue; }

    const dados = {
      nome: conta.nome, valor, gorjeta, total: valor + gorjeta,
      periodoInicio: contexto.periodoInicio, periodoFim: contexto.periodoFim,
    };

    aGerar.push({
      entregadorId,
      // Telefone ausente NÃO impede (decisão do operador 2026-09-23): a nota é
      // emitida e validada do mesmo jeito; só o disparo por WhatsApp não
      // alcança, e o relatório avisa.
      semTelefone: !conta.telefone,
      linha: {
        number: conta.telefone ?? null,
        nome: conta.nome,
        valor,
        gorjeta: gorjeta > 0 ? gorjeta : null,   // a planilha grava null quando não há (FR-003/CL-002)
        cnpj_prestador: conta.cnpjPrestador,
        cnpj_tomador: contexto.cnpjTomador,
        id_empresa: contexto.idEmpresa,
        dt_inicial: contexto.periodoInicio,
        dt_final: contexto.periodoFim,
        enviado: 'off',                          // mesmo estado inicial do upload
        mov_fechado: false,
        mensagem1: renderizarMensagem(contexto.mensagem1Modelo, dados),
        mensagem2: renderizarMensagem(contexto.mensagem2Modelo, dados),
      },
    });
  }

  return { aGerar, recusados };
}

module.exports = { planejarGeracao, entregadoresComMovimentoEmSemanaRetida, MOTIVOS };

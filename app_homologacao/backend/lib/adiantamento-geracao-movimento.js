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
};

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
 * @returns {{ aGerar: Array, recusados: Array }}
 */
function planejarGeracao(itens, contasPorEntregador, jaGerados, cnpjsComMovimentoAberto, contexto) {
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

module.exports = { planejarGeracao, MOTIVOS };

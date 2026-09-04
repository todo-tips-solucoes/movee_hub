// busca-pessoa-entrego.js (hub-motorista-360 FASE 5, tasks.md 5.3.2) — busca
// dos dados de cadastro da pessoa entregadora no portal EntreGô, por UUID.
//
// contracts/entrego-enriquecimento.md §3 — SEM endpoint de BFF confirmado
// (research.md Decision 9, spec.md FR-005/FR-016: "nunca suposto",
// Constitution VI). A via de API preferencial (page.evaluate, mesmo padrão
// de entrego-portal.js#buscarUrlsRelatorio) fica `[PROPOSTA]` até a task
// 5.3.1 (inspeção da aba Network durante os 6 passos, sessão
// operador-supervisionada — mesma metodologia de
// docs/plans/robo-entrego/ACHADOS-PORTAL.md §1-7) ser executada e
// documentada em ACHADOS-PORTAL.md. Implementado aqui SÓ o fallback
// declarado: os 6 XPaths do operador (BRIEFING-INPUT.md linhas 41-48,
// NENHUM verificado contra a plataforma real), navegação de UI completa até
// a página "Dados da pessoa entregadora".
//
// IMPORTANTE — extração de campos NÃO implementada por padrão: os 6 XPaths
// só cobrem a NAVEGAÇÃO até a página; nenhuma fonte (briefing,
// ACHADOS-PORTAL.md) documenta os seletores dos campos (nome, CPF, RG,
// contato de emergência, ...) DENTRO dela. Inventar esses seletores seria
// fabricar estrutura de DOM de um sistema externo nunca inspecionado —
// violação direta do Princípio VI. `extrairDadosPessoaPlaceholder` (usado
// por padrão) lança `ErroExtracaoNaoLevantada` em vez de adivinhar; o
// chamador (enriquecimento.js) trata isso como falha que interrompe a
// rodada (mesmo espírito de ErroConfiguracaoHub — gap de implementação, não
// sinal transitório do portal). Substituível via `opts.extrairDadosPessoa`
// assim que o levantamento acontecer, sem mudar o resto do pipeline.
'use strict';

const { ErroAntibotSuspeito } = require('./entrego-portal');

// contracts/entrego-enriquecimento.md §3 — tabela de 6 XPaths (idênticos ao
// briefing, cópia literal — nenhum caractere alterado).
const XPATHS = Object.freeze({
  menu: '/html/body/div[1]/div/div/div[2]/div/div/div/div/div[2]/div[1]/div[1]/div/div[2]/span',
  itemBuscaPessoas: '/html/body/div[1]/div/div/div[2]/div/div/div/div/div[2]/div[2]/div[8]/div[1]/div/div[2]/span',
  botaoFiltro: '/html/body/div[1]/div/div/div[2]/main/div/div[1]/div[2]/button/span',
  campoUuid: '/html/body/div[2]/div/div[1]/form/div[1]/div[5]/div[1]/div/input',
  botaoAplicarFiltros: '//*[@id="pomodoro-modal-root"]/div/div[1]/form/div[2]/button[2]',
  botaoVerDetalhes: '/html/body/div[1]/div/div/div[2]/main/div/div[3]/table/tbody/tr/td[5]/button',
});

const TIMEOUT_NAVEGACAO_MS_DEFAULT = 30000;

/** Playwright localiza por XPath prefixando `xpath=` (convenção nativa da lib). */
function porXPath(xpath) {
  return `xpath=${xpath}`;
}

/** Ver cabeçalho do módulo — gap de implementação deliberado (Constitution VI), não erro de portal. */
class ErroExtracaoNaoLevantada extends Error {
  constructor(message) {
    super(message);
    this.name = 'ErroExtracaoNaoLevantada';
  }
}

/** Implementação padrão de `opts.extrairDadosPessoa` — ver cabeçalho do módulo. */
async function extrairDadosPessoaPlaceholder(_page) {
  throw new ErroExtracaoNaoLevantada(
    'busca-pessoa-entrego: seletores de campo da página "Dados da pessoa entregadora" '
    + 'não foram levantados empiricamente (docs/plans/robo-entrego/ACHADOS-PORTAL.md não '
    + 'documenta esta tela) — nunca supor DOM de sistema externo (Constitution VI). '
    + 'Substitua via opts.extrairDadosPessoa em buscarDadosPessoaPorUuid() após o '
    + 'levantamento (task 5.3.1, sessão operador-supervisionada).'
  );
}

/**
 * Navega os 6 passos até a página de detalhe da pessoa entregadora
 * (contracts/entrego-enriquecimento.md §3) e delega a extração dos campos a
 * `opts.extrairDadosPessoa` (injetável — ver ErroExtracaoNaoLevantada).
 * Qualquer elemento de navegação que não aparecer dentro do timeout é
 * suspeita de anti-bot (mesmo critério de
 * entrego-portal.js#realizarLoginCompleto) — nunca retry.
 * @param {object} page - Playwright Page (produção) ou mock (teste)
 * @param {object} opts
 * @param {string} opts.uuid - `Entregador.id_externo` (UUID EntreGô)
 * @param {(page: object) => Promise<object>} [opts.extrairDadosPessoa]
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<object>} shape de data-model.md §Shape interno de dados_entrego_json
 * @throws {ErroAntibotSuspeito} navegação (6 passos) não concluída dentro do timeout
 * @throws {ErroExtracaoNaoLevantada} extração não implementada (comportamento padrão)
 */
async function buscarDadosPessoaPorUuid(page, { uuid, extrairDadosPessoa = extrairDadosPessoaPlaceholder, timeoutMs = TIMEOUT_NAVEGACAO_MS_DEFAULT } = {}) {
  try {
    await page.click(porXPath(XPATHS.menu), { timeout: timeoutMs });
    await page.click(porXPath(XPATHS.itemBuscaPessoas), { timeout: timeoutMs });
    await page.click(porXPath(XPATHS.botaoFiltro), { timeout: timeoutMs });
    await page.fill(porXPath(XPATHS.campoUuid), uuid, { timeout: timeoutMs });
    await page.click(porXPath(XPATHS.botaoAplicarFiltros), { timeout: timeoutMs });
    await page.click(porXPath(XPATHS.botaoVerDetalhes), { timeout: timeoutMs });
  } catch (e) {
    if (e instanceof ErroExtracaoNaoLevantada) throw e;
    throw new ErroAntibotSuspeito(`busca-pessoa-entrego: navegação (6 passos) não concluída dentro do timeout (${e.message})`);
  }

  return extrairDadosPessoa(page);
}

module.exports = {
  buscarDadosPessoaPorUuid,
  extrairDadosPessoaPlaceholder,
  ErroExtracaoNaoLevantada,
  XPATHS,
};

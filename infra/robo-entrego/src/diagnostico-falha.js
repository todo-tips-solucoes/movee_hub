// diagnostico-falha.js — fotografa o estado da página quando a rodada falha.
//
// POR QUE ISTO EXISTE
// Em 2026-08-28, três execuções reais falharam e o `execucoes.jsonl` não
// explicou NENHUMA delas. Pior: 3 das 11 mensagens de erro daquela sessão
// apontavam para a conclusão ERRADA — a última dizia "nenhuma mensagem
// encontrada com o assunto" enquanto o e-mail estava na caixa havia 8 minutos
// (a causa real era a granularidade de DIA do SINCE do IMAP).
//
// Quem lê o alerta das 6h da manhã tem só o `motivo_falha`. Sem o estado da
// página e das chamadas de rede, a conclusão natural costuma ser a errada.
// Este módulo anexa esse contexto ao log, sem nunca gravar credencial.
//
// SEGURANÇA: coleta apenas ESTRUTURA (ids, textos de botão, status HTTP e path).
// Nunca valores de campo, nunca corpo de requisição, nunca cookie/token. Os
// valores de input viram booleano `preenchido`. A querystring é descartada,
// exceto o nome dos parâmetros — a do S3 carrega assinatura AWS.
'use strict';

/** Avaliado DENTRO da página (mesma disciplina dos `_eval*` de entrego-portal.js:
 *  não fecha sobre escopo do módulo). */
function _evalEstadoPagina() {
  const corta = (s, n) => String(s || '').trim().slice(0, n);
  return {
    url: location.href.split('?')[0],
    titulo: document.title,
    inputs: [...document.querySelectorAll('input')]
      .filter((e) => e.offsetParent)
      .map((e) => ({ id: e.id, type: e.type, testid: e.getAttribute('data-testid'), preenchido: !!e.value })),
    // TODOS os botões — `button[type="submit"]` volta vazio neste portal, o
    // React não renderiza o atributo (bug #2 de 2026-08-28).
    botoes: [...document.querySelectorAll('button')]
      .filter((e) => e.offsetParent)
      .map((e) => ({ texto: corta(e.innerText, 40), disabled: !!e.disabled })),
    erros: [...document.querySelectorAll('[role="alert"],[class*="rror"],[class*="lert"]')]
      .filter((e) => e.offsetParent)
      .map((e) => corta(e.innerText, 120))
      .filter(Boolean)
      .slice(0, 5),
    texto: corta(document.body && document.body.innerText, 400),
  };
}

/**
 * Liga a captura de rede na página. Chamar UMA vez, logo após criar a page.
 * Guarda só método/status/path — nunca corpo, nunca querystring com assinatura.
 * @returns {{eventos: string[]}} referência viva, lida por `coletar`.
 */
function instrumentarRede(page, { limite = 40 } = {}) {
  const eventos = [];
  try {
    page.on('response', (r) => {
      try {
        const u = String(r.url());
        if (!/entregolog\.com|amazonaws\.com/.test(u)) return;
        if (/\.(js|css|woff2?|png|jpe?g|svg|ico|ttf)(\?|$)/.test(u)) return;
        const semQs = u.split('?')[0];
        const params = u.includes('?') ? `?[${u.split('?')[1].split('&').map((p) => p.split('=')[0]).join(',')}]` : '';
        if (eventos.length < limite) eventos.push(`${r.status()} ${r.request().method()} ${semQs}${params}`);
      } catch (_) { /* um evento perdido não pode derrubar a rodada */ }
    });
  } catch (_) { /* page sem .on (mock/teste): segue sem rede */ }
  return { eventos };
}

/**
 * Coleta o diagnóstico. NUNCA lança — uma falha aqui não pode mascarar a falha
 * original que estamos tentando explicar.
 * @returns {Promise<object>} objeto serializável para o log
 */
async function coletar(page, rede, { screenshotPath } = {}) {
  const diag = { capturado_em: new Date().toISOString() };

  try {
    if (page && typeof page.evaluate === 'function') {
      diag.pagina = await page.evaluate(_evalEstadoPagina);
    }
  } catch (e) {
    diag.pagina_erro = String((e && e.message) || e).slice(0, 200);
  }

  if (rede && Array.isArray(rede.eventos)) diag.rede = rede.eventos.slice(-15);

  if (screenshotPath && page && typeof page.screenshot === 'function') {
    try {
      await page.screenshot({ path: screenshotPath, fullPage: true });
      diag.screenshot = screenshotPath;
    } catch (e) {
      diag.screenshot_erro = String((e && e.message) || e).slice(0, 120);
    }
  }

  return diag;
}

module.exports = { instrumentarRede, coletar, _evalEstadoPagina };

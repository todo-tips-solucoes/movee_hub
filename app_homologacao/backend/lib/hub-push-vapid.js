/**
 * hub-push-vapid.js — carga e validação da chave VAPID no boot (FASE 2,
 * tasks.md 2.3).
 *
 * Lê `VAPID_KEYS_FILE` no formato gravado por `infra/hub/scripts/gen-vapid.sh`
 * (`chavePublica`, `chavePrivada`, `keyId`, `geradoPor`, `geradoEm`), valida
 * a forma (tamanhos EC P-256 decodificados e `keyId = sha256(chavePublica)
 * .slice(0,16)` hex — mesma fórmula do script e de data-model.md Entity
 * PushChaveVapid) e expõe `getKeyAtual()` para as rotas que precisam da
 * chave pública/keyId ativos.
 *
 * Fail-closed (FR-025/FR-026, tasks 2.3.2): arquivo ausente ou inválido faz
 * `getKeyAtual()` LANÇAR — quem chama (rota) captura e responde
 * `503 PUSH_INDISPONIVEL` (contracts/motorista-push.md).
 *
 * O registro em `"PushChaveVapid"` + auditoria `push_chave_registrada`
 * (mitigação S9 — `geradoPor` vem do próprio arquivo, nunca inferido) é
 * feito via `registrarFn` INJETADA em `inicializar()` — a assinatura do
 * claim de worker `hub_push_worker` e a chamada real ao PostgREST para essa
 * escrita são explicitamente FASE 5.2 (tasks.md), fora do escopo desta
 * tarefa; aqui só o mecanismo de injeção existe, testável sem PostgREST
 * real (node --test), mesmo padrão de `lib/envio-gate.js`/
 * `lib/hub-faturamento-dto.js` (`env`/`agora` injetáveis).
 *
 * A chave PRIVADA nunca fica em `getKeyAtual()` (só a rota pública de
 * chave-pública/keyId a consome) — quem assina o push é o worker de envio
 * (FASE 5), que lê o arquivo direto.
 *
 * Ref: contracts/motorista-push.md, data-model.md Entity PushChaveVapid,
 * infra/hub/scripts/gen-vapid.sh.
 */

'use strict';

const fs = require('fs');
const crypto = require('crypto');

const CAMPOS_OBRIGATORIOS = ['chavePublica', 'chavePrivada', 'keyId', 'geradoPor', 'geradoEm', 'subject'];
const REGEX_SUBJECT = /^(mailto:|https:)/;
const CHAVE_PUBLICA_BYTES = 65;
const CHAVE_PUBLICA_PREFIXO = 0x04;
const CHAVE_PRIVADA_BYTES = 32;

const REGEX_BASE64URL = /^[A-Za-z0-9_-]+$/;

// Estado do módulo — populado por `inicializar()`, lido por `getKeyAtual()`.
// Um único processo backend só tem 1 chave ativa por vez (mesma premissa de
// `lib/envio-gate.js`: sem classe, sem singleton factory — 1 boot, 1 estado).
let chaveAtual = null;

/** 16 hex de sha256(chavePublica) — mesma fórmula de gen-vapid.sh e data-model.md. */
function calcularKeyId(chavePublica) {
  return crypto.createHash('sha256').update(String(chavePublica || '')).digest('hex').slice(0, 16);
}

function decodificarBase64Url(str) {
  if (typeof str !== 'string' || str === '' || !REGEX_BASE64URL.test(str)) return null;
  try {
    return Buffer.from(str, 'base64url');
  } catch (e) {
    return null;
  }
}

/**
 * Valida a FORMA do conteúdo já parseado (sem tocar disco) — separado de
 * `carregarArquivoChave` para ser testável sem fixture em disco.
 * @param {object} conteudoCru
 * @returns {{ok:true, chave:{chavePublica:string, chavePrivada:string,
 *   keyId:string, geradoPor:string, geradoEm:string}}
 *   | {ok:false, erro:'campo_faltando', motivo:string}
 *   | {ok:false, erro:'chave_publica_invalida'|'chave_privada_invalida'|'key_id_divergente'}}
 */
function validarConteudoChave(conteudoCru) {
  const c = conteudoCru && typeof conteudoCru === 'object' ? conteudoCru : {};

  for (const campo of CAMPOS_OBRIGATORIOS) {
    if (typeof c[campo] !== 'string' || !c[campo]) {
      return { ok: false, erro: 'campo_faltando', motivo: campo };
    }
  }

  const pubBuf = decodificarBase64Url(c.chavePublica);
  if (!pubBuf || pubBuf.length !== CHAVE_PUBLICA_BYTES || pubBuf[0] !== CHAVE_PUBLICA_PREFIXO) {
    return { ok: false, erro: 'chave_publica_invalida' };
  }

  const privBuf = decodificarBase64Url(c.chavePrivada);
  if (!privBuf || privBuf.length !== CHAVE_PRIVADA_BYTES) {
    return { ok: false, erro: 'chave_privada_invalida' };
  }

  if (c.keyId !== calcularKeyId(c.chavePublica)) {
    return { ok: false, erro: 'key_id_divergente' };
  }

  // FASE 5 (research.md Decision 2: "Formato: { publicKey, privateKey,
  // subject, geradoPor, geradoEm }") — o worker de envio (lib/hub-push-worker.js)
  // precisa de um `subject` VAPID (`mailto:`/`https:`, exigido pela lib
  // `web-push`, research.md linha 26) para assinar os envios. Fornecido pelo
  // OPERADOR no próprio arquivo de chave (gen-vapid.sh --subject) — nunca
  // inventado aqui.
  if (typeof c.subject !== 'string' || !REGEX_SUBJECT.test(c.subject)) {
    return { ok: false, erro: 'subject_invalido' };
  }

  return {
    ok: true,
    chave: {
      chavePublica: c.chavePublica,
      chavePrivada: c.chavePrivada,
      keyId: c.keyId,
      geradoPor: c.geradoPor,
      geradoEm: c.geradoEm,
      subject: c.subject,
    },
  };
}

/**
 * Lê e valida `VAPID_KEYS_FILE`. Síncrono (só roda 1x no boot, mesmo padrão
 * de leitura de segredo em disco desta base — `gen-secrets.sh`/`gen-vapid.sh`).
 * @param {string} caminho
 * @returns {ReturnType<typeof validarConteudoChave> | {ok:false, erro:'arquivo_ausente'|'json_invalido'}}
 */
function carregarArquivoChave(caminho) {
  let bruto;
  try {
    bruto = fs.readFileSync(caminho, 'utf8');
  } catch (e) {
    return { ok: false, erro: 'arquivo_ausente' };
  }

  let json;
  try {
    json = JSON.parse(bruto);
  } catch (e) {
    return { ok: false, erro: 'json_invalido' };
  }

  return validarConteudoChave(json);
}

/**
 * Inicializa o gerenciador no boot. Arquivo ausente/inválido NÃO lança
 * aqui — só deixa `chaveAtual` nulo; quem lança é `getKeyAtual()` (fail-closed,
 * tasks 2.3.2), chamada de dentro da rota que decide o `503 PUSH_INDISPONIVEL`.
 * @param {object} opts
 * @param {string} opts.caminhoArquivo - valor de `VAPID_KEYS_FILE`
 * @param {(chave:{chavePublica:string,keyId:string,geradoPor:string,geradoEm:string}) => (Promise<void>|void)} [opts.registrarFn]
 *   - grava `"PushChaveVapid"` + auditoria `push_chave_registrada`; omitida
 *   em teste puro de carregamento (FASE 5.2 fornece a implementação real)
 * @returns {Promise<{ok:true}|{ok:false, erro:string, motivo?:string}>}
 */
async function inicializar(opts) {
  const o = opts || {};
  const resultado = carregarArquivoChave(o.caminhoArquivo);
  if (!resultado.ok) {
    chaveAtual = null;
    return resultado;
  }

  if (typeof o.registrarFn === 'function') {
    await o.registrarFn(resultado.chave);
  }

  chaveAtual = {
    chavePublica: resultado.chave.chavePublica,
    keyId: resultado.chave.keyId,
    geradoPor: resultado.chave.geradoPor,
    geradoEm: resultado.chave.geradoEm,
  };
  return { ok: true };
}

/**
 * Fail-closed (tasks 2.3.2): sem chave válida carregada, LANÇA — a rota
 * chamadora captura e responde `503 PUSH_INDISPONIVEL`.
 * @returns {{chavePublica:string, keyId:string, geradoPor:string, geradoEm:string}}
 */
function getKeyAtual() {
  if (!chaveAtual) {
    throw new Error('PUSH_INDISPONIVEL');
  }
  return chaveAtual;
}

/** Só para teste: reseta o estado do módulo entre casos (evita vazamento entre `describe`s). */
function _resetParaTeste() {
  chaveAtual = null;
}

module.exports = {
  calcularKeyId,
  validarConteudoChave,
  carregarArquivoChave,
  inicializar,
  getKeyAtual,
  _resetParaTeste,
  CAMPOS_OBRIGATORIOS,
  CHAVE_PUBLICA_BYTES,
  CHAVE_PRIVADA_BYTES,
};

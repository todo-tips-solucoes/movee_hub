/**
 * hub-avisos-dto.js — helpers PUROS (sem I/O) de borda de API para o
 * módulo Avisos (push para o app motorista), FASE 2 (tasks.md 2.1).
 *
 * Valida o corpo de `POST /api/v1/avisos` (contracts/hub-avisos.md): título
 * (1-60 chars), corpo (1-180 chars), `modoDestinatarios` (enum),
 * `destinatariosIds` (1-500, condicional ao modo), `chaveIdempotencia`
 * (UUID) e o tamanho do payload de push montado a partir de título+corpo
 * (≤ 1.024 bytes UTF-8, research.md Decision 11). Recusa caracteres de
 * controle Unicode `Cc` (control) e `Cf` (format, inclui os marcadores bidi
 * `U+202A`-`U+202E`/`U+2066`-`U+2069`) em título e corpo — mitigação do
 * achado owasp-security S7.
 *
 * Extraído para arquivo próprio (não inline em routes/hub-avisos.js, ainda
 * não criado — FASE 4) para ser testável isoladamente sem PostgREST/DB
 * real (node --test), mesmo padrão de lib/hub-motoristas-dto.js /
 * lib/hub-faturamento-dto.js.
 *
 * Códigos de erro retornados batem com contracts/hub-avisos.md
 * (`400 DADOS_INVALIDOS` com `motivo`; `400 CONTEUDO_EXCEDE_LIMITE` para
 * título/corpo acima do limite ou payload acima de 1.024 bytes).
 *
 * Ref: contracts/hub-avisos.md, research.md Decision 11, data-model.md
 * Entity Aviso.
 */

'use strict';

const { uuidValido } = require('./hub-import-normalizer');

const TITULO_MIN = 1;
const TITULO_MAX = 60;
const CORPO_MIN = 1;
const CORPO_MAX = 180;
const IDS_MAX = 500;
const PAYLOAD_MAX_BYTES = 1024;
const MODOS_VALIDOS = ['toda_base', 'individual', 'empresa'];

// `avisoId` ainda não existe no momento desta validação — é `serial` gerado
// pelo INSERT (data-model.md Entity Aviso), depois de já termos validado
// título/corpo. Usamos o maior valor plausível de `int4` (10 dígitos) como
// placeholder do cálculo de tamanho do payload — o payload real, com um
// `avisoId` de fato menor, nunca ultrapassa o que já passou aqui.
// (ponytail: placeholder conservador em vez de um segundo cálculo pós-insert)
const AVISO_ID_PLACEHOLDER = 9999999999;

// Unicode `Cc` (control) + `Cf` (format — cobre os marcadores bidi
// U+202A-U+202E/U+2066-U+2069 sem precisar listá-los à mão).
const REGEX_CARACTERE_CONTROLE = /[\p{Cc}\p{Cf}]/u;

/**
 * Tamanho em bytes UTF-8 do payload de push montado a partir de
 * `titulo`/`corpo` (research.md Decision 11 —
 * `{"avisoId":<int>,"titulo":"…","corpo":"…"}`), usando o placeholder de
 * `avisoId` acima. Exportada separada de `validarAviso` para ser testável
 * isoladamente (2.1.3) — dentro dos limites de caracteres de título/corpo
 * (60/180) o payload nunca chega perto de 1.024 bytes (o pior caso, só com
 * caracteres de 3 bytes UTF-8, fica em ~765), então o teste do estouro
 * exercita esta função diretamente com um `corpo` sintético maior, sem
 * precisar (nem poder) passar pelo gate de tamanho de `validarAviso`.
 * @param {string} titulo
 * @param {string} corpo
 * @returns {number}
 */
function tamanhoPayloadBytes(titulo, corpo) {
  return Buffer.byteLength(
    JSON.stringify({ avisoId: AVISO_ID_PLACEHOLDER, titulo, corpo }),
    'utf8',
  );
}

/**
 * Valida um campo de texto (título/corpo): precisa ser string não-vazia
 * depois de `trim`, sem caractere de controle/formatação Unicode.
 * @returns {{ok:true, valor:string}|{ok:false}}
 */
function validarTexto(valorCru) {
  const valor = typeof valorCru === 'string' ? valorCru.trim() : '';
  if (!valor || REGEX_CARACTERE_CONTROLE.test(valor)) {
    return { ok: false };
  }
  return { ok: true, valor };
}

/**
 * Valida o corpo de `POST /api/v1/avisos` (contracts/hub-avisos.md).
 * @param {object} corpoCru - `req.body`
 * @returns {{ok:true, titulo:string, corpo:string, modoDestinatarios:string,
 *   destinatariosIds:number[], chaveIdempotencia:string}
 *   | {ok:false, erro:'DADOS_INVALIDOS', motivo:'titulo'|'corpo'|'modo'|'ids'|'chave'}
 *   | {ok:false, erro:'CONTEUDO_EXCEDE_LIMITE'}}
 */
function validarAviso(corpoCru) {
  const corpo = corpoCru && typeof corpoCru === 'object' ? corpoCru : {};

  const tituloResult = validarTexto(corpo.titulo);
  if (!tituloResult.ok) {
    return { ok: false, erro: 'DADOS_INVALIDOS', motivo: 'titulo' };
  }
  if (tituloResult.valor.length < TITULO_MIN || tituloResult.valor.length > TITULO_MAX) {
    return { ok: false, erro: 'CONTEUDO_EXCEDE_LIMITE' };
  }
  const titulo = tituloResult.valor;

  const corpoTextoResult = validarTexto(corpo.corpo);
  if (!corpoTextoResult.ok) {
    return { ok: false, erro: 'DADOS_INVALIDOS', motivo: 'corpo' };
  }
  if (corpoTextoResult.valor.length < CORPO_MIN || corpoTextoResult.valor.length > CORPO_MAX) {
    return { ok: false, erro: 'CONTEUDO_EXCEDE_LIMITE' };
  }
  const corpoTexto = corpoTextoResult.valor;

  const modoDestinatarios = corpo.modoDestinatarios;
  if (!MODOS_VALIDOS.includes(modoDestinatarios)) {
    return { ok: false, erro: 'DADOS_INVALIDOS', motivo: 'modo' };
  }

  const idsCru = Array.isArray(corpo.destinatariosIds) ? corpo.destinatariosIds : [];
  if (modoDestinatarios === 'toda_base') {
    if (idsCru.length !== 0) {
      return { ok: false, erro: 'DADOS_INVALIDOS', motivo: 'ids' };
    }
  } else {
    const idsValidos = idsCru.length >= 1
      && idsCru.length <= IDS_MAX
      && idsCru.every((v) => Number.isInteger(v) && v > 0);
    if (!idsValidos) {
      return { ok: false, erro: 'DADOS_INVALIDOS', motivo: 'ids' };
    }
  }

  const chaveCru = typeof corpo.chaveIdempotencia === 'string' ? corpo.chaveIdempotencia.trim() : '';
  if (!uuidValido(chaveCru)) {
    return { ok: false, erro: 'DADOS_INVALIDOS', motivo: 'chave' };
  }
  const chaveIdempotencia = chaveCru.toLowerCase();

  const payloadBytes = tamanhoPayloadBytes(titulo, corpoTexto);
  if (payloadBytes > PAYLOAD_MAX_BYTES) {
    return { ok: false, erro: 'CONTEUDO_EXCEDE_LIMITE' };
  }

  return {
    ok: true,
    titulo,
    corpo: corpoTexto,
    modoDestinatarios,
    destinatariosIds: modoDestinatarios === 'toda_base' ? [] : idsCru,
    chaveIdempotencia,
  };
}

module.exports = {
  validarAviso,
  tamanhoPayloadBytes,
  MODOS_VALIDOS,
  TITULO_MAX,
  CORPO_MAX,
  IDS_MAX,
  PAYLOAD_MAX_BYTES,
};

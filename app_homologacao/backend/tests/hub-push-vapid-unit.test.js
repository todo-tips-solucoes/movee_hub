/**
 * Testes unitários — lib/hub-push-vapid.js (tasks.md FASE 2, 2.3.3).
 * Rodam com: node --test tests/hub-push-vapid-unit.test.js
 *
 * Cobre `carregarArquivoChave`/`validarConteudoChave` (arquivo ausente,
 * JSON inválido, campo faltando, sucesso, `keyId` calculado bate com
 * `sha256(chavePublica)` esperado) e `inicializar`/`getKeyAtual`
 * (fail-closed — 2.3.2 — e propagação de `geradoPor` para o `registrarFn`
 * injetado, mitigação S9).
 *
 * O par de chaves de teste é gerado EM MEMÓRIA (mesmo algoritmo de
 * `infra/hub/scripts/gen-vapid.sh` — EC P-256 via `node:crypto`) e escrito
 * num arquivo temporário só para este processo de teste — nunca a chave
 * real de `/var/lib/hub_secrets/`.
 */

'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const {
  calcularKeyId,
  validarConteudoChave,
  carregarArquivoChave,
  inicializar,
  getKeyAtual,
  _resetParaTeste,
} = require('../lib/hub-push-vapid');

/** Gera um par de chaves VAPID sintético válido (mesmo formato de gen-vapid.sh). */
function gerarChaveVapidTeste(overrides) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pubJwk = publicKey.export({ format: 'jwk' });
  const privJwk = privateKey.export({ format: 'jwk' });
  const x = Buffer.from(pubJwk.x, 'base64url');
  const y = Buffer.from(pubJwk.y, 'base64url');
  const chavePublica = Buffer.concat([Buffer.from([0x04]), x, y]).toString('base64url');
  const d = Buffer.from(privJwk.d, 'base64url');
  const chavePrivada = d.toString('base64url');
  const keyId = crypto.createHash('sha256').update(chavePublica).digest('hex').slice(0, 16);

  return Object.assign(
    {
      chavePublica,
      chavePrivada,
      keyId,
      geradoPor: 'teste-unitario',
      geradoEm: new Date().toISOString(),
      subject: 'mailto:teste-unitario@example.com',
    },
    overrides,
  );
}

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-push-vapid-test-'));
  _resetParaTeste();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  _resetParaTeste();
});

function escreverArquivo(conteudo) {
  const caminho = path.join(tmpDir, 'vapid.json');
  fs.writeFileSync(caminho, typeof conteudo === 'string' ? conteudo : JSON.stringify(conteudo));
  return caminho;
}

describe('calcularKeyId', () => {
  test('bate com sha256(chavePublica) truncado em 16 hex', () => {
    const chave = gerarChaveVapidTeste();
    const esperado = crypto.createHash('sha256').update(chave.chavePublica).digest('hex').slice(0, 16);
    assert.equal(calcularKeyId(chave.chavePublica), esperado);
    assert.equal(chave.keyId, esperado);
  });
});

describe('validarConteudoChave', () => {
  test('conteúdo válido: ok', () => {
    const chave = gerarChaveVapidTeste();
    const r = validarConteudoChave(chave);
    assert.equal(r.ok, true);
    assert.equal(r.chave.keyId, chave.keyId);
  });

  test('campo faltando (chavePrivada): campo_faltando', () => {
    const chave = gerarChaveVapidTeste();
    delete chave.chavePrivada;
    const r = validarConteudoChave(chave);
    assert.equal(r.ok, false);
    assert.equal(r.erro, 'campo_faltando');
    assert.equal(r.motivo, 'chavePrivada');
  });

  test('keyId divergente do sha256(chavePublica): key_id_divergente', () => {
    const chave = gerarChaveVapidTeste({ keyId: 'ffffffffffffffff' });
    const r = validarConteudoChave(chave);
    assert.equal(r.ok, false);
    assert.equal(r.erro, 'key_id_divergente');
  });

  test('chavePublica com tamanho errado: chave_publica_invalida', () => {
    const chave = gerarChaveVapidTeste({ chavePublica: Buffer.alloc(64, 1).toString('base64url') });
    const r = validarConteudoChave(chave);
    assert.equal(r.ok, false);
    assert.equal(r.erro, 'chave_publica_invalida');
  });

  test('chavePrivada com tamanho errado: chave_privada_invalida', () => {
    const chave = gerarChaveVapidTeste({ chavePrivada: Buffer.alloc(31, 1).toString('base64url') });
    const r = validarConteudoChave(chave);
    assert.equal(r.ok, false);
    assert.equal(r.erro, 'chave_privada_invalida');
  });

  // FASE 5 (tasks.md 5.1, research.md Decision 2) — subject VAPID exigido
  // pela lib `web-push` para assinar os envios; fornecido pelo operador no
  // arquivo, nunca inventado pelo backend.
  test('subject ausente: campo_faltando', () => {
    const chave = gerarChaveVapidTeste();
    delete chave.subject;
    const r = validarConteudoChave(chave);
    assert.equal(r.ok, false);
    assert.equal(r.erro, 'campo_faltando');
    assert.equal(r.motivo, 'subject');
  });

  test('subject sem prefixo mailto:/https:: subject_invalido', () => {
    const chave = gerarChaveVapidTeste({ subject: 'contato@example.com' });
    const r = validarConteudoChave(chave);
    assert.equal(r.ok, false);
    assert.equal(r.erro, 'subject_invalido');
  });

  test('subject com prefixo https:: ok', () => {
    const chave = gerarChaveVapidTeste({ subject: 'https://moveelog.com.br/contato' });
    const r = validarConteudoChave(chave);
    assert.equal(r.ok, true);
    assert.equal(r.chave.subject, 'https://moveelog.com.br/contato');
  });
});

describe('carregarArquivoChave', () => {
  test('arquivo ausente: arquivo_ausente', () => {
    const r = carregarArquivoChave(path.join(tmpDir, 'nao-existe.json'));
    assert.equal(r.ok, false);
    assert.equal(r.erro, 'arquivo_ausente');
  });

  test('JSON inválido: json_invalido', () => {
    const caminho = escreverArquivo('{ nao fecha o json');
    const r = carregarArquivoChave(caminho);
    assert.equal(r.ok, false);
    assert.equal(r.erro, 'json_invalido');
  });

  test('sucesso: lê e valida um arquivo real gerado no formato de gen-vapid.sh', () => {
    const chave = gerarChaveVapidTeste();
    const caminho = escreverArquivo(chave);
    const r = carregarArquivoChave(caminho);
    assert.equal(r.ok, true);
    assert.equal(r.chave.chavePublica, chave.chavePublica);
    assert.equal(r.chave.keyId, chave.keyId);
  });
});

describe('inicializar / getKeyAtual (fail-closed)', () => {
  test('getKeyAtual lança sem inicialização prévia', () => {
    assert.throws(() => getKeyAtual(), /PUSH_INDISPONIVEL/);
  });

  test('inicializar com arquivo ausente: getKeyAtual continua lançando', async () => {
    const r = await inicializar({ caminhoArquivo: path.join(tmpDir, 'nao-existe.json') });
    assert.equal(r.ok, false);
    assert.throws(() => getKeyAtual(), /PUSH_INDISPONIVEL/);
  });

  test('inicializar com arquivo válido: getKeyAtual devolve chave pública/keyId, sem a privada', async () => {
    const chave = gerarChaveVapidTeste();
    const caminho = escreverArquivo(chave);
    const r = await inicializar({ caminhoArquivo: caminho });
    assert.equal(r.ok, true);
    const atual = getKeyAtual();
    assert.equal(atual.chavePublica, chave.chavePublica);
    assert.equal(atual.keyId, chave.keyId);
    assert.equal(atual.geradoPor, chave.geradoPor);
    assert.equal('chavePrivada' in atual, false);
  });

  test('geradoPor do arquivo é propagado para o registrarFn injetado (mitigação S9)', async () => {
    const chave = gerarChaveVapidTeste({ geradoPor: 'operador-x' });
    const caminho = escreverArquivo(chave);
    let chaveRecebida = null;
    await inicializar({
      caminhoArquivo: caminho,
      registrarFn: (c) => { chaveRecebida = c; },
    });
    assert.ok(chaveRecebida);
    assert.equal(chaveRecebida.geradoPor, 'operador-x');
    assert.equal(chaveRecebida.keyId, chave.keyId);
  });

  test('rotação de chave: registrarFn grava geradoPor na Auditoria TAL COMO declarado no arquivo, sem inferir autor (task 4.3.2/4.3.3)', async () => {
    // Simula a forma da implementação real de `registrarFn` (FASE 5.2 —
    // grava "PushChaveVapid" + auditoria `push_chave_registrada`): aqui só a
    // ponta de auditoria é exercitada, com um double de
    // lib/hub-auditoria.js#registrarAuditoria — a garantia testada é que
    // `detalhes.geradoPor` é o valor LITERAL do arquivo de chave, nunca um
    // usuário/processo inferido pelo caller.
    const eventosAuditoria = [];
    async function registrarAuditoriaFake(evento) {
      eventosAuditoria.push(evento);
    }
    async function registrarFnProducaoSimulado(chave) {
      await registrarAuditoriaFake({
        idEmpresa: null,
        usuarioId: null,
        acao: 'push_chave_registrada',
        recurso: 'PushChaveVapid',
        recursoId: chave.keyId,
        detalhes: { geradoPor: chave.geradoPor },
      });
    }

    const chave = gerarChaveVapidTeste({ geradoPor: 'gen-vapid.sh@2026-09-11T00:00:00Z' });
    const caminho = escreverArquivo(chave);
    await inicializar({ caminhoArquivo: caminho, registrarFn: registrarFnProducaoSimulado });

    assert.equal(eventosAuditoria.length, 1);
    assert.equal(eventosAuditoria[0].acao, 'push_chave_registrada');
    assert.equal(eventosAuditoria[0].detalhes.geradoPor, chave.geradoPor);
    assert.notEqual(eventosAuditoria[0].detalhes.geradoPor, 'teste-unitario'); // nunca um default/inferido
  });

  test('registrarFn não é chamada quando o arquivo é inválido', async () => {
    let chamada = false;
    await inicializar({
      caminhoArquivo: path.join(tmpDir, 'nao-existe.json'),
      registrarFn: () => { chamada = true; },
    });
    assert.equal(chamada, false);
  });
});

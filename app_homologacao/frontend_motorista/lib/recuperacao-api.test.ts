/**
 * Teste unitário — lib/recuperacao-api.ts ("esqueci minha senha", 2026-09-25).
 * Mesmo padrão de lib/adiantamento-api.test.ts: stub puro de `fetch`, sem
 * jsdom e sem mock de módulo.
 *
 *   node --experimental-strip-types --test lib/recuperacao-api.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pedirRecuperacaoSenha, definirSenhaComToken } from './recuperacao-api.ts';

function fakeResponse(status: number, body?: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body ?? {} } as unknown as Response;
}

let ultimaChamada: { url: string; init: RequestInit } | null = null;

function stubFetch(status: number, body?: unknown): void {
  ultimaChamada = null;
  (globalThis as unknown as Record<string, unknown>).fetch = async (input: unknown, init?: RequestInit): Promise<Response> => {
    ultimaChamada = { url: String(input), init: init ?? {} };
    return fakeResponse(status, body);
  };
}

test('pedirRecuperacaoSenha: manda o CNPJ e devolve o e-mail mascarado', async () => {
  stubFetch(200, { ok: true, emailMascarado: 'fu***@gm***.com' });
  const r = await pedirRecuperacaoSenha('12345678000195');
  assert.equal(r.emailMascarado, 'fu***@gm***.com');
  assert.ok(ultimaChamada!.url.includes('/motorista/recuperar-senha'));
  assert.deepEqual(JSON.parse(String(ultimaChamada!.init.body)), { cnpjPrestador: '12345678000195' });
});

// Conta sem e-mail responde 200 com máscara NULA — a tela não pode tratar isso
// como erro, senão revelaria que o cadastro existe mas está incompleto.
test('pedirRecuperacaoSenha: máscara nula é resposta válida, não erro', async () => {
  stubFetch(200, { ok: true, emailMascarado: null });
  const r = await pedirRecuperacaoSenha('12345678000195');
  assert.equal(r.emailMascarado, null);
});

test('pedirRecuperacaoSenha: 429 vira exceção para a tela tratar', async () => {
  stubFetch(429, { error: 'Muitas tentativas. Aguarde alguns minutos e tente novamente.' });
  await assert.rejects(() => pedirRecuperacaoSenha('12345678000195'), /Muitas tentativas/);
});

test('definirSenhaComToken: manda token e senha nova', async () => {
  stubFetch(200, { ok: true });
  await definirSenhaComToken('a'.repeat(64), 'SenhaNova123');
  assert.ok(ultimaChamada!.url.includes('/motorista/definir-senha'));
  assert.deepEqual(JSON.parse(String(ultimaChamada!.init.body)), {
    token: 'a'.repeat(64), novaSenha: 'SenhaNova123',
  });
});

test('definirSenhaComToken: token expirado vira exceção com a mensagem do servidor', async () => {
  stubFetch(400, { error: 'Link inválido ou expirado.' });
  await assert.rejects(() => definirSenhaComToken('x'.repeat(64), 'SenhaNova123'), /inválido ou expirado/);
});

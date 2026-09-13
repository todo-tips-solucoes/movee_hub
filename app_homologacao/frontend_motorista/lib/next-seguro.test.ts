/**
 * Teste unitário — lib/next-seguro.ts (push-motorista, tasks.md 3.3.2).
 * Roda com o test runner nativo do Node (type-stripping, sem framework
 * novo — `frontend_motorista` não tem test runner instalado; ver nota no
 * cabeçalho de resolveNextSeguro sobre o parâmetro `origin` injetável):
 *
 *   node --experimental-strip-types --test lib/next-seguro.test.ts
 *
 * 5 payloads maliciosos recusados (caem no fallback) + 1 caso válido aceito
 * (contracts/motorista-push.md, achado owasp-security S3).
 *
 * ⚠️ EXIGÊNCIA EXPLÍCITA DE NODE (decisão registrada, não implícita):
 * `--experimental-strip-types` exige Node >= 22.6 (este host roda v22.22.3,
 * 8/8 verde). A imagem de PRODUÇÃO deste app (`Dockerfile:4`) é
 * `node:20-alpine`, que não suporta o flag — mas o `Dockerfile` só faz
 * `next build`/`next start`, nunca `npm test`, então isso NÃO afeta o
 * runtime do produto (tasks.md 3.3.2 §Novidades onda-015). Impacto real:
 * `npm test` neste pacote só roda num ambiente (dev/CI) com Node >= 22.6.
 * Alternativa descartada: instalar um runner TS (tsx/ts-node/esbuild) para
 * rodar em Node 20 — introduziria dependência nova só para 1 arquivo de
 * teste (bloqueado por bash-guard em execução autônoma; sem ganho real,
 * já que produção nunca executa este script). Se o CI/dev pinado em Node
 * 20 precisar rodar esta suíte, a correção é o operador decidir entre
 * elevar o Node de dev/CI para >= 22.6 ou introduzir deliberadamente um
 * runner TS — não algo a inferir aqui.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveNextSeguro } from './next-seguro.ts';

const ORIGIN = 'https://app.moveelog.com.br';

test('protocol-relative (//evil.example) -> recusado, cai no fallback', () => {
  assert.equal(resolveNextSeguro('//evil.example', '/movimento', ORIGIN), '/movimento');
});

test('barra invertida (/\\evil.example) -> recusado, cai no fallback', () => {
  assert.equal(resolveNextSeguro('/\\evil.example', '/movimento', ORIGIN), '/movimento');
});

test('TAB literal (/\\t/evil.example) -> recusado, cai no fallback', () => {
  assert.equal(resolveNextSeguro('/\t/evil.example', '/movimento', ORIGIN), '/movimento');
});

test('LF literal (/\\n/evil.example) -> recusado, cai no fallback', () => {
  assert.equal(resolveNextSeguro('/\n/evil.example', '/movimento', ORIGIN), '/movimento');
});

test('esquema javascript: -> recusado, cai no fallback', () => {
  assert.equal(resolveNextSeguro('javascript:alert(1)', '/movimento', ORIGIN), '/movimento');
});

test('caminho válido da mesma origem (/avisos/123) -> aceito', () => {
  assert.equal(resolveNextSeguro('/avisos/123', '/movimento', ORIGIN), '/avisos/123');
});

test('ausente/vazio -> fallback', () => {
  assert.equal(resolveNextSeguro(null, '/movimento', ORIGIN), '/movimento');
  assert.equal(resolveNextSeguro('', '/movimento', ORIGIN), '/movimento');
});

test('preserva query/hash de um caminho válido', () => {
  assert.equal(resolveNextSeguro('/avisos/123?x=1#topo', '/movimento', ORIGIN), '/avisos/123?x=1#topo');
});

/**
 * Teste unitário — lib/ajuda.ts e a integridade de lib/ajuda-conteudo.json
 * contra o que a tela renderiza.
 *
 *   node --experimental-strip-types --test lib/ajuda.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { imagemQuebrada, imagemSrc, ROTULO_AVISO, secaoDoHash } from './ajuda.ts';

const conteudo = JSON.parse(readFileSync(new URL('./ajuda-conteudo.json', import.meta.url), 'utf8'));

test('imagemSrc: serve de /ajuda/img/ e escapa o nome', () => {
  assert.equal(imagemSrc('01-login.png'), '/ajuda/img/01-login.png');
  assert.equal(imagemSrc('../x y.png'), '/ajuda/img/..%2Fx%20y.png');
});

test('imagemQuebrada: só complete + largura 0 conta como quebrada', () => {
  assert.equal(imagemQuebrada({ complete: true, naturalWidth: 0 }), true);
  assert.equal(imagemQuebrada({ complete: true, naturalWidth: 320 }), false);
  assert.equal(imagemQuebrada({ complete: false, naturalWidth: 0 }), false); // ainda carregando
});

test('secaoDoHash: abre só id existente', () => {
  const ids = conteudo.secoes.map((s: { id: string }) => s.id);
  assert.equal(secaoDoHash('#conta', ids), 'conta');
  assert.equal(secaoDoHash('conta', ids), 'conta');
  assert.equal(secaoDoHash('#nao-existe', ids), null);
  assert.equal(secaoDoHash('', ids), null);
  assert.equal(secaoDoHash('#a[href]', ids), null);
});

test('conteúdo: pode/não pode tem 7 e 9 itens, com o,porque,saida', () => {
  assert.equal(conteudo.podeNaoPode.pode.length, 7);
  assert.equal(conteudo.podeNaoPode.naoPode.length, 9);
  for (const n of conteudo.podeNaoPode.naoPode) {
    assert.ok(n.o && n.porque && n.saida);
  }
});

test('conteúdo: todo tipo de aviso do JSON tem rótulo', () => {
  for (const s of conteudo.secoes) {
    for (const a of s.avisos ?? []) assert.ok(a.tipo in ROTULO_AVISO, a.tipo);
  }
});

// Campos que a tela sabe renderizar (SecaoAjuda em app/(app)/ajuda/page.tsx).
// Campo novo no JSON sem entrar aqui falha — evita omitir texto em silêncio.
const CAMPOS_RENDERIZADOS = new Set([
  'id', 'titulo', 'intro', 'img', 'imgAlt', 'img2', 'img2Alt', 'passos', 'tabela', 'avisos',
  'resultados', 'errosCampos', 'regras', 'requisitos', 'motivos', 'extra', 'primeiraVez', 'esqueciSenha',
]);

test('conteúdo: toda chave de seção é renderizada pela tela', () => {
  for (const s of conteudo.secoes) {
    for (const k of Object.keys(s)) assert.ok(CAMPOS_RENDERIZADOS.has(k), `${s.id}.${k}`);
  }
});

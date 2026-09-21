/**
 * Nenhum `require` de pacote pode depender de dependência TRANSITIVA.
 *
 * Nasceu de um incidente real (bump bcrypt 5→6): o `server.js:13` fazia
 * `require('node-fetch')` sem que `node-fetch` estivesse no package.json — ele
 * vinha de carona como transitivo de bcrypt@5 → @mapbox/node-pre-gyp. O bump
 * removeu essa árvore e o backend passou a morrer no boot com MODULE_NOT_FOUND.
 *
 * Os 1538 testes não pegaram porque NENHUM carrega o server.js (ele dá listen).
 * Este teste não carrega nada: lê os require() do código e confere contra o
 * package.json. Determinístico, sem I/O de rede, pega a classe inteira do bug —
 * qualquer npm install que reorganize a árvore de transitivos.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { builtinModules } = require('node:module');

const RAIZ = path.join(__dirname, '..');
const IGNORAR = new Set(['node_modules', 'uploads', 'tests', 'coverage']);

/** Nome do pacote a partir do especificador: 'a/b' -> 'a', '@e/p/x' -> '@e/p'. */
function pacoteDe(spec) {
  return spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
}

function arquivosJs(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (IGNORAR.has(e.name) || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) arquivosJs(p, acc);
    else if (e.name.endsWith('.js')) acc.push(p);
  }
  return acc;
}

test('todo pacote exigido por require() está declarado em dependencies', () => {
  const declaradas = new Set(Object.keys(require('../package.json').dependencies || {}));
  const builtin = new Set(builtinModules);
  const fantasmas = new Map(); // pacote -> arquivos que o usam

  for (const arquivo of arquivosJs(RAIZ)) {
    const src = fs.readFileSync(arquivo, 'utf8');
    for (const m of src.matchAll(/require\(['"]([^'"]+)['"]\)/g)) {
      const spec = m[1];
      if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('node:')) continue;
      const pkg = pacoteDe(spec);
      if (builtin.has(pkg) || declaradas.has(pkg)) continue;
      if (!fantasmas.has(pkg)) fantasmas.set(pkg, []);
      fantasmas.get(pkg).push(path.relative(RAIZ, arquivo));
    }
  }

  const relato = [...fantasmas].map(([p, a]) => `  ${p} — usado em ${[...new Set(a)].join(', ')}`);
  assert.deepEqual(
    relato,
    [],
    `dependência(s) não declarada(s) em package.json — o backend morre no boot se a árvore de\n` +
    `transitivos mudar. Declare com \`npm install <pacote>\`:\n${relato.join('\n')}`,
  );
});

test('o varredor enxerga um require de pacote não declarado (controle negativo)', () => {
  // Sem este controle, o teste acima passaria igual se a regex estivesse quebrada.
  const src = "const x = require('pacote-que-nao-existe-no-json');";
  const achados = [...src.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((m) => pacoteDe(m[1]));
  assert.deepEqual(achados, ['pacote-que-nao-existe-no-json']);
});

test('pacoteDe resolve escopo e subcaminho', () => {
  assert.equal(pacoteDe('node-fetch'), 'node-fetch');
  assert.equal(pacoteDe('lodash/get'), 'lodash');
  assert.equal(pacoteDe('@mapbox/node-pre-gyp'), '@mapbox/node-pre-gyp');
  assert.equal(pacoteDe('@scope/pkg/sub/path'), '@scope/pkg');
});

/**
 * Regressão do `trust proxy` por HOPS (server.js:193).
 *
 * Por que existe: sem `trust proxy`, `req.ip` é o IP do Traefik — igual para
 * todos — e o rate limit de login virou um teto GLOBAL (incidente do 429 no
 * login motorista, PR #46). Nada guardava esse comportamento, e `proxy-addr`
 * (quem resolve `req.ip`) acabou de ser atualizado por advisory.
 *
 * O que se afirma aqui é só o que o produto usa: confiança por NÚMERO de hops.
 * A advisory GHSA-jqcg-44mw-7w3h é do caminho de SUBNET, que este backend não
 * configura — por isso não há caso de subnet neste arquivo.
 *
 *   node --test tests/trust-proxy-hops.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

// Sobe um app com a MESMA configuração do server.js e devolve o `req.ip` visto.
async function ipVistoPor(hops, xForwardedFor) {
  const app = express();
  app.set('trust proxy', hops);
  app.get('/ip', (req, res) => res.json({ ip: req.ip, ips: req.ips }));

  const servidor = app.listen(0, '127.0.0.1');
  await new Promise((ok) => servidor.once('listening', ok));
  try {
    const r = await fetch(`http://127.0.0.1:${servidor.address().port}/ip`, {
      headers: xForwardedFor ? { 'X-Forwarded-For': xForwardedFor } : {},
    });
    return await r.json();
  } finally {
    servidor.close();
  }
}

test('com 1 hop, req.ip é o cliente real anunciado pelo proxy — não o IP do proxy', async () => {
  const { ip } = await ipVistoPor(1, '203.0.113.7');
  assert.equal(ip, '203.0.113.7');
});

test('com 1 hop, só o ÚLTIMO salto é confiável: cadeia forjada não promove o primeiro', async () => {
  // O cliente manda "1.2.3.4" de mentira; o proxy acrescenta o IP real.
  const { ip } = await ipVistoPor(1, '1.2.3.4, 203.0.113.7');
  assert.equal(ip, '203.0.113.7', 'confiar em 1 hop não pode aceitar o IP forjado pelo cliente');
});

test('com 2 hops (Traefik + proxy do Next), req.ip atravessa os dois', async () => {
  const { ip } = await ipVistoPor(2, '203.0.113.7, 10.0.0.9');
  assert.equal(ip, '203.0.113.7');
});

test('sem trust proxy, req.ip ignora o header — é este o estado que causou o 429 global', async () => {
  const { ip } = await ipVistoPor(0, '203.0.113.7');
  assert.equal(ip, '127.0.0.1');
});

test('IPv4-mapeado em IPv6 no header não vira outro IP por conta própria', async () => {
  const { ip } = await ipVistoPor(1, '::ffff:203.0.113.7');
  assert.equal(ip, '::ffff:203.0.113.7');
});

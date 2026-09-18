/**
 * Teste unitário — lib/auth-sessao.ts (tasks.md 6.7.4).
 *
 * Cobre explicitamente os dois cenários do gap de segurança CHK003:
 * "sessão com access expirado mas refresh válido restaura silenciosamente"
 * e "sessão com refresh também expirado vai direto para o login sem erro
 * genérico" — mais o caso de login/sessão já válida (equivalente ao 6.7.1).
 *
 *   node --experimental-strip-types --test lib/auth-sessao.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { restaurarSessao, type DepsRestaurarSessao } from './auth-sessao.ts';

function verificarAuthOk() {
  return Promise.resolve({ authenticated: true, cnpjPrestador: '12345678000190', nome: 'Joana' });
}

test('restaurarSessao: access ainda válido (equivalente a login já feito) — nunca chama refresh', async () => {
  let chamouRefresh = false;
  const deps: DepsRestaurarSessao = {
    verificarAuth: verificarAuthOk,
    renovarToken: () => { chamouRefresh = true; return Promise.resolve(); },
  };
  const user = await restaurarSessao(deps);
  assert.deepEqual(user, { cnpjPrestador: '12345678000190', nome: 'Joana' });
  assert.equal(chamouRefresh, false);
});

test('restaurarSessao: access expirado mas refresh válido restaura silenciosamente', async () => {
  let chamadasVerify = 0;
  const deps: DepsRestaurarSessao = {
    verificarAuth: () => {
      chamadasVerify += 1;
      if (chamadasVerify === 1) return Promise.reject(new Error('401'));
      return verificarAuthOk();
    },
    renovarToken: () => Promise.resolve(),
  };
  const user = await restaurarSessao(deps);
  assert.deepEqual(user, { cnpjPrestador: '12345678000190', nome: 'Joana' });
  assert.equal(chamadasVerify, 2);
});

test('restaurarSessao: refresh também expirado vai para sessão nula (login), sem loop e sem lançar', async () => {
  let chamadasRefresh = 0;
  const deps: DepsRestaurarSessao = {
    verificarAuth: () => Promise.reject(new Error('401')),
    renovarToken: () => {
      chamadasRefresh += 1;
      return Promise.reject(new Error('403 refresh inválido'));
    },
  };
  const user = await restaurarSessao(deps);
  assert.equal(user, null);
  assert.equal(chamadasRefresh, 1); // uma única tentativa — nunca em loop
});

test('restaurarSessao: refresh funciona mas o segundo verificarAuth ainda falha — sessão nula, sem lançar', async () => {
  const deps: DepsRestaurarSessao = {
    verificarAuth: () => Promise.reject(new Error('401')),
    renovarToken: () => Promise.resolve(),
  };
  const user = await restaurarSessao(deps);
  assert.equal(user, null);
});

test('restaurarSessao: verificarAuth resolve authenticated:false (sem erro) é tratado como sessão nula direto', async () => {
  let chamouRefresh = false;
  const deps: DepsRestaurarSessao = {
    verificarAuth: () => Promise.resolve({ authenticated: false, cnpjPrestador: '', nome: '' }),
    renovarToken: () => { chamouRefresh = true; return Promise.resolve(); },
  };
  const user = await restaurarSessao(deps);
  assert.equal(user, null);
  assert.equal(chamouRefresh, false);
});

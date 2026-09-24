// Espelho da senha na tabela legada (`Motorista`) — incidente 2026-09-23/24.
//
// Por que isto existe: o login do app motorista ainda autentica contra
// `Motorista.senha`. Mexer na senha só na `ContaMotorista` não tem efeito
// nenhum para o motorista — era por isso que o reset do hub prometia repor
// acesso e não repunha.
//
// O mock substitui `lib/hub-postgrest` ANTES de carregar a rota, para
// inspecionar exatamente quais chamadas o espelho faz (sem banco, sem HTTP).
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const CAMINHO_PG = require.resolve('../lib/hub-postgrest');
const chamadas = [];
let respostaConta = [{ cnpj_prestador: '89000000000100' }];
let falharPatch = false;

require.cache[CAMINHO_PG] = {
  id: CAMINHO_PG, filename: CAMINHO_PG, loaded: true, exports: {
    async hubPostgrestRequest(endpoint, metodo = 'GET', corpo = null) {
      chamadas.push({ endpoint, metodo, corpo });
      if (metodo === 'GET') return respostaConta;
      if (falharPatch) throw new Error('PostgREST fora do ar');
      return [];
    },
  },
};

const { espelharSenhaNoLegado } = require('../routes/hub-motoristas');

function reset() { chamadas.length = 0; respostaConta = [{ cnpj_prestador: '89000000000100' }]; falharPatch = false; }

test.describe('espelharSenhaNoLegado()', () => {
  test('grava o hash na tabela do LOGIN, casando por CNPJ só com dígitos', async () => {
    reset();
    const r = await espelharSenhaNoLegado(1, '$2b$10$hashnovo', {});
    assert.equal(r.ok, true);
    const patch = chamadas.find((c) => c.metodo === 'PATCH');
    assert.match(patch.endpoint, /^Motorista\?cnpj_prestador=eq\.89000000000100$/);
    assert.deepEqual(patch.corpo, { senha: '$2b$10$hashnovo' });
  });

  // O reset zera; sem espelhar, o motorista continuaria entrando com a senha
  // antiga e o reset seria só aparência.
  test('propaga a INVALIDAÇÃO (null) — é o que faz o reset valer no app', async () => {
    reset();
    await espelharSenhaNoLegado(1, null, {});
    const patch = chamadas.find((c) => c.metodo === 'PATCH');
    assert.deepEqual(patch.corpo, { senha: null });
  });

  // A ContaMotorista deveria guardar só dígitos (0095), mas se um CNPJ
  // pontuado escapar, o espelho não pode falhar em silêncio: o login normaliza
  // para dígitos e é assim que a tabela legada guarda.
  test('normaliza CNPJ pontuado antes de casar com o legado', async () => {
    reset();
    respostaConta = [{ cnpj_prestador: '89.000.000/0001-00' }];
    await espelharSenhaNoLegado(1, '$2b$10$x', {});
    const patch = chamadas.find((c) => c.metodo === 'PATCH');
    assert.match(patch.endpoint, /cnpj_prestador=eq\.89000000000100$/);
  });

  test('conta sem CNPJ não gera escrita nenhuma', async () => {
    reset();
    respostaConta = [{ cnpj_prestador: null }];
    const r = await espelharSenhaNoLegado(1, '$2b$10$x', {});
    assert.equal(r.ok, false);
    assert.equal(r.motivo, 'conta_sem_cnpj');
    assert.equal(chamadas.filter((c) => c.metodo === 'PATCH').length, 0);
  });

  // Best-effort: o hub é a fonte, o legado é a cópia. Uma falha aqui não pode
  // derrubar a operação — mas tem de ser REPORTADA, senão o operador acha que
  // repôs o acesso e não repôs.
  test('falha do legado não lança, mas devolve ok:false', async () => {
    reset();
    falharPatch = true;
    const r = await espelharSenhaNoLegado(1, '$2b$10$x', {});
    assert.equal(r.ok, false);
    assert.equal(r.motivo, 'erro');
  });
});

// Guarda estrutural: as TRÊS escritas de senha do hub têm de espelhar. Se
// alguém acrescentar uma quarta sem espelho, o reset volta a ser aparência —
// ou pior, zera sem repor e tranca o motorista para fora.
test('as escritas de senha do hub chamam o espelho (guarda de regressão)', () => {
  const fonte = require('node:fs').readFileSync(
    path.resolve(__dirname, '../routes/hub-motoristas.js'), 'utf8');
  const escritas = (fonte.match(/senha:\s*(hash|null)\s*[,}]/g) || []).length;
  const espelhos = (fonte.match(/espelharSenhaNoLegado\(/g) || []).length - 1; // -1 = a definição
  assert.ok(espelhos >= 3, `esperava ao menos 3 chamadas ao espelho, achei ${espelhos}`);
  assert.ok(escritas >= 3, `esperava ao menos 3 escritas de senha, achei ${escritas}`);
});

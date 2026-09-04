#!/usr/bin/env node
/**
 * scripts/backfill-vinculo-motorista.js — backfill retroativo do vínculo
 * automático de credencial (FR-012, contracts/vinculo-automatico.md
 * §Script "backfill retroativo único"). Reusa a MESMA função de FR-009
 * (`lib/hub-motorista-vinculo-automatico.js#vincularAutomaticamente`) para
 * cada motorista já cadastrado (`Motorista.senha` preenchida) ANTES desta
 * entrega — nunca reimplementa a lógica de similaridade/threshold.
 *
 * Execução MANUAL, ÚNICA, pelo OPERADOR (rito de produção, CLAUDE.md — esta
 * pipeline nunca escreve em produção nem executa scripts contra ela).
 * Idempotente (tasks.md 3.2.4): reexecutar é no-op para quem já está
 * vinculado (mesma checagem de idempotência de FR-011, dentro de
 * `vincularAutomaticamente`) — nunca piora o estado atual (Scenario 3 do
 * quickstart.md).
 *
 * Uso (a partir de app_homologacao/backend/):
 *   POSTGREST_URL=... POSTGREST_API_KEY=... PGRST_JWT_SECRET=... \
 *     node scripts/backfill-vinculo-motorista.js
 *
 * `POSTGREST_URL`+`POSTGREST_API_KEY` (legado, mesmas variáveis de
 * server.js) leem `Motorista` (chatmasterveloz). `POSTGREST_URL`+
 * `PGRST_JWT_SECRET` (hub, mesmas de lib/hub-postgrest-jwt.js) fazem o
 * vínculo em si — em produção é o MESMO PostgREST/banco para os dois
 * (tabelas do hub vivem dentro do chatmasterveloz desde o cutover G3), mas
 * o script nunca assume isso: usa cada helper com sua própria credencial,
 * mesmo padrão de duplicação deliberada já usado entre routes/hub-*.js
 * (nenhum import cross-domain de server.js, que não exporta nada).
 *
 * Runbook de execução (rito de produção, gates + comando exato para o
 * operador): docs/plans/hub-motorista-360/RUNBOOK-BACKFILL-VINCULO.md.
 */
'use strict';

const jwt = require('jsonwebtoken');
const { vincularAutomaticamente } = require('../lib/hub-motorista-vinculo-automatico');

const POSTGREST_URL = process.env.POSTGREST_URL;
const POSTGREST_API_KEY = process.env.POSTGREST_API_KEY;

/**
 * Cópia mínima e deliberada de `server.js#postgrestRequest` (GET-only, o
 * único método que este script precisa do lado legado) — server.js não
 * exporta nada para reuso fora do processo Express. Mesmo padrão de
 * duplicação de helpers pequenos já usado entre arquivos de rota do hub.
 */
async function legadoGet(endpoint) {
  const token = jwt.sign({ role: 'authenticated' }, POSTGREST_API_KEY, { expiresIn: '30m' });
  const response = await fetch(`${POSTGREST_URL}/${endpoint}`, {
    headers: { Authorization: `Bearer ${token}`, 'Cache-Control': 'no-cache' },
  });
  if (!response.ok) {
    throw new Error(`legado GET ${endpoint}: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

/**
 * Laço de agregação PURO o bastante para ser testado sem PostgREST/DB real
 * (tasks.md 3.2.4 idempotência / 3.2.5 fixture sintética) — `vincularFn` é
 * injetável (default: `vincularAutomaticamente` real). Isola falha de 1
 * motorista (rede/RLS pontual) do restante do backfill, mesmo espírito
 * best-effort do hook de `/register`; conta como ambíguo (revisão manual)
 * para nunca sumir do relatório final, sem nunca logar dado pessoal.
 * @param {Array<{cnpj_prestador:string, nome:string}>} motoristas
 * @param {Function} [vincularFn]
 * @returns {Promise<{totalProcessados:number, totalVinculados:number, totalAmbiguos:number}>}
 */
async function processarBackfill(motoristas, vincularFn = vincularAutomaticamente) {
  let totalProcessados = 0;
  let totalVinculados = 0;
  let totalAmbiguos = 0;

  for (const m of motoristas || []) {
    totalProcessados += 1;
    const cnpjNorm = String(m.cnpj_prestador || '').replace(/\D/g, '');
    if (!cnpjNorm) continue;
    try {
      // Mesma lógica de FR-009 (localizar/criar ContaMotorista por CNPJ,
      // vincular ao Entregador por similaridade de nome >= 0.9 exato-1).
      const resultado = await vincularFn({ cnpjPrestador: cnpjNorm, nome: m.nome });
      if (resultado.status === 'vinculado') {
        totalVinculados += 1;
      } else if (resultado.status === 'ambiguo' || resultado.status === 'sem_candidato') {
        // Sem correspondência confiável — fica para vínculo manual
        // (FR-010, "Vincular"/"Criar credencial"), nunca vinculado em massa
        // por adivinhação (FR-012).
        totalAmbiguos += 1;
      }
      // 'ja_vinculado' e 'sem_grupo_elegivel': nem novo vínculo nem
      // ambíguo — já resolvido antes, ou fora do grupo elegível (FR-011,
      // reexecutar é no-op — tasks.md 3.2.4).
    } catch (err) {
      console.error('[backfill] falha ao processar 1 motorista (contabilizado em totalAmbiguos):', err.message);
      totalAmbiguos += 1;
    }
  }

  return { totalProcessados, totalVinculados, totalAmbiguos };
}

async function main() {
  if (!POSTGREST_URL || !POSTGREST_API_KEY) {
    console.error('POSTGREST_URL e POSTGREST_API_KEY são obrigatórios (credenciais do PostgREST legado, mesmas de server.js).');
    process.exitCode = 1;
    return;
  }
  if (!process.env.PGRST_JWT_SECRET) {
    console.error('PGRST_JWT_SECRET é obrigatório (credencial do PostgREST do hub, lib/hub-postgrest-jwt.js).');
    process.exitCode = 1;
    return;
  }

  const motoristas = await legadoGet('Motorista?senha=not.is.null&select=cnpj_prestador,nome');
  const relatorio = await processarBackfill(motoristas);
  console.log(JSON.stringify(relatorio, null, 2));
}

// Só executa contra I/O real quando rodado diretamente (`node scripts/...`)
// — `require('./backfill-vinculo-motorista')` em teste importa só as
// funções puras/injetáveis abaixo, sem disparar main().
if (require.main === module) {
  main().catch((err) => {
    console.error('[backfill] erro fatal:', err.message);
    process.exitCode = 1;
  });
}

module.exports = { processarBackfill };

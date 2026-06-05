#!/usr/bin/env node
/**
 * Gerador de seed SQL para motorista de teste.
 * Execute dentro do container do backend (onde bcrypt está instalado):
 *
 *   node db/seed-motorista.js | psql <connection-string>
 *
 * Ou capture e aplique manualmente no PostgreSQL.
 */

const bcrypt = require('bcrypt');

const MOTORISTA_TESTE = {
  cnpj_prestador: '12345678000199', // 12.345.678/0001-99 — CNPJ fictício para testes
  senha_plain: 'Motorista@2026',
  nome: 'Motorista Teste Homologação',
  ativo: true,
};

(async () => {
  const hash = await bcrypt.hash(MOTORISTA_TESTE.senha_plain, 10);

  console.log(`-- Seed gerado em ${new Date().toISOString()}`);
  console.log(`-- Senha: ${MOTORISTA_TESTE.senha_plain} (NÃO commitar senha plana em produção)`);
  console.log();
  console.log(`INSERT INTO "Motorista" (cnpj_prestador, senha, nome, ativo)`);
  console.log(`VALUES (`);
  console.log(`  '${MOTORISTA_TESTE.cnpj_prestador}',`);
  console.log(`  '${hash}',`);
  console.log(`  '${MOTORISTA_TESTE.nome}',`);
  console.log(`  ${MOTORISTA_TESTE.ativo}`);
  console.log(`)`);
  console.log(`ON CONFLICT (cnpj_prestador) DO NOTHING;`);
  console.log();
  console.log(`-- Verificação: SELECT id, cnpj_prestador, nome, ativo FROM "Motorista" WHERE cnpj_prestador = '${MOTORISTA_TESTE.cnpj_prestador}';`);
})();

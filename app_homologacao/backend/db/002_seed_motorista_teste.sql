-- Seed: 1 motorista de teste para homologação
-- Senha: 'Motorista@2026'
-- CNPJ: 12.345.678/0001-99 (sem pontuação: 12345678000199) — fictício para testes
-- Idempotente: INSERT ... ON CONFLICT DO NOTHING
--
-- ATENÇÃO: Substitua o hash abaixo pelo gerado via:
--   node db/seed-motorista.js   (dentro do container do backend)
-- O placeholder abaixo é inválido e deve ser trocado antes de usar.

INSERT INTO "Motorista" (cnpj_prestador, senha, nome, ativo)
VALUES (
  '12345678000199',
  '$2b$10$PLACEHOLDER_SUBSTITUA_PELO_HASH_GERADO_VIA_seed-motorista.js',
  'Motorista Teste Homologação',
  true
)
ON CONFLICT (cnpj_prestador) DO NOTHING;

-- Para gerar e aplicar o seed com hash real, execute dentro do container:
--   node db/seed-motorista.js | psql $DATABASE_URL

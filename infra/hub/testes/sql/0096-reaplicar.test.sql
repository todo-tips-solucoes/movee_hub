-- Entre as duas aplicações da migration: o hub assume o cadastro.
-- Se o backfill perder o guard `email IS NULL`, a segunda aplicação apaga isto.
\set ON_ERROR_STOP on
DO $$
DECLARE c record;
BEGIN
  SELECT * INTO c FROM _ctx;
  UPDATE "ContaMotorista" SET email = 'hub.mandou@exemplo.com', email_origem = 'hub'
   WHERE id = c.c_ja_hub;
  RAISE NOTICE 'entre aplicações: hub gravou hub.mandou@exemplo.com';
END $$;

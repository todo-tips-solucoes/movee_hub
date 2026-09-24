-- Depois da SEGUNDA aplicação da migration.
\set ON_ERROR_STOP on
DO $$
DECLARE c record; v text;
BEGIN
  SELECT * INTO c FROM _ctx;
  SELECT email INTO v FROM "ContaMotorista" WHERE id = c.c_ja_hub;
  ASSERT v = 'hub.mandou@exemplo.com',
    format('reaplicar a migration sobrescreveu o e-mail do hub (veio %s)', v);
  RAISE NOTICE 'ok  reaplicar a migration não toca no e-mail do hub';
END $$;

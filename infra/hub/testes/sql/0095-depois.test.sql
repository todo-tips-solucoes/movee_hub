-- Parte 2: asserções DEPOIS da migration.
\set ON_ERROR_STOP on
DO $$
DECLARE c record;
BEGIN
  SELECT * INTO c FROM _ctx;

  -- 1. migrou o hash do legado, sem alterá-lo
  ASSERT (SELECT senha FROM "ContaMotorista" WHERE id = c.c_migra) = c.v_hash_legado,
    'o hash do legado devia ter sido copiado tal e qual';
  RAISE NOTICE 'ok  hash do legado copiado para o hub, sem transformação';

  -- 2. O QUE MAIS IMPORTA: senha já definida no hub NÃO é sobrescrita.
  --    Sobrescrever tiraria o acesso de quem já tinha credencial no hub.
  ASSERT (SELECT senha FROM "ContaMotorista" WHERE id = c.c_ja_tem) = c.v_hash_hub,
    'senha já definida no hub foi SOBRESCRITA pelo legado — isso tira acesso de alguém';
  RAISE NOTICE 'ok  senha já existente no hub preservada (não sobrescreve)';

  -- 3. sem correspondente no legado, continua sem senha (não inventa)
  ASSERT (SELECT senha FROM "ContaMotorista" WHERE id = c.c_sem_legado) IS NULL,
    'conta sem legado não pode ganhar senha do nada';
  RAISE NOTICE 'ok  sem correspondente no legado: segue sem senha';

  -- 4. CNPJ pontuado: normalizado E migrado (o defeito da 0093 corrigido)
  ASSERT (SELECT cnpj_prestador FROM "ContaMotorista" WHERE id = c.c_pontuado) = '91000000000104',
    'o CNPJ pontuado devia ter sido normalizado para só dígitos';
  ASSERT (SELECT senha FROM "ContaMotorista" WHERE id = c.c_pontuado) = c.v_hash_legado,
    'depois de normalizar, o CNPJ pontuado devia casar com o legado e migrar';
  RAISE NOTICE 'ok  CNPJ pontuado normalizado e casado com o legado';

  -- 5. nenhum CNPJ pontuado sobrou
  ASSERT (SELECT count(*) FROM "ContaMotorista" WHERE cnpj_prestador ~ '[^0-9]') = 0,
    'sobrou CNPJ com pontuação no hub';
  RAISE NOTICE 'ok  nenhum CNPJ pontuado restante';

  -- 6. o legado NÃO foi tocado — o login de hoje depende dele
  ASSERT (SELECT senha FROM "Motorista" WHERE cnpj_prestador = '91000000000101') = c.v_hash_legado,
    'a migration alterou a tabela do LOGIN — nunca pode';
  RAISE NOTICE 'ok  tabela legada intacta (o login de hoje não muda)';
END $$;

-- 7. Idempotente: reaplicar não muda nada.
DO $$
DECLARE c record; v_antes text; v_depois text;
BEGIN
  SELECT * INTO c FROM _ctx;
  SELECT senha INTO v_antes FROM "ContaMotorista" WHERE id = c.c_ja_tem;
  UPDATE "ContaMotorista" cm SET senha = m.senha FROM "Motorista" m
   WHERE cm.senha IS NULL AND m.senha IS NOT NULL
     AND regexp_replace(m.cnpj_prestador,'[^0-9]','','g') = cm.cnpj_prestador;
  SELECT senha INTO v_depois FROM "ContaMotorista" WHERE id = c.c_ja_tem;
  ASSERT v_antes = v_depois, 'reaplicar sobrescreveu senha existente';
  RAISE NOTICE 'ok  idempotente: reaplicar não altera senha já definida';
END $$;

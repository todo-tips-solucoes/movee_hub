-- Parte 2 de 2 do teste da 0098 (F3 — saldo mínimo carregado). Roda DEPOIS
-- da migration 0098, na mesma transação de 0098-antes.sql (driver: futuro
-- infra/hub/testes/hub-repasse-saldo-minimo.sh — ROLLBACK=1 conferido,
-- molde de infra/hub/testes/hub-apuracao-divisao-nota.sh). Cobre os 9 casos
-- da tabela quickstart.md §F3 + o cenário F3.15 (piso vigente no
-- fechamento). tasks.md 3.8.1/3.8.4.
--
-- Piso da empresa = 5,50 (default da 0098) até o caso 10 (F3.15), que sobe
-- para 8,00. Cada caso fecha semanas EM SEQUÊNCIA para um motorista de
-- teste dedicado — mas o fechamento é por EMPRESA (todas as linhas de uma
-- semana fecham juntas), então os motoristas compartilham as MESMAS 5
-- semanas (W0..W4), calculadas dinamicamente a partir do que já estiver
-- fechado para a empresa 6 (nunca colide com fixtures de migrations
-- testadas antes desta).
--
-- Caso 5b (semana 2) cobre também dec-055/block-008 (revisão adversarial da
-- F3): crédito nota-elegível + débito MAIOR na MESMA semana de um motorista
-- com saldo_anterior>0 — confere que `transportado_nota`/`transportado_fora`
-- (0098:279/284) continuam iguais a `saldo_anterior_nota`/`_fora` (o saldo
-- ANTIGO, intocado) e NUNCA somam a produção nota-elegível desta semana
-- negativa — essa produção fica só em `valor_nota`/`valor_fora_nota` do
-- próprio item, para virar nota da PRÓPRIA semana no app
-- (`lib/adiantamento-geracao-movimento.js`), nunca duplicada no saldo
-- carregado. SQL não mudou nesta decisão (a correção foi só no app) — este
-- caso formaliza a cobertura que já valia antes.
--
-- CONTROLES NEGATIVOS (tasks.md 3.7, conferir QUAIS falham ao remover a
-- correção correspondente — não codificados aqui, são checados MANUALMENTE
-- revertendo a linha indicada e rerodando este arquivo):
--   - Sem incluir quem só tem saldo no CTE `linhas` (Decision 10) => o
--     BLOCO do caso 2 falha (a asserção `count(*) = 1` do item da semana
--     sem atividade não encontra a linha).
--   - Sem somar `saldo_anterior` no cálculo de `valor_pago`/`valor_transportado`
--     (Decision 8) => os BLOCOS dos casos 1, 3 e 7 falham (valores pagos
--     batem com o remanescente da própria semana, não com o total
--     acumulado).
--   - Sem a guarda de ordem estrita (Decision 9, EXISTS + `<> ultimo + 7`)
--     => o BLOCO do caso 6 falha (as duas tentativas fora de ordem NÃO
--     lançam `APURACAO_FORA_DE_ORDEM`).
\set ON_ERROR_STOP on

-- ── Setup: semanas dinâmicas + identidade com pagamento_confirmar ───────
DO $$
DECLARE v_base date; v_sub int; v_emp int;
BEGIN
  SELECT COALESCE(max(periodo_inicio), date '2026-01-05') + 7 INTO v_base
  FROM "ApuracaoRepasse" WHERE id_empresa = 6;

  SELECT ue.usuario_id, ue.empresa_id INTO v_sub, v_emp
    FROM "UsuarioEntidade" ue
    JOIN "PapelPermissao" pp ON pp.papel_id = ue.papel_id
    JOIN "Permissao" p ON p.id = pp.permissao_id
    JOIN "ModuloEntidade" me ON me.modulo_id = p.modulo_id AND me.empresa_id = ue.empresa_id
   WHERE p.codigo = 'adiantamentos.pagamento_confirmar' AND ue.ativo AND me.ativo
   ORDER BY ue.usuario_id LIMIT 1;
  IF v_sub IS NULL THEN RAISE EXCEPTION 'fixture: nenhum usuario com adiantamentos.pagamento_confirmar'; END IF;
  PERFORM set_config('request.jwt.claims',
    format('{"sub":"%s","empresa_ativa":"%s","escopo":[6,%s]}', v_sub, v_emp, v_emp), true);

  CREATE TEMP TABLE saldo_min_ctx AS
    SELECT v_base AS w0, v_base + 7 AS w1, v_base + 14 AS w2, v_base + 21 AS w3, v_base + 28 AS w4;
  RAISE NOTICE 'ok  semanas do teste: w0=% w1=% w2=% w3=%', v_base, v_base+7, v_base+14, v_base+21;
END $$;

-- ── Fixtures W0 (casos 1, 2, 3, 4, 5a, 5b, 9) ────────────────────────────
DO $$
DECLARE
  c record; v_imp int;
  v_a int; v_b int; v_c int; v_d int; v_e int; v_f int; v_i int;
BEGIN
  SELECT * INTO c FROM saldo_min_ctx;
  SELECT id INTO v_imp FROM "ImportacaoArquivo" WHERE id_empresa = 6 AND tipo = 'faturamento'
    AND status NOT IN ('pending','validating','processing') ORDER BY id DESC LIMIT 1;
  IF v_imp IS NULL THEN
    INSERT INTO "ImportacaoArquivo" (id_empresa, tipo, hash_sha256, status)
    VALUES (6, 'faturamento', repeat('8', 64), 'completed') RETURNING id INTO v_imp;
  END IF;

  INSERT INTO "Entregador" (id_empresa, id_externo, nome) VALUES (6, gen_random_uuid(), 'Caso1 Retido-Depois-Paga') RETURNING id INTO v_a;
  INSERT INTO "Entregador" (id_empresa, id_externo, nome) VALUES (6, gen_random_uuid(), 'Caso2 Sem-Atividade')     RETURNING id INTO v_b;
  INSERT INTO "Entregador" (id_empresa, id_externo, nome) VALUES (6, gen_random_uuid(), 'Caso3 Acumula-4-Semanas') RETURNING id INTO v_c;
  INSERT INTO "Entregador" (id_empresa, id_externo, nome) VALUES (6, gen_random_uuid(), 'Caso4 Limite-Exato')      RETURNING id INTO v_d;
  INSERT INTO "Entregador" (id_empresa, id_externo, nome) VALUES (6, gen_random_uuid(), 'Caso5a Negativo-Sem-Saldo') RETURNING id INTO v_e;
  INSERT INTO "Entregador" (id_empresa, id_externo, nome) VALUES (6, gen_random_uuid(), 'Caso5b Negativo-Com-Saldo') RETURNING id INTO v_f;
  INSERT INTO "Entregador" (id_empresa, id_externo, nome) VALUES (6, gen_random_uuid(), 'Caso9 Desativado-Com-Saldo') RETURNING id INTO v_i;

  INSERT INTO "FaturamentoLancamento" (id_empresa, importacao_id, entregador_id, data_lancamento, data_referencia, tipo, valor, descricao, hash_linha) VALUES
    (6, v_imp, v_a, c.w0, c.w0, 'Credito', 3.00,  'Corridas concluidas', md5('t0098a-w0')||md5('x')),
    (6, v_imp, v_b, c.w0, c.w0, 'Credito', 3.00,  'Corridas concluidas', md5('t0098b-w0')||md5('x')),
    (6, v_imp, v_c, c.w0, c.w0, 'Credito', 2.00,  'Corridas concluidas', md5('t0098c-w0')||md5('x')),
    (6, v_imp, v_d, c.w0, c.w0, 'Credito', 5.50,  'Corridas concluidas', md5('t0098d-w0')||md5('x')),
    (6, v_imp, v_e, c.w0, c.w0, 'Debito', 10.00,  'Multa',               md5('t0098e-w0')||md5('x')),
    (6, v_imp, v_f, c.w0, c.w0, 'Credito', 3.00,  'Corridas concluidas', md5('t0098f-w0')||md5('x')),
    (6, v_imp, v_i, c.w0, c.w0, 'Credito', 3.00,  'Corridas concluidas', md5('t0098i-w0')||md5('x'));

  CREATE TEMP TABLE saldo_min_eids AS
    SELECT v_a AS a, v_b AS b, v_c AS c, v_d AS d, v_e AS e, v_f AS f, v_i AS i;
  RAISE NOTICE 'fixture W0: a=% b=% c=% d=% e=% f=% i=%', v_a, v_b, v_c, v_d, v_e, v_f, v_i;
END $$;

-- ── Fecha W0 e confere os casos resolvidos nesta semana (4, 5a) ─────────
DO $$
DECLARE c record; e record; v_ap record; i record;
BEGIN
  SELECT * INTO c FROM saldo_min_ctx; SELECT * INTO e FROM saldo_min_eids;
  SELECT * INTO v_ap FROM hub_adiantamento_repasse_fechar(c.w0);
  -- piso_aplicado não está no RETURN da função (mantém assinatura, Decision
  -- 11) -- conferido direto na tabela.
  ASSERT (SELECT piso_aplicado FROM "ApuracaoRepasse" WHERE id = v_ap.apuracao_id) = 5.50,
    'W0: piso_aplicado deveria ser 5.50 (default)';

  -- Caso 4 — limite exato: 5,50 >= piso (5,50) => paga.
  SELECT * INTO i FROM "ApuracaoRepasseItem" WHERE apuracao_id = v_ap.apuracao_id AND entregador_id = e.d;
  ASSERT i.valor_pago = 5.50 AND i.valor_transportado = 0,
    format('caso 4 (limite exato): esperado pago=5.50/transp=0, veio pago=%s/transp=%s', i.valor_pago, i.valor_transportado);
  RAISE NOTICE 'ok  caso 4 (limite exato, 5,50 paga)';

  -- Caso 5a — negativo sem saldo: nada transporta, alerta como hoje.
  SELECT * INTO i FROM "ApuracaoRepasseItem" WHERE apuracao_id = v_ap.apuracao_id AND entregador_id = e.e;
  ASSERT i.remanescente = -10.00 AND i.valor_pago = 0 AND i.valor_transportado = 0,
    format('caso 5a (negativo sem saldo): esperado remanescente=-10/pago=0/transp=0, veio %s/%s/%s', i.remanescente, i.valor_pago, i.valor_transportado);
  RAISE NOTICE 'ok  caso 5a (negativo sem saldo, nada transporta)';

  -- W0 retido para 1, 2, 3, 5b, 9 — conferido em bloco só para não repetir.
  PERFORM 1 FROM "ApuracaoRepasseItem" i2
   WHERE i2.apuracao_id = v_ap.apuracao_id AND i2.entregador_id IN (e.a, e.b, e.c, e.f, e.i)
     AND NOT (i2.valor_pago = 0 AND i2.valor_transportado = i2.remanescente);
  IF FOUND THEN RAISE EXCEPTION 'W0: caso 1/2/3/5b/9 deveriam estar retidos (pago=0, transp=remanescente) na primeira semana'; END IF;
  RAISE NOTICE 'ok  W0: casos 1/2/3/5b/9 retidos na primeira semana (abaixo do piso)';
END $$;

-- ── F3.11 (tasks.md 3.8.3) — CSV com motorista retido, dados REAIS ──────
-- Extrai a linha do RPC congelado (o mesmo que GET /repasse/exportar chama
-- para semana fechada) para o motorista retido do caso 1 em W0, como JSON
-- de uma única linha (RAISE NOTICE). O driver bash (hub-repasse-saldo-
-- minimo.sh) captura essa linha e alimenta `serializarCsvRemanescente`
-- (lib/adiantamento-remanescente.js) de verdade — não mockada — conferindo
-- que a linha CSV sai com "A pagar"=0,00 e "Passou para a próxima semana"
-- (transportado) coerente com o dado congelado real.
DO $$
DECLARE c record; e record; v_row jsonb;
BEGIN
  SELECT * INTO c FROM saldo_min_ctx; SELECT * INTO e FROM saldo_min_eids;
  SELECT to_jsonb(t) INTO v_row
    FROM hub_adiantamento_repasse_congelado(c.w0, NULL, false, 0, 100) t
   WHERE t.entregador_id = e.a;
  IF v_row IS NULL THEN
    RAISE EXCEPTION 'F3.11: RPC congelado nao retornou linha para o motorista retido do caso 1 em W0';
  END IF;
  IF NOT (v_row->>'retido')::boolean THEN
    RAISE EXCEPTION 'F3.11: motorista do caso 1 deveria estar retido=true no congelado de W0, veio %', v_row->>'retido';
  END IF;
  RAISE NOTICE 'CSV_ROW_JSON: %', v_row;
END $$;

-- ── Deativa o motorista do caso 9 ANTES da próxima semana ───────────────
DO $$
DECLARE e record;
BEGIN
  SELECT * INTO e FROM saldo_min_eids;
  UPDATE "Entregador" SET ativo = false WHERE id = e.i;
  RAISE NOTICE 'ok  caso 9: motorista desativado (ativo=false) com saldo retido de 3,00';
END $$;

-- ── Case 6 (parte 1) — tentativas fora de ordem ANTES de fechar W1 ──────
-- Após fechar W0, o único período válido para o próximo fechamento é W1
-- (w0 + 7). Tentar (a) uma semana ANTERIOR a w0 (nunca fechada) e (b) uma
-- semana que PULA w1 devem recusar com APURACAO_FORA_DE_ORDEM.
--
-- (a) usa w0 - 14, NÃO w0 - 7: w0 - 7 é exatamente a semana que
-- 0098-antes.sql já fechou (fixture "retrato antes/depois", caso 8) --
-- tentar fechá-la de novo cai no `IF EXISTS` de APURACAO_JA_FECHADA (que
-- roda ANTES da checagem de ordem), nunca chegando a exercitar
-- APURACAO_FORA_DE_ORDEM. w0 - 14 é uma semana anterior genuinamente nunca
-- fechada, que exercita a checagem de ordem em si (Decision 9).
DO $$
DECLARE c record; v_erro text;
BEGIN
  SELECT * INTO c FROM saldo_min_ctx;

  BEGIN
    PERFORM hub_adiantamento_repasse_fechar(c.w0 - 14);
    RAISE EXCEPTION 'FALHOU: fechar semana ANTERIOR a w0 deveria ter sido recusado';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_erro = MESSAGE_TEXT;
    ASSERT v_erro = 'APURACAO_FORA_DE_ORDEM', format('esperado APURACAO_FORA_DE_ORDEM, veio %s', v_erro);
  END;

  BEGIN
    PERFORM hub_adiantamento_repasse_fechar(c.w2); -- pula w1
    RAISE EXCEPTION 'FALHOU: pular w1 e fechar w2 direto deveria ter sido recusado';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_erro = MESSAGE_TEXT;
    ASSERT v_erro = 'APURACAO_FORA_DE_ORDEM', format('esperado APURACAO_FORA_DE_ORDEM, veio %s', v_erro);
  END;

  RAISE NOTICE 'ok  caso 6: fechar semana anterior e pular semana -- ambos APURACAO_FORA_DE_ORDEM';
END $$;

-- ── Fixtures W1 (casos 1, 2 [sem atividade], 3, 5b) ──────────────────────
DO $$
DECLARE c record; e record; v_imp int;
BEGIN
  SELECT * INTO c FROM saldo_min_ctx; SELECT * INTO e FROM saldo_min_eids;
  SELECT id INTO v_imp FROM "ImportacaoArquivo" WHERE id_empresa = 6 AND tipo = 'faturamento'
    AND status NOT IN ('pending','validating','processing') ORDER BY id DESC LIMIT 1;

  INSERT INTO "FaturamentoLancamento" (id_empresa, importacao_id, entregador_id, data_lancamento, data_referencia, tipo, valor, descricao, hash_linha) VALUES
    (6, v_imp, e.a, c.w1, c.w1, 'Credito', 4.00,  'Corridas concluidas', md5('t0098a-w1')||md5('x')),
    (6, v_imp, e.c, c.w1, c.w1, 'Credito', 1.50,  'Corridas concluidas', md5('t0098c-w1')||md5('x')),
    -- Caso 5b (dec-055/block-008): crédito NOTA-ELEGÍVEL na MESMA semana do
    -- débito maior -- prova que a produção (4,00) vai para valor_nota do
    -- PRÓPRIO item, nunca somada ao saldo carregado (que continua só 3,00).
    (6, v_imp, e.f, c.w1, c.w1, 'Credito', 4.00,  'Corridas concluidas', md5('t0098f-w1-credito')||md5('x')),
    (6, v_imp, e.f, c.w1, c.w1, 'Debito', 10.00,  'Multa',               md5('t0098f-w1')||md5('x'));
    -- e.b (caso 2): nenhuma linha -- semana SEM atividade, de propósito.
  RAISE NOTICE 'fixture W1: sem atividade para caso 2 (proposital)';
END $$;

-- ── Fecha W1 e confere casos 1, 2, 5b, 9 ────────────────────────────────
DO $$
DECLARE c record; e record; v_ap record; i record; v_qtd int;
BEGIN
  SELECT * INTO c FROM saldo_min_ctx; SELECT * INTO e FROM saldo_min_eids;
  SELECT * INTO v_ap FROM hub_adiantamento_repasse_fechar(c.w1);

  -- Caso 1 — 3,00 -> 4,00: semana 2 paga 7,00 (uma nota com os componentes somados).
  SELECT * INTO i FROM "ApuracaoRepasseItem" WHERE apuracao_id = v_ap.apuracao_id AND entregador_id = e.a;
  ASSERT i.saldo_anterior = 3.00 AND i.valor_pago = 7.00 AND i.valor_transportado = 0,
    format('caso 1 (semana 2): esperado saldo_anterior=3/pago=7/transp=0, veio %s/%s/%s', i.saldo_anterior, i.valor_pago, i.valor_transportado);
  RAISE NOTICE 'ok  caso 1: 3,00 -> 4,00 => semana 2 paga 7,00';

  -- Caso 2 — sem atividade: item TEM que existir com saldo_anterior=3,00, segue retida.
  SELECT count(*) INTO v_qtd FROM "ApuracaoRepasseItem" WHERE apuracao_id = v_ap.apuracao_id AND entregador_id = e.b;
  ASSERT v_qtd = 1, 'caso 2: item deveria existir mesmo sem nenhuma atividade na semana (Decision 10)';
  SELECT * INTO i FROM "ApuracaoRepasseItem" WHERE apuracao_id = v_ap.apuracao_id AND entregador_id = e.b;
  ASSERT i.remanescente = 0 AND i.saldo_anterior = 3.00 AND i.valor_pago = 0 AND i.valor_transportado = 3.00,
    format('caso 2: esperado remanescente=0/saldo_anterior=3/pago=0/transp=3, veio %s/%s/%s/%s', i.remanescente, i.saldo_anterior, i.valor_pago, i.valor_transportado);
  RAISE NOTICE 'ok  caso 2: 3,00 -> sem atividade => segue retida com saldo_anterior=3,00';

  -- Caso 5b — 3,00 -> crédito 4,00 (nota-elegível) + débito 10,00 =>
  -- remanescente -6,00: semana 2 preserva o saldo ANTIGO (D9), não reduz
  -- pelo negativo, e NÃO soma a produção desta semana ao saldo transportado
  -- (dec-055/block-008): a produção (4,00) fica em valor_nota do PRÓPRIO
  -- item -- vira nota da semana no app, não no saldo carregado.
  SELECT * INTO i FROM "ApuracaoRepasseItem" WHERE apuracao_id = v_ap.apuracao_id AND entregador_id = e.f;
  ASSERT i.remanescente = -6.00 AND i.valor_pago = 0 AND i.valor_transportado = 3.00,
    format('caso 5b (semana 2): esperado remanescente=-6/pago=0/transp=3 (saldo preservado), veio %s/%s/%s', i.remanescente, i.valor_pago, i.valor_transportado);
  ASSERT i.valor_nota = 4.00 AND COALESCE(i.valor_fora_nota, 0) = 0,
    format('caso 5b (semana 2, dec-055/block-008): a produção da própria semana deveria ficar em valor_nota=4/valor_fora_nota=0, veio %s/%s', i.valor_nota, i.valor_fora_nota);
  ASSERT i.saldo_anterior_nota = 3.00 AND COALESCE(i.saldo_anterior_fora, 0) = 0,
    format('caso 5b (semana 2): saldo_anterior_nota deveria vir de W0 (3.00), veio %s/%s', i.saldo_anterior_nota, i.saldo_anterior_fora);
  ASSERT i.transportado_nota = 3.00 AND COALESCE(i.transportado_fora, 0) = 0,
    format('caso 5b (semana 2, dec-055/block-008): remanescente<0 NÃO soma a produção desta semana (4.00) ao saldo transportado -- transportado_nota deveria continuar 3.00 (só o saldo antigo), veio %s/%s', i.transportado_nota, i.transportado_fora);
  RAISE NOTICE 'ok  caso 5b: negativo com saldo preserva o saldo anterior integralmente (D9) e NÃO soma a produção da semana ao saldo carregado (dec-055/block-008)';

  -- Caso 9 — motorista desativado com saldo: item continua sendo criado.
  SELECT count(*) INTO v_qtd FROM "ApuracaoRepasseItem" WHERE apuracao_id = v_ap.apuracao_id AND entregador_id = e.i;
  ASSERT v_qtd = 1, 'caso 9: item deveria continuar sendo criado mesmo com o motorista desativado';
  RAISE NOTICE 'ok  caso 9: motorista desativado com saldo -- item continua sendo criado';
END $$;

-- ── Fixtures W2 (casos 3, 5b) ─────────────────────────────────────────
DO $$
DECLARE c record; e record; v_imp int;
BEGIN
  SELECT * INTO c FROM saldo_min_ctx; SELECT * INTO e FROM saldo_min_eids;
  SELECT id INTO v_imp FROM "ImportacaoArquivo" WHERE id_empresa = 6 AND tipo = 'faturamento'
    AND status NOT IN ('pending','validating','processing') ORDER BY id DESC LIMIT 1;

  INSERT INTO "FaturamentoLancamento" (id_empresa, importacao_id, entregador_id, data_lancamento, data_referencia, tipo, valor, descricao, hash_linha) VALUES
    (6, v_imp, e.c, c.w2, c.w2, 'Credito', 1.00,  'Corridas concluidas', md5('t0098c-w2')||md5('x')),
    (6, v_imp, e.f, c.w2, c.w2, 'Credito', 4.00,  'Corridas concluidas', md5('t0098f-w2')||md5('x'));
END $$;

-- ── Fecha W2 e confere caso 5b (paga 7,00) ──────────────────────────────
DO $$
DECLARE c record; e record; v_ap record; i record;
BEGIN
  SELECT * INTO c FROM saldo_min_ctx; SELECT * INTO e FROM saldo_min_eids;
  SELECT * INTO v_ap FROM hub_adiantamento_repasse_fechar(c.w2);

  SELECT * INTO i FROM "ApuracaoRepasseItem" WHERE apuracao_id = v_ap.apuracao_id AND entregador_id = e.f;
  ASSERT i.saldo_anterior = 3.00 AND i.valor_pago = 7.00 AND i.valor_transportado = 0,
    format('caso 5b (semana 3): esperado saldo_anterior=3/pago=7/transp=0, veio %s/%s/%s', i.saldo_anterior, i.valor_pago, i.valor_transportado);
  -- dec-055/block-008: o saldo_anterior_nota que chega aqui é o mesmo 3,00 de
  -- W0 -- a produção de 4,00 gerada na semana negativa (W1) já virou nota
  -- própria dela (asserção acima) e não se repete aqui.
  ASSERT i.saldo_anterior_nota = 3.00 AND COALESCE(i.saldo_anterior_fora, 0) = 0,
    format('caso 5b (semana 3, dec-055/block-008): saldo_anterior_nota carregado da semana negativa deveria continuar 3.00 (a produção de 4.00 dela já virou nota separada), veio %s/%s', i.saldo_anterior_nota, i.saldo_anterior_fora);
  RAISE NOTICE 'ok  caso 5b: -6,00 (com produção de 4,00 já faturada na própria nota) -> 4,00 => semana 3 paga 7,00 (total = 4 + 3 de saldo)';

  SELECT * INTO i FROM "ApuracaoRepasseItem" WHERE apuracao_id = v_ap.apuracao_id AND entregador_id = e.c;
  ASSERT i.saldo_anterior = 3.50 AND i.valor_pago = 0 AND i.valor_transportado = 4.50,
    format('caso 3 (semana 3): esperado saldo_anterior=3.50/pago=0/transp=4.50, veio %s/%s/%s', i.saldo_anterior, i.valor_pago, i.valor_transportado);
  RAISE NOTICE 'ok  caso 3: acumulado ate a semana 3 = 4,50 retido';
END $$;

-- ── Fixtures W3 (caso 3, fecha em 8,50) ──────────────────────────────────
DO $$
DECLARE c record; e record; v_imp int;
BEGIN
  SELECT * INTO c FROM saldo_min_ctx; SELECT * INTO e FROM saldo_min_eids;
  SELECT id INTO v_imp FROM "ImportacaoArquivo" WHERE id_empresa = 6 AND tipo = 'faturamento'
    AND status NOT IN ('pending','validating','processing') ORDER BY id DESC LIMIT 1;
  INSERT INTO "FaturamentoLancamento" (id_empresa, importacao_id, entregador_id, data_lancamento, data_referencia, tipo, valor, descricao, hash_linha) VALUES
    (6, v_imp, e.c, c.w3, c.w3, 'Credito', 4.00,  'Corridas concluidas', md5('t0098c-w3')||md5('x'));
END $$;

DO $$
DECLARE c record; e record; v_ap record; i record;
BEGIN
  SELECT * INTO c FROM saldo_min_ctx; SELECT * INTO e FROM saldo_min_eids;
  SELECT * INTO v_ap FROM hub_adiantamento_repasse_fechar(c.w3);

  SELECT * INTO i FROM "ApuracaoRepasseItem" WHERE apuracao_id = v_ap.apuracao_id AND entregador_id = e.c;
  ASSERT i.saldo_anterior = 4.50 AND i.valor_pago = 8.50 AND i.valor_transportado = 0,
    format('caso 3 (semana 4): esperado saldo_anterior=4.50/pago=8.50/transp=0, veio %s/%s/%s', i.saldo_anterior, i.valor_pago, i.valor_transportado);
  RAISE NOTICE 'ok  caso 3: 2,00 -> 1,50 -> 1,00 -> 4,00 => acumula 4,50, semana 4 paga 8,50';
END $$;

-- ── Caso 7 — conservação, por motorista, em todas as semanas fechadas ───
DO $$
DECLARE v_dif int;
BEGIN
  -- Σ remanescente(>=0) = Σ valor_pago + último valor_transportado, por
  -- entregador, considerando só os itens desta rodada de teste.
  CREATE TEMP TABLE saldo_min_conserva AS
    WITH itens AS (
      SELECT i.* FROM "ApuracaoRepasseItem" i
      JOIN saldo_min_eids e ON i.entregador_id IN (e.a, e.b, e.c, e.d, e.e, e.f, e.i)
    ),
    soma_positivos AS (
      SELECT entregador_id, sum(remanescente) FILTER (WHERE remanescente >= 0) AS soma_rem_pos,
             sum(valor_pago) AS soma_pago
      FROM itens GROUP BY entregador_id
    ),
    ultimo AS (
      SELECT DISTINCT ON (i.entregador_id) i.entregador_id, i.valor_transportado
      FROM itens i JOIN "ApuracaoRepasse" a ON a.id = i.apuracao_id
      ORDER BY i.entregador_id, a.periodo_inicio DESC
    )
    SELECT sp.entregador_id, sp.soma_rem_pos, sp.soma_pago, u.valor_transportado AS ultimo_transportado
    FROM soma_positivos sp JOIN ultimo u ON u.entregador_id = sp.entregador_id;

  SELECT count(*) INTO v_dif FROM saldo_min_conserva
   WHERE COALESCE(soma_rem_pos, 0) <> COALESCE(soma_pago, 0) + COALESCE(ultimo_transportado, 0);
  IF v_dif > 0 THEN
    RAISE EXCEPTION 'FALHOU: conservacao quebrada para % motorista(s) (Sigma remanescente(>=0) <> Sigma pago + ultimo transportado)', v_dif;
  END IF;
  RAISE NOTICE 'ok  caso 7: conservacao (Sigma remanescente>=0 = Sigma pago + ultimo transportado) vale para todos os motoristas do teste';
END $$;

-- ── Caso 8 — retrato antes/depois (fixture de 0098-antes.sql) ───────────
DO $$
DECLARE ctx record; i record;
BEGIN
  SELECT * INTO ctx FROM saldo_min_antes_ctx;
  SELECT * INTO i FROM "ApuracaoRepasseItem" WHERE apuracao_id = ctx.apuracao_id AND entregador_id = ctx.entregador_id;

  ASSERT i.creditos = 42.00, format('caso 8: creditos antigos deveriam continuar 42.00, veio %s', i.creditos);
  ASSERT i.remanescente = 42.00, format('caso 8: remanescente antigo deveria continuar 42.00, veio %s', i.remanescente);
  ASSERT i.saldo_anterior IS NULL AND i.valor_pago IS NULL AND i.valor_transportado IS NULL,
    format('caso 8: colunas novas deveriam nascer NULL num item pre-0098, veio saldo_anterior=%s valor_pago=%s valor_transportado=%s',
      i.saldo_anterior, i.valor_pago, i.valor_transportado);
  ASSERT (SELECT piso_aplicado FROM "ApuracaoRepasse" WHERE id = ctx.apuracao_id) IS NULL,
    'caso 8: piso_aplicado deveria ser NULL numa apuracao fechada antes da 0098';
  RAISE NOTICE 'ok  caso 8: retrato antes/depois -- colunas antigas iguais, colunas novas NULL, sem reprocessamento (FR-022)';
END $$;

-- ── Caso 10 (F3.15) — piso vigente no momento do FECHAMENTO ─────────────
-- Abre a semana com piso 5,50 (prévia usaria 5,50); antes de fechar, o piso
-- sobe para 8,00; o fechamento usa 8,00 (não o do início da semana).
DO $$
DECLARE
  c record; v_imp int; v_j int; v_ver int; v_atual record; v_nova "AdiantamentoConfiguracao";
  v_ap record; i record;
BEGIN
  SELECT * INTO c FROM saldo_min_ctx;
  SELECT id INTO v_imp FROM "ImportacaoArquivo" WHERE id_empresa = 6 AND tipo = 'faturamento'
    AND status NOT IN ('pending','validating','processing') ORDER BY id DESC LIMIT 1;

  INSERT INTO "Entregador" (id_empresa, id_externo, nome) VALUES (6, gen_random_uuid(), 'Caso10 Piso-No-Fechamento') RETURNING id INTO v_j;
  INSERT INTO "FaturamentoLancamento" (id_empresa, importacao_id, entregador_id, data_lancamento, data_referencia, tipo, valor, descricao, hash_linha)
  VALUES (6, v_imp, v_j, c.w4, c.w4, 'Credito', 6.00, 'Corridas concluidas', md5('t0098j-w4')||md5('x'));

  SELECT * INTO v_atual FROM "AdiantamentoConfiguracao" WHERE id_empresa = 6 ORDER BY versao DESC LIMIT 1;
  ASSERT v_atual.repasse_valor_minimo = 5.50, format('pre-condicao do caso 10: piso deveria estar em 5.50, veio %s', v_atual.repasse_valor_minimo);

  -- Sobe o piso para 8,00 ANTES do fechamento (financeiro_aprovador/admin: já
  -- é quem está autenticado na sessão -- tem pagamento_confirmar).
  SELECT * INTO v_nova FROM hub_adiantamento_configuracao_salvar(v_atual.versao, jsonb_build_object('repasseValorMinimo', '8.00'));
  ASSERT v_nova.repasse_valor_minimo = 8.00, format('caso 10: piso deveria ter sido salvo como 8.00, veio %s', v_nova.repasse_valor_minimo);

  SELECT * INTO v_ap FROM hub_adiantamento_repasse_fechar(c.w4);
  ASSERT (SELECT piso_aplicado FROM "ApuracaoRepasse" WHERE id = v_ap.apuracao_id) = 8.00,
    'caso 10: piso_aplicado deveria gravar 8.00 (o vigente NO FECHAMENTO)';

  SELECT * INTO i FROM "ApuracaoRepasseItem" WHERE apuracao_id = v_ap.apuracao_id AND entregador_id = v_j;
  ASSERT i.valor_pago = 0 AND i.valor_transportado = 6.00,
    format('caso 10: 6,00 < piso 8,00 (vigente no fechamento) deveria reter, veio pago=%s/transp=%s', i.valor_pago, i.valor_transportado);
  RAISE NOTICE 'ok  caso 10 (F3.15): piso alterado para 8,00 antes do fechamento -- motorista com 6,00 fica retido (nao pago pelo piso antigo de 5,50)';
END $$;

-- ── Cenário F3.10 — piso editável só por quem tem pagamento_confirmar ───
DO $$
DECLARE v_sub_config int; v_emp int; v_atual record; v_erro text;
BEGIN
  -- Usuário com `adiantamentos.configurar` mas SEM `adiantamentos.pagamento_confirmar`.
  SELECT ue.usuario_id, ue.empresa_id INTO v_sub_config, v_emp
    FROM "UsuarioEntidade" ue
    JOIN "PapelPermissao" pp ON pp.papel_id = ue.papel_id
    JOIN "Permissao" p ON p.id = pp.permissao_id
    JOIN "ModuloEntidade" me ON me.modulo_id = p.modulo_id AND me.empresa_id = ue.empresa_id
   WHERE p.codigo = 'adiantamentos.configurar' AND ue.ativo AND me.ativo
     AND ue.usuario_id NOT IN (
       SELECT ue2.usuario_id FROM "UsuarioEntidade" ue2
       JOIN "PapelPermissao" pp2 ON pp2.papel_id = ue2.papel_id
       JOIN "Permissao" p2 ON p2.id = pp2.permissao_id
       WHERE p2.codigo = 'adiantamentos.pagamento_confirmar' AND ue2.ativo)
   ORDER BY ue.usuario_id LIMIT 1;

  IF v_sub_config IS NULL THEN
    RAISE NOTICE 'skip caso F3.10: nenhum usuario de teste com configurar-sem-pagamento_confirmar (papel restrito da F2 pode ter deixado só combinacoes com as duas)';
  ELSE
    PERFORM set_config('request.jwt.claims',
      format('{"sub":"%s","empresa_ativa":"%s","escopo":[6,%s]}', v_sub_config, v_emp, v_emp), true);
    SELECT * INTO v_atual FROM "AdiantamentoConfiguracao" WHERE id_empresa = 6 ORDER BY versao DESC LIMIT 1;
    BEGIN
      PERFORM hub_adiantamento_configuracao_salvar(v_atual.versao, jsonb_build_object('repasseValorMinimo', '6.00'));
      RAISE EXCEPTION 'FALHOU: usuario sem pagamento_confirmar conseguiu alterar o piso';
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_erro = MESSAGE_TEXT;
      ASSERT v_erro = 'PERMISSAO_NEGADA_PISO', format('esperado PERMISSAO_NEGADA_PISO, veio %s', v_erro);
    END;
    RAISE NOTICE 'ok  F3.10: usuario com apenas adiantamentos.configurar nao pode alterar o piso (PERMISSAO_NEGADA_PISO)';
  END IF;
END $$;

-- 0/-1 recusados pelo RPC (defesa em profundidade) mesmo por quem TEM a permissão.
DO $$
DECLARE v_sub int; v_emp int; v_atual record; v_erro text;
BEGIN
  SELECT ue.usuario_id, ue.empresa_id INTO v_sub, v_emp
    FROM "UsuarioEntidade" ue
    JOIN "PapelPermissao" pp ON pp.papel_id = ue.papel_id
    JOIN "Permissao" p ON p.id = pp.permissao_id
    JOIN "ModuloEntidade" me ON me.modulo_id = p.modulo_id AND me.empresa_id = ue.empresa_id
   WHERE p.codigo = 'adiantamentos.pagamento_confirmar' AND ue.ativo AND me.ativo
   ORDER BY ue.usuario_id LIMIT 1;
  PERFORM set_config('request.jwt.claims',
    format('{"sub":"%s","empresa_ativa":"%s","escopo":[6,%s]}', v_sub, v_emp, v_emp), true);
  SELECT * INTO v_atual FROM "AdiantamentoConfiguracao" WHERE id_empresa = 6 ORDER BY versao DESC LIMIT 1;

  BEGIN
    PERFORM hub_adiantamento_configuracao_salvar(v_atual.versao, jsonb_build_object('repasseValorMinimo', '0'));
    RAISE EXCEPTION 'FALHOU: piso 0 deveria ter sido recusado';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_erro = MESSAGE_TEXT;
    ASSERT v_erro = 'DADOS_INVALIDOS_REPASSE_VALOR_MINIMO', format('esperado DADOS_INVALIDOS_REPASSE_VALOR_MINIMO, veio %s', v_erro);
  END;

  BEGIN
    PERFORM hub_adiantamento_configuracao_salvar(v_atual.versao, jsonb_build_object('repasseValorMinimo', '-1'));
    RAISE EXCEPTION 'FALHOU: piso -1 deveria ter sido recusado';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_erro = MESSAGE_TEXT;
    ASSERT v_erro = 'DADOS_INVALIDOS_REPASSE_VALOR_MINIMO', format('esperado DADOS_INVALIDOS_REPASSE_VALOR_MINIMO, veio %s', v_erro);
  END;
  RAISE NOTICE 'ok  F3.10: piso 0 e -1 recusados pelo RPC (DADOS_INVALIDOS_REPASSE_VALOR_MINIMO)';
END $$;

-- 0116 — Correção de valor/gorjeta/mensagem de movimento da EnvioMassa, com guarda
-- ATÔMICA no banco (feature corrigir-movimento, FR-015..FR-024).
-- Reusa o padrão da 0109/0067 (SECURITY DEFINER, search_path fixo, GRANT TO authenticated).
-- Guarda de "nota enviada" = nota_ok preenchido E erro_validacao vazio (btrim, NULL = vazio):
-- NUNCA numnota — nota_ok é gravado até em nota reprovada (nota reprovada pode ser corrigida).
-- A linha é travada (FOR UPDATE) e as guardas são avaliadas sobre a versão commitada mais
-- recente: nota anexada entre a leitura do chamador e esta chamada nunca é sobrescrita.
-- SECURITY DEFINER + EnvioMassa SEM RLS alguma (medido 2026-10-20: zero CREATE POLICY e
-- zero ENABLE ROW LEVEL SECURITY para ela; so GRANT por tabela): p_id_empresa e a UNICA fronteira de
-- tenant. O chamador MUST obtê-lo de resolveEmpresaAlvo, nunca do corpo da requisição.
-- Só altera valor, gorjeta, mensagem1 (chave ausente no jsonb = não mexe). Iguais => 'inalterado',
-- sem UPDATE e sem Auditoria. Alterado => 1 linha em "Auditoria" na mesma transação
-- (usuario_id NULL no painel legado: o login legado é por empresa, autoria nunca inventada).
-- msg_valor_antigo: movimento alterado cuja mensagem já havia sido enviada (enviado <> 'off').
-- Aditiva e idempotente (CREATE OR REPLACE). Nenhuma tabela/coluna nova.
-- ROLLBACK: DROP FUNCTION IF EXISTS hub_envio_massa_corrigir_valor(int, jsonb, text, text, int);

CREATE OR REPLACE FUNCTION hub_envio_massa_corrigir_valor(
    p_id_empresa int,
    p_movimentos jsonb,
    p_motivo     text,
    p_origem     text,
    p_usuario_id int
) RETURNS TABLE (
    movimento_id     bigint,
    desfecho         text,
    valor_anterior   numeric,
    msg_valor_antigo boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    m          jsonb;
    r          "EnvioMassa"%ROWTYPE;
    v_id       bigint;
    v_valor    double precision;
    v_gorjeta  double precision;
    v_msg      text;
    v_tem_msg  boolean;
    v_tem_gor  boolean;
    -- ESPELHO de String.prototype.trim() do JS (notaAprovada em routes/hub-validacao-xml.js): manter em paridade.
    v_ws       text := E' \t\n\u000b\f\r\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff';
BEGIN
    IF p_origem NOT IN ('tela', 'reimportacao') THEN
        RAISE EXCEPTION 'origem invalida: %', p_origem USING ERRCODE = '22023';
    END IF;
    IF p_motivo IS NULL OR btrim(p_motivo) = '' THEN
        RAISE EXCEPTION 'motivo obrigatorio' USING ERRCODE = '22023';
    END IF;

    FOR m IN SELECT * FROM jsonb_array_elements(COALESCE(p_movimentos, '[]'::jsonb)) LOOP
        v_id      := (m ->> 'id')::bigint;
        v_tem_gor := m ? 'gorjeta';
        v_tem_msg := m ? 'mensagem1';
        v_valor   := (m ->> 'valor')::double precision;
        v_gorjeta := (m ->> 'gorjeta')::double precision;
        v_msg     := m ->> 'mensagem1';

        movimento_id := v_id; valor_anterior := NULL; msg_valor_antigo := false;

        -- escopo de tenant + trava da linha (relê a versão commitada mais recente)
        SELECT * INTO r FROM "EnvioMassa" WHERE id = v_id AND id_empresa = p_id_empresa FOR UPDATE;
        IF NOT FOUND THEN
            desfecho := 'nao_encontrado'; RETURN NEXT; CONTINUE;
        END IF;
        valor_anterior := r.valor;

        IF r.mov_fechado THEN
            desfecho := 'pulado_mov_fechado';
        ELSIF NULLIF(btrim(COALESCE(r.nota_ok, ''), v_ws), '') IS NOT NULL
          AND NULLIF(btrim(COALESCE(r.erro_validacao, ''), v_ws), '') IS NULL THEN
            desfecho := 'pulado_nota_enviada';
        ELSIF r.valor IS NOT DISTINCT FROM COALESCE(v_valor, r.valor)
          AND (NOT v_tem_gor OR r.gorjeta IS NOT DISTINCT FROM v_gorjeta)
          AND (NOT v_tem_msg OR r.mensagem1 IS NOT DISTINCT FROM v_msg) THEN
            desfecho := 'inalterado';
        ELSE
            UPDATE "EnvioMassa"
               SET valor     = COALESCE(v_valor, valor),
                   gorjeta   = CASE WHEN v_tem_gor THEN v_gorjeta ELSE gorjeta END,
                   mensagem1 = CASE WHEN v_tem_msg THEN v_msg ELSE mensagem1 END
             WHERE id = v_id AND id_empresa = p_id_empresa;

            INSERT INTO "Auditoria" (id_empresa, usuario_id, acao, recurso, recurso_id, detalhes)
            VALUES (p_id_empresa, p_usuario_id, 'movimento_valor_corrigido', 'EnvioMassa', v_id::text,
                    jsonb_build_object(
                        'valor_anterior',    r.valor,
                        'valor_novo',        COALESCE(v_valor, r.valor),
                        'gorjeta_anterior',  r.gorjeta,
                        'gorjeta_nova',      CASE WHEN v_tem_gor THEN v_gorjeta ELSE r.gorjeta END,
                        'motivo',            p_motivo,
                        'origem',            p_origem,
                        'mensagem_ajustada', v_tem_msg));
            desfecho := 'atualizado';
            msg_valor_antigo := COALESCE(NULLIF(btrim(r.enviado), ''), 'off') <> 'off';
        END IF;
        RETURN NEXT;
    END LOOP;
END
$$;

-- SECURITY DEFINER sem RLS na tabela: EXECUTE default de PUBLIC deixaria qualquer papel (inclusive anon)
-- corrigir valor de qualquer empresa. Fecha antes de abrir so para o papel que o backend usa.
REVOKE ALL ON FUNCTION hub_envio_massa_corrigir_valor(int, jsonb, text, text, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hub_envio_massa_corrigir_valor(int, jsonb, text, text, int) TO authenticated;

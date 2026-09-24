-- ROLLBACK da 0096 (e-mail como cadastro do hub).
--
-- Dropa os gatilhos e as funções. A COLUNA e os DADOS ficam:
--   - e-mail com `email_origem='hub'` foi digitado por gente e não existe em
--     nenhum outro lugar — apagá-lo é perda definitiva;
--   - e-mail com origem 'entrego' é recuperável do enriquecimento, mas dropar a
--     coluna levaria os dois juntos.
--
-- ⚠️ Sem os gatilhos, o e-mail volta a NÃO ser normalizado na gravação e o
-- enriquecimento volta a poder sobrescrever o que o hub digitou — que é
-- exatamente o problema que esta migration resolveu.
--
-- Conferir antes de cogitar dropar a coluna:
--   SELECT email_origem, count(*) FROM "ContaMotorista"
--    WHERE email IS NOT NULL GROUP BY 1;

DROP TRIGGER IF EXISTS trg_contamotorista_protege_email ON "ContaMotorista";
DROP TRIGGER IF EXISTS trg_contamotorista_normaliza_email ON "ContaMotorista";
DROP FUNCTION IF EXISTS hub_protege_email_motorista();
DROP FUNCTION IF EXISTS hub_normaliza_email_motorista_insert();

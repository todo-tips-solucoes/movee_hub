-- ROLLBACK da 0094. Nada depende do índice; as consultas por CNPJ do prestador
-- voltam a fazer Parallel Seq Scan em 207 mil linhas (~62 ms cada).
DROP INDEX IF EXISTS idx_envio_massa_cnpj_prestador;

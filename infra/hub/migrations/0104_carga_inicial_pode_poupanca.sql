-- 0104 — conserta a trava de poupança: ela impedia APOSENTAR conta antiga.
--
-- A 0103 proibiu POUPANCA em qualquer linha nova, com `NOT VALID` para não
-- mexer nas 4 contas poupança que já existiam. O `NOT VALID` isenta essas
-- linhas da validação INICIAL — mas qualquer UPDATE nelas revalida a
-- constraint. Resultado medido em 2026-10-06, simulando a carga:
--
--   UPDATE "ContaBancariaMotorista" SET status = 'CANCELADA' ... (poupança APP)
--   ERROR: violates check constraint "contabancariamotorista_sem_poupanca_chk"
--
-- Ou seja: rejeitar ou substituir uma conta poupança pendente — exatamente o
-- movimento que a regra quer — estava IMPOSSÍVEL pelo hub. Bug latente que
-- ninguém tinha tropeçado ainda porque nenhuma dessas 4 foi revisada desde
-- ontem.
--
-- A trava passa a valer só para conta que VALE: `PENDENTE` e `APROVADA`.
-- Conta morta (CANCELADA/SUBSTITUIDA/REJEITADA) pode ser poupança — tirar uma
-- poupança de circulação é o objetivo, não a violação.
--
-- E abre a exceção que o operador pediu para a carga da planilha
-- (2026-10-06): `CARGA_INICIAL` pode trazer poupança, porque são motoristas
-- que já operam assim. App (origem APP) e hub (origem HUB) continuam recusados.

ALTER TABLE "ContaBancariaMotorista" DROP CONSTRAINT IF EXISTS contabancariamotorista_sem_poupanca_chk;
ALTER TABLE "ContaBancariaMotorista"
  ADD CONSTRAINT contabancariamotorista_sem_poupanca_chk
  CHECK (
    tipo_conta = 'CORRENTE'
    OR origem = 'CARGA_INICIAL'
    OR status IN ('CANCELADA', 'SUBSTITUIDA', 'REJEITADA')
  ) NOT VALID;

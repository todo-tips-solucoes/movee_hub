-- 0113 — "EnvioMassa".pago_manual / nota_apagada: ações do financeiro sobre os
-- pagamentos retidos (Hub → Validação XML → "Pagamentos retidos aguardando liberação").
--
-- POR QUE EXISTE: motoristas regularizaram pelo app notas de movimentos que o
-- financeiro JÁ tinha pago fora da plataforma (medido em 14/10: 6 de 36 com o
-- mesmo número e valor na planilha UneCont). O operador precisa, pela tela:
--   1. "Já foi pago": marca o movimento como pago fora. Reusa conciliada_em
--      (a 0112 já bloqueia o lote com JA_PAGO_CONCILIADO) com
--      conciliada_origem = 'MANUAL'; `pago_manual` guarda quem/quando/referência
--      para a tela e para o Desfazer (só desfaz origem 'MANUAL', nunca 'UNECONT:').
--   2. "Apagar nota": desvincula a nota (o movimento volta a pendente).
--      `nota_apagada` guarda o estado anterior para recuperação manual. Não vai
--      para a Auditoria porque o scrub dela omite qualquer valor com 14 dígitos
--      seguidos, e a URL do XML (`nota_ok`) carrega a chave de 50 dígitos.
--
-- SEMÂNTICA: NULL = nunca houve a ação (todo o histórico). `nota_apagada` é a
-- ÚLTIMA nota apagada daquele movimento (uma nova exclusão sobrescreve).
--
-- PERMISSÃO: GRANT da EnvioMassa é por tabela (0033); as colunas herdam.
--
-- Aditiva e idempotente. Depois de aplicar: SIGUSR1 no PostgREST (cache de schema).
-- ROLLBACK: as colunas podem ficar (inertes) ou sair com DROP COLUMN.

ALTER TABLE "EnvioMassa" ADD COLUMN IF NOT EXISTS pago_manual jsonb;
ALTER TABLE "EnvioMassa" ADD COLUMN IF NOT EXISTS nota_apagada jsonb;

-- 0056 — a importação passa a registrar o INTERVALO de datas do arquivo, não
-- uma data só copiada da primeira linha.
--
-- ── POR QUE ─────────────────────────────────────────────────────────────────
-- `ImportacaoArquivo.data_referencia` recebia a data da PRIMEIRA linha válida
-- (`hub-import-processor.js`), o que rotula a importação com um dia que muitas
-- vezes não é o dela. Caso real: o arquivo de faturamento de 28/08/2026 tem
-- 4.786 linhas com competências espalhadas entre 25/08 e 28/08, e a importação
-- aparecia como "27/08" só porque foi o que veio na linha 1.
--
-- Decisão do operador em 2026-08-30: a importação informa o RANGE; cada
-- REGISTRO continua com a data da própria linha. A segunda metade nunca
-- dependeu deste campo — as tabelas de fato sempre gravaram linha a linha
-- (conferido em 8 campos × 3.067 linhas do arquivo de 28/08: zero
-- divergências). O que muda aqui é só o metadado.
--
-- ── O QUE MUDA ──────────────────────────────────────────────────────────────
-- `data_referencia` passa a ser o INÍCIO do intervalo (a menor data do arquivo)
-- e ganha o par `data_referencia_fim` (a maior). Manter o nome do campo antigo
-- como início é o que evita quebrar o `select`, a ordenação (`ORDENAVEIS_
-- IMPORTACOES`), o contrato e as telas que já leem `dataReferencia`.
--
-- O campo por tipo é o que LIGA os dois módulos e não muda: performance usa
-- `data_do_periodo` (a data do turno), faturamento usa a competência
-- (`data_do_periodo_de_referencia`).
--
-- Aditiva e idempotente. O backfill recalcula a partir das tabelas de fato —
-- a fonte da verdade — então corrige de uma vez os rótulos errados que a regra
-- da "primeira linha" deixou para trás, e rodar de novo dá o mesmo resultado.

ALTER TABLE "ImportacaoArquivo"
    ADD COLUMN IF NOT EXISTS data_referencia_fim date NULL;

COMMENT ON COLUMN "ImportacaoArquivo".data_referencia IS
    'Início do intervalo de datas do arquivo (menor data das linhas válidas). Performance: data_do_periodo. Faturamento: competência.';
COMMENT ON COLUMN "ImportacaoArquivo".data_referencia_fim IS
    'Fim do intervalo (maior data das linhas válidas). NULL em importações antigas sem fatos remanescentes.';

-- Backfill a partir dos FATOS (não do arquivo original, que pode já ter sido
-- expurgado pela retenção de 12 meses da 0052).
UPDATE "ImportacaoArquivo" i
   SET data_referencia     = f.min_d,
       data_referencia_fim = f.max_d
  FROM (
        SELECT importacao_id, min(data_referencia) AS min_d, max(data_referencia) AS max_d
          FROM "FaturamentoLancamento"
         GROUP BY importacao_id
       ) f
 WHERE i.id = f.importacao_id
   AND i.tipo = 'faturamento'
   AND (i.data_referencia IS DISTINCT FROM f.min_d OR i.data_referencia_fim IS DISTINCT FROM f.max_d);

UPDATE "ImportacaoArquivo" i
   SET data_referencia     = p.min_d,
       data_referencia_fim = p.max_d
  FROM (
        SELECT importacao_id, min(data_periodo) AS min_d, max(data_periodo) AS max_d
          FROM "PerformanceTurno"
         GROUP BY importacao_id
       ) p
 WHERE i.id = p.importacao_id
   AND i.tipo = 'performance'
   AND (i.data_referencia IS DISTINCT FROM p.min_d OR i.data_referencia_fim IS DISTINCT FROM p.max_d);

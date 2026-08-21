-- 0052 — limpa o literal `""` gravado pelos imports anteriores ao fix de
-- desaspagem do parser (hub-import-parser.js#desasparCampo).
--
-- O CSV real da plataforma parceira representa campo vazio como `""` (aspas
-- duplas literais). O split por `;` sem desaspagem gravava essa string de
-- 2 caracteres como se fosse valor. Medido no arquivo de 2026-07-03 já
-- importado: FaturamentoLancamento com `""` em origem (3.873), subpraca
-- (820), periodo (211) e margem_fee_raw (3.909); PerformanceTurno com `""`
-- em origem (2.685) e subpraca (505). Efeitos visíveis: `""` renderizado na
-- tabela de faturamento e uma "área" fantasma `""` em
-- hub_areas_por_entregador.
--
-- DML idempotente e aditiva-segura: só converte o marcador `""` em NULL —
-- que é exatamente o que o parser corrigido teria produzido. `hash_linha`
-- NÃO é recalculado de propósito: ele continua deduplicando o arquivo
-- original já importado.

UPDATE "FaturamentoLancamento" SET origem = NULL WHERE origem = '""';
UPDATE "FaturamentoLancamento" SET subpraca = NULL WHERE subpraca = '""';
UPDATE "FaturamentoLancamento" SET periodo = NULL WHERE periodo = '""';
UPDATE "FaturamentoLancamento" SET margem_fee_raw = NULL WHERE margem_fee_raw = '""';

UPDATE "PerformanceTurno" SET origem = NULL WHERE origem = '""';
UPDATE "PerformanceTurno" SET subpraca = NULL WHERE subpraca = '""';

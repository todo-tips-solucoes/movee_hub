-- 0049 — Canoniza `praca`/`periodo` de PerformanceMeta (corretiva da 0048).
--
-- Revisão adversarial de 2026-08-16, reproduzida contra o hub-homolog antes de
-- escrever esta migration:
--
--   PUT {praca:"SAO PAULO", periodo:"ALMOCO", ...}  -> 200
--   PUT {praca:"Sao Paulo", periodo:"Almoco", ...}  -> 200
--   GET /performance/metas                          -> DUAS linhas
--
-- A unique da 0048 é byte-exata, então o `ON CONFLICT` não disparou. Mas a
-- chave de casamento da tela normalizava caixa, colapsava as duas e aplicava
-- só uma — qual delas dependia da ordenação. O admin via duas metas listadas,
-- a tela de Performance julgava por uma, e nada dizia qual. Numa tela cujo
-- número vira cobrança contratual, isso é uma reprovação que ninguém consegue
-- reconstruir.
--
-- Havia ainda o caso mudo: a MESMA letra acentuada em NFD (planilha exportada
-- em macOS) e NFC é visualmente idêntica e diferente para a unique e para a
-- chave. A meta era gravada, aparecia na lista e nunca marcava nada —
-- indistinguível de "sem meta", que é estado legítimo do produto.
--
-- A correção completa tem duas metades: `canonizarTexto` no backend (grava a
-- forma canônica) e ESTA migration (converte o que já está gravado). Sem a
-- segunda, linhas anteriores continuariam órfãs da chave nova.
--
-- Forma canônica: NFC -> espaços internos colapsados -> trim -> MAIÚSCULAS.
-- Maiúsculas porque é o que as planilhas de origem produzem ("SAO PAULO",
-- "ALMOCO 11H30-15H29"): canonizar para elas mantém o que a pessoa lê igual ao
-- que a importação gera.
--
-- Idempotente: reexecutar sobre dados já canônicos não muda nada.

-- Helper IMMUTABLE, no mesmo espírito de `hub_normaliza_nome` (0021): a regra
-- de canonização aparece em cinco lugares nesta migration (dedup, update e três
-- CHECKs) e repeti-la à mão é como as cinco cópias divergem.
--
-- `normalize()` existe desde o PG 13 (o hub roda 13.23, confirmado no cutover).
CREATE OR REPLACE FUNCTION hub_meta_canonica(texto text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT upper(btrim(regexp_replace(normalize(coalesce(texto, ''), NFC), '\s+', ' ', 'g')));
$$;

-- ORDEM IMPORTA, e errei nela na primeira escrita desta migration: canonizar
-- ANTES de deduplicar faz a unique disparar no meio do UPDATE, porque
-- 'Sao Paulo' vira 'SAO PAULO' enquanto a linha 'SAO PAULO' ainda existe. O
-- migrate.sh é transacional por arquivo, então nada ficou pela metade — mas a
-- lição fica: dedup primeiro, sobre a forma CANÔNICA, e só depois a conversão.
DELETE FROM "PerformanceMeta" m
USING "PerformanceMeta" outra
WHERE m.id_empresa = outra.id_empresa
  AND m.indicador  = outra.indicador
  AND hub_meta_canonica(m.praca)   = hub_meta_canonica(outra.praca)
  AND hub_meta_canonica(m.periodo) = hub_meta_canonica(outra.periodo)
  -- Fica a mais recente: `atualizado_em` é o que a tela mostra como "quando
  -- isto foi decidido". Em empate, o maior id — o último gravado.
  AND (m.atualizado_em, m.id) < (outra.atualizado_em, outra.id);

UPDATE "PerformanceMeta"
SET praca   = hub_meta_canonica(praca),
    periodo = hub_meta_canonica(periodo)
WHERE praca   IS DISTINCT FROM hub_meta_canonica(praca)
   OR periodo IS DISTINCT FROM hub_meta_canonica(periodo);

-- A unique da 0048 (colunas cruas) passa a bastar, porque o que se grava agora
-- JÁ é a forma canônica. Não se troca por índice sobre expressão de propósito:
-- o `on_conflict=` do PostgREST recebe nomes de coluna, não expressões — um
-- índice funcional quebraria o upsert.
--
-- Os CHECKs são a rede: impedem que uma escrita futura (script, correção
-- manual, endpoint novo) volte a gravar forma não-canônica sem passar pelo
-- backend. Sem eles, a divergência entre banco e chave renasceria em silêncio,
-- que é exatamente como ela nasceu.
ALTER TABLE "PerformanceMeta" DROP CONSTRAINT IF EXISTS performancemeta_praca_canonica_chk;
ALTER TABLE "PerformanceMeta" ADD CONSTRAINT performancemeta_praca_canonica_chk
  CHECK (praca = hub_meta_canonica(praca));

ALTER TABLE "PerformanceMeta" DROP CONSTRAINT IF EXISTS performancemeta_periodo_canonico_chk;
ALTER TABLE "PerformanceMeta" ADD CONSTRAINT performancemeta_periodo_canonico_chk
  CHECK (periodo = hub_meta_canonica(periodo));

-- Teto de comprimento, espelhando `TAMANHO_MAX_TEXTO` do backend. Sem ele, a
-- unique aceita combinações novas sem fim e cada PUT despeja texto arbitrário
-- na auditoria, que é imutável e retida 12 meses.
ALTER TABLE "PerformanceMeta" DROP CONSTRAINT IF EXISTS performancemeta_tamanho_chk;
ALTER TABLE "PerformanceMeta" ADD CONSTRAINT performancemeta_tamanho_chk
  CHECK (length(praca) <= 120 AND length(periodo) <= 120);

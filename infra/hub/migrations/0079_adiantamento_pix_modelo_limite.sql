-- 0079 — Limita `descricao_pix_modelo` a 140 chars por CONSTRAINT (feature
-- "Adiantamento pelo App, Dados Bancários e Exportação Transfeera", FASE 12 /
-- converge-report.md (2ª passada), tasks.md 12.3, FR-055-descricao-pix). Não
-- edita 0066/.../0078 (já aplicadas no hub-homolog persistente) — expand-only.
--
-- Bug: `descricao_pix_modelo` é `text` sem limite (0066:64) e o único CHECK
-- é `LIKE '%{nome}%'` (0066:91) — `PUT /configuracoes` não valida
-- comprimento. `hub_adiantamento_lote_criar` (0076) grava o modelo BRUTO em
-- `col_descricao_pix` truncado em 140 só por segurança do CHECK da COLUNA de
-- destino (`AdiantamentoLoteItem.col_descricao_pix`) — um `left(modelo,140)`
-- que cai no meio de um `{...}` derrota a própria validação que 11.16
-- introduziu (renderizarDescricaoPix só recusa placeholder desconhecido; um
-- placeholder partido pelo corte não é mais reconhecível como placeholder e
-- passa como texto literal).
--
-- Fix: mesmo padrão já usado para `previsao_pagamento_texto`
-- (`adiantamentoconfiguracao_previsao_chk`, 0066:89) — CHECK de comprimento
-- na própria coluna do MODELO, para que nenhum caminho de escrita (PUT
-- /configuracoes de hoje, RPC direta, ou uma futura tela de admin) consiga
-- gravar um modelo que o truncamento de 0076 possa partir ao meio.
ALTER TABLE "AdiantamentoConfiguracao"
    ADD CONSTRAINT adiantamentoconfiguracao_pix_modelo_len_chk
    CHECK (char_length(descricao_pix_modelo) <= 140);

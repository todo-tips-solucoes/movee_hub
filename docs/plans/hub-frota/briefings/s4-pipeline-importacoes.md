# Briefing S4 — Pipeline de importações (faturamento + performance)

**Fase:** S4 · **Branch:** `feat/hub-importacoes` · **Pré-requisito:** S2 mergeada
(schema/RBAC); S3 recomendada antes (telas usam o shell).

## Contexto mínimo (autossuficiente)

- Fontes: CSVs diários exportados da plataforma parceira, entregues como ZIP com 1 CSV.
  **Formatos reais medidos** (2026-07-03):
  - **Faturamento**: 4.014 linhas × 20 colunas; UTF-8 **com BOM**; separador `;`;
    **decimal vírgula**; datas ISO. 1 linha = 1 lançamento financeiro. Colunas:
    `data_do_lancamento_financeiro, data_do_periodo_de_referencia, data_do_repasse,
    periodo, praca, subpraca, origem, id_da_pessoa_entregadora (UUID, 4,5% vazio),
    recebedor (nome), tipo (Credito), valor, descricao (10 categorias),
    atingido, percentual_de_{tempo_disponivel,aceitacao,conclusao},
    criterio_{tempo_disponivel,rotas_aceitas,rotas_concluidas},
    margem_fee_porcentagem (texto "MIN: x, INTER: y")` — campos de bônus ~97% vazios.
  - **Performance**: 2.720 linhas × 19 colunas; UTF-8 com BOM; `;`; **decimal ponto**;
    `duracao_do_periodo`/`tempo_disponivel_absoluto` em `HH:MM:SS`;
    `soma_das_taxas_das_corridas_aceitas` em **centavos** (int);
    `tempo_disponivel_escalado` é **percentual** (0–100,14). Header `sub_praca`
    (com underscore, difere do faturamento). 1 linha = entregador×turno×dia(×subpraça).
  - **Não há chave natural única**: dedupe por **hash sha256 da linha normalizada** +
    hash do arquivo. 179 linhas de faturamento sem UUID (bônus agregados) são válidas.
  - **LGPD**: nome + UUID do entregador são dados pessoais. CSV bruto nunca em git, log
    ou contexto de sessão; na homolog usar os **seeds anonimizados da S1**; se precisar
    inspecionar CSV real, só no sandbox context-mode.
- Modelo de destino (migrations desta fase, série única 011+ continuada):
  `Entregador(id_empresa, id_externo uuid, nome, motorista_id NULL,
  UNIQUE(id_empresa,id_externo))`; `ImportacaoArquivo(id_empresa, tipo, nome_arquivo,
  hash_sha256, tamanho, status, total/validas/invalidas, data_referencia,
  UNIQUE(id_empresa,tipo,hash_sha256))`; `ImportacaoLinhaErro(importacao_id, numero_linha,
  motivo, campo, valor_mascarado)`; `FaturamentoLancamento` e `PerformanceTurno`
  (fatos append-only, `UNIQUE(id_empresa, hash_linha)`). Matriz de mapeamento completa:
  plano técnico §10 (**seguir coluna a coluna**). Catálogo: §9.2.
- ⚠️ Ambiente do VPSTodo É PRODUÇÃO — trabalho só no ambiente isolado.

## Objetivo

Pipeline idempotente de importação (upload→validação→persistência→erros→histórico) +
telas, para os tipos `faturamento` e `performance`.

## Escopo

**Inclui**
1. Migrations das tabelas acima (+ GRANTs + RLS, padrão da S2).
2. **Backend** `/api/v1/importacoes*` (contratos: plano §14): POST upload multipart
   (CSV/ZIP ≤ 20 MB) com: validação de extensão/MIME/tamanho/conteúdo; sha256; 409 para
   arquivo duplicado (link da original); armazenamento do original em volume privado por
   id; ZIP seguro (1 entrada, sem path traversal, limite descomprimido 100 MB);
   processamento em lotes de 500 com `ON CONFLICT (id_empresa, hash_linha) DO NOTHING`;
   upsert de `Entregador` por `(id_empresa, id_externo)`; validações da matriz §10 com
   erros por linha (motivo+campo+**valor mascarado** — nunca a linha bruta); estados
   `pending→validating→processing→completed|completed_with_errors|failed|cancelled`;
   falha estrutural (cabeçalho errado, >50% inválidas) → `failed` sem persistir nada;
   lock advisory por `(id_empresa,tipo)`; GET lista/detalhe (contadores p/ polling),
   GET erros (+`?format=csv` com proteção CSV injection), GET original
   (`importacoes.export`), POST reprocessar (failed/cancelled), POST cancelar.
3. **Frontend**: `/importacoes` e `/importacoes/:id` (requisitos completos na §13.3 do
   plano — wizard de upload, progresso por polling, tabela de erros, download relatório,
   histórico, reprocessar/cancelar). Design via /ui-ux-pro-max. Reusar padrões
   `use-process-status`/`data-table`/`filters`.

**Não inclui:** telas de consulta de faturamento/performance (S6/S7); fila assíncrona
(volume não justifica — interface `ImportJob` isolada para plugar depois); tipo
`envio_massa` (S8); mudanças no `/upload` legado.

## Ordem

migrations → parser/normalizador (unit-first: vírgula vs ponto decimal!) → POST upload +
dedupe → processamento em lote + erros → endpoints de consulta/ação → telas → E2E →
evidências.

## Testes exigidos

- **Unit:** parser (BOM, `;`, decimal vírgula E ponto, HH:MM:SS→interval, UUID, margem_fee
  regex, linha sem UUID válida, hash estável), validações da matriz, mascaramento.
- **Integração:** importar fixture anonimizada dos 2 tipos → contagens; **reimportar o
  mesmo arquivo → 0 inserções** (por hash de arquivo E por hash de linha com arquivo
  renomeado); arquivo com cabeçalho errado → `failed` e 0 linhas; 409 de duplicado;
  cancelamento entre lotes.
- **E2E:** upload pela UI → progresso → conclusão → erros visíveis → download do
  relatório → reprocessamento de um `failed`.

## Evidências

Resumo das importações (contagens); log da reimportação no-op; relatório de erros gerado;
prova de que nenhum valor bruto pessoal aparece em logs (grep na saída dos serviços).

## Critérios de aceite

1. Importar os seeds dos 2 tipos com 100% de linhas válidas; 2. reimportação = 0 novas
linhas; 3. §13.3 completo na UI; 4. nenhum dado pessoal em log/erro; 5. estados §12.2
respeitados; 6. PR + DIARIO.md.

## Gotchas

- Os dois CSVs usam **separador decimal diferente** — parser por tipo, não único.
- Cabeçalho `subpraca` (fat.) vs `sub_praca` (perf.).
- `tipo` hoje só tem `Credito` — aceitar `Debito` (validação por domínio com warning
  para valor novo, não erro fatal).
- Categoria nova em `descricao` = warning, não erro (schema do parceiro pode evoluir).
- PostgREST: GRANT + reload de schema para cada tabela nova.

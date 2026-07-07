# Research — Pipeline de Importações (hub-importacoes / S4)

Phase 0 do `/plan`. Resolve os unknowns técnicos antes do design (data-model,
contracts). Fontes canônicas: `docs/plans/hub-frota/01-plano-tecnico.md` §9.2,
§10, §12, §14; briefing `docs/plans/hub-frota/briefings/s4-pipeline-importacoes.md`.
Estado real da S2/S3 verificado no código (não presumido).

---

## Decision 1 — Série de migrations continua em `0010` (não `011`)

**Decision**: as migrations desta fase começam em `0010_*.sql` em
`infra/hub/migrations/`, continuando a série única da S2/S3 (última aplicada =
`0009_rls_hardening_indices.sql`). Aplicadas por `infra/hub/scripts/migrate.sh`
(registra em `SchemaMigration` + envia `SIGUSR1` ao PostgREST para reload do
schema cache). Todas idempotentes (`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX
IF NOT EXISTS`, `DO $$ ... IF NOT EXISTS` guards, `CREATE OR REPLACE`, `DROP
POLICY IF EXISTS` antes de `CREATE POLICY`, `ON CONFLICT DO NOTHING` em seeds).

**Rationale**: verificado por `ls infra/hub/migrations/` — a numeração real é
`0000`–`0009` (o briefing dizia "011+", mas isso era o rótulo lógico do plano
mestre; a série FÍSICA no repo está em 0009, dec-027 da S2). A regra "série única
continuada" vale sobre a numeração real. Migrar em `backend/db/011+` (como o
briefing sugeria à primeira vista) criaria uma série paralela órfã.

**Alternatives considered**: (a) numerar `0011+` deixando gap — rejeitado, gap
sem migration `0010` confunde o `migrate.sh` que ordena lexicograficamente; (b)
arquivo único `0010_importacoes.sql` com tudo — rejeitado, quebra o padrão S2 de
1 família de tabela por arquivo + RLS/seed dedicados (dificulta revisão e rollback
mental).

**Decomposição proposta** (7 migrations):
| Nº | Arquivo | Conteúdo |
|----|---------|----------|
| 0010 | `entregador.sql` | tabela `Entregador` + índices + GRANTs |
| 0011 | `importacao_arquivo.sql` | tabela `ImportacaoArquivo` + índices + GRANTs |
| 0012 | `importacao_linha_erro.sql` | tabela `ImportacaoLinhaErro` (+ `id_empresa` denormalizado, ver Decision 4) + GRANTs |
| 0013 | `faturamento_lancamento.sql` | tabela `FaturamentoLancamento` + índices + GRANTs |
| 0014 | `performance_turno.sql` | tabela `PerformanceTurno` + índices + GRANTs |
| 0015 | `rls_importacoes.sql` | ENABLE RLS + policies nas 5 tabelas novas |
| 0016 | `seed_permissao_importacoes.sql` | adiciona `importacoes.exportar` + grants aos papéis (ver Decision 2) |

---

## Decision 2 — Reconciliação de permissões: seed real é PT-BR e falta `importacoes.exportar`

**Decision**: o backend usa os códigos de permissão **reais já semeados** em
`0007_seed_papeis_permissoes_modulos.sql` (verbos em português), NÃO os rótulos
English do §14/§9.2 do plano. Mapeamento lógico→real:

| Ação lógica (spec/§14) | Código real (middleware `requirePermission`) | Situação |
|------------------------|-----------------------------------------------|----------|
| `importacoes.list` / `importacoes.view` | `importacoes.consultar` | JÁ existe (0007) |
| `importacoes.create` | `importacoes.criar` | JÁ existe (0007) |
| (processamento interno) | `importacoes.importar` | JÁ existe (0007) — reservado; endpoints usam `criar` p/ upload/reprocessar/cancelar |
| `importacoes.export` | **`importacoes.exportar`** | **AUSENTE — 0016 cria + concede** |

`0016` adiciona `importacoes.exportar` a `Permissao` e concede a
`admin_plataforma` (via CROSS JOIN já cobre — mas o seed 0007 já rodou, então
`0016` faz o `INSERT ... ON CONFLICT DO NOTHING` na permissão + `INSERT` explícito
em `PapelPermissao` para `admin_plataforma` e `admin_entidade`; `operador`/`leitura`
NÃO recebem export por padrão — export de arquivo original é ação sensível/LGPD).

**Rationale**: verificado lendo `0007` linha a linha — módulo `importacoes` tem só
`consultar`, `criar`, `importar`; `exportar` existe para `faturamento`/`performance`/
`motoristas` mas NÃO para `importacoes`. A spec (US4 cenário 5) exige que "consultar
sem exportar" recuse o download do original — isso é impossível sem a permissão
`importacoes.exportar` distinta de `importacoes.consultar`. Sem 0016, `GET
/importacoes/:id/original` ficaria sem gate ou reusaria `consultar` (violando US4-5).

**Alternatives considered**: (a) reusar `importacoes.criar` para export — rejeitado,
mistura semântica de escrita com leitura sensível; (b) editar 0007 — rejeitado,
migration já aplicada em hub-homolog é imutável (expand-only), correção entra como
migration nova (0016), mesmo padrão do comentário de 0007 ("ajuste por migration
corretiva").

---

## Decision 3 — Parser POR TIPO com dois dialetos numéricos (não parser único)

**Decision**: dois normalizadores separados, selecionados por `tipo`
(`faturamento` | `performance`), compartilhando primitivas (strip BOM, split `;`,
sha256 de linha normalizada) mas com regras numéricas distintas:

- **Faturamento**: decimal **vírgula→ponto** (`"1.234,56"` → `1234.56`; remover
  separador de milhar `.` antes de trocar `,`→`.`); header `subpraca` (sem `_`).
- **Performance**: decimal **ponto** direto; header `sub_praca` (com `_`);
  `HH:MM:SS` → `interval`; `soma_das_taxas_das_corridas_aceitas` em **centavos** (int
  direto, sem divisão); `tempo_disponivel_escalado` é percentual 0–150 (`numeric(6,2)`).

Ambos: UTF-8 **com BOM** (strip `﻿` inicial); separador `;`; parse por
streaming linha-a-linha (sem carregar o arquivo inteiro na memória).

**Rationale**: briefing e §10 medem empiricamente os dois formatos (Faturamento
4.014×20 decimal vírgula; Performance 2.720×19 decimal ponto) — um parser único
com "detecção de separador" seria heurística frágil (uma linha de faturamento com
valor inteiro sem vírgula seria ambígua). O tipo é conhecido no upload (campo
`tipo` do multipart), então a seleção é determinística.

**Alternatives considered**: parser único com sniffing — rejeitado (frágil, contradiz
gotcha explícito do briefing "parser por tipo, não único").

**margem_fee** (só faturamento): campo texto `"MIN: x, INTER: y"`. Regra: gravar
`margem_fee_raw` (cru, trim) SEMPRE; derivar `margem_fee_min`/`margem_fee_inter`
via regex `MIN:\s*([\d.,]+).*INTER:\s*([\d.,]+)` (aplicar a mesma normalização
vírgula→ponto aos capturados). Regex não casa → só `raw` preenchido, min/inter NULL,
**sem erro de linha** (campo não obrigatório). D4 ratificado.

**atingido** e `pct_*`/`criterio_*`: `numeric(8,2)`, vírgula→ponto, faixa 0–1000,
**sem interpretar negócio** (D4). Fora da faixa → erro de linha no campo.

---

## Decision 4 — RLS de `ImportacaoLinhaErro`: denormalizar `id_empresa`

**Decision**: adicionar coluna `id_empresa FK Empresa NOT NULL` a
`ImportacaoLinhaErro` (além do `importacao_id` do §9.2), preenchida no insert com
o mesmo `id_empresa` da importação-pai. RLS por `id_empresa = ANY(hub_jwt_escopo_ids())`,
idêntica às demais tabelas de fato.

**Rationale**: o padrão RLS da S2 (`0006`) escopa por coluna `id_empresa`/`empresa_id`
direta via `hub_jwt_escopo_ids()`. `ImportacaoLinhaErro` no §9.2 só tem `importacao_id`
— uma policy `EXISTS (SELECT 1 FROM ImportacaoArquivo ...)` funcionaria mas: (a)
paga subquery por linha em listagens de erro paginadas; (b) foge do padrão uniforme
das outras 4 tabelas. Denormalizar `id_empresa` é expand-only, barato, e mantém a
policy trivial e consistente. `numero_linha`, `motivo`, `campo`, `valor_mascarado`
seguem o §9.2.

**Alternatives considered**: RLS via EXISTS na pai — rejeitado (custo + inconsistência);
sem RLS em LinhaErro confiando só no filtro do backend — rejeitado (viola Princípio
II NON-NEGOTIABLE, defesa em profundidade da S2 exige RLS na tabela).

---

## Decision 5 — Concorrência: lock advisory Postgres por `(id_empresa, tipo)`

**Decision**: 1 importação ativa por `(id_empresa, tipo)`. Implementação:
`pg_try_advisory_lock(hashtext(id_empresa || ':' || tipo))` no início do
processamento; se ocupado, a nova importação fica em `pending` (estado de espera
visível) e o processamento inicia automaticamente quando a anterior atinge estado
terminal (Clarify Q1 / dec-009 = opção A, score 3). NÃO rejeita com 409 por
concorrência (409 é só para arquivo duplicado por hash).

**Rationale**: §12.1 "lock advisory por `(id_empresa, tipo)` — 1 importação ativa
por tipo por entidade; demais aguardam em `pending`". Clarify ratificou espera
automática (não rejeição). Advisory lock do Postgres é leve e não persiste além da
sessão — casa com processamento síncrono em chunks.

**Alternatives considered**: fila assíncrona — fora de escopo (volume não justifica,
interface `ImportJob` isolada para plugar depois); coluna de lock em tabela — mais
estado a limpar em crash; advisory lock é auto-liberado ao fim da sessão.

---

## Decision 6 — Dedupe duplo + idempotência de reprocessamento

**Decision**: duas camadas independentes:
1. **Arquivo**: `UNIQUE(id_empresa, tipo, hash_sha256)` em `ImportacaoArquivo`.
   Upload de arquivo já existente → **409** com `{importacao_original_id}` (link).
   Reimportar `completed*` = no-op por construção (hash colide).
2. **Linha**: `UNIQUE(id_empresa, hash_linha)` nos fatos + `ON CONFLICT
   (id_empresa, hash_linha) DO NOTHING` no bulk insert de 500. Duas linhas
   idênticas no MESMO arquivo → a 2ª é dedupe silencioso, conta como válida
   (Clarify Q3 / dec-011 = opção A, score 3).

**Reprocessar** (`failed`/`cancelled`): reusa o arquivo armazenado; **reseta o
registro existente** (limpa `ImportacaoLinhaErro`, zera contadores, volta a
`pending`) — NÃO cria novo `ImportacaoArquivo` (Clarify Q2 / dec-010 = opção A,
score 3; `UNIQUE(id_empresa,tipo,hash)` torna "criar novo" inviável por colisão).
`completed*` → reprocessar recusado com **409** (correção entra como arquivo novo).

**hash_linha**: sha256 da linha normalizada (trim, uppercase em campos de domínio,
decimal canônico) — determinístico, estável entre reimportações.

**Rationale**: §10.2, §12.1, Clarifications 2026-07-07. Idempotência é o requisito
central da feature (US2).

---

## Decision 7 — Falha estrutural = rollback total; falha pontual = linha vai p/ erros

**Decision**: dois modos de falha:
- **Estrutural** (cabeçalho errado/faltando, encoding/separador inválido, **>50%
  linhas inválidas**): status `failed`, **nenhuma** linha persiste (rollback do
  processamento — as inserções de fato já feitas são revertidas), `erro_resumo`
  explica o motivo.
- **Pontual** (linha X com campo obrigatório ausente/fora de faixa): a linha vai
  para `ImportacaoLinhaErro` (motivo+campo+valor_mascarado), o resto segue →
  status final `completed_with_errors`.

O limiar >50% é avaliado ao fim do parse (contagem inválidas/total). Cada lote de
500 roda em transação; o rollback estrutural descarta os fatos já inseridos daquela
importação (filtro por `importacao_id`).

**Rationale**: §12.1 explícito. US3-4 (cenário >50%) exige recusa total sem persistir.

**Avisos (warnings)**: `tipo` fora de {Credito,Debito} e categoria nova em
`descricao` são **warning, não erro** (schema do parceiro evolui) — a linha é
persistida, NÃO conta como inválida, e **não tem superfície própria de contagem/
lista** nesta fase (Clarify Q5 / dec-013 = opção B, score 3). Só total/válidas/
inválidas são expostos.

---

## Decision 8 — Armazenamento do arquivo original + LGPD

**Decision**: original armazenado em volume privado por id
(`uploads/importacoes/<id>` dentro do container do backend hub, fora do git,
fora de qualquer log). Acessível só via `GET /importacoes/:id/original` com
`importacoes.exportar`. Retenção **indefinida** nesta fase (Clarify Q4 / dec-012
= opção A, score 2; política de expurgo D5 fica aberta p/ fase futura).

**LGPD** (Princípio implícito + briefing): `valor_mascarado` em `ImportacaoLinhaErro`
NUNCA carrega a linha bruta (mascarar UUID/nome do entregador); CSV bruto nunca em
log/git/contexto de sessão; em homolog usar seeds anonimizados da S1; inspeção de
CSV real só no sandbox context-mode. Export de erros em CSV com proteção contra CSV
injection (prefixar `'` em células que começam com `= + - @`).

**Rationale**: §12.5, briefing "LGPD", US3-3.

---

## Decision 9 — Upsert de `Entregador` por `(id_empresa, id_externo)`

**Decision**: durante o processamento, cada linha com `id_da_pessoa_entregadora`
(UUID) faz upsert em `Entregador` (`INSERT ... ON CONFLICT (id_empresa, id_externo)
DO UPDATE SET nome = EXCLUDED.nome` quando há nome novo) e usa o `id` resultante
como `entregador_id` no fato. Faturamento: 4,5% das linhas sem UUID → `entregador_id
NULL` + `recebedor_agregado` = rótulo do bônus (linha válida). Performance: UUID
**obrigatório** (erro de linha se ausente).

**Rationale**: §9.2 `Entregador`, §10 matriz, briefing "179 linhas de faturamento
sem UUID são válidas". `Entregador` é a única dimensão upsertada na importação (§10.2).

---

## Decision 10 — Sem fila; interface `ImportJob` isolada

**Decision**: processamento **síncrono em chunks** dentro do request de upload (ou
disparado logo após criar o registro), sem fila. 4k linhas ≈ segundos em lotes de
500. Uma interface `ImportJob` (contrato de função) isola o processamento para
plugar fila depois sem refazer o pipeline. Gatilho para introduzir fila: arquivo
> 50k linhas ou timeout de request. Timeout de importação: 120 s; retentativa por
lote (1×) em erro transiente. Progresso via `GET /importacoes/:id` (polling,
padrão `use-process-status` já existente no frontend).

**Rationale**: §12.1 "Filas: não nesta escala", §12.6.

---

## Constraints herdados (não-decisões — invariantes)

- **Ambiente**: trabalho SÓ em recursos `hub-*` isolados (hub-homolog no VPSTodo).
  NUNCA produção/`chatmasterveloz`. Migrations rodam no banco do hub via `migrate.sh`.
- **Auth**: JWT em cookies httpOnly (Princípio I). Escopo server-side por token
  (Princípio II NON-NEGOTIABLE) — `id_empresa` do token, nunca do corpo/query.
- **PostgREST**: GRANT + `SIGUSR1` reload por tabela nova (gotcha briefing). Backend
  fala com PostgREST via `lib/hub-postgrest.js` + JWT de claims via `lib/hub-postgrest-jwt.js`.
- **Limites (fonte canônica §12)**: upload ≤ 20 MB; ZIP descomprimido ≤ 100 MB, 1
  entrada, sem path traversal; lote 500; >50% inválidas → failed.

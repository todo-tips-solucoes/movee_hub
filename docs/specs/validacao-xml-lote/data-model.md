# Data Model — Validação de XML em Lote Idempotente

**SEM DDL** (clarify P2): nenhuma entidade persistida nova; nenhuma coluna nova. A chave de acesso
é derivada em runtime das colunas existentes. As entidades abaixo são: (a) a tabela existente
`EnvioMassa` (referência, somente os campos relevantes), e (b) estruturas **in-memory / de
transporte** (extração e resposta HTTP).

---

## Entity: `EnvioMassa` (existente — PostgREST, sem DDL)

Tabela de movimentos. Colunas relevantes (do `select` em server.js:1649):

| Campo | Tipo | Papel nesta feature |
|-------|------|---------------------|
| `id` | int | **chave de persistência idempotente** (`PATCH ?id=eq.<id>`, FR-012) |
| `id_empresa` | int | **escopo multi-tenant** — filtro de casamento (resolveEmpresaAlvo) |
| `mov_fechado` | bool | só `=false` (movimentos abertos) é elegível (FR-004) |
| `cnpj_prestador` | string | chave de fallback (cnpj+numnota+data_emissao) |
| `numnota` | string | chave de fallback |
| `data_emissao` | timestamp | chave de fallback (normalizar por dia) |
| `nota_ok` | string (URL/XML) | resultado da validação; base da chave derivada (getNFeKeyFromNotaOk) |
| `erro_validacao` | string | mensagem de erro (vazio = OK) |
| `valor` | double | **NUNCA alterado** por esta feature (P5) |

**Estado do movimento (derivado de `nota_ok` + `erro_validacao`):**

| `nota_ok` | `erro_validacao` | Estado | Ação no lote |
|-----------|------------------|--------|--------------|
| cheio | vazio | **APROVADA** | skip → `ja_validada` (não grava) |
| cheio | cheio | **REPROVADA** | revalida + PATCH → `revalidada` |
| vazio | (qualquer) | **SEM VALIDAÇÃO** | valida + PATCH → `validada` |

**Campos gravados pelo PATCH** (apenas estes): `nota_ok`, `erro_validacao`.

---

## Entity: `XmlExtractedFields` (in-memory — saída de `extractNfseFields`)

Resultado da extração de um XML. Evolução do retorno atual (que tinha só
`cnpj_prestador`/`razao_social`/`data_emissao`/`valor_nota`).

| Campo | Tipo | Origem no XML | Notas |
|-------|------|---------------|-------|
| `chave` | string \| null | `Id` de `<infNFSe>` sem prefixo `NFS`; fallback basename do `filename` | 50 dígitos; `null` se inextraível → cai no fallback |
| `numnota` | string \| null | `<nNFSe>` | NÃO `<nDPS>`/`<nDFSe>` |
| `cnpj_prestador` | string \| null | `<emit><CNPJ>` | — |
| `data_emissao` | string \| null | `<dhEmi>`; fallback `<dhProc>` | ISO; normalizar por dia no fallback |
| `valor` | number \| null | `<vLiq>`; fallback `<vServ>` | leitura apenas (P5) |
| `razao_social` | string \| null | `<xNome>` | preservado (compat) |

**Regra**: extração defensiva — qualquer campo ausente vira `null` (não lança), permitindo o
fallback de casamento.

---

## Entity: `MatchResult` (in-memory — saída de `findMovimentoParaXml`)

| Campo | Tipo | Valores |
|-------|------|---------|
| `movimento` | objeto `EnvioMassa` \| null | o movimento casado, ou `null` |
| `criterio` | enum | `chave` \| `fallback` \| `none` |

---

## Entity: `ValidationRow` (transporte — uma linha da resposta HTTP)

Substitui as flags booleanas (`valid`, `valid_cnpj_prestador`, `valid_valor`) pelo enum (clarify
Q4). **snake_case** ponta-a-ponta (ver Convenções de Borda no plan.md).

| Campo | Tipo | Notas |
|-------|------|-------|
| `arquivo` | string | nome do arquivo XML |
| `status` | enum | `ja_validada` \| `validada` \| `revalidada` \| `duplicada_no_lote` \| `sem_movimento` \| `erro` |
| `match_criterio` | enum | `chave` \| `fallback` \| `none` |
| `movimento_id` | int \| null | `id` do movimento casado; `null` se `sem_movimento`/`erro` |
| `cnpj_prestador` | string \| null | informativo (UI) |
| `numnota` | string \| null | informativo (UI) |
| `erro_validacao` | string \| null | mensagem (negócio = detail real; infra = "serviço … indisponível") |

**Transições de status** (uma linha assume exatamente UM status terminal):

```
                        ┌─ casou (chave|fallback) ─┐
parse OK ──► casamento ─┤                          ├─► aprovada?  ──► ja_validada
                        │                          ├─► reprovada? ──► [FastAPI] ─► revalidada
                        │                          └─► sem valid? ──► [FastAPI] ─► validada
                        ├─ chave repetida no lote ─────────────────► duplicada_no_lote
                        └─ não casou ──────────────────────────────► sem_movimento
parse FALHA / FastAPI infra ───────────────────────────────────────► erro
```

---

## Entity: `BatchStats` (transporte — agregados da resposta)

| Campo | Tipo | Notas |
|-------|------|-------|
| `total` | int | total de XMLs no lote |
| `ja_validada` | int | contador por status |
| `validada` | int | contador por status |
| `revalidada` | int | contador por status |
| `duplicada_no_lote` | int | contador por status |
| `sem_movimento` | int | contador por status |
| `erro` | int | contador por status |

(Os contadores agregados alimentam o resumo no topo do card — US2: "N validadas, M preservadas,
P erros".)

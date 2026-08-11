# Contract — API de Importações (`/api/v1/importacoes*`)

Base: §14 do plano técnico. Todos os endpoints exigem `authenticateToken` (JWT
cookie httpOnly) + `requirePermission(<código real>)` (ver mapa em data-model.md).
Escopo `id_empresa` sempre do token (Princípio II), nunca do corpo/query. Backend
fala com PostgREST via `lib/hub-postgrest.js` (+ JWT de claims `lib/hub-postgrest-jwt.js`).
Convenção de payload: request/response em **camelCase**; DB/PostgREST em snake_case;
mapeamento no route/DTO do backend (ver §Convenções de Borda no plan.md).

Códigos de erro padrão do hub: `401 NAO_AUTENTICADO`, `403 PERMISSAO_NEGADA`
(fail-closed), `404 NAO_ENCONTRADO`, `409 CONFLITO`, `422 INVALIDO`.

---

## POST /importacoes  — upload (multipart)

**Permissão**: `importacoes.criar`.
**Request**: `multipart/form-data` com `tipo` (`faturamento`|`performance`) e
`file` (CSV ou ZIP, ≤ 20 MB).

**Validações imediatas** (antes de criar registro): extensão (`.csv`/`.zip`) →
MIME → tamanho (≤ 20 MB) → conteúdo (é CSV? ZIP com exatamente 1 entrada, sem
path traversal `../`, descomprimido ≤ 100 MB) → sha256 do arquivo → duplicado?

**Responses**:
- `201` `{ id, status: "pending" }` — aceito; processamento inicia (ou aguarda lock).
- `409` `{ error: "CONFLITO", importacaoOriginalId: <id> }` — arquivo duplicado
  (mesmo `id_empresa+tipo+hash`).
- `422` `{ error: "INVALIDO", motivo }` — extensão/MIME/tamanho/conteúdo/ZIP inválido.

**Efeito**: cria `ImportacaoArquivo(status=pending)`, armazena original em
`uploads/importacoes/<id>`, adquire `pg_try_advisory_lock(id_empresa,tipo)`; se
ocupado permanece `pending` até o anterior terminar (inicia automaticamente).
Registra `Auditoria(acao='importacao.criada')`.

---

## GET /importacoes  — histórico paginado

**Permissão**: `importacoes.consultar`.
**Query**: `tipo`, `status`, `de`, `ate`, `responsavel`, `page`/`pageSize`
(paginação obrigatória via Range PostgREST; default últimos 30 dias),
`ordenarPor`/`direcao` (impeccable rodada 16).

`ordenarPor` aceita **somente** `criado_em` (padrão), `tipo`, `status`,
`nome_arquivo`, `total_linhas`, `data_referencia`; `direcao` aceita `asc` ou
`desc` (padrão `desc`). O valor é validado por allowlist
(`lib/hub-ordenacao.js`) **antes** de virar fragmento `order=` na URL do
PostgREST. Valor fora da lista **não** é erro: cai no padrão — um link antigo
com parâmetro inválido continua abrindo a tela em vez de devolver 400. A
direção só é considerada quando a coluna veio válida, para que `direcao=desc`
sozinho não inverta silenciosamente a ordem padrão. `order` sempre leva
`nullslast`: ausência de valor não encabeça o decrescente.
**Response** `200`: `{ items: [{ id, tipo, status, nomeArquivo, totalLinhas,
linhasValidas, linhasInvalidas, dataReferencia, criadoPor, iniciadoEm, concluidoEm,
duracaoSegundos, aguardandoLock }], total, page, pageSize }`.

`aguardandoLock` (task 5.1, dec-032/CHK013) é campo **derivado** (não existe
coluna própria): `true` somente quando `status === "pending"` **e** já existe
outra importação do MESMO `(id_empresa, tipo)` em `validating`/`processing` —
distingue no histórico um `pending` "prestes a começar" (acabou de ser
criado, ainda não tentou o lock) de um `pending` "esperando o lock liberar"
(resolução de FR-019/CHK013, sem introduzir um estado novo na máquina).

---

## GET /importacoes/:id  — detalhe + progresso (polling)

**Permissão**: `importacoes.consultar`.
**Response** `200`: `{ id, tipo, status, contadores: { total, validas, invalidas },
dataReferencia, iniciadoEm, concluidoEm, duracaoSegundos, erroResumo }`.
`404` se fora do escopo do token (RLS + filtro). UI faz polling enquanto
`status ∈ {pending, validating, processing}`.

---

## GET /importacoes/:id/erros  — erros paginados (+ `?format=csv`)

**Permissão**: `importacoes.consultar`.
**Query**: `page`/`pageSize`, `format=csv` (opcional).
**Response** `200` (JSON): `{ items: [{ numeroLinha, campo, motivo, valorMascarado }],
total }`. Com `format=csv`: `text/csv` com **proteção CSV injection** (prefixa `'`
em células iniciadas por `= + - @`). `valorMascarado` nunca expõe dado bruto (LGPD).

---

## GET /importacoes/:id/original  — download do arquivo

**Permissão**: `importacoes.exportar` (**distinta de `consultar`** — US4 cenário 5).
**Response** `200`: stream do arquivo original (`Content-Disposition: attachment`).
`403 PERMISSAO_NEGADA` se o usuário tem `consultar` mas não `exportar`.
`404 NAO_ENCONTRADO` se o `id` não existe ou está fora do escopo do token.

**`410` `{ erro: "ARQUIVO_INDISPONIVEL", motivo: "arquivo_original_nao_encontrado_no_armazenamento" }`**
— resolve CHK021 (gap): o registro `ImportacaoArquivo` existe e está no
escopo do token, mas o arquivo físico originalmente retido não está mais
disponível no volume de armazenamento (`uploads/importacoes/<id>/original.*`
ausente, ex.: `ENOENT`). Distinto de `500` genérico — mensagem de erro clara
para a pessoa (edge case explícito da spec). Qualquer outra falha de leitura
(permissão de disco, I/O) continua caindo em `500 ERRO_SERVIDOR`.

---

## POST /importacoes/:id/reprocessar

**Permissão**: `importacoes.criar`.
**Pré-condição**: `status ∈ {failed, cancelled}`.
**Response**: `202` `{ id, status: "pending" }` — reusa arquivo armazenado, **reseta**
o registro (limpa `ImportacaoLinhaErro`, zera contadores). `409 CONFLITO` se
`status ∈ {completed, completed_with_errors, ...}` (correção = arquivo novo).

---

## POST /importacoes/:id/cancelar

**Permissão**: `importacoes.criar`.
**Pré-condição**: `status ∈ {pending, validating, processing}`.
**Response**: `202` `{ id, status: "cancelled" }` — em `processing`, interrompe
entre lotes (ponto seguro). `409 CONFLITO` se já terminal.

---

## Convenção de máquina de estados (fonte da verdade)

```
pending ──(lock livre)──▶ validating ──▶ processing ──▶ completed
   │                          │              │        └▶ completed_with_errors
   │                          │              │        └▶ failed (>50% inválidas / estrutural; rollback)
   └────────── cancelar ──────┴──────────────┘──▶ cancelled
failed | cancelled ──(reprocessar)──▶ pending (reset)
```
Falha estrutural (cabeçalho/encoding/separador ou >50% inválidas) → `failed`,
**nenhuma linha persiste**. Falha pontual → linha em `ImportacaoLinhaErro`, resto
segue → `completed_with_errors`.

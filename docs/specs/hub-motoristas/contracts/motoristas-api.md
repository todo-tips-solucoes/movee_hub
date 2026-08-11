# Contract — API de Motoristas (`/api/v1/motoristas*`)

Base: §14 do plano técnico + `data-model.md` desta fase. Todos os endpoints
exigem `authenticateToken` (JWT cookie httpOnly) + `requirePermission(<código
real>)` (mapa em `data-model.md`). Escopo `id_empresa` sempre do token
(Princípio II), nunca do corpo/query. Backend fala com PostgREST via
`lib/hub-postgrest.js`. Convenção de payload: request/response em
**camelCase**; DB/PostgREST em snake_case; mapeamento no route/DTO do backend
(ver §Convenções de Borda no `plan.md`).

Códigos de erro padrão do hub: `401 NAO_AUTENTICADO`, `403 PERMISSAO_NEGADA`
(fail-closed), `404 NAO_ENCONTRADO`, `409 CONFLITO`, `422 INVALIDO`.

---

## GET /motoristas — lista paginada de pessoas entregadoras

**Permissão**: `motoristas.listar`.
**Query**: `nome` (busca parcial, normalizada — `hub_normaliza_nome`), `ativo`
(`true`/`false`), `area` (subpraça — casa se QUALQUER área distinta do
Entregador corresponder, FR-002/Clarification Q2), `comVinculo`
(`true`/`false`/omitido=todos), `page`/`pageSize` (default 20, máx. 100 — mesmo
padrão de `parsePaginacao`), `ordenarPor`/`direcao` (impeccable rodada 16).

`ordenarPor` aceita **somente** `nome` (padrão), `ativo` e `area`; `direcao`
aceita `asc` (padrão) ou `desc`, validados por allowlist em
`lib/hub-ordenacao.js`. Valor fora da lista cai no padrão, sem 400. Nesta rota
a ordenação é aplicada **em memória**, sobre o conjunto já filtrado e ANTES de
paginar (a rota busca os candidatos do escopo, filtra `nome`/`area` em JS por
causa da tolerância a acento e pagina em JS) — ordenar depois do recorte
ordenaria só a página. `nome` e `area` comparam com `localeCompare` pt-BR;
`ativo` traz ativos primeiro no crescente; quem não tem área vai para o fim.

**Response** `200`: `{ items: [{ id, nome, ativo, comVinculo, areas: string[]
}], total, page, pageSize }`. `areas` é a lista de subpraças distintas já
conhecidas para aquele Entregador (mesma fonte de FR-003, computada por linha —
ver data-model.md; pode vir vazia se o Entregador ainda não tem nenhum fato
associado).

**Estado vazio**: `items: []`, `total: 0` — nunca erro (FR-002 Edge Case,
"estado vazio claro").

---

## GET /motoristas/:id — detalhe

**Permissão**: `motoristas.consultar`.
**Response** `200`:
```json
{
  "id": 1,
  "nome": "Fulano da Silva",
  "ativo": true,
  "nomeEditadoManualmente": false,
  "areas": [
    { "subpraca": "Zona Sul", "dataMaisRecente": "2026-07-01" },
    { "subpraca": "Centro",   "dataMaisRecente": "2026-05-14" }
  ],
  "resumo": {
    "totalFaturamento": 42,
    "totalPerformance": 30,
    "dataMaisRecente": "2026-07-01"
  },
  "vinculo": {
    "contaMotoristaId": 7,
    "nome": "Fulano da Silva",
    "cnpjPrestadorMascarado": "12.***.***/0001-**"
  }
}
```
`vinculo: null` quando sem conta vinculada (estado mais comum logo após a
importação inicial, FR-003/Edge Case). `areas` ordenado por `dataMaisRecente`
DESC — primeira entrada é a área "destacável" (Clarification Q2).
`404 NAO_ENCONTRADO` se fora do escopo do token (RLS + filtro por `id_empresa`).

---

## PATCH /motoristas/:id — editar nome e/ou situação

**Permissão**: `motoristas.editar`.
**Request**: `{ nome?, ativo? }` — ao menos um campo. **Allowlist estrita**
(research.md Decision 12): o handler só lê `nome` e `ativo` do corpo — qualquer
outro campo (`motoristaId`, `nomeEditadoManualmente`, `id`, `idEmpresa`, etc.)
é ignorado, nunca repassado ao PostgREST; não existe caminho de mass
assignment neste endpoint.
**Efeito**: se `nome` presente, grava com `nomeEditadoManualmente=true` no
mesmo UPDATE (data-model.md, trigger de proteção). Nenhum registro histórico de
`FaturamentoLancamento`/`PerformanceTurno` é tocado (FR-004).
**Response** `200`: mesmo shape do detalhe (`GET /motoristas/:id`).
**Auditoria**: `motorista.editado` (`detalhes: {camposAlterados}`).
`422 INVALIDO` se `nome` vazio/só espaços. `404 NAO_ENCONTRADO` fora do escopo.

---

## GET /motoristas/:id/sugestoes — candidatos automáticos por semelhança de nome

**Permissão**: `motoristas.editar`.
**Pré-condição**: Entregador sem vínculo é o caso comum, mas o endpoint também
responde para um Entregador já vinculado (permite trocar — FR-013).
**Implementação**: backend chama `POST /rpc/hub_motoristas_candidatos
{p_entregador_id}` (research.md Decision 10) — nunca SQL montado por
concatenação de string.
**Response** `200`: `{ items: [{ contaMotoristaId, nome,
cnpjPrestadorMascarado, similaridade, jaVinculadoA: { entregadorId, nome } |
null }], entidadeElegivel: boolean }`.

- `404 NAO_ENCONTRADO` se `:id` referencia um Entregador **fora do escopo do
  token** (research.md Decision 11) — a função RPC roda com `SECURITY INVOKER`,
  então a RLS de `Entregador` (`0015`) já devolve 0 linhas nesse caso; o
  backend traduz "sem linhas para o Entregador-base" em `404`, mesmo padrão de
  `GET /motoristas/:id`. Nenhuma checagem de aplicação duplicada — é a mesma
  garantia de isolamento multi-tenant do resto do hub se propagando.
- `entidadeElegivel=false` (entidade ativa fora do grupo Movee, FR-011): `items:
  []`, **sem erro** — a tela comunica "sem contas elegíveis neste contexto".
- Corte **top 10** por `similarity` decrescente, limiar mínimo `>= 0.3`
  (Clarification Q4/block-002) — candidatos abaixo do limiar nunca aparecem,
  mesmo que faltem itens para completar o N.
- `jaVinculadoA` não-nulo não impede a listagem (SC-003 exige que a conta
  correta apareça mesmo se hoje vinculada por engano a outra pessoa) — a UI
  mostra um aviso; a confirmação de vínculo (`POST .../vinculo`) é quem recusa
  com `409` se a pessoa usuária tentar de fato.

---

## GET /motoristas/contas-elegiveis — busca manual de conta de acesso

**Permissão**: `motoristas.editar`.
**Query**: `entregadorId` (obrigatório — ancora a checagem de escopo/
elegibilidade no mesmo Entregador do fluxo de vínculo), `q` (termo de busca por
nome, normalizado — mínimo 2 caracteres), `page`/`pageSize` (paginação normal,
sem corte por similaridade).
**Implementação**: backend chama `POST /rpc/hub_motoristas_busca
{p_entregador_id, p_termo, p_limit, p_offset}` (research.md Decision 10).
**Response** `200`: `{ items: [{ contaMotoristaId, nome,
cnpjPrestadorMascarado, jaVinculadoA }], total, page, pageSize,
entidadeElegivel }`. Mesma regra de `404` por `entregadorId` fora do escopo
(Decision 11) e de `entidadeElegivel=false` → lista vazia sem erro (FR-011).
Usado quando a sugestão automática (FR-007) não é suficiente (FR-009).

---

## POST /motoristas/:id/vinculo — criar ou substituir vínculo

**Permissão**: `motoristas.editar`.
**Request**: `{ contaMotoristaId, origem? }`. **Allowlist estrita**
(research.md Decision 12): só `contaMotoristaId` **influencia o UPDATE** —
nenhum outro campo (ex.: `idEmpresa`, `nome`) chega ao PostgREST. `origem`
é **aditivo e opcional** (`"sugestao"` | `"busca_manual"`), lido só para
preencher `detalhes.origem` da entrada de auditoria `motorista.vinculado`
(research.md Decision 9 — distingue se o vínculo veio da sugestão
automática ou da busca manual); nunca influencia a escrita em `Entregador`,
e um valor ausente/fora do enum vira `"nao_informado"` sem rejeitar a
requisição (implementado em `lib/hub-motoristas-dto.js#validarVinculoBody`,
tasks.md 6.1.1).
**Efeito**: `UPDATE Entregador SET motorista_id=$contaMotoristaId`. Se o
Entregador já tinha vínculo, substitui em uma única ação (FR-013) — não exige
desvínculo prévio.
**Responses**:
- `200` `{ id, vinculo: { contaMotoristaId, nome, cnpjPrestadorMascarado } }`
  — sucesso.
- `409 CONFLITO` `{ erro: "CONFLITO", motivo: "conta_ja_vinculada",
  vinculadaA: { entregadorId, nome } }` — a conta já está vinculada a outra
  pessoa entregadora (FR-012; violação da constraint única traduzida em erro
  amigável, motivo consultado antes de tentar o UPDATE para poder informar o
  nome). Chave `erro` (não `error`) — corrigido para consistência com o
  restante deste contrato e com o padrão já implementado em todas as demais
  rotas do módulo (`{erro: "NAO_ENCONTRADO"}` etc., FASE 3-5). Se o conflito
  for cross-tenant (índice único global sobre `motorista_id`, invisível pela
  RLS do pre-check — ver `routes/hub-motoristas.js` FASE 6), a resposta é o
  mesmo `409` porém **sem** `vinculadaA` (nunca expõe dados de outro tenant,
  Constitution II).
- `422 INVALIDO` `{ motivo: "entidade_fora_do_grupo" }` — tentativa de vincular
  fora do grupo elegível (FR-010/FR-011 Edge Case), mesmo que o
  `contaMotoristaId` exista no banco.
- `404 NAO_ENCONTRADO` — Entregador fora do escopo do token (RLS), OU
  `contaMotoristaId` inexistente (violação de FK) — distinto do `409` acima
  (conta existe mas já está vinculada a outra pessoa).
**Auditoria**: `motorista.vinculado` (`detalhes: {contaMotoristaId, origem}`).
**NUNCA automático** — este endpoint só é chamado por ação explícita da pessoa
usuária (FR-008); nenhum outro fluxo do sistema o invoca implicitamente.

---

## DELETE /motoristas/:id/vinculo — desfazer vínculo

**Permissão**: `motoristas.editar`.
**Efeito**: `UPDATE Entregador SET motorista_id=NULL`. Idempotente — chamar
sobre um Entregador já sem vínculo é um no-op que retorna `204` (sem erro).
**Response** `204`.
**Auditoria**: `motorista.desvinculado` (`detalhes: {contaMotoristaIdAnterior}`)
— só registrada quando havia de fato um vínculo antes (no-op não gera entrada
de auditoria vazia).

---

## Acesso negado (FR-005)

Toda pessoa sem `motoristas.editar` recebe `403 PERMISSAO_NEGADA` em
`PATCH`/`sugestoes`/`contas-elegiveis`/`POST vinculo`/`DELETE vinculo`, mesmo
que tenha `motoristas.consultar`/`motoristas.listar` (somente-leitura). O
`middleware/hub-require-permission.js` já é fail-closed por padrão — nenhum
tratamento adicional necessário nas rotas desta fase.

## Mascaramento de CNPJ (LGPD, mesmo padrão já aplicado a dado pessoal no hub)

`cnpjPrestadorMascarado` nunca expõe o CNPJ completo na API — formato
`NN.***.***/NNNN-**` (mantém prefixo/sufixo suficientes para diferenciar
candidatos homônimos sem expor o documento completo). Mapeamento feito no
route/DTO do backend (mesma camada que traduz snake_case→camelCase), nunca no
banco.

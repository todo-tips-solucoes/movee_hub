# Contrato — `/api/v1/faturamento*` (hub-faturamento / S6)

Padrões herdados de `docs/plans/hub-frota/01-plano-tecnico.md §14`: prefixo
`/api/v1`; auth por cookie JWT (`hub_accessToken`); entidade ativa resolvida do
token (nunca de query/body); erros JSON `{ "error": { "code", "message",
"details?" } }` (ou `{ "erro": "..." }` no formato curto já em uso pelos
demais módulos do hub — ver `hub-require-permission.js`/`hub-importacoes.js`;
esta fase segue o formato curto por consistência com o código já
implementado, não o mais verboso do plano técnico). Todos os campos de
resposta em **camelCase** (§Convenções de Borda do `plan.md`).

---

## GET /faturamento — lista paginada de lançamentos

**Permissão**: `faturamento.listar` (rota) — **+ `faturamento.exportar`**
checado inline quando `?format=csv` (research.md Decision 9).

**Query params**:

| Param | Tipo | Default | Nota |
|---|---|---|---|
| `de` | date `YYYY-MM-DD` | hoje − 30 dias | filtra por `data_referencia` (FR-002) |
| `ate` | date `YYYY-MM-DD` | hoje | idem |
| `categoria` | string | — | match exato em `descricao` |
| `entregadorId` | int | — | match exato em `entregador_id`; combinado com `comEntregador=false` é 400 (contraditório) |
| `subpraca` | string | — | match exato |
| `comEntregador` | `true` \| `false` | — (ambos) | `true` = só com `entregador_id` NOT NULL; `false` = só agregados/bônus (`entregador_id IS NULL`); ausente = ambos |
| `page` | int | 1 | 1-indexed |
| `pageSize` | int | 20 | máx. 100 (mesma constante `PAGE_SIZE_MAX` de `importacoes`/`motoristas`) |
| `format` | `csv` | — | ativa modo export (streaming, sem paginação — `page`/`pageSize` ignorados) |

**Resposta 200 (JSON, sem `format`)**:
```json
{
  "items": [
    {
      "id": 123,
      "dataReferencia": "2026-07-01",
      "dataLancamento": "2026-07-01",
      "dataRepasse": "2026-07-06",
      "categoria": "Corridas concluidas",
      "valor": "61.50",
      "entregadorId": 42,
      "entregadorNome": "F*** S***",
      "subpraca": "SAO PAULO - ZONA SUL",
      "praca": "SAO PAULO",
      "periodo": "ALMOCO 11H30-15H29",
      "comEntregador": true
    }
  ],
  "total": 4014,
  "page": 1,
  "pageSize": 20
}
```
- `valor` é **string decimal** (research.md Decision 7) — nunca somar no
  cliente.
- `entregadorNome`/`entregadorId` são `null` quando `comEntregador: false`
  (lançamento agregado/bônus, FR-005).
- `comEntregador` é derivado (`entregador_id IS NOT NULL`) — conveniência
  para o frontend não precisar checar `entregadorId !== null` toda vez.

**Resposta 200 (`?format=csv`)**: `Content-Type: text/csv; charset=utf-8`,
`Content-Disposition: attachment; filename="faturamento-<de>_<ate>.csv"`.
Cabeçalho: `dataReferencia,categoria,valor,entregadorNome,subpraca,praca,periodo`.
Streaming em lotes de 1.000 linhas (research.md Decision 5); célula
neutralizada por `lib/hub-csv.js` quando começa com `= + - @` (FR-007/SC-005).
Filtro vazio → arquivo só com cabeçalho (edge case explícito da spec, não é
erro).

**Erros**: `401` sem sessão; `403 { erro: 'PERMISSAO_NEGADA' }` sem
`faturamento.listar` (ou sem `faturamento.exportar` quando `format=csv`);
`400` filtro contraditório (`entregadorId` + `comEntregador=false` juntos)
ou data inválida.

---

## GET /faturamento/resumo — agregados do período

**Permissão**: `faturamento.consultar`.

**Query params**: mesmos filtros de `GET /faturamento` (`de`, `ate`,
`categoria`, `entregadorId`, `subpraca`, `comEntregador`) **+**:

| Param | Tipo | Default | Nota |
|---|---|---|---|
| `groupBy` | `dia` \| `categoria` \| `entregador` | — (ausente) | ausente → resposta "cards" (FR-003); presente → resposta agrupada (FR-004) |

**Resposta 200 — sem `groupBy` (cards, FR-003)**:
```json
{
  "totalGeral": "98135.40",
  "categoriaMaiorValor": "Corridas concluidas",
  "entregadoresDistintos": 691
}
```
Quando não há nenhum lançamento no filtro (FR-012): `{ "totalGeral": "0.00",
"categoriaMaiorValor": null, "entregadoresDistintos": 0 }` — nunca erro,
nunca corpo vazio.

**Resposta 200 — com `groupBy` (FR-004)**:
```json
{
  "groupBy": "entregador",
  "grupos": [
    { "chave": "42", "rotulo": "F*** S***", "total": "1250.00", "quantidade": 18 },
    { "chave": "agregados_bonus", "rotulo": "Agregados/bônus", "total": "3940.40", "quantidade": 885 }
  ]
}
```
- `rotulo` é resolvido pelo backend (join com `Entregador.nome` quando
  `chave` é um id; literal `"Agregados/bônus"` quando `chave ===
  'agregados_bonus'`; a própria categoria/data quando `groupBy` é
  `categoria`/`dia`) — o frontend nunca precisa mapear `chave` manualmente.
- `groupBy=dia`: `chave` no formato `YYYY-MM-DD`, `rotulo` idêntico a
  `chave`.

**Erros**: `401`/`403` (mesmo padrão); `400` `groupBy` fora do enum.

**Frescor dos dados (follow-up SC-004, migration `0028`)**: os agregados
deste endpoint são servidos pela materialized view `mv_faturamento_dia`
(exceto quando o filtro `subpraca` é usado — dimensão fora da MV, cai na
tabela-base). O **contrato não muda** (mesmos shapes, valores monetários como
`text`), mas o resumo pode estar **defasado até o fim do processamento da
importação em curso**: a MV é atualizada (`REFRESH ... CONCURRENTLY`)
automaticamente ao final de toda importação de faturamento bem-sucedida —
único caminho de escrita nos fatos — e manualmente via RPC
`hub_faturamento_refresh_mv`. Casos residuais (falha best-effort do refresh;
importação cancelada após inserir lotes) entram no resumo no próximo
refresh. `GET /faturamento` (lista) lê a tabela-base e é sempre fresco.

---

## Acesso negado (FR-008)

Qualquer requisição sem a permissão exigida (listar/consultar/exportar,
conforme o endpoint/modo) recebe `403 { "erro": "PERMISSAO_NEGADA" }` —
nunca `404` nem uma lista vazia silenciosa (isso mascararia a diferença
entre "sem permissão" e "sem dado", violando a auditabilidade do acesso
negado exigida por SC-006).

## Mascaramento de dado pessoal (LGPD, mesmo padrão de `Entregador`/`Motorista`)

`entregadorNome`/`rotulo` reaproveitam o mesmo dado já retornado por
`GET /motoristas` (S5) — nenhum mascaramento adicional introduzido aqui além
do que a S5 já aplica (a S5 não mascara nome, só CNPJ do vínculo, que esta
API não expõe).

## Navegação para detalhe do entregador (FR-010, User Story 3)

Não é um campo de resposta desta API — o frontend monta o link
`/hub/dashboard/motoristas/{entregadorId}` diretamente a partir de
`entregadorId` (quando não-nulo) e da permissão `motoristas.consultar` já
carregada por `GET /me` (research.md Decision 11). Nenhum endpoint novo.

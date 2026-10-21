# Contrato — `GET /motorista/bancos`

**Status**: contrato **EXISTENTE** quanto à **forma** (método, path, parâmetro, shape da
resposta, teto de 20): tudo isso foi extraído do código real
(`app_homologacao/backend/routes/motorista-adiantamento.js:733-738` e
`app_homologacao/frontend_motorista/lib/adiantamento-api.ts:225-230`) e confirmado por
chamada HTTP de fato observada **nesta onda** (router real sobre `app.listen(0)`:
`GET /motorista/bancos?q=260` → `200 {"itens":[{"codigo":"260","nome":"NU PAGAMENTOS - IP"}]}`).

**Dois pontos deste documento são `[PROPOSTA]`, não comportamento vigente** — estão
marcados no texto:

1. o **cap de 60 caracteres** em `q` (§Request);
2. a **ordem dos itens** por relevância em 4 tiers (§Ordem dos itens).

A forma da resposta não muda, e é por isso que o cliente não requer alteração (FR-008).

---

## Request

```http
GET /motorista/bancos?q=<termo>
```

| Parâmetro | Onde | Tipo | Obrigatório | Notas |
|---|---|---|---|---|
| `q` | query string | string | não | Termo de busca. Ausente, vazio ou só pontuação/espaço ⇒ lista limitada (FR-007). |

Autenticação: `authenticateMotorista` (JWT do app motorista em cookie httpOnly), já
aplicado ao montar o router. A identidade **não** influencia a resposta: a lista COMPE
é a mesma para todo motorista autenticado.

Nenhum outro parâmetro é aceito. Nenhum id de empresa/entregador/conta é lido do corpo
ou da query (Constitution II — já coberto pelo teste 3.1.9 existente).

**Limite de tamanho de `q`** `[PROPOSTA]`: a partir desta feature, `q` é truncado em 60 caracteres
antes de normalizar (guarda de fronteira de confiança — research.md Decision 7). Não
é erro: termo maior é truncado, não rejeitado.

## Response — `200 OK`

```json
{
  "itens": [
    { "codigo": "260", "nome": "NU PAGAMENTOS - IP" }
  ]
}
```

| Campo | Tipo | Notas |
|---|---|---|
| `itens` | array | No máximo **20** itens (FR-004). Array vazio quando nada casa — nunca erro. |
| `itens[].codigo` | string | 3 dígitos, zero à esquerda preservado. |
| `itens[].nome` | string | Nome **oficial** do BCB. Nunca o apelido digitado (FR-003). |

`ispb` da fixture **não** é exposto. Nenhum campo novo é adicionado — o cliente
(`interface Banco { codigo: string; nome: string }`) continua válido sem mudança.

Esta rota não chama PostgREST (lê fixture em memória). O teste existente assere
`chamadasPostgrest.length === 0`.

## Outros status

| Status | Quando |
|---|---|
| `401` | sem/inválido token de motorista. **Não observado nesta feature**: é comportamento de `authenticateMotorista`, que é externo a este arquivo — o header da rota só prova que o router é montado atrás dele |

Não há `4xx` de validação: `q` inválido não existe — qualquer string é um termo
legítimo, inclusive uma que não casa nada (⇒ `itens: []`).

---

## Ordem dos itens (a mudança desta feature) `[PROPOSTA]`

A ordem passa a ser por relevância, em 4 tiers com dedup (plan.md §Algoritmo de
busca). O **contrato de forma** não muda; o que muda é qual item vem primeiro.

Exemplos medidos (antes → depois):

| `q` | Antes | Depois |
|---|---|---|
| `nubank` | `{"itens":[]}` | `[260]` |
| `nu` | `[360, 260, 386, …]` | `[260, 386, 419, 140, 360, …]` |
| `itau` | `[479]` | `[341, 479]` |
| `260` | `[260]` | `[260]` (inalterado) |

## Consumidor

`app_homologacao/frontend_motorista/lib/adiantamento-api.ts:230`

```ts
export function buscarBancos(q = ''): Promise<{ itens: Banco[] }>
```

Passa o termo por `encodeURIComponent` e omite `?q=` quando o termo é vazio após
`trim()`. O resultado alimenta `validarBanco(codigo, bancosDisponiveis)` em
`lib/conta-bancaria-form.ts`, que casa por **código** contra a lista viva recebida por
injeção de dependência. Como nem a forma nem os códigos mudam, **o cliente não
requer alteração alguma** — conclusão medida, base do FR-008.

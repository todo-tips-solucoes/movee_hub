# Contract — `POST /validate-xml-batch`

Handler reescrito em `app_homologacao/backend/server.js:1903`. Mudança **aditiva** na resposta
(Constituição III). Request **inalterada**. Consumido pelo frontend via proxy `/api/*`.

---

## Request (inalterada)

```
POST /validate-xml-batch
Auth:    cookie httpOnly JWT (middleware authenticateToken)
Content-Type: multipart/form-data
```

| Campo | Tipo | Origem | Notas |
|-------|------|--------|-------|
| `xmlFiles` | file[] (até 100) | multipart (`upload.array('xmlFiles', 100)`) | XMLs NFS-e |
| `empresa_id` | int | query ou body | escopo; validado por `resolveEmpresaAlvo` (403/503 fora do escopo) |
| `validarDescricao` | bool | body (opcional) | comportamento existente preservado |

---

## Comportamento (árvore de decisão §4)

1. Resolver empresa-alvo: `resolveEmpresaAlvo(req.user, empresa_id, 'POST /validate-xml-batch')`
   (lança 403/503 — propagar).
2. **Carregar UMA vez** os movimentos abertos da empresa-alvo:
   `GET EnvioMassa?mov_fechado=eq.false&id_empresa=eq.<idEmp>&select=...`.
3. Construir índices em memória: por **chave** (via `getNFeKeyFromNotaOk(nota_ok)` de cada
   movimento) e por **`cnpj_prestador|numnota|data_emissao(dia)`**.
4. Para cada XML:
   a. `parseStringPromise` + `extractNfseFields(parsed, filename)` → `XmlExtractedFields`.
      Parse falho → `status=erro` (mensagem de parsing), **continua** o lote (FR-015/FR-016).
   b. Dedup intra-lote por chave: se a chave já foi processada → `status=duplicada_no_lote`,
      `match_criterio` herda o do 1º; **sem** chamada FastAPI.
   c. `findMovimentoParaXml` → `{movimento, criterio}`.
      - `criterio=none` → `status=sem_movimento` (**não insere**, P3).
      - movimento APROVADO (`nota_ok` cheio + `erro_validacao` vazio) → `status=ja_validada`
        (**não chama FastAPI, não grava** — gate central).
      - movimento REPROVADO (`nota_ok` cheio + `erro_validacao` cheio) → chama FastAPI →
        `PATCH` → `status=revalidada`.
      - movimento SEM VALIDAÇÃO (`nota_ok` vazio) → chama FastAPI → `PATCH` → `status=validada`.
   d. **Roteamento FastAPI**: `mesmoGrupoQue(idEmp, 6)` → não-nexus (`fastapihomologacao/
      validade_nfse`, `id_empresa=6`) vs nexus (`fastapihomologacaonexus`, `nexus=true`).
   e. **PATCH** (só quando permitido): `PATCH EnvioMassa?id=eq.<movimento.id>` body
      `{ nota_ok, erro_validacao }`. **Nunca** `valor` (P5). **Nunca** sobrescreve aprovada.
   f. Tratamento de erro FastAPI: 4xx com `detail` → grava `erro_validacao=detail` (negócio,
      `status=revalidada`/`validada` com nota reprovada); timeout/5xx/sem resposta → `status=erro`,
      `erro_validacao="serviço de validação indisponível"`, **não grava** resultado falso.
   g. **Rate-limit**: aguardar 2 s **apenas** se houve chamada à FastAPI nesta linha.

---

## Response 200 (snake_case — campos novos aditivos)

```jsonc
{
  "stats": {
    "total": 5,
    "ja_validada": 2,
    "validada": 1,
    "revalidada": 1,
    "duplicada_no_lote": 1,
    "sem_movimento": 0,
    "erro": 0
  },
  "results": [
    {
      "arquivo": "355030822435681740001680000000000098260656508356 50.xml",
      "status": "ja_validada",          // enum SUBSTITUI flags valid/valid_cnpj_prestador/valid_valor
      "match_criterio": "chave",        // chave | fallback | none
      "movimento_id": 12345,            // null quando sem_movimento/erro
      "cnpj_prestador": "43568174000168",
      "numnota": "98",
      "erro_validacao": null
    }
    // ... uma entrada por XML, ordem do upload
  ]
}
```

### Enum `status`

| Valor | Significado | Gravou? |
|-------|-------------|---------|
| `ja_validada` | nota aprovada preservada | não |
| `validada` | validada agora (sem validação prévia) | sim |
| `revalidada` | reprovada → revalidada | sim |
| `duplicada_no_lote` | chave repetida no lote (valida 1x) | não (2ª+) |
| `sem_movimento` | nenhum movimento aberto casou | não (não insere) |
| `erro` | parse/infra falhou | não |

### Enum `match_criterio`

`chave` (primário) · `fallback` (cnpj+numnota+data) · `none` (não casou / erro).

---

## Erros

| Código | Quando | Corpo |
|--------|--------|-------|
| 401 | sem JWT válido | (middleware) |
| 403 | empresa fora do escopo do usuário | `resolveEmpresaAlvo` |
| 503 | escopo indisponível | `resolveEmpresaAlvo` |
| 200 | sucesso (mesmo com linhas `erro`) | erros são por-linha, não derrubam o lote (FR-015) |

> Erros **por linha** (parse, casamento, FastAPI) ficam em `results[].status=erro` +
> `erro_validacao`, **não** em status HTTP. O HTTP só falha em auth/escopo.

---

## Invariantes (testáveis)

- **INV-1 (idempotência)**: reenviar o mesmo lote produz o mesmo `stats` e nenhuma escrita nova
  para linhas `ja_validada` (verificável por diff de `SELECT` antes/depois — quickstart §2).
- **INV-2 (não-sobrescrita)**: nenhum `PATCH` ocorre para movimento APROVADO.
- **INV-3 (isolamento)**: `movimento_id` retornado sempre pertence à empresa-alvo; XML de outra
  empresa → `sem_movimento`.
- **INV-4 (valor imutável)**: `valor` do movimento é idêntico antes/depois do lote.
- **INV-5 (shape)**: o JSON real do backend tem exatamente `status`/`match_criterio`/`movimento_id`
  em snake_case — validado pelo roundtrip E2E (quickstart §Roundtrip).

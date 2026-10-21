# Data Model: Corrigir o valor de um movimento antes do envio da nota

**Feature**: `corrigir-movimento` · **Fase**: Phase 1 (plan) · **Data**: 2026-10-20

Fonte das colunas afirmadas como existentes: `select` explícito de
`app_homologacao/backend/server.js:2122`, o objeto inserido pelo `/upload`
(`server.js:1973-1993`) e o DDL de `infra/hub/migrations/0033_schema_legado_envio_massa.sql`
/ `0046` / `0109`. Campos marcados `[PROPOSTA]` **não existem ainda** — são desenho a
validar na implementação, nunca afirmados como reais.

---

## Entity: Movimento (`EnvioMassa`)

Lançamento por motorista/período de uma empresa. **Nenhuma coluna nova** é exigida por esta
feature.

### Campos relevantes (existentes)

| Campo | Tipo | Papel nesta feature |
|---|---|---|
| `id` | bigserial (PK) | identidade do movimento; **nunca** sozinho no `WHERE` (FR-019) |
| `id_empresa` | **bigint** → `Empresa(id)` | **fronteira de tenant** — filtro explícito obrigatório (FR-019, Decision 7) |
| `uuid` | text | ramo 1 da chave dupla; vem da planilha (`uuid: row.uuid`). **Sem índice** |
| `cnpj_prestador` | text | ramo 2 da chave dupla; coluna **líder** do índice da 0109 |
| `dt_inicial` | timestamptz | ramo 2; gravado do range da requisição via `toTimestamptzMidnightSP` (⚠️ ver Decision 3 — **não** é meia-noite) |
| `dt_final` | timestamptz | ramo 2; idem |
| `valor` | **double precision** | **alvo da correção** |
| `gorjeta` | **double precision** DEFAULT NULL | **alvo da correção**; `null` quando a célula traz `R$ -` **ou valor <= 0** |
| `mensagem1` | text | **alvo da correção** — embute o valor por extenso (Decision 4) |
| `mensagem2` | text | não alterado |
| `enviado` | text | status de envio da mensagem; **lido** (FR-018), nunca alterado (FR-003) |
| `nota_ok` | text | **nota anexada** — é esta a coluna da guarda "nota enviada" (FR-015); ver INV-3 |
| `numnota` | text | número da nota; **NÃO** é a coluna da guarda — lido apenas para exibição |
| `erro_validacao` | text | compõe a guarda "nota enviada" (FR-015) |
| `mov_fechado` | boolean | movimento fechado ⇒ não alterável (FR, Q3) |
| `nome` | text | não alterado (FR-003) |
| `cnpj_tomador` | text | não alterado (FR-003) |
| `entregador_uuid` | uuid NULL | **NÃO** é o `uuid` da planilha (0046); irrelevante aqui |

### Invariantes

- **INV-1 (FR-019)**: nenhuma leitura ou escrita identifica um movimento sem
  `id_empresa` no predicado. O banco **não** escopa esta tabela (Decision 7).
- **INV-2 (FR-003)**: a reimportação altera **somente** `valor`, `gorjeta`, `mensagem1`.
  Nota, status de envio, CNPJs, datas e nome permanecem.
- **INV-3 (FR-015)**: "nota enviada" ⇔ **`nota_ok`** preenchida **E** `erro_validacao`
  **vazio**. Valor só com espaços conta como vazio (`btrim`). Nota anexada **com** erro de
  validação **não** é nota enviada — é tentativa reprovada, e o movimento segue corrigível.

  > ⚠️ **A coluna da guarda é `nota_ok`, não `numnota`** — corrigido após auditoria de
  > veracidade. A spec (FR-015) diz "nota anexada preenchida" sem nomear a coluna, e
  > `numnota` é a leitura intuitiva errada. O predicado **vigente no repositório** é o da
  > 0109:49-51, literal:
  > ```sql
  > NULLIF(btrim(em.nota_ok, E' \t\r\n'), '') IS NOT NULL
  >   AND NULLIF(btrim(em.erro_validacao, E' \t\r\n'), '') IS NULL
  > ```
  > A implementação **MUST** reusar exatamente este predicado — divergir dele faria a guarda
  > julgar pela coluna errada e **permitir alterar o valor de um movimento cuja nota já foi
  > enviada**, que é precisamente o dano que D2/FR-016 existem para impedir.
- **INV-4 (FR-016)**: movimento com nota enviada **mantém** o valor e é contado como pulado.
- **INV-5 (FR-017 + FR-023)**: a guarda de INV-3, o `UPDATE` e o `INSERT` de auditoria são
  **um só comando** (Decision 5). Sem registro não há alteração.

### State transitions

O movimento não tem máquina de estados própria; o que importa é a **elegibilidade à
correção**, derivada de duas colunas:

```
                    mov_fechado = true ──────────────────► NÃO ALTERÁVEL (pulado: fechado)

  Movimento ──┬── nota_ok preenchida E erro_validacao vazio ─► NÃO ALTERÁVEL (pulado: nota enviada)
              │
              └── demais casos ─────────────────────────────► CORRIGÍVEL
                        │
                        ├── enviado indica mensagem já enviada ──► CORRIGÍVEL + contar em
                        │                                          "mensagem já enviada com
                        │                                          valor antigo" (FR-018)
                        └── caso contrário ──────────────────────► CORRIGÍVEL
```

A transição é avaliada **dentro** da função transacional, não antes (INV-5).

---

## Entity: Registro de correção (`Auditoria`)

Reuso integral da tabela existente (`0004_auditoria.sql`). **Nenhuma coluna nova, nenhuma
tabela nova** — ver Decision 6.

### Campos (existentes)

| Campo | Tipo | Uso nesta feature |
|---|---|---|
| `id` | bigserial (PK) | — |
| `id_empresa` | int **NULL** | empresa do movimento; **representa a conta** no painel legado |
| `usuario_id` | int **NULL** → `Usuario(id)` | a **pessoa** na sessão do hub; **`NULL`** no painel legado |
| `acao` | text NOT NULL | `movimento_valor_corrigido` **[PROPOSTA]** |
| `recurso` | text NOT NULL | `EnvioMassa` |
| `recurso_id` | text NULL | `id` do movimento corrigido |
| `detalhes` | jsonb NOT NULL | carga da correção (abaixo) **[PROPOSTA]** |
| `ip` | inet NULL | opcional |
| `criado_em` | timestamptz NOT NULL `now()` | o **instante** exigido por FR-021 |

### `detalhes` (jsonb) — **[PROPOSTA]**

| Chave | Tipo | FR |
|---|---|---|
| `valor_anterior` | number | FR-021 |
| `valor_novo` | number | FR-021 |
| `gorjeta_anterior` | number \| null | FR-021 |
| `gorjeta_nova` | number \| null | FR-021 |
| `motivo` | string | FR-021; **preservado integralmente**, nunca mascarado |
| `origem` | `"tela"` \| `"reimportacao"` | FR-021 |
| `mensagem_ajustada` | boolean | FR-014 — âncora encontrada? |

### Invariantes

- **INV-6 (FR-022)**: autoria **nunca é inventada**. Hub ⇒ `usuario_id` da pessoa.
  Legado ⇒ `usuario_id = NULL` + `id_empresa`, porque o login legado é **por empresa**.
  Não existe usuário sintético.
- **INV-7 (FR-024)**: imutabilidade **já garantida pelo schema** — `GRANT` só de
  `SELECT, INSERT` (0004:21), `REVOKE UPDATE, DELETE` (0004:27) e trigger que bloqueia
  **incondicionalmente** `UPDATE`/`DELETE` (0004:29). Nada a implementar.
- **INV-8 (FR-024)**: `motivo` vai integral em `detalhes`, inclusive quando contém número
  parecido com documento ou e-mail (Edge Case). Não é descartado nem mascarado.
- **INV-9 (FR-021)**: exatamente **um** registro por movimento alterado. Movimento pulado
  (nota enviada / fechado) **não** gera registro — não houve alteração.
- **INV-10 (FR-004)**: reimportação idempotente ⇒ segunda execução não altera dados **nem
  gera registro**. A função só grava auditoria quando o `UPDATE` de fato mudou algo.

---

## Entity: Resultado da reimportação (efêmero, não persistido)

Devolvido como **resposta** do `POST /upload` (Decision 10). Não há tabela.

### Contagens (FR-009) — os sete desfechos

| Chave **[PROPOSTA]** | Significado |
|---|---|
| `criados` | linha sem correspondente, criada (FR-002/FR-007) |
| `atualizados` | movimento existente corrigido |
| `inalterados` | casou, mas valor/gorjeta/mensagem idênticos (FR-004) |
| `pulados_nota_enviada` | INV-3 (FR-016) |
| `pulados_mov_fechado` | movimento fechado (Q3) |
| `ambiguos` | casou com >1 movimento; **nenhum** tocado (FR-006) |
| `sem_identificador` | sem `uuid` **e** sem correspondente no fallback (FR-007) |

### Listas (FR-009 / FR-006)

- `ambiguos[]` — linha da planilha + os `id` candidatos, para o operador resolver.
- `pulados[]` — linha + motivo do pulo.
- `mensagem_valor_antigo` — quantos corrigidos **já tinham a mensagem enviada** com o valor
  antigo (FR-018), para o operador reenviar ou avisar.

### Invariante

- **INV-11 (FR-013 / Edge Case "falha no meio")**: o resumo **nunca** confirma sucesso
  total quando houve falha parcial; as contagens descrevem o que de fato foi aplicado.
  A soma dos sete desfechos **MUST** igualar o total de linhas válidas do arquivo — é essa
  igualdade que torna o resumo auditável em vez de decorativo.

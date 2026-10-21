# Contrato: Correção de valor de movimento

**Feature**: `corrigir-movimento` · **Fase**: Phase 1 (plan) · **Data**: 2026-10-20

> **Procedência de cada campo.** O que está sob "Hoje (REAL)" foi extraído do código-fonte,
> com arquivo e linha. O que está sob **[PROPOSTA — a validar na implementação]** não existe
> ainda: é desenho. Nenhum campo é afirmado como real sem fonte (principio de zero-fabricacao; a constitution deste projeto tem apenas I-V).

---

## 1. `POST /upload` — reimportação

### 1.1 Hoje (REAL) — `server.js:1789`

Cadeia de middleware, literal:

```
authenticateTokenCompartilhado, hubEnvioMassaClaimsBridge,
hubEnvioMassaRequirePermission('envio_massa.criar'), upload.single('file')
```

- **Content-Type**: `multipart/form-data` (multer) — **não** passa pelo `express.json()`
  global de 100 KB (Decision 10).
- **Campos de formulário** (REAL):

| Campo | Fonte | Obrigatório | Formato |
|---|---|---|---|
| `file` | `upload.single('file')` | sim | XLSX |
| `dt_inicial` | `server.js:1819` | sim (`:1823`) | `DD/MM/YYYY` (`:1833`) |
| `dt_final` | `server.js:1820` | sim (`:1826`) | `DD/MM/YYYY` (`:1836`) |
| `empresa_id` | `resolveEmpresaAlvo` | não | inteiro; validado contra o escopo do token |

- **Validação de range** (REAL): `dt_inicial <= dt_final` (`server.js:1838-1840`).
- **Colunas da planilha** (REAL, confirmadas nos dois arquivos; a planilha **não tem**
  colunas de data — `server.js:1948`):
  `uuid, number, nome, valor, mensagem1, mensagem2, enviado, retorno_envio_msg_1,
  retorno_envio_msg_2, tribnac, cnpj_tomador, cnpj_prestador, gorjeta`
- **Comportamento atual**: insere o lote inteiro
  (`postgrestRequest('EnvioMassa', 'POST', dataToInsert)`), **duplicando** movimentos já
  existentes. Linha inválida aborta tudo antes do insert.

### 1.2 **[PROPOSTA — a validar na implementação]** — campos novos

| Campo | Tipo | Obrigatório | FR |
|---|---|---|---|
| `motivo` | string | **condicional**: obrigatório quando a reimportação alteraria movimentos existentes; recusado **antes de qualquer alteração** se ausente | FR-008 |

`motivo` é texto livre, um por lote (Q5/dec-010). Não há lista fixa.

### 1.3 **[PROPOSTA]** Resposta

```
200 OK
{
  "success": true,
  "resumo": {
    "total_linhas": 982,
    "criados": 0,
    "atualizados": 974,
    "inalterados": 3,
    "pulados_nota_enviada": 4,
    "pulados_mov_fechado": 1,
    "ambiguos": 0,
    "sem_identificador": 0,
    "mensagem_valor_antigo": 112
  },
  "ambiguos": [ { "linha": 57, "cnpj_prestador": "...", "candidatos": [1234, 5678] } ],
  "pulados":  [ { "linha": 12, "motivo": "nota_enviada" } ]
}
```

- A soma dos sete desfechos **MUST** igualar `total_linhas` (INV-11).
- `400` quando `motivo` falta e o lote alteraria existentes (FR-008) — **sem** ter alterado nada.
- `400` com a lista de `errors` por linha quando há linha **inválida**: nada criado nem
  atualizado (FR-005, tudo-ou-nada **preservado**).
- Ambiguidade **não** é erro: `200` com as demais linhas aplicadas e as ambíguas listadas
  (FR-006 — muda deliberadamente o tudo-ou-nada atual, autorizado pelo operador).

### 1.4 **[PROPOSTA]** Consulta de casamento (interna)

Uma passada em lotes de 100 CNPJs, via `buscarEmLotes` com cliente injetado (Decision 11):

```
GET EnvioMassa
  ?id_empresa=eq.<empresaAlvo>
  &dt_inicial=gte.<D0>&dt_inicial=lt.<D0+1dia>
  &dt_final=gte.<F0>&dt_final=lt.<F0+1dia>
  &cnpj_prestador=in.(<até 100 CNPJs>)
  &select=id,uuid,cnpj_prestador,dt_inicial,dt_final,valor,gorjeta,mensagem1,enviado,nota_ok,numnota,erro_validacao,mov_fechado
```

- Faixa, **nunca** `::date` — `::date` na coluna impede o índice (Decision 3).
- Usa `idx_envio_massa_cnpj_periodo (cnpj_prestador, dt_inicial, dt_final)` da 0109:
  igualdade na coluna líder + faixa nas seguintes. **Nenhum índice novo** (Decision 2).
- O `select` traz `uuid`, então o ramo 1 da chave dupla resolve **em memória** sobre este
  mesmo resultado — sem segunda consulta e sem índice em `uuid`, que não existe.
- `id_empresa` explícito é **obrigatório**: o banco não escopa esta tabela (Decision 7).

> **SEC-2 — a lista do `in.()` só aceita valor normalizado (OWASP A05:2025 Injection /
> CWE-89 na camada de query string do PostgREST; gate `owasp-security`).** Os
> `cnpj_prestador` vêm de **células de planilha**, que são entrada não confiável. Um valor
> com `,`, `)`, `.` ou operador do PostgREST pode **escapar do filtro** e alterar a
> consulta. A implementação **MUST** construir a lista **exclusivamente** a partir de
> valores já normalizados e validados — `onlyDigits` + `isCNPJ14`, exatamente como as duas
> rotas já fazem (`cnpjPrestDigits` no `/upload`; `onlyDigits(cnpjRaw)` + `isCNPJ14` em
> `server.js:1097-1099`) — e **MUST NOT** interpolar a célula bruta. Linha cujo CNPJ não
> passa na validação já é **linha inválida** (FR-005) e não chega a esta consulta.
>
> **O `uuid` NUNCA entra em query.** Hoje ele é gravado **cru** da planilha
> (`uuid: row.uuid`, `server.js:1989`), sem normalização nem validação de formato. Por isso
> a Decision 1 resolve o ramo `uuid` **em memória**, comparando strings em JavaScript — o
> que, além de dispensar índice, **elimina por construção** este vetor de injeção. Qualquer
> refatoração futura que mova o `uuid` para um filtro `uuid=in.(...)` **reintroduz** a
> vulnerabilidade e exige validar o formato antes.

---

## 2. `PATCH /update-envio-massa/:id` — edição pela tela

### 2.1 Hoje (REAL) — `server.js:1079`

Mesma cadeia de middleware da §1.1 (`envio_massa.criar`). Corpo **JSON** pequeno.

| Campo | Fonte | Papel |
|---|---|---|
| `enviado` | `server.js:1081` | status de envio |
| `mensagem` | `server.js:1081` | retorno de envio msg 1/2 |
| `tipo` | `server.js:1081` | `"men1"` \| `"men2"` — seleciona qual retorno gravar |
| `empresa_id` | `server.js:1086` | validado por `resolveEmpresaAlvo` (403 fora do escopo) |
| `cnpj_prestador` | `server.js:1092` | opcional; dispara a migração de CNPJ `[B]..[F]` |

**Causa raiz do defeito desta feature** (FR-011 / Contexto da spec): `updateEnvioMassa`
monta `updateData` **somente** para `tipo === "men1"` ou `"men2"`
(`server.js:1050-1057`) — **`valor` nunca entra no corpo do PATCH**. O movimento vai para
`EnvioMassa?id=eq.<id>&id_empresa=eq.<idEmp>` (`:1063`) sem o valor, e a rota ainda assim
responde `"Registro atualizado com sucesso!"`. O escopo por empresa **já** está correto
aqui (filtro composto `id` + `id_empresa`); o que falta é gravar o campo.

O frontend chama `api.patch('/update-envio-massa/${id}', payload)` com
`empresa_id` anexado (`frontend_v2/hooks/use-envio-massa.ts:98-99`).

### 2.2 **[PROPOSTA — a validar na implementação]** — campos novos

| Campo | Tipo | Obrigatório | FR |
|---|---|---|---|
| `valor` | number | sim, neste caminho | FR-011, FR-012 |
| `motivo` | string não vazia | **sempre** | FR-011, Q5/dec-010 |
| `gorjeta` | number \| null | opcional | FR-003 |

`valor` passa pela **mesma** validação numérica da importação (FR-012) — reusar o parser do
`/upload`, não escrever um segundo (o repositório já teve o mesmo mapa duplicado 3×).

> **SEC-1 — allowlist explícita de campos graváveis (OWASP API3:2023 BOPLA / mass
> assignment; gate `owasp-security`).** O corpo desta rota **já** carrega `enviado`,
> `mensagem`, `tipo`, `cnpj_prestador` e `empresa_id`, e agora ganha `valor`/`gorjeta`. A
> implementação **MUST** montar o corpo do `UPDATE` a partir de uma **allowlist literal**
> (`valor`, `gorjeta`, `mensagem1`) e **MUST NOT** repassar o `req.body` — nem um
> *spread* dele — para a escrita. Sem a allowlist, um cliente autenticado poderia gravar
> `nota_ok`, `numnota`, `erro_validacao`, `mov_fechado`, `dt_inicial`/`dt_final` ou `id_empresa`,
> **contornando as guardas** de FR-015/FR-016 e o isolamento de FR-019 — ou seja,
> liberando o pagamento de um movimento que a nota deveria travar.
> Hoje a rota é segura **por acidente**: `updateEnvioMassa` só mapeia `men1`/`men2`
> (`server.js:1050-1057`), o que é uma allowlist implícita. Esta feature **MUST** preservar
> essa disciplina de forma **explícita**, não herdá-la por acidente.

### 2.3 **[PROPOSTA]** Resposta — o desfecho real, nunca sucesso presumido (FR-013)

| Situação | Status | Corpo |
|---|---|---|
| gravado, mensagem ajustada | `200` | `{ "resultado": "atualizado", "mensagem_ajustada": true }` |
| gravado, **âncora não encontrada** | `200` | `{ "resultado": "atualizado", "mensagem_ajustada": false, "aviso": "O valor foi corrigido, mas a mensagem não pôde ser ajustada automaticamente — revise o texto antes de enviar." }` |
| nota enviada | `409` | `{ "resultado": "pulado_nota_enviada" }` |
| movimento fechado | `409` | `{ "resultado": "pulado_mov_fechado" }` |
| outra empresa / inexistente | `404` | `{ "resultado": "nao_encontrado" }` (FR-019) |
| `motivo` vazio | `400` | — |
| falha ao gravar | `500` | **nunca** mensagem de sucesso |

`mensagem_ajustada: false` é **sucesso parcial explícito** (FR-014 + Edge Case "mensagem não
reconhecível"): o sistema avisa em vez de declarar sucesso pleno.

---

## 3. **[PROPOSTA — a validar na implementação]** Função transacional (RPC)

Decision 5: FR-017 (guarda + gravação indivisíveis) e FR-023 (alteração + auditoria juntas)
não são atingíveis com ler-depois-PATCH sobre PostgREST. Padrão já usado no repositório
(`hub_repasse_lote_avaliar` 0109, `hub_adiantamento_repasse_fechar` 0098).

### Assinatura proposta

```
hub_envio_massa_corrigir_valor(
    p_id_empresa   int,
    p_movimentos   jsonb,   -- [{id, valor, gorjeta, mensagem1}, ...]
    p_motivo       text,
    p_origem       text,    -- 'tela' | 'reimportacao'
    p_usuario_id   int      -- NULL no painel legado (Decision 6)
) RETURNS TABLE (
    movimento_id   bigint,
    desfecho       text,    -- 'atualizado'|'inalterado'|'pulado_nota_enviada'|'pulado_mov_fechado'|'nao_encontrado'
    valor_anterior numeric,
    msg_valor_antigo boolean
)
```

### Requisitos da função

1. **Escopo**: `WHERE id = ... AND id_empresa = p_id_empresa`. Jamais só por `id` — o banco
   não escopa esta tabela (Decision 7); `id` de outra empresa sai como `nao_encontrado`.
2. **Guarda de nota enviada** no mesmo comando do `UPDATE` (FR-017): nota anexada
   preenchida **E** `erro_validacao` vazio, `btrim` nos dois (FR-015).
3. **Guarda de fechado**: `mov_fechado = false`.
4. **Auditoria no mesmo comando** (FR-023): `INSERT INTO "Auditoria"` por movimento de fato
   alterado, `acao = 'movimento_valor_corrigido'`, `usuario_id = p_usuario_id` (nulo no
   legado), `detalhes` conforme `data-model.md`. Nada alterado ⇒ nenhum registro (FR-004/INV-9).
5. **Idempotência** (FR-004): valor/gorjeta/mensagem iguais ⇒ `inalterado`, **sem** `UPDATE`
   e **sem** registro de auditoria.
6. **Campos alteráveis**: **apenas** `valor`, `gorjeta`, `mensagem1` (FR-003/INV-2).
7. `SET search_path = public, pg_temp` e `SECURITY DEFINER` — mesmo padrão da 0109/0098.
   Com `SECURITY DEFINER`, `p_id_empresa` é a **única** fronteira de tenant: o parâmetro
   **MUST** vir de `resolveEmpresaAlvo`, nunca direto do corpo da requisição (Princípio II).
8. **Migration aditiva**, próxima da série `infra/hub/migrations/NNNN_*.sql` (nunca editar
   migration aplicada), com `GRANT EXECUTE … TO authenticated` e linha de `ROLLBACK` no
   cabeçalho, como as demais.

---

## 4. Convenções de borda

| Camada | Case | Validação | Fonte da verdade |
|---|---|---|---|
| Colunas do banco | `snake_case` | DDL | `infra/hub/migrations/*.sql` |
| Corpo/resposta HTTP do legado | `snake_case` | manual no handler | `server.js` (rotas `/upload`, `/update-envio-massa/:id`) |
| Cliente frontend | `snake_case` no payload | TS types | `frontend_v2/hooks/use-envio-massa.ts` |
| Parâmetros da função | `p_<snake_case>` | assinatura SQL | migration nova |

**Nota deliberada**: este módulo é **legado** e trafega `snake_case` ponta a ponta
(`dt_inicial`, `empresa_id`, `cnpj_prestador` — verificável em `use-envio-massa.ts` e
`server.js:1819-1820`). Os campos novos **seguem `snake_case`** por coerência local. Não há
camada de mapper e **não se introduz uma** nesta feature — o hub usa `camelCase`, mas estas
duas rotas são do painel legado, e trocar a convenção delas seria mudança de contrato
público sem pedido (FR-025).

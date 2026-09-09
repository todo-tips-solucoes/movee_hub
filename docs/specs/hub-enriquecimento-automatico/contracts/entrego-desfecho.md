# Contracts: desfecho de enriquecimento (robô ↔ hub)

Feature `hub-enriquecimento-automatico`. Escopo backend apenas (dec-011) —
nenhum contrato de frontend.

Este documento cobre **uma mudança aditiva** num endpoint que **já existe**.
As partes marcadas ✅ EXISTENTE foram extraídas do código real
(`app_homologacao/backend/routes/hub-robo-entrego.js`, montado em
`app_homologacao/backend/server.js:2847` sob `/api/v1/robo-entrego`). As partes marcadas
🆕 PROPOSTA são novas e serão validadas na implementação.

---

## 1. `PATCH /api/v1/robo-entrego/motoristas/:id/entrego-enriquecimento`

Grava o resultado de uma tentativa de enriquecimento.

**Auth** ✅ EXISTENTE: cookie httpOnly `hub_accessToken`
(`decodificarAccessToken(lerAccessTokenDoRequest(req))`).
**Permissão** ✅ EXISTENTE: `motoristas.enriquecimento.atualizar`
(`requirePermission` + revalidação por entidade via
`obterPermissoesEfetivasPorEntidade`).
**Rate limit** ✅ EXISTENTE: `roboEntregoRateLimiter`.

### Escopo multi-tenant (FR-009) ✅ EXISTENTE — inalterado

O `id_empresa` **nunca** vem do corpo. Ele é derivado de
`payload.entidade_ativa` do token e injetado nas claims do JWT do PostgREST:

```
const claims = { usuarioId: payload.sub, empresaAtiva: entidadeAtiva, escopo: [entidadeAtiva] };
```

O `PATCH` ao PostgREST usa `Entregador?id=eq.${id}` **sem** filtro
`id_empresa` explícito — de propósito: quem decide se a linha existe e
pertence ao tenant é a RLS (`0015`). Zero linhas afetadas ⇒ `404`.
Esta feature **não altera nada disso**.

### Request

| Field | Type | Required | Status | Validação |
|-------|------|----------|--------|-----------|
| `sucesso` | boolean | **sim** | ✅ EXISTENTE | `typeof !== 'boolean'` ⇒ `422 INVALIDO` |
| `dados` | object | não | ✅ EXISTENTE | Só considerado quando `sucesso=true`; `dados && typeof === 'object'` senão `null` |
| `motivoFalha` | string | não | ✅ EXISTENTE | Texto livre; vai **só** para auditoria (`detalhes.motivoFalha`), nunca para coluna |
| `modo` | string | não | ✅ EXISTENTE | Só registrado em auditoria quando `typeof === 'string'` |
| **`sinalFalha`** | **string** | **não** | **🆕 PROPOSTA** | **Allowlist fechada no servidor; valor desconhecido/ausente ⇒ `outra-falha` (nunca `422`)** |

> **Por que `sinalFalha` e não reaproveitar `motivoFalha`**: `motivoFalha` é
> `e.message` (texto livre — `infra/robo-entrego/src/enriquecimento.js:259`).
> Classificar por regex sobre mensagem de erro é frágil e acopla o backend ao
> texto do robô. O sinal estruturado já existe:
> `infra/robo-entrego/src/entrego-portal.js:80-86` define
> `ErroPessoaNaoEncontradaNoPortal` com `this.sinal = 'pessoa_nao_encontrada'`.

### Mapeamento `sinalFalha` → `dados_entrego_desfecho` 🆕 PROPOSTA

Allowlist fechada, avaliada **no servidor** (mesma disciplina do
`ACOES_PERMITIDAS` já existente em `routes/hub-robo-entrego.js:55-61`,
introduzido por achado MEDIUM de gate `owasp-security` anterior):

| `sucesso` | `sinalFalha` recebido | `dados_entrego_desfecho` gravado |
|---|---|---|
| `true` | (ignorado) | `sucesso` |
| `false` | `"pessoa_nao_encontrada"` | `pessoa-nao-encontrada` |
| `false` | qualquer outro valor | `outra-falha` |
| `false` | ausente / `null` / não-string | `outra-falha` |

**Regra dura**: o valor recebido **nunca** é gravado diretamente na coluna. O
destino tem `CHECK` de 4 valores; repassar entrada do cliente causaria
violação de constraint e `500`. O mapeamento é total — todo input produz um
dos 4 valores válidos, então nenhum valor novo do robô pode derrubar o
endpoint.

### Corpo do PATCH ao PostgREST

✅ EXISTENTE (`routes/hub-robo-entrego.js:222-229`) — a coluna nova é
**adicionada** aos dois ramos; nada é removido:

```
sucesso === true:
  {
    dados_entrego_json:             <dados|null>,   // ✅ existente
    dados_entrego_enriquecidos_em:  <now ISO>,      // ✅ existente
    dados_entrego_solicitado_em:     null,          // ✅ existente
    dados_entrego_solicitado_manual: false,         // 🆕 FR-011 (M1)
    dados_entrego_desfecho:          'sucesso'      // 🆕 MESMO PATCH (dec-010)
  }

sucesso === false:
  {
    dados_entrego_solicitado_em:     null,          // ✅ existente
    dados_entrego_solicitado_manual: false,         // 🆕 FR-011 (M1)
    dados_entrego_desfecho:          <mapeado>      // 🆕
  }
```

> **INVARIANTE INEGOCIÁVEL (dec-010)**: `dados_entrego_desfecho: 'sucesso'` e
> `dados_entrego_enriquecidos_em` saem no **mesmo** objeto de PATCH. Não há
> janela para divergirem. Nenhum dos dois pode ser removido sob alegação de
> redundância — a spec proíbe explicitamente.

> **FR-008 preservada**: o ramo de falha continua **não** tocando
> `dados_entrego_json` nem `dados_entrego_enriquecidos_em`. Uma falha nunca
> descarta enriquecimento anterior; só reclassifica o desfecho.

### Response (200) ✅ EXISTENTE — inalterada

| Field | Type | Description |
|-------|------|-------------|
| `ok` | boolean | Sempre `true` |

### Error Responses ✅ EXISTENTE — inalteradas

| Status | Code | Quando |
|--------|------|--------|
| 401 | `NAO_AUTENTICADO` | Token ausente/inválido |
| 400 | `ENTIDADE_NAO_SELECIONADA` | `payload.entidade_ativa` ausente |
| 403 | `PERMISSAO_NEGADA` | Sem `motoristas.enriquecimento.atualizar` na entidade |
| 404 | `NAO_ENCONTRADO` | `id` não numérico, ou 0 linhas afetadas (fora do escopo pela RLS) |
| 422 | `INVALIDO` | `sucesso` não é boolean |
| 500 | `ERRO_SERVIDOR` | Exceção |

`sinalFalha` inválido **não** gera `422` — degrada para `outra-falha`
(mapeamento total). Motivo: perder um PATCH significa perder trabalho já feito
no portal, e o cliente do robô só considera `200`/`404`/`5xx`/`429`
(`infra/robo-entrego/src/hub-client.js:289-298`).

### Auditoria ✅ EXISTENTE — inalterada

`acao: 'motorista.entrego_enriquecido'` (sucesso) ou
`'motorista.entrego_enriquecimento_falhou'` (falha), `recurso: 'Entregador'`,
`recursoId: id`, `detalhes: { modo, motivoFalha }`. **`detalhes` nunca inclui
`dados`** (payload sensível) — disciplina explícita no código, mantida.

🆕 PROPOSTA (revisada pelo gate `owasp-security`, achado **M4**): incluir em
`detalhes` o **valor já mapeado** (`desfecho`, um dos 4 tokens), **nunca** o
`sinalFalha` bruto recebido do cliente.

> **Por que a versão anterior desta proposta estava errada**: dizer que
> "`sinalFalha` é um enum curto, não PII" confunde o que o servidor *aceita*
> com o que o cliente *envia*. O campo é atacante-controlado — nada impede um
> cliente de mandar 4 KB de trecho de página (com nome, RG, CNH) nesse campo.
> `scrubDetalhes` só remove CPF/CNPJ/e-mail por regex, não pega nome/RG/CNH nem
> limita tamanho. Gravar o valor **mapeado** elimina a classe inteira: só 4
> strings possíveis podem chegar à auditoria.

Validações adicionais no handler (mesmo achado M4):

| Regra | Motivo |
|---|---|
| `sinalFalha` só é lido se `typeof === 'string'` e `length <= 64` | Acima disso não é sinal; cai em `outra-falha` sem ser propagado |
| `motivoFalha` é truncado antes de ir para `detalhes` (sugestão: 500 chars) | Hoje é `e.message` do Playwright, sem limite — pode carregar trecho de página |
| `detalhes` continua **proibido** de conter `dados` | Regra já existente, inalterada |

Sem mudança na allowlist `ACOES_PERMITIDAS` — ela governa o endpoint de
**eventos**, não este.

---

## 2. `GET /api/v1/robo-entrego/motoristas-para-enriquecer` 🆕 **uma chave de ordenação**

Documentado aqui porque é o consumo da fila (FR-004) e a prova de que
**nenhum canal novo é necessário**. A resposta de `block-003` (M1/FR-011)
mudou este endpoint: era "sem mudança" na onda-004, agora ganha **uma** chave
de ordenação — nada mais.

**Query**: `modo=sob-demanda|semestral` (outro valor ⇒ `422 INVALIDO`).
**Permissão**: `motoristas.enriquecimento.consultar`.

Filtro do modo `sob-demanda` (`routes/hub-robo-entrego.js:167`):

```
ANTES  dados_entrego_solicitado_em=not.is.null
      &order=dados_entrego_solicitado_em.asc

DEPOIS dados_entrego_solicitado_em=not.is.null
      &order=dados_entrego_solicitado_manual.desc,dados_entrego_solicitado_em.asc
```

**Semântica (FR-011)**: `desc` num booleano `NOT NULL` traz `true` (pedido
manual) primeiro; dentro de cada grupo o desempate segue FIFO por
`dados_entrego_solicitado_em`. O `limit` de 20 continua o mesmo, então uma
rodada com pedidos manuais pendentes é **inteiramente** consumida por eles —
que é exatamente o efeito pedido ("o botão não pode virar 'enriquecer em
alguns dias'").

**Starvation ao contrário não é risco prático**: o pedido manual exige clique
humano e já tem *rate limit* próprio (`entregoEnriquecimentoRateLimiter`,
`routes/hub-motoristas.js:814`) mais dedup por motorista
(`429 JA_PENDENTE`, `:842`). Não há caminho pelo qual pedidos manuais cheguem
em volume capaz de afogar a fila automática indefinidamente.

O modo `semestral` **não** muda: ele ordena por
`dados_entrego_enriquecidos_em.asc` e não lê nenhuma das colunas novas.

**Response (200)**: `{ items: [{ id: number, idExterno: uuid }] }`, no máximo
`LOTE_ENRIQUECIMENTO_DEFAULT = 20` (`routes/hub-robo-entrego.js:44`).

**Consequência para FR-001/FR-004**: como a fila é exatamente
`dados_entrego_solicitado_em IS NOT NULL`, carimbar essa coluna na criação
(via trigger da `0060`) faz o entregador novo aparecer aqui na rodada
seguinte, **sem uma linha de código novo neste endpoint**.

**Não alargar este filtro** para incluir `dados_entrego_desfecho =
'nunca-tentado'`: isso enfileiraria retroativamente todos os já cadastrados, e
retroatividade foi bloqueio humano na feature irmã `hub-motorista-360`. O
gatilho da `0060` chega perto disso no ramo de `UPDATE` (é assim que o
excedente do teto entra na importação seguinte, FR-010) — e é justamente por
isso que ele exige `criado_em >= EnriquecimentoAutomatico.desde`: o recorte
mantém fora **todo** entregador anterior à habilitação da empresa.

---

## 3. Cliente do robô — `atualizarEnriquecimento` 🆕 PROPOSTA (aditiva)

`infra/robo-entrego/src/hub-client.js:283-287` monta hoje:

```
const corpo = { sucesso, modo };
if (sucesso) corpo.dados = dados;
else corpo.motivoFalha = motivoFalha;
```

Mudança proposta: no ramo de falha, anexar também `corpo.sinalFalha =
sinalFalha` quando presente. A regra "`sucesso=false` NUNCA envia `dados`"
permanece intacta.

Chamador (`infra/robo-entrego/src/enriquecimento.js:259`) passa a enviar
`sinalFalha: e.sinal` junto do `motivoFalha: e.message` já existente —
`e.sinal` é `undefined` para erros sem sinal, o que cai corretamente em
`outra-falha` pelo mapeamento total do servidor.

> ⚠️ **Worktree obrigatório**: `infra/robo-entrego/` é executado pelo systemd
> a partir do **diretório vivo** do repositório (`ExecStart`). Alterar esses
> arquivos na working tree principal muda o que roda em produção antes do
> merge. Toda mudança aqui se faz em git worktree separado, e a suíte precisa
> ser provada **no diretório vivo** após o merge.

---

## 4. Habilitação por empresa 🆕 PROPOSTA — **não é API**

FR-012/FR-013 (M2/H1). Deliberadamente **não existe rota** para ligar ou
desligar o enfileiramento automático: a habilitação é uma linha em
`"EnriquecimentoAutomatico"` (ver `data-model.md`), escrita pelo operador
direto no banco durante o runbook de cutover. O role `authenticated` só tem
`SELECT`, e ainda assim sob RLS escopada por `hub_jwt_escopo_ids()` — mesmo
precedente de `"ModuloEntidade"` (`0006:84-89`).

```sql
-- LIGAR para uma empresa (cutover — só após a decisão de retenção de PII)
INSERT INTO "EnriquecimentoAutomatico" (empresa_id, ativo, teto, desde)
VALUES (:empresa_id, true, 100, now())
ON CONFLICT (empresa_id) DO UPDATE
   SET ativo = true, teto = EXCLUDED.teto,
       desde = now(), atualizado_em = now();

-- DESLIGAR (reversão imediata, sem deploy)
UPDATE "EnriquecimentoAutomatico"
   SET ativo = false, atualizado_em = now()
 WHERE empresa_id = :empresa_id;
```

> `desde = now()` **em toda (re)ativação**, inclusive ao religar depois de uma
> pausa. Sem isso, os entregadores criados durante a pausa virariam candidatos
> no primeiro import seguinte — um efeito retroativo pela porta dos fundos,
> logo depois de alguém ter decidido desligar a coleta.

**Contrato de ausência**: empresa **sem linha** (ou com `ativo = false`) ⇒ o
`SELECT … INTO cfg` do gatilho não encontra nada, a função retorna sem
carimbar ⇒ nada é enfileirado, e nenhum erro é emitido. É o mesmo
nega-por-padrão de `"ModuloEntidade"` (`routes/hub-admin.js:121-123`).

# Contrato — `POST /api/v1/adiantamentos/repasse/:periodo/movimentos`

**Feature**: `repasse-gera-movimento` · **Data**: 2026-10-28

> **Estado da arte**: esta rota **já existe** (`app_homologacao/backend/routes/hub-adiantamentos.js:2177`). Tudo marcado **[VIGENTE]** foi lido do código e é afirmado como real. Tudo marcado **[PROPOSTA]** é desenho novo desta frente, a validar na implementação (Constitution VI — não se afirma como real o que ainda não existe).

- **Prefixo real das rotas** (conferido em `app_homologacao/frontend_v2/lib/hub/adiantamentos-api.ts`): `/adiantamentos/repasse/...` sob a base `/api/v1`.
- **Middlewares [VIGENTE]**: `requireModuloAtivo('adiantamentos')` + `requirePermission('adiantamentos.pagamento_confirmar')`.
- **O browser nunca chama o backend direto** (Constitution §III): a chamada passa pelo proxy `app/api/[...path]`, que repassa os cookies `httpOnly`.

---

## Request

**[VIGENTE]** — não muda.

```
POST /api/v1/adiantamentos/repasse/2026-10-19/movimentos
Content-Type: application/json

{ "confirmacao": true }
```

| Campo | Regra |
|---|---|
| `:periodo` (path) | `^\d{4}-\d{2}-\d{2}$`; qualquer outra forma ⇒ `400 { erro: 'DADOS_INVALIDOS', motivo: 'periodo' }` |
| `confirmacao` (body) | **obrigatório** e exatamente `true`; ausente/≠ ⇒ `400 { erro: 'DADOS_INVALIDOS', motivo: 'confirmacao' }` |

Corpo minúsculo e de tamanho fixo — **sem interação** com o `express.json()` global de 100 KB (que é limite de **request** e roda antes do router).

---

## Ordem de operações

**[PROPOSTA]** — a mudança central da frente (`research.md` Decision 2).

```
1. valida :periodo e confirmacao                                       [VIGENTE]
2. PRÉ-FLIGHT de pendências de adiantamento — SEMPRE                   [PROPOSTA]
      pendência → 409 ADIANTAMENTOS_PENDENTES · nada fechado, nada criado
3. busca ApuracaoRepasse do período (id_empresa + periodo_inicio)      [VIGENTE]
4. se NÃO existe → rpc/hub_adiantamento_repasse_fechar                 [PROPOSTA]
      erro do RPC → 409 mapeado (tabela abaixo) · nada criado
   se existe      → usa a existente, SEM fechar de novo                [PROPOSTA]
5. geração: itens congelados + trilha + CNPJ/nome/telefone +
   tomador + movimentos abertos + planejarGeracao + inserts            [VIGENTE]
6. auditoria `adiantamento.movimentos_gerados`                         [VIGENTE]
7. 201 com { apuracaoId, gerados, semTelefone, recusados }             [VIGENTE]
```

**O 409 removido**: `if (!apuracao) return res.status(409).json({ erro: 'APURACAO_NAO_FECHADA' })` (`:2193`). Ele some — é o travamento nº 1 do BRIEFING §3.

⚠️ **O passo 2 vem antes do 4 por requisito, não por estilo.** A checagem `APURACAO_COM_PENDENCIAS` existe **dentro** do RPC de fechamento (`infra/hub/migrations/0117_lancamento_externo.sql:759`–`:771`) e portanto **não roda** quando a apuração já existe. FR-008 é sobre a **semana**, não sobre o fechamento: um adiantamento pode ser liberado depois de a apuração ter sido fechada. Além disso, o RPC só devolve **contagem por status** (`jsonb_object_agg(status, qtd)`) — nunca nomes, que FR-009 exige.

⚠️ **Ordem de entrega**: a remoção do 409 de `:2193` só pode ir ao ar **depois** de o pré-flight existir. Invertido, abre-se uma janela em que a geração roda sem a proteção de D5.

---

## Respostas

### `201 Created` — **[VIGENTE]**, shape inalterado

```json
{
  "apuracaoId": 12,
  "gerados": 57,
  "semTelefone": 3,
  "recusados": [
    { "entregadorId": 901, "nome": "Fulano", "motivo": "MOVIMENTO_ABERTO", "detalhe": "O motorista já tem movimento aberto (provavelmente da planilha)." }
  ]
}
```

Tipos já declarados em `app_homologacao/frontend_v2/lib/hub/adiantamentos-api.ts:752`–`:775`:
`GerarMovimentosResponse = { apuracaoId: number; gerados: number; semTelefone: number; recusados: MovimentoRecusado[] }` ·
`MovimentoRecusado = { entregadorId: number; nome: string | null; motivo: string; detalhe: string }`.

**Movimento só-com-gorjeta (FR-022)**: o motorista cuja nota zerou por dedução do pago por fora, **com** gorjeta, **entra em `gerados`** (não em `recusados`): `EnvioMassa` com `valor = 0`, `gorjeta > 0`. Se a base da nota já era zero ou não há gorjeta, ele **continua** em `recusados` com `VALOR_ZERO`. O conjunto de motivos de `recusados` emitidos por `planejarGeracao` são **8**: `RETIDO`, `SEM_CNPJ`, `SEM_DIVISAO`, `NOTA_LIQUIDA_AUSENTE`, `VALOR_ZERO`, `JA_GERADO`, `MOVIMENTO_ABERTO`, `MOVIMENTO_LEGADO_EM_SEMANA_RETIDA` (+ `FALHA_AO_GRAVAR`, emitido pela rota). O app do motorista não vê o movimento de valor zero (FR-023).

**Mantido deliberadamente**: a resposta de sucesso **não** ganha campos. O cliente atual continua válido byte a byte (SC-008).

### `200 OK` — apuração sem itens — **[VIGENTE]**

```json
{ "apuracaoId": 12, "gerados": 0, "recusados": [], "semTelefone": 0 }
```

### `409 ADIANTAMENTOS_PENDENTES` — **[PROPOSTA]** (D5 / FR-008 / FR-009)

```json
{
  "erro": "ADIANTAMENTOS_PENDENTES",
  "total": 116,
  "porStatus": { "LIBERADA": 50, "EXPORTADA": 66 },
  "motoristas": [
    { "entregadorId": 901, "nome": "Fulano de Tal", "status": "LIBERADA" }
  ],
  "motoristasOmitidos": 96
}
```

| Campo | Tipo | Regra |
|---|---|---|
| `total` | `int` | total de adiantamentos pendentes na semana (não de motoristas) |
| `porStatus` | `{ [status]: int }` | chaves do conjunto já usado pelo RPC: `AGUARDANDO_CORTE`, `AGUARDANDO_PRODUCAO`, `LIBERADA`, `EM_LOTE`, `EXPORTADA`, `FALHOU` (`0117:773`). Status sem pendência **não aparece** |
| `motoristas` | `array` | **capada em 20 itens**. Um item por (motorista, status); mesmo motorista com dois status aparece duas vezes |
| `motoristasOmitidos` | `int` | quantos itens ficaram fora do cap. `0` quando a lista é completa |

**Campos PROIBIDOS no corpo** (gate de privacidade de 01/10): `cnpj`/`cnpj_prestador`, telefone, conta bancária, qualquer valor monetário. **Nome + status + `entregadorId` bastam** para o financeiro destravar, e o `entregadorId` já abre a solicitação na tela.

**Nada é fechado e nada é criado** nesta resposta — é a condição de FR-008 ("recusada por inteiro").

### `409` mapeados do RPC de fechamento — **[PROPOSTA]** no *escopo desta rota*; os códigos são **[VIGENTE]**

Os códigos abaixo **já existem** e já são mapeados pela rota `POST /repasse/:periodo/fechar` (`routes/hub-adiantamentos.js:2110`–`:2135`). O que esta frente faz é **reusar aquele mapeamento** — extraído para helper compartilhado, **nunca duplicado**.

| Código | HTTP | Quando | Texto que o financeiro precisa ver |
|---|---|---|---|
| `PERIODO_EM_ABERTO` | 409 | `hub_adiantamento_repasse_pode_fechar` (`0067:1891`) exige `now() >= ((periodo_fim + 1) + horario_corte) AT TIME ZONE timezone` | ⚠️ **A recusa mais provável e a mais confundível.** A semana ainda pode receber pedido de adiantamento da produção do último dia. Precisa dizer **até quando** esperar, senão vira recusa misteriosa |
| `APURACAO_FORA_DE_ORDEM` | 409 | período ≠ último fechado + 7 dias | Há semana anterior não processada; processe-a primeiro |
| `APURACAO_NAO_CONFIGURADA` | 409 | sem `AdiantamentoConfiguracao` vigente ou sem `apuracao_data_base` | Configuração do repasse ausente |
| `PERIODO_DESALINHADO` | 409 | gatilho da `0086`: janela não começa no `apuracao_dia_inicio` configurado | A semana pedida não é uma semana de apuração |
| `APURACAO_JA_FECHADA` | 409 | corrida: outro acionamento fechou entre o passo 3 e o 4 | **Não é erro para o financeiro.** Ver "Concorrência" abaixo |
| `PERMISSAO_NEGADA` | 403 | `hub_adiantamento_tem_permissao` falhou dentro do RPC | — |
| `EMPRESA_SEM_CNPJ` | 409 | `Empresa.cnpj` ausente (`:2243`) | **[VIGENTE]**, inalterado |

⚠️ `PERIODO_EM_ABERTO`, `APURACAO_FORA_DE_ORDEM`, `APURACAO_NAO_CONFIGURADA` e `PERIODO_DESALINHADO` **não desaparecem com D1**. D1 remove o **passo manual**, não as regras do fechamento. A tela tem de explicar cada um — ver `contracts/ui-gerar-do-repasse.md`.

---

## Concorrência (Edge Case da spec)

Dois financeiros acionam a mesma semana ao mesmo tempo:

1. O `pg_advisory_xact_lock(6, hashtext('hub_adiantamento_repasse_fechar'))` (`0117:732`) serializa os fechamentos. **[VIGENTE]**
2. O segundo recebe `APURACAO_JA_FECHADA` do RPC. **[VIGENTE]**
3. **[PROPOSTA]** Nesta rota, `APURACAO_JA_FECHADA` **não é erro**: significa que a apuração que faltava passou a existir. A rota **relê** a apuração e **segue para a geração** (passo 5). O 409 só sai se a releitura também falhar.
4. **[PROPOSTA]** A trilha `ApuracaoRepasseMovimento` (UNIQUE apuração+entregador) vira a **reserva** (id pré-alocado, ver §Idempotência): o segundo acionamento vê `JA_GERADO` nos motoristas que o primeiro já reservou, e a PK da `EnvioMassa` serializa a conclusão. Hoje (**[VIGENTE]**) isso só vale para quem a trilha já registrou **depois** do `EnvioMassa` — por isso S1.

Resultado: **no máximo uma apuração e um movimento por motorista**, com o segundo acionamento vendo "já gerado" — exatamente o que o Edge Case pede.

---

## Idempotência e re-entrância

⚠️ **[`block-001` opção B · `dec-038` · `block-002` → `dec-040`]** A trilha passa a ser **reserva adquirida ANTES** do `POST EnvioMassa`, com o **id da `EnvioMassa` pré-alocado** por `nextval` (RPC `SECURITY INVOKER` `hub_repasse_alocar_envio_id`). **Sem** mudança de schema na trilha (ver `data-model.md` §`ApuracaoRepasseMovimento`). Sem isso, a idempotência abaixo **não existe**: hoje `jaGerados` é lido **uma vez** no início e duas requisições concorrentes gravam as duas.

**Ordem por motorista** (a **única** ordem; não há `PATCH` — `0092:63` concede só `SELECT, INSERT`):

```
1. id := rpc/hub_repasse_alocar_envio_id                      (ou o id de uma reserva já existente sem movimento)
2. POST ApuracaoRepasseMovimento { …, envio_massa_id: id }    UNIQUE (apuracao_id, entregador_id) ⇒ JA_GERADO
3. POST EnvioMassa { …, id }                                  o MESMO id; violação da PK ⇒ JA_GERADO
```

| Cenário | Resultado |
|---|---|
| Acionar duas vezes, tudo ok | 2ª vez: `gerados: 0`, todos em `recusados` com `JA_GERADO` |
| **Duas requisições concorrentes** | A segunda bate no `UNIQUE (apuracao_id, entregador_id)` **antes** de qualquer escrita em `EnvioMassa` ⇒ `JA_GERADO`, **zero duplicata** |
| Falha entre a reserva e o `POST EnvioMassa` | Reserva cujo `envio_massa_id` **não existe** em `EnvioMassa` (decidível por leitura de `EnvioMassa?id=in.(…)&id_empresa=in.(<grupo>)`). O **reacionamento conclui**: re-posta a `EnvioMassa` com o **mesmo** id. Não duplica; **nunca apaga** a reserva. A mensagem diz que a reserva foi registrada e o movimento **não** foi criado |
| Duas requisições **concluem** a mesma reserva ao mesmo tempo (retomada × original lenta) | Ambas postam o **mesmo** id; a **PK** da `EnvioMassa` deixa passar **uma**; a outra recebe a violação e responde `JA_GERADO`. Íntegro por construção, **sem** depender de tempo |
| Reserva com valor/gorjeta ≠ recomputados | `FALHA_AO_GRAVAR` nomeando a divergência; **não** conclui |
| Falha no meio da geração | Apuração fechada + parte dos movimentos. **Acionar de novo completa os que faltam.** Não é estado terminal |
| Falha no fechamento (passo 4) | Nada fechado (o RPC é uma transação), nada criado. Acionar de novo recomeça |

⚠️ **Descartado, não reintroduzir**: o `PATCH` da reserva (impossível sem DDL e `GRANT` novos), a liberação da reserva órfã por `DELETE` (não distingue órfã de em andamento — `MIG/0011:7`–`:9`) e qualquer heurística de tempo (*"reserva com menos de 5 min"*). Histórico em `plan.md` §O mecanismo da reserva do S1.

✅ **A mensagem de `FALHA_AO_GRAVAR` foi consertada** (exigência literal do operador em `block-001`; entregue na FASE 3 — **não é pendência**). **Antes** da correção, `:2321` (numeração de antes) devolvia *"Não foi possível criar o movimento; nada foi gravado para este motorista."* — **falso** quando o `EnvioMassa` gravava e a trilha não. **Hoje**, com a reserva primeiro, cada modo de falha tem seu texto verdadeiro em `TEXTO_FALHA` (`lib/adiantamento-geracao-movimento.js:253`–`:256`): `NADA_GRAVADO` só quando nada foi gravado, `RESERVA_SEM_MOVIMENTO` e `RESERVA_DIVERGENTE` nos outros dois. Tabela em `plan.md` §S1 ("A mensagem do `catch`").

⚠️ **O que esta rota NÃO oferece**: rollback do fechamento. `ApuracaoRepasse`/`ApuracaoRepasseItem` são **imutáveis** por `REVOKE UPDATE, DELETE` + trigger (`infra/hub/migrations/0066_adiantamento_tabelas.sql:460`–`:461` (REVOKE) · `:463` + `:470`–`:478` (função e triggers)). A garantia entregue é **retrato atômico + geração re-entrante**, não rollback — ver `research.md` Decision 1, que declara essa reinterpretação de FR-002/Acceptance Scenario 3.

---

## Tenant (FR-018 · Constitution §II NON-NEGOTIABLE)

⚠️ A `EnvioMassa` **não tem RLS alguma** (`infra/hub/migrations/0033_schema_legado_envio_massa.sql:125`): o filtro de `id_empresa` na query é a **única** proteção de tenant.

| Query | Filtro exigido |
|---|---|
| Pendências de adiantamento **[PROPOSTA]** | `AdiantamentoSolicitacao?id_empresa=in.(<escopo do token>)` — mesmo padrão das demais consultas do arquivo |
| **Histórico** na `EnvioMassa` **[VIGENTE]** | `id_empresa=in.(<ids do grupo>)`, ids de `mesmoGrupoQue(GRUPO_MOVEE_ID, GRUPO_MOVEE_ID, cache)` (`:2278` resolve, `:2282` filtra) — **nunca** `id_empresa === 6` estrito (regra de domínio do `CLAUDE.md`). ⚠️ Só roda dentro de `if (comSaldoIds.length)` |
| **Movimentos abertos** na `EnvioMassa` **[PROPOSTA — achado S7]** | ⚠️ **HOJE NÃO TEM FILTRO NENHUM**: `:2250`–`:2251` é `buscarEmLotes('EnvioMassa?mov_fechado=eq.false&select=cnpj_prestador', cnpjs, { campoId: 'cnpj_prestador', claims })`, e `lib/hub-postgrest-lotes.js:39` só acrescenta `campoId=in.(...)`. Lê **todos os tenants** de uma tabela **sem RLS**, e recusa `MOVIMENTO_ABERTO` por movimento de **outra** empresa cliente ⇒ motorista legítimo não recebe nota. **Precisa do mesmo `id_empresa=in.(<ids do grupo>)`**, com o grupo resolvido **uma vez** e reusado pelas duas queries |
| Apuração e itens **[VIGENTE]** | RLS própria por `hub_jwt_escopo_ids()` (`0066:447`–`:456`) **mais** o filtro explícito que a rota já aplica |

O escopo vem **sempre** do token, nunca do corpo da requisição.

⚠️ **A prévia depende da claim de escopo do JWT**: sem ela, `hub_jwt_escopo_ids()` não resolve e a prévia devolve **zero** — *parece* defeito e não é (BRIEFING §9). Todo teste de integração assina o JWT com escopo; todo diagnóstico de "tela vazia" checa a claim **antes** de suspeitar do cálculo.

---

## O que o cliente TypeScript ganha

**[PROPOSTA]** — em `app_homologacao/frontend_v2/lib/hub/adiantamentos-api.ts`:

```ts
// novo — corpo do 409 de D5
type AdiantamentosPendentes = {
  total: number;
  porStatus: Record<string, number>;
  motoristas: { entregadorId: number; nome: string; status: string }[];
  motoristasOmitidos: number;
};
```

`gerarMovimentos(periodo)` mantém assinatura e retorno **[VIGENTE]**. O corpo do 409 chega pelo `AdiantamentosApiError` já existente, no mesmo formato em que `fecharRepasse` hoje entrega `e.detalhe` (`components/hub/adiantamento-fechar-apuracao-dialog.tsx`).

**Nenhuma rota nova é criada.** `POST /repasse/:periodo/fechar` **permanece** no backend, intocada: D4 remove o **botão**, não a capacidade (FR-013 literal — *"a capacidade de fechar a apuração MUST permanecer no sistema, acionada apenas pela geração"*).

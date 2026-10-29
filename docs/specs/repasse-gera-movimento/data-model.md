# Data Model — `repasse-gera-movimento`

**Data**: 2026-10-28 · **Fase**: Phase 1 (plan)
**Migration desta frente**: **`0118`** — `infra/hub/migrations/0118_repasse_nota_a_emitir.sql`.
⚠️ **Nunca editar a `0117`** (migration já aplicada). A série é única e aditiva: migration aplicada não se reescreve, cria-se a próxima `NNNN` (`CLAUDE.md`).

> Prefixos: `MIG = infra/hub/migrations`, `BK = app_homologacao/backend`.
> Tudo o que está afirmado abaixo sobre o schema **atual** foi lido do repositório (medições M1–M9 de `research.md`).

---

## Entity: `ApuracaoRepasseItem` — **uma** coluna nova

Tabela criada em `MIG/0066_adiantamento_tabelas.sql:429`. Retrato **imutável** por motorista de uma semana de repasse.

### Coluna nova (a única mudança de schema desta frente)

| Campo | Tipo | Null | Default | Semântica |
|---|---|---|---|---|
| `nota_a_emitir` | `numeric(12,2)` | **SIM** | — (sem default) | Valor **final** da nota a emitir para o motorista nesta semana, **congelado** no fechamento: nota bruta da semana + saldo de nota carregado − dedução do pago por fora, **piso em 0**. `NULL` = empresa **sem** `categorias_nota` configurada ⇒ não há divisão ⇒ recusa `SEM_DIVISAO` |

`NULL` e **não** `0` de propósito: preserva a distinção *"não configurado"* × *"zero"* que o SQL já usa em `CASE WHEN cfg.categorias_nota IS NULL THEN NULL ELSE COALESCE(i.valor_nota,0) END` (`MIG/0117:1267`). `0` colidiria com o diagnóstico `VALOR_ZERO`, que é outra coisa (`BK/lib/adiantamento-geracao-movimento.js:14`).

`ADD COLUMN` **não é** `UPDATE`: os bloqueios de imutabilidade de `MIG/0066:460`–`:461`, `:463`, `:470`–`:478` (`REVOKE UPDATE, DELETE` + trigger `hub_bloqueia_alteracao_apuracao()`) não são tocados nem enfraquecidos — mesmo argumento que a `0117:673`–`:674` já registrou para `lancamentos_externos`.

### Colunas existentes que mudam de **conteúdo possível** (nenhuma muda de tipo nem de nome)

| Campo | Tipo atual | O que muda | Por que é seguro |
|---|---|---|---|
| `transportado_nota` | `numeric(12,2)` (`MIG/0098:54`) | Passa a poder ser **negativo**, carregando o **excedente** de pago por fora sobre a nota (D3) | **Não aparece** em nenhum CHECK. O `apuracaorepasseitem_saldo_conserva` (`MIG/0098:71`–`:81`) só amarra `valor_pago`, `valor_transportado`, `remanescente` e `saldo_anterior` |
| `saldo_anterior_nota` | `numeric(12,2)` (`MIG/0098:50`) | Passa a poder chegar **negativo** na semana seguinte (é a leitura do `transportado_nota` da apuração anterior) | Mesma razão; é coluna derivada por cópia, sem CHECK |

### Colunas que **não** mudam (e por quê — isto é requisito, não observação)

| Campo | Invariante |
|---|---|
| `valor_nota` | **Continua bruto.** Cinco funções vivas o leem (`research.md` M9), **duas são o app do motorista**, que já exibe `lancamentos_externos` em separado — netar aqui faria o app contar a dedução **duas vezes** |
| `valor_fora_nota`, `transportado_fora` | **Gorjeta intacta** (D2 literal). Nenhuma dedução a toca |
| `valor_pago`, `valor_transportado`, `remanescente`, `saldo_anterior` | O **livro do caixa** não muda nesta frente. `valor_transportado` negativo é **proibido** pelo CHECK, e com `remanescente < 0` o CHECK ainda **exige** `valor_transportado = saldo_anterior` |
| `lancamentos_externos` | Continua sendo o efeito **líquido** (negativo deduz, positivo soma), `NOT NULL DEFAULT 0` (`MIG/0117:675`) |

### Restrições — o que se toca e o que não

| Restrição | Ação |
|---|---|
| `apuracaorepasseitem_saldo_conserva` (`MIG/0098:71`–`:81`) | **NÃO ALTERAR.** É CHECK de conservação de dinheiro sobre tabela imutável. A `0117:682`–`:685` já se recusou a tocá-lo, pelo mesmo motivo. Esta é a razão pela qual o excedente é transportado no livro da **nota** e não no do **caixa** (`research.md` Decision 3) |
| CHECK novo para `nota_a_emitir` | **Nenhum.** `nota_a_emitir >= 0` seria tentador, mas a coluna é `NULL`-ável e o piso já é aplicado na expressão que a grava; um CHECK a mais numa tabela imutável é restrição sem requisito. A garantia vai por **teste** (identidade de conservação abaixo), não por DDL |

### Identidade de conservação — asserção de **teste**, não CHECK

Para cada item de uma apuração com `categorias_nota` configurada:

```
total_nota + saldo_anterior_nota
    = nota_a_emitir
    + (parcela de transportado_nota atribuível à nota da semana)
    + deducao_aplicada_na_nota
```

onde `deducao_aplicada_na_nota = LEAST(externos_deducao, GREATEST(total_nota + saldo_anterior_nota, 0))` e o **excedente** (`externos_deducao − deducao_aplicada_na_nota`) entra em `transportado_nota` com **sinal negativo**.

Não é CHECK porque envolve `externos_deducao`, que **não é coluna** do item — é um termo agregado da CTE `externos_cte` do fechamento (`MIG/0117:818`–`:827`), e o item guarda apenas o **líquido** em `lancamentos_externos`. Formalizar isso como CHECK exigiria materializar a dedução bruta numa coluna só para satisfazer a restrição: coluna nova sem consumidor.

---

## Entity: `ApuracaoRepasse` — **sem mudança de schema**

O que muda é **quem a cria**: hoje só a rota `POST /repasse/:periodo/fechar` (acionada pelo botão manual que D4 aposenta); passa a ser criada também — e, na prática, principalmente — pela própria rota de geração, via `rpc/hub_adiantamento_repasse_fechar`.

**Imutabilidade preservada integralmente** (`MIG/0066:460`–`:461`, `:463`, `:470`–`:478`). Consequência arquitetural registrada em `research.md` Decision 1: **não há rollback de fechamento**, nem para esta frente nem para nenhuma outra.

---

## Entity: `ApuracaoRepasseMovimento` (trilha) — **vira RESERVA, sem mudança de schema** (`dec-038` · `dec-040`)

Criada em `MIG/0092_apuracao_divisao_nota_e_trilha.sql:39`, com `CONSTRAINT apuracaorepassemovimento_uniq UNIQUE (apuracao_id, entregador_id)` (`:49`) e `COMMENT` que já a declara como a idempotência (`:52`–`:53`); policy de `INSERT` corrigida pela `MIG/0099:49`.

⚠️ **Mudança exigida pela resposta do operador a `block-001`** (opção B: *"a trilha tem de ser **reserva**, gravada **antes** do `POST EnvioMassa` — ou mecanismo equivalente que garanta idempotência real"*). O **mecanismo equivalente** vigente (`block-002` → `dec-040`) **não toca o schema desta tabela**.

### Por que a inversão literal e os outros desenhos não cabem (medido)

| Obstáculo medido | Onde |
|---|---|
| `envio_massa_id bigint NOT NULL` — sem o id não há como gravar a reserva antes da `EnvioMassa` | `MIG/0092:44` |
| `GRANT SELECT, INSERT` **e nada mais** — sem `UPDATE`/`DELETE`, deliberado (*"trilha imutável… mesma classe de `Auditoria`"*) ⇒ o `PATCH` de `dec-030` é **impossível** sem DDL e `GRANT` novos | `MIG/0092:63` · `MIG/0099:41`–`:44` |
| RLS com policies só de `SELECT` e `INSERT` | `MIG/0092:60`, `MIG/0099:49` |
| `GRANT USAGE, SELECT ON SEQUENCE "EnvioMassa_id_seq" TO authenticated` **já existe** ⇒ o cliente já pode alocar o id | `MIG/0033:197` |

### O que a `0118` faz — e o que **não** faz

**Não faz**: nenhuma DDL nesta tabela. **Zero** `ALTER`, **zero** `GRANT` novo, **zero** policy nova, **zero** `SECURITY DEFINER` novo, **zero** `DELETE`. A imutabilidade de `MIG/0099:41`–`:44` fica **intacta**.

**Faz**: cria a função `hub_repasse_alocar_envio_id() RETURNS bigint` (`LANGUAGE sql`, **`SECURITY INVOKER`**, `SELECT nextval('"EnvioMassa_id_seq"')`) — o PostgREST não chama `nextval` direto. ACL obrigatória (S5) em §Funções SQL afetadas.

### Fluxo, por motorista

```
rpc/hub_repasse_alocar_envio_id         → id            (INVOKER; sem privilégio novo)
POST ApuracaoRepasseMovimento { envio_massa_id: id, valor, gorjeta, … }
        └─ UNIQUE (apuracao_id, entregador_id) recusa o concorrente AQUI ⇒ JA_GERADO
POST EnvioMassa { …, id }                                ← o MESMO id
        └─ PK da EnvioMassa recusa a segunda conclusão ⇒ JA_GERADO
```

**Estado parcial decidível**: reserva cujo `envio_massa_id` **não existe** em `EnvioMassa` (leitura `EnvioMassa?id=in.(…)&id_empresa=in.(<grupo>)` — a tabela não tem RLS). O reacionamento **conclui** re-postando o mesmo id; **nunca apaga** a reserva. Sem DELETE, sem heurística de tempo, sem adivinhar se a reserva está "viva".

**O que muda de garantia**: hoje `jaGerados` é lido **uma vez** no começo da requisição (`BK/routes/hub-adiantamentos.js`), então duas requisições concorrentes leem a trilha vazia e **ambas** gravam ⇒ nota fiscal em dobro. Com a reserva, a segunda bate no `UNIQUE` **antes** de qualquer escrita em `EnvioMassa`; e duas conclusões concorrentes são serializadas pela PK.

**Trade-off declarado, e é o lado bom**: o estado parcial deixa de ser *linha de `EnvioMassa` órfã* — invisível e **duplicável** no retry — e passa a ser *reserva sem movimento*: **decidível** e **concluível**. É o princípio do briefing §9, *"uma guarda não pode exigir o que a ação não consegue desfazer"*.

**Limite declarado**: se alguém apagar uma `EnvioMassa` já gerada, a próxima geração a recria. Nenhum caminho do backend faz `DELETE` nela (medido 2026-10-28), embora `0033:192` conceda `DELETE`; a varredura P6 reconfere.

⚠️ **Desenhos descartados** (histórico em `plan.md` §O mecanismo da reserva do S1): `dec-030` (nullable + `GRANT UPDATE` por coluna + `PATCH`), `dec-034` (RPC `DEFINER` com `DELETE` da órfã) e a heurística de 5 minutos de `dec-035`.

**Consequências para a lógica de recusa**:
- `JA_GERADO` passa a vir também da **violação do UNIQUE** e da **violação da PK**, não só da leitura inicial (que continua como pré-filtro barato, agora separando `jaGerados` de `reservados`).
- Falha do `POST EnvioMassa` **depois** da reserva deixa reserva sem movimento — **concluída** na próxima tentativa, com o mesmo id.
- ⚠️ **ANTES desta frente** (defeito já **CORRIGIDO** na FASE 3 — não é bug vivo): a mensagem do `catch` em `:2321` (numeração de antes da correção) — *"nada foi gravado para este motorista"* — era **falsa** quando o `EnvioMassa` gravava e a trilha não. O operador exigiu o conserto junto (`block-001`). **Hoje**: `TEXTO_FALHA` (`lib/adiantamento-geracao-movimento.js:253`–`:256`) dá um texto verdadeiro por modo de falha; os textos estão em `plan.md` §S1.

---

## Entity: `EnvioMassa` — **sem mudança de schema**

Tabela **legada**, espelhada no ambiente isolado por `MIG/0033_schema_legado_envio_massa.sql:125`.

⚠️ **Não tem RLS alguma.** O filtro de `id_empresa` na query é a **única** proteção de tenant (BRIEFING §7, medido na frente `corrigir-valor`). Toda query desta frente que a toque leva filtro explícito — ver `research.md` Decision 8 e `contracts/hub-repasse-gerar-movimentos.md` §Tenant.

**Movimento só-com-gorjeta (FR-022, `dec-054`)**: quando a nota zera por dedução e há gorjeta, a linha gerada tem `valor = 0`, `gorjeta > 0` e `total = gorjeta`; `gorjeta` vai `NULL` só quando não há (como a planilha grava). É o **único** caso em que o hub grava `EnvioMassa.valor = 0` — o app do motorista a ignora (`valor=gt.0`, FR-023) e o lote não a cobra como nota (`0119`).

A linha gerada continua **indistinguível de uma linha de planilha** (decisão já vigente, registrada em `BK/routes/hub-adiantamentos.js:2170`–`:2171`): nada muda na FastAPI nem na validação de XML.

---

## State transitions

### Semana (do ponto de vista do financeiro)

```
sem apuração ──[Gerar do repasse]──> apuração fechada + movimentos criados
      │                                        │
      │                                        └──[Gerar de novo]──> JA_GERADO (nada criado)
      │
      ├──[pendências de adiantamento]──────> 409 ADIANTAMENTOS_PENDENTES (nada fechado, nada criado)
      ├──[antes do corte D-1]──────────────> 409 PERIODO_EM_ABERTO        (nada fechado, nada criado)
      └──[fora de ordem / sem config]──────> 409 APURACAO_FORA_DE_ORDEM | APURACAO_NAO_CONFIGURADA

apuração fechada SEM movimentos (falha no meio)
      └──[Gerar do repasse de novo]────────> completa os que faltam   ← NÃO é estado terminal
```

A **primeira** transição é o que não existe hoje: `BK/routes/hub-adiantamentos.js:2193` devolve `409 APURACAO_NAO_FECHADA` sempre que a apuração não existe, e é esse 409 que a frente remove.

A **última** transição é o coração de `research.md` Decision 1. O estado "apuração fechada sem movimentos" já era alcançável **antes desta frente** (a geração podia falhar no meio — `:2318`–`:2321` na numeração de **antes** da correção) e já é **retomável** — a trilha garante que a retomada não duplique. O que D4 temia ("travaria a geração sem caminho de volta pela tela") só acontecia porque o botão manual podia fechar a apuração **sem** gerar e a tela não oferecia o segundo passo em seguida. Com o botão aposentado e os dois atos na mesma rota, a própria rota é o caminho de volta.

### Saldo da nota entre semanas

```
semana N:    nota bruta + saldo_anterior_nota ── menos dedução ──> nota_a_emitir (piso 0)
                                                        │
                                      excedente (se houver) ──> transportado_nota  (NEGATIVO)
                                                                        │
semana N+1:                                            saldo_anterior_nota ◄──┘  (NEGATIVO)
                                                                        │
                                                 reduz a nota da semana N+1
```

⚠️ **Buraco a fechar explicitamente na `0118`**: a CTE `linhas` do fechamento só inclui um motorista quando ele tem atividade na semana **ou** `COALESCE(sa.valor_transportado, 0) > 0` (`MIG/0117:866`–`:867`). Um motorista com **apenas** `transportado_nota` negativo e `valor_transportado = 0` **não entraria** na semana seguinte — e a dívida da nota se perderia em silêncio. O predicado de inclusão precisa ganhar `OR COALESCE(sa.transportado_nota, 0) <> 0`. Sem isso, FR-007 e SC-005 falham no caso mais comum do D3 (dedução maior que a nota, nenhuma produção na semana seguinte).

---

## Funções SQL afetadas

| Função | Versão viva | Mudança em `0118` | Caminho |
|---|---|---|---|
| `hub_adiantamento_repasse_fechar(date)` | `MIG/0117:708` | Grava `nota_a_emitir`; aplica a dedução na parte da nota; transporta o excedente em `transportado_nota`; corrige o predicado de inclusão da CTE `linhas` | Tipo de retorno **não muda** ⇒ `CREATE OR REPLACE` preserva os GRANT |
| `hub_adiantamento_repasse(date, text, boolean, int, int)` (prévia) | `MIG/0117:942` | Devolve o **mesmo líquido** que a geração usará (SC-002) | Tipo de retorno **ganha coluna** ⇒ `DROP FUNCTION` + `CREATE FUNCTION` + `GRANT EXECUTE ... TO authenticated` (caminho documentado em `MIG/0117:690`–`:707`) |
| `hub_adiantamento_repasse_congelado(date, text, boolean, int, int)` | `MIG/0117:1253` | Idem — a semana já fechada tem de mostrar o mesmo número | Idem (DROP + CREATE + GRANT) |
| `hub_adiantamento_repasse_motorista()` | `MIG/0117` §8.3 | **NENHUMA** — app do motorista fora de escopo | — |
| `hub_adiantamento_repasse_motorista_ultimo_fechado()` | `MIG/0117` §8.5 | **NENHUMA** — idem | — |
| `hub_repasse_lote_avaliar(bigint[], int[])` | `MIG/0117` §9 | **`0119`** (`dec-054`): `nota_a_emitir` no `SELECT`; `NOTA_PENDENTE` não vale quando `nota_a_emitir = 0` (movimento só-com-gorjeta, FR-022). `NULL` → comportamento anterior | Assinatura e retorno iguais ⇒ `CREATE OR REPLACE` preserva o `GRANT` |
| `hub_adiantamento_repasse_pode_fechar(config, date, timestamptz)` | `MIG/0067:1891` | **NENHUMA** — o corte D-1 continua valendo e continua recusando (`PERIODO_EM_ABERTO`) | — |

**Três** das cinco funções vivas mudam na `0118` (a `0119` muda uma sexta, do lote); **duas** ficam intocadas, deliberadamente. A `0117:690`–`:707` é a nota de método a seguir — inclusive o aviso de que o `DROP` apaga a ACL antiga.

### ⚠️ S5 — ACL após `DROP FUNCTION`: **obrigatório, não deferível**

Exigência literal do operador em `block-001`: *"S5 (REVOKE ALL FROM PUBLIC após DROP FUNCTION) é OBRIGATÓRIO na 0118, não é deferível"*.

O `DROP`+`CREATE` **zera a ACL** e o default deixa `EXECUTE` aberto a `PUBLIC`. Cada `CREATE` de função (`DEFINER` ou `INVOKER`) nesta migration MUST ser seguido de **ambos**, nesta ordem — padrão que a `MIG/0067:2278`–`:2279` já usa:

```
REVOKE ALL     ON FUNCTION <nome>(<assinatura>) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION <nome>(<assinatura>) TO   authenticated;
```

**Teste de ACL**: `has_function_privilege('anon', '<nome>(<assinatura>)', 'EXECUTE') = false`, e `proacl` conferido antes/depois.
⚠️ `SET search_path = public, pg_temp` está **correto** (`pg_temp` por último) e é o padrão do repo — **não mexer**.
⚠️ São **três** funções criadas/recriadas a cobrir: prévia, congelado e a nova `hub_repasse_alocar_envio_id` (`SECURITY INVOKER` — o `REVOKE ALL ... FROM PUBLIC` vale igual, por consistência); `hub_adiantamento_repasse_fechar` repete o par por idempotência. Como a trilha **não** recebe grant por coluna neste desenho (`dec-038`), `has_function_privilege` basta e a armadilha do `has_table_privilege` com grant por coluna **não se aplica** aqui — o aviso fica registrado porque continua verdadeiro em geral.

⚠️ **Dívida nomeada** (já registrada em `research.md` Decision 5): após a `0118`, o app do motorista mostra a nota **bruta** + a linha de pago por fora em separado, e a tela do hub mostra a nota **líquida**. Os dois são verdadeiros; o vocabulário é que divergiu. Unificar é frente própria — e, pela lição de 23/09, exige **abrir a tela do app e mostrar onde o dado já aparece** antes de propor rótulo novo.

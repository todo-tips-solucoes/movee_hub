# Data Model — `lancamento-externo`

**Migration**: `infra/hub/migrations/0117_lancamento_externo.sql` · aplicada sem
erro no **`hub_homolog`** isolado (PG 13.23). Produção é do operador (FR-044).

---

## Entity: `LancamentoExternoTipo` (novo — tabela de domínio)

O **sinal mora aqui e em nenhum outro lugar**. É o que torna FR-012 verdadeiro
de forma estrutural: a linha de lançamento **não tem coluna de sinal** para
contradizer o tipo, logo um registro incoerente é impossível de representar —
mais forte que um CHECK, que permitiria escrever as duas colunas (só obrigaria
coerência).

| Campo | Tipo | Nulo | Notas |
|---|---|---|---|
| `codigo` | `text` | PK | `ADIANTAMENTO`, `AJUSTE_CREDITO` |
| `sinal` | `smallint` | NOT NULL | `CHECK (sinal IN (-1, 1))`; −1 deduz, +1 soma |
| `descricao` | `text` | NOT NULL | rótulo para o seletor da tela (FR-010) |

**Semeado**: `('ADIANTAMENTO', -1, …)`, `('AJUSTE_CREDITO', 1, …)` com
`ON CONFLICT DO NOTHING` (migration idempotente).

**FR-013 satisfeito**: tipo novo = **um INSERT**, sem DDL e sem redesenho do
modelo. Era a razão de D1. Um enum ou um `CHECK (tipo IN (…))` exigiria
`ALTER TYPE`/migration para cada tipo novo.

---

## Entity: `LancamentoExterno` (novo — append-only)

Padrão de armazenamento vigente (`0108_repasse_lote.sql:12-49`): chave
sequencial, empresa obrigatória, autoria, restrições **nomeadas**, índices
idempotentes.

| Campo | Tipo | Nulo | Notas |
|---|---|---|---|
| `id` | `bigserial` | PK | |
| `id_empresa` | `int` | NOT NULL | escopo; **resolvido do token**, nunca do corpo (FR-035) |
| `entregador_id` | `int` | NOT NULL → `Entregador(id)` | resolvido do CNPJ **no import** e gravado — ver nota abaixo |
| `cnpj_prestador` | `text` | NOT NULL | `CHECK (~ '^[0-9]{14}$')` — 14 dígitos após normalização (FR-005) |
| `data_pagamento` | `date` | NOT NULL | **quando o dinheiro saiu do caixa** (D4/FR-014) |
| `tipo` | `text` | NOT NULL → `LancamentoExternoTipo(codigo)` | o sentido vem daqui, por FK |
| `valor` | `numeric(12,2)` | NOT NULL | `CHECK (valor > 0)` — sempre positivo (D2/FR-006) |
| `observacao` | `text` | NULL | `CHECK (char_length <= 500)` (FR-008) |
| `criado_por` | `int` | NOT NULL → `Usuario(id)` | autoria |
| `criado_em` | `timestamptz` | NOT NULL `DEFAULT now()` | |

### Por que `entregador_id` é resolvido no import e gravado

Duas razões, a segunda é a que decide:

1. toda rodada de repasse pagaria um `JOIN` a mais se a resolução fosse no cálculo;
2. uma reconstrução futura do vínculo por similaridade de nome — como a `0093`
   já fez uma vez — mudaria **em silêncio** a entrada de uma apuração **já
   congelada**. Num retrato imutável isso é inaceitável.

O CNPJ fica gravado ao lado porque é **ele** a chave de idempotência (D6) e a
prova do que o financeiro digitou.

**Resolução** (FR-023/FR-025) — alcança no máximo um motorista por construção:

```sql
SELECT e.id FROM "Entregador" e
JOIN "ContaMotorista" cm ON cm.id = e.motorista_id
WHERE cm.cnpj_prestador = $1 AND e.id_empresa = ANY (v_escopo)
```

`ContaMotorista.cnpj_prestador` é `UNIQUE` (`0021:20`) e
`idx_entregador_motorista_id_unico` (`0021:57-58`) garante um vínculo único ⇒
**um mesmo CNPJ não pode produzir dedução duplicada**.

### Restrições e índices

| Nome | Papel |
|---|---|
| `lancamentoexterno_idempotencia_uniq` `UNIQUE (id_empresa, cnpj_prestador, data_pagamento, tipo)` | **FR-026-IDEMP** (D6): um de cada tipo, por motorista, por dia. Sem TTL — o efeito é dinheiro, logo permanente. É o que torna o reenvio do arquivo inteiro seguro (US3) |
| `lancamentoexterno_valor_positivo_chk` | FR-006 |
| `lancamentoexterno_cnpj_14_chk` | FR-005 |
| `lancamentoexterno_observacao_tam_chk` | FR-008 |
| `lancamentoexterno_data_piso_chk` `>= 2024-01-01` | FR-048, **piso só**. O teto (`hoje+1`) não entra em CHECK porque `now()` não é imutável — fica na borda e na função |
| `idx_lancamentoexterno_empresa_data_entregador (id_empresa, data_pagamento, entregador_id)` | **FR-042/SC-009**. Plano medido: `Index Scan`, 0,68% da tabela, 1,604 ms (research §6) |
| `idx_lancamentoexterno_entregador (entregador_id)` | FK sem índice é varredura na checagem de integridade (Supabase `schema-foreign-key-indexes`) |

**Teto por linha (R$ 5.000,00) NÃO está aqui** — é política, vive no leitor JS.
Justificativa em research §3.

### RLS e privilégios (FR-036)

A camada de dados é **pública** (PostgREST exposto), então o default é fechado:

```text
ENABLE ROW LEVEL SECURITY
POLICY lancamentoexterno_select_por_escopo FOR SELECT USING (id_empresa = ANY (hub_jwt_escopo_ids()))
GRANT SELECT TO authenticated
REVOKE INSERT, UPDATE, DELETE FROM authenticated
```

**Nenhum GRANT de escrita.** A única porta é
`hub_lancamento_externo_aplicar`, `SECURITY DEFINER`, com `REVOKE ALL FROM
PUBLIC` **antes** do `GRANT EXECUTE` — o par obrigatório da série
(`0100:164-165`, `0098:629-630`). A forma da política é a da casa, por medição
— ver research §9.

### State transitions

**Nenhuma.** A entidade é **append-only**: não se edita nem se exclui pela tela
nesta entrega (spec §Key Entities, §Fora de Escopo). Reenvio da mesma chave com
valor diferente é **recusado**, não atualizado (FR-028) — o sistema nunca
sobrescreve um lançamento.

---

## Entity: `ApuracaoRepasseItem` (existente — **um** campo novo)

| Campo | Tipo | Notas |
|---|---|---|
| `lancamentos_externos` | `numeric(12,2) NOT NULL DEFAULT 0` | efeito **líquido**, **já após** o gate de `desconto_adiantamentos`. Negativo deduz, positivo soma |

Por que existe, por que uma só e por que `DEFAULT 0`: research §8. Em resumo —
sem ela o item congelado teria `remanescente <> creditos - adiantamentos -
debitos` **sem explicação, para sempre**; e `DEFAULT 0` é o default seguro que
sustenta FR-021/SC-008 (quem não usa a feature tem aritmética byte-a-byte igual
à de hoje).

**Verificado**: nenhum `CHECK` liga `remanescente` às parcelas. Os únicos
constraints são `apuracaorepasseitem_entregador_uniq` (`0066:439`) e
`apuracaorepasseitem_saldo_conserva` (`0098:71-81`), que amarra
`remanescente + saldo_anterior = valor_pago + valor_transportado` e **não**
envolve as parcelas. Somar um 4º termo não viola nada.

`ADD COLUMN` não é `UPDATE`: os bloqueios de imutabilidade (`0066:443-470`) não
são tocados nem enfraquecidos.

---

## Entity: `AdiantamentoConfiguracao` (existente — **inalterada**)

Lida, nunca escrita. Campos que decidem nesta feature (valores de produção lidos
por `SELECT`, spec §Anexo):

| Campo | Produção | Uso aqui |
|---|---|---|
| `apuracao_dia_inicio` | `1` (segunda) | FR-015: a semana é derivada **daqui**, nunca fixa em código |
| `apuracao_dias_ate_repasse` | `3` | 25/10 + 3 = quarta **28/10** |
| `desconto_adiantamentos` | `t` | FR-022: gateia **só** o ramo de dedução |
| `desconto_debitos` | `t` | a 2ª fonte já ativa — a nova faz **três** |
| `repasse_valor_minimo` | `5.50` | piso sobre o qual `AJUSTE_CREDITO` opera (FR-018) |

---

## Funções (SQL)

| Função | Volatilidade | Papel |
|---|---|---|
| `hub_apuracao_semana_de(date, smallint)` → `date` | `IMMUTABLE STRICT` | início da semana que **contém** a data (FR-014/FR-015). Fórmula já existente 5× na série, agora com nome. **Provada**: 19–25/10 → `2026-10-19`; 26/10 → `2026-10-26` |
| `hub_lancamento_externo_aplicar(text, jsonb)` → `TABLE(idx int, situacao text)` | `SECURITY DEFINER` | única porta de escrita. Permissão, escopo do token, **mesma trava do fechamento** (FR-041), situação nomeada por linha |
| `hub_lancamento_externo_resumo(date)` → contagens | `STABLE SECURITY DEFINER` | alimenta o aviso de FR-049. **Só contagem e total** — nenhum dado identificável (FR-031) |

### Funções existentes alteradas (CINCO — corpo; tipo de retorno muda em QUATRO)

| Função viva | Mudança | Tipo de retorno | Como é recriada |
|---|---|---|---|
| `hub_adiantamento_repasse` (**`0100:26`**) | + `externos_cte`; termo no `remanescente`; + coluna `lancamentos_externos` | **muda** | `DROP` + `CREATE` + `GRANT` |
| `hub_adiantamento_repasse_fechar` (**`0098:111`**) | + `externos_cte`; termo no `remanescente`; grava `lancamentos_externos` no item | igual | `CREATE OR REPLACE` (GRANT preservado) |
| `hub_adiantamento_repasse_motorista` (**`0098:515`**) | + o mesmo termo, para o detalhe não divergir da prévia; + coluna | **muda** | `DROP` + `CREATE` + `GRANT` |
| `hub_adiantamento_repasse_congelado` (**`0100:172-232`**) | lê `lancamentos_externos` do item congelado; + coluna | **muda** | `DROP` + `CREATE` + `GRANT` |
| `hub_adiantamento_repasse_motorista_ultimo_fechado` (**`0098:639-681`**) | idem, para o app | **muda** | `DROP` + `CREATE` + `GRANT` |
| `hub_repasse_lote_avaliar` (**`0112`**) | **H1**: item cujo valor vem de crédito externo e sem produção não exige nota (ver §Inversão de invariante) | igual | `CREATE OR REPLACE` (GRANT preservado) |

⚠️ O `DROP` apaga a ACL (`0098:30`): cada `CREATE` é seguido de `GRANT EXECUTE … TO authenticated`, dentro da
mesma transação (`psql -1`). Versão anterior deste parágrafo dizia que "o tipo de retorno das três não muda" —
estava errado (eram cinco, e quatro mudam).

### Inversão de invariante (H1, rodada 2, decisão do operador 2026-10-23)

Até aqui valia **faturado ≥ pago**: todo valor a pagar vinha de produção, e produção gera `EnvioMassa` (a nota).
Um `AJUSTE_CREDITO` para motorista **sem produção** na semana quebra isso: `remanescente = valor_pago = crédito`,
e não existe movimento a notar. O lote exigia nota (`NOTA_PENDENTE`, `apta=false`) que o motorista **não tem
como emitir**. **Decisão**: crédito externo **não exige nota**. `hub_repasse_lote_avaliar` deixa de devolver
`NOTA_PENDENTE` quando `total = 0` (nenhum movimento) **e** `creditos = 0` (nenhuma produção no item) **e**
`lancamentos_externos > 0`. Semana **mista** (produção + crédito) continua exigindo a nota **da produção**, e o
lote paga o total (`valor_pago`). `ADIANTAMENTO` (dedução) **não muda**: a nota é da produção e o pagamento é
líquido.


## Constraints — o teto por linha NÃO é `CHECK` (dec-026)

O teto de R$ 5.000,00 por linha (FR-048, guard-rail de digitação) vive em `lib/lancamento-externo.js`
(`TETO_CENTAVOS`), nunca em `CHECK`. **Porquê**: uma violação de `CHECK` vira exceção de transação e
aborta o lote inteiro (F4), enquanto FR-030/FR-032 exigem recusa de LINHA com motivo nomeado
(`VALOR_ACIMA_DO_TETO`) sem derrubar as demais. O limite estrutural segue sendo `numeric(12,2)`.


## Rodada 3 (2026-10-23) — acréscimos

### `"LancamentoExternoExclusao"` (nova, append-only) — FR-056
Cópia da linha apagada + quem/quando excluiu, gravada **na mesma transação** do `DELETE` por `hub_lancamento_externo_excluir`.

| Coluna | Tipo | Nota |
|---|---|---|
| `id` | bigserial PK | |
| `lancamento_id` | bigint NOT NULL | o `id` que a linha TINHA (sem FK: ela deixou de existir) |
| `id_empresa`, `entregador_id` (FK `Entregador`), `cnpj_prestador`, `data_pagamento`, `tipo`, `valor`, `observacao` | espelho de `"LancamentoExterno"` | o valor que havia |
| `criado_por`, `criado_em` | int / timestamptz | autoria do lançamento original |
| `excluido_por` (FK `Usuario`), `excluido_em` | int / timestamptz DEFAULT now() | autoria da exclusão |

Rodada 4 (M8): **`REVOKE ALL` de `authenticated`** e sem policy de SELECT — a tabela guarda `cnpj_prestador`, nenhum leitor do produto a usa e o SELECT
por escopo anterior tinha gate mais fraco que a listagem. Única porta de escrita: a função; leitura: dono do banco (auditoria).

### Funções novas
`hub_lancamento_externo_liquido(int, date, AdiantamentoConfiguracao)` e `hub_lancamento_externo_semana_fechada(date, smallint)` — **internas** (sem `GRANT` a `authenticated`);
`hub_lancamento_externo_listar(date, text, int, int)` (rodada 4: ganhou `semana_fechada boolean`) e `hub_lancamento_externo_excluir(bigint)` (rodada 4: recusa excluir crédito que deixa o líquido negativo **quando há dedução de `LancamentoExterno` na semana a apagar antes**, `EXCLUSAO_DEIXA_LIQUIDO_NEGATIVO`; rodada 5) — `SECURITY DEFINER`, `GRANT EXECUTE` a `authenticated`.
`hub_lancamento_externo_aplicar` ganhou a coluna de retorno `liquido numeric` (preenchida só em `VALOR_EXCEDE_LIQUIDO`).

### Regra de líquido (FR-055)
`liquido = Σ créditos(extrato) − Σ adiantamentos(PAGA+EXPORTADA, se flag) − Σ débitos(se flag) + Σ créditos externos − Σ deduções externas(se flag)` da semana do motorista,
**antes** do saldo anterior e do piso. A conta é cópia da prévia; o driver afirma igualdade com o `remanescente` da prévia (paridade).

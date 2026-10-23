# Research — `lancamento-externo` (Phase 0)

**Feature**: `lancamento-externo` · **Spec**: [`spec.md`](./spec.md) · **Onda**: 003
**Constitution**: v1.1.0

Toda afirmação aqui é **medida**, com o comando e o resultado literal. O que não
foi medido está marcado como `[PROPOSTA]`. Nenhum número foi estimado
(Constitution — Veracidade de Dados).

Ambiente das medições de banco: **`hub_homolog` isolado** (`hub_homolog_db`,
PostgreSQL **13.23**), dentro da exceção standing `hub-*`. **Produção não foi
tocada em nenhum momento** — nem leitura.

---

## Decision 1 — Qual é a definição VIVA de cada função do repasse

**Decision**: a feature altera **três** funções, e nenhuma delas é a que a spec
aponta por número de linha em dois dos casos:

| Papel | Definição VIVA | Observação |
|---|---|---|
| Prévia / listagem | `hub_adiantamento_repasse(date,text,boolean,int,int)` — **`0100:26`** | `debitos_cte`:71 · `adiant`:81 · joins:113-114 |
| Fechamento | `hub_adiantamento_repasse_fechar(date)` — **`0098:111`** | `debitos_cte`:208 · `pagas`:222 · `linhas`:232 · `calc`:256 · piso:259 |
| Detalhe por motorista | `hub_adiantamento_repasse_motorista()` — **`0098:515`** | gate da flag dentro do corpo |

**Rationale**: a série redefine as mesmas funções várias vezes, e a redefinição
usa `DROP` + `CREATE FUNCTION` (não `CREATE OR REPLACE`) sempre que o tipo de
retorno muda. Logo, uma busca por `CREATE OR REPLACE FUNCTION` **não encontra**
as versões mais novas. Medido:

```text
$ grep -nE '^CREATE FUNCTION hub_adiantamento_repasse' infra/hub/migrations/*.sql
0083:268  0088:34  0098:321  0100:26        <- hub_adiantamento_repasse
0098:457  0100:174                          <- ..._congelado
0071:23   0098:515                          <- ..._motorista
```

**Consequência direta**: `0098:321-444` (a prévia definida na 0098; corpo entre o
`CREATE` da 321 e o `$$;` da 444, mais o par `REVOKE`/`GRANT` de `0098:447-448`)
é **código morto** — a `0100:24` dropa exatamente aquela assinatura e a
`0100:26` recria a função. A spec, em FR-022 e no Anexo, citava `0098:237` como
"prévia" e `0098:391` como "cálculo": os dois rótulos estavam **trocados**, e
`0098:391` está dentro da função morta. ⚠️ **Terceiro rótulo morto, achado na
onda-004**: FR-022 apontava o detalhe por motorista para `0071:104`, mas
`0098:513`/`0098:515` redefine `hub_adiantamento_repasse_motorista` — a `0071`
também é morta nesse ponto.

Os pontos VIVOS do gate `desconto_adiantamentos` são **três**, e só três
(medido: `grep -nE 'desconto_adiantamentos' 0071_*.sql 0098_*.sql 0100_*.sql`):
`0100:103` (prévia), `0098:237` (fechamento) e `0098:597`, no corpo de
`0098:515` (detalhe) — e é neles, e só neles, que o termo novo entra. Não existe
um quarto ponto "cálculo": esse era a prévia morta.

**Alternatives considered**: seguir os números da spec — rejeitado: produziria
uma alteração em função que não é executada, e a prévia (US2, SC-002) continuaria
divergindo do fechamento, que é justamente o defeito que a feature não pode ter.

---

## Decision 2 — Como a semana é derivada (o detalhe que mais pode errar dinheiro)

**Decision**: `apuracao_dia_inicio` é **`extract(dow)`** — domingo=0 … sábado=6 —
e a semana é `d - ((extract(dow FROM d) - dia_inicio + 7) % 7)`. Produção tem
`apuracao_dia_inicio = 1` ⇒ **segunda**.

**Rationale**: medido no esquema e no código, não suposto:

- `0066:92` — `CHECK (apuracao_dia_inicio IS NULL OR apuracao_dia_inicio BETWEEN 0 AND 6)`
- `0086:58` — o trigger valida com `extract(dow FROM NEW.periodo_inicio) <> v_dia_inicio`
- a fórmula já aparece **5 vezes**: `0071:66`, `0083:182`, `0088:291`, `0089:57`,
  e no comentário `0086:26`

`extract(dow)` ≠ `extract(isodow)` (nesta, segunda=1 e domingo=7). Trocar um pelo
outro desloca a semana e desconta o valor do período errado.

**Prova executada** (`hub_homolog`, helper novo, `dia_inicio = 1`):

```text
 2026-10-19 | Mon | 2026-10-19      2026-10-23 | Fri | 2026-10-19
 2026-10-20 | Tue | 2026-10-19      2026-10-24 | Sat | 2026-10-19
 2026-10-21 | Wed | 2026-10-19      2026-10-25 | Sun | 2026-10-19
 2026-10-22 | Thu | 2026-10-19      2026-10-26 | Mon | 2026-10-26
```

Os sete dias de **19–25/10** caem na semana `2026-10-19`, e 26/10 abre a semana
seguinte. É exatamente a semana que o operador vai fechar.

**Alternatives considered**: escrever a fórmula inline na função nova (6ª cópia)
— rejeitado; `date_trunc('week', d)` — rejeitado: fixa segunda em código e viola
FR-015, que exige derivar da configuração.

**Dívida NOMEADA, não paga**: as 5 cópias existentes continuam como estão.
Unificá-las obrigaria a redeployar 5 funções de dinheiro vivas sem nenhum
requisito pedindo, contra FR-021 (quem não usa a feature não vê diferença).

---

## Decision 3 — Teto de valor por linha: **R$ 5.000,00** (resolve a pendência 5)

**Decision**: R$ 5.000,00 por linha, com recusa nomeada
`VALOR_ACIMA_DO_TETO` citando o teto na mensagem.

**Rationale**: medição do operador no banco de produção (`SELECT` sobre os
adiantamentos pagos): **106 adiantamentos**, média **R$ 93,66**, p99
**R$ 361,12**, máximo **R$ 451,73**. O teto é **11× o máximo real já pago**.
Cumpre o propósito que FR-048 dá a ele — barrar o erro clássico de digitar
`15000` no lugar de `150,00` — sem barrar nenhum valor plausível. O limite
**estrutural** do domínio é outro e permanece: `numeric(12,2)` (`0066:13`).

**Onde o número mora**: **só no leitor JS**, como constante única. Não entra em
`CHECK`. Motivo: FR-048 define o teto como *guard-rail de digitação*, "não um
limite de negócio" — ou seja, uma política que pode ser recalibrada. Em `CHECK`
exigiria migration para mudar; e em `CHECK` a violação viraria exceção de
transação, não a **recusa de linha com motivo** que FR-030/FR-032 pedem (as
outras linhas do arquivo têm de ser aplicadas).

**Alternatives considered**: `CHECK (valor <= 5000)` — rejeitado (acima);
coluna em `AdiantamentoConfiguracao` — rejeitado: exigiria tela de **edição** de
configuração, que segue fora de escopo (FR-040; a rodada 3 abriu listagem e exclusão
de lançamento, FR-056/FR-057, não a edição de configuração).

---

## Decision 4 — Extração do núcleo de leitura XLSX (FR-050/FR-052)

**Decision**: núcleo novo `app_homologacao/backend/lib/xlsx-import-core.js`,
**parametrizado** e com **fábrica de erro injetada**:

```text
lerPlanilha(buffer, { cabecalhoEsperado, maxLinhas, erro })  ->  { linhas, date1904 }
conferirTetoZip(buffer, { maxEntradas, maxBytesDescomprimidos, erro })
XLSX_MIME
```

`adiantamento-retorno-transfeera.js` passa a ser uma chamada + o `map` que já
tem, preservando **byte a byte** sua superfície exportada:

```js
function lerXlsx(buffer) {
  return lerPlanilha(buffer, {
    cabecalhoEsperado: CABECALHO_ESPERADO,   // as 21 colunas, continuam aqui
    maxLinhas: MAX_LINHAS_RETORNO,
    erro: parseErro,                          // -> RetornoTransfeeraParseError
  }).linhas.map(normalizarLinha);
}
```

**Rationale**: a fábrica de erro injetada é o que evita hierarquia de classes e
re-embrulho. `routes/hub-adiantamentos.js:1515` faz
`e instanceof RetornoTransfeeraParseError` — com a fábrica, o objeto de erro
lançado continua sendo **exatamente a mesma classe com o mesmo `motivo`**, logo
o `instanceof` e todos os códigos de erro da rota em produção seguem idênticos.
O que fica duplicado de propósito (FR-050): a interpretação de cada coluna e os
motivos de recusa — os dois layouts não têm uma coluna em comum.

`{ linhas, date1904 }` em vez de só o array: o leitor novo precisa do epoch
(FR-046) e o do retorno simplesmente ignora o segundo campo.

**FR-052 — as opções de leitura não mudam.** Medido (spec §Anexo):
`bookProps: false` — o valor em uso em `:136` — é justamente o que **expõe**
`wb.Workbook.WBProps.date1904`; com `bookProps: true` o objeto `Workbook` não é
populado e o epoch fica ilegível. "Ligar as props do workbook para obter o
epoch" é o engano a evitar. As opções de `:136` são transportadas **sem uma
única alteração**.

**Achado novo desta onda** — `parse_date_code` **não está nos tipos
publicados**:

```text
$ grep -nE 'parse_date_code|date1904|WBProps|bookProps|cellDates' \
    node_modules/xlsx/types/index.d.ts
115: cellDates?: boolean;   227: bookProps?: boolean;   339: Workbook?: WBProps;
374: export interface WBProps;  385: WBProps?: WorkbookProperties;  397: date1904?: boolean;
```

`date1904` e `bookProps` são tipados; `parse_date_code` **não aparece** —
existe em runtime (medido na spec: `SSF keys: … parse_date_code …`) mas é
**não-tipado**. Consequência: a chamada é legítima (o backend é JS puro, sem
`tsc`), mas o retorno **não tem garantia de tipo** e o `null`-check de FR-046
é obrigatório, não defensivo-por-educação.

**Rede de não-regressão — nomes, não promessa.** A extração mexe em código em
produção desde 2026-10-22. Ordem obrigatória: medir **antes**, extrair, medir
**depois**, exigir números idênticos nestes três arquivos já existentes:

| Suíte | Papel |
|---|---|
| `tests/adiantamento-retorno-transfeera-unit.test.js` | contrato de cabeçalho, motivos, dedup |
| `tests/adiantamento-retorno-transfeera-arquivo-real.test.js` | fixture do arquivo real de 21 colunas |
| `tests/adiantamento-transfeera-xlsx-unit.test.js` | leitura/tetos do XLSX |
| `tests/hub-adiantamentos-rotas-unit.test.js` | a rota que faz `instanceof` do erro |

⚠️ **Gate que engana** (spec §Anexo, confirmado): `backend/package.json:8` lista
os arquivos de teste **um a um**. O arquivo de teste novo que não entrar na
lista **não roda**, e o verde fica oco.

---

## Decision 5 — `paraCentavos` arredonda calado: o gate de FR-047 vem ANTES dela

**Decision**: o critério de centavo exato roda **antes** de qualquer conversão,
e a célula **nativa** (número) é convertida por `Math.round(v * 100)` depois de
aprovada — nunca pela via de texto.

**Rationale**: achado desta onda, lendo `lib/adiantamento-remanescente.js:33-46`.
A função tem um fallback silencioso e, pior, a via normal **também** arredonda:

```js
const magnitude = Number(inteiro) * 100 + duasCasas + (terceiraCasa >= '5' ? 1 : 0);
```

Para `100.005`, `String(v)` casa o regex, `terceiraCasa === '5'` e o resultado é
**10001 centavos = R$ 100,01**. Isto é precisamente o que FR-047 proíbe: meio
centavo não é representável, a direção do arredondamento é convenção, não dado.
Se a conversão fosse delegada a `paraCentavos`, a linha seria **aceita com valor
alterado em silêncio** — em caminho de dinheiro.

Por isso FR-050 ("reusar `paraCentavos` por import") vale para a via de
**texto**, e a via **nativa** usa arredondamento exato após o gate. Os dois
concordam quando o gate passa; o que não pode é o gate vir depois.

**Critério, mantido como está (dec-018)**: `|v × 100 − round(v × 100)| <= 1e-6`.
A fronteira literal do "meio centavo" é instável em ponto flutuante — medido:
`100.005` dá delta `0.005000000000009663` (recusa) e `1234.565` dá
`0.004999999999881766` (aceita), **mesmo caso semântico, veredito oposto**. O
critério de erro de representação não tem essa instabilidade.

**Alternatives considered**: endurecer `paraCentavos` — **rejeitado**: ela é
compartilhada com o remanescente do adiantamento, onde `1.234` pode legitimamente
ser 1,234; mudá-la é alterar comportamento de código de dinheiro em produção sem
requisito que peça.

---

## Decision 6 — A CTE nova: onde entra, por que não colide, e o plano MEDIDO

**Decision**: CTE `externos_cte`, agregando por `entregador_id`, com as duas
direções separadas por `FILTER`:

```sql
externos_cte AS (
    SELECT l.entregador_id,
           sum(l.valor) FILTER (WHERE t.sinal < 0) AS deducoes,
           sum(l.valor) FILTER (WHERE t.sinal > 0) AS creditos
    FROM "LancamentoExterno" l
    JOIN "LancamentoExternoTipo" t ON t.codigo = l.tipo
    WHERE l.id_empresa = ANY (v_escopo)
      AND l.data_pagamento BETWEEN p_periodo_inicio AND v_fim
    GROUP BY l.entregador_id
)
```

e o termo entrando **uma vez**, no `remanescente`, antes do piso:

```sql
-- em `linhas` (mesmo lugar onde o gate da flag já existe — sem criar um quinto)
CASE WHEN v_config.desconto_adiantamentos THEN COALESCE(x.deducoes, 0) ELSE 0 END AS externos_deducao,
COALESCE(x.creditos, 0) AS externos_credito
-- em `calc`
(creditos - adiantamentos - debitos - externos_deducao + externos_credito) AS remanescente
```

**Por que não colide com `debitos_cte`** (as três razões que FR-042 exige):

| Risco | Por que não ocorre |
|---|---|
| Nome | `externos_cte` ≠ `debitos_cte` ≠ `adiant`/`pagas`; nenhum nome reaproveitado |
| Chave de junção | mesma chave (`entregador_id`), em `LEFT JOIN` próprio — a junção adicional não altera a cardinalidade das outras (a CTE já vem agregada, uma linha por entregador) |
| Dupla contagem | **impossível por construção**: `debitos_cte` lê `"FaturamentoLancamento"` com `tipo='Debito'`; `externos_cte` lê `"LancamentoExterno"`. São **tabelas diferentes**, e nenhum valor é gravado nas duas |

**Por que `AJUSTE_CREDITO` sai do gate da flag**: `desconto_adiantamentos`
significa "esta empresa não **desconta** adiantamento do repasse" (FR-022). Um
crédito não é desconto; zerá-lo com a flag retiraria do motorista um valor a
favor dele. Só o ramo `sinal < 0` é gateado.

**Por que isto satisfaz FR-018 de graça**: no fluxo vivo o `remanescente` é
calculado em `calc` e o piso é testado **depois** (`0098:256` → `0098:259`;
`0100` idem). Compondo o crédito dentro do `remanescente`, ele já está lá quando
o piso é testado — é exatamente D9 (R$ 4,00 + R$ 3,00 = R$ 7,00 ⇒ recebe).

### EXPLAIN — medido com as TRÊS fontes

Dado sintético (FR-043), **pessimista de propósito**: **229.467** linhas, 223
entregadores, 2024-01-01 → 2026-10-25, 60 MB. A realidade de produção é ~106
adiantamentos no total.

**(a) CTE nova isolada** — `EXPLAIN (ANALYZE, BUFFERS)`:

```text
HashAggregate (actual time=1.370..1.484 rows=222 loops=1)
  Buffers: shared hit=47
  ->  Hash Join (actual rows=1554)
        ->  Index Scan using idx_lancamentoexterno_empresa_data_entregador on "LancamentoExterno" l
              Index Cond: ((id_empresa = ANY ('{9001}'::integer[]))
                           AND (data_pagamento >= '2026-10-19')
                           AND (data_pagamento <= '2026-10-25'))
              Buffers: shared hit=43
        ->  Seq Scan on "LancamentoExternoTipo" t (actual rows=2)
Execution Time: 1.604 ms
```

**Índice usado, com `Index Cond` cobrindo a igualdade E a faixa.** Leu **1.554
de 229.467** linhas (**0,68%**) — sem varredura completa, que é o que SC-009
cobra. O `Seq Scan` é só na tabela de domínio de **2 linhas**, lida uma vez
para o hash.

**(b) As três fontes juntas**, com o `remanescente` de fato selecionado
(`creditos`, `debitos_cte`, `adiant`, `externos_cte` + `Entregador`):

```text
Hash Left Join (actual time=1.758..2.094 rows=222 loops=1)
  Buffers: shared hit=58
```

**2,094 ms** e **58 buffers** no total, 222 linhas. Cada fonte usa índice
próprio (`idx_faturamentolancamento_empresa_lancamento` nas de faturamento). O
`Seq Scan on "Entregador"` (222 linhas) é a forma que a função viva já tem
hoje — não é introduzido aqui.

> Medição descartada por honestidade: uma 3ª variante deu 0,108 ms porque as
> colunas das CTEs não eram selecionadas e o planner eliminou os `LEFT JOIN`
> como inúteis. Não serve de prova e não é citada como resultado.

**Índice, justificado**: `(id_empresa, data_pagamento, entregador_id)` —
igualdade primeiro, faixa depois, coluna de agrupamento ao fim, conforme o guia
Supabase (`query-composite-indexes`: *"place equality columns first, range
columns last"*). É exatamente a lacuna que `0066:224-225` deixou aberta e que
FR-042 proíbe repetir.

**Alternatives considered**: índice com `INCLUDE (valor, tipo)` para
*index-only scan* — rejeitado: com 1.554 linhas lidas e 47 buffers o ganho é
teatro, e `INCLUDE` aumenta o índice sem beneficiário medido. Reavaliar só se
uma medição futura mostrar o *heap fetch* dominando.

---

## Decision 7 — A primeira apuração da história é o único caminho que vai rodar

**Decision**: o desenho é validado **explicitamente** no caminho "primeira
apuração, sem anterior, com lançamento externo", e esse é o cenário obrigatório
do `quickstart.md`.

**Rationale**: fato medido pelo operador em produção — **`ApuracaoRepasse` tem
ZERO registros**, e `ApuracaoRepasseItem.valor_pago` também. Consequências,
cada uma verificada no código:

| Consequência | Verificação |
|---|---|
| Sem bloqueio de ordem | `0098:140` — *"Empresa sem nenhuma apuração: livre"*; `v_ultimo_periodo` vem `NULL` e o `IF` de `APURACAO_FORA_DE_ORDEM` não dispara |
| `saldo_anterior` = 0 | `v_apuracao_anterior_id` não existe ⇒ a CTE `saldo_ant` (`0098:227`) devolve 0 linhas ⇒ `COALESCE(sa.valor_transportado, 0)` = 0 |
| Ramo certo do CHECK | `apuracaorepasseitem_saldo_conserva` (`0098:71-81`): o item novo é gravado com `valor_pago NOT NULL`, logo cai no ramo **pós-regra**, e a conservação exigida é `remanescente + 0 = valor_pago + valor_transportado`. O ramo "item pré-regra" (`valor_pago IS NULL`) **não** se aplica |
| O CHECK não constrange as parcelas | verificado: **não existe** nenhum `CHECK` ligando `remanescente` a `creditos/adiantamentos/debitos`. Os únicos constraints da tabela são `apuracaorepasseitem_entregador_uniq` (`0066:439`) e `apuracaorepasseitem_saldo_conserva` (`0098:71`). Somar um 4º termo ao remanescente **não viola nada** |

**Risco que isto cria e que o plano assume**: o caminho de fechamento nunca
rodou em produção com dado real, e a feature entra justamente nesse primeiro
fechamento — **irreversível**. É por isso que o passo de **conferir a prévia
antes de fechar** é entregável (runbook §4), e não recomendação.

---

## Decision 8 — Rastro no item congelado: UMA coluna

**Decision**: `ApuracaoRepasseItem.lancamentos_externos numeric(12,2) NOT NULL
DEFAULT 0`, guardando o efeito **líquido** e **já após** o gate da flag
(negativo deduz, positivo soma).

**Rationale**: sem ela o item fechado teria
`remanescente <> creditos - adiantamentos - debitos` e a diferença ficaria **sem
explicação para sempre**, num retrato imutável. Uma coluna e não duas porque o
que entrou no remanescente é um número só; a proveniência por lançamento vai no
`detalhe jsonb` que a função já preenche (`0098:290` grava
`{'solicitacoesPagas': …}`).

`DEFAULT 0` é o default **seguro**: quem não usa a feature tem 0 e a aritmética
é a de hoje — é o que sustenta FR-021/SC-008. `ADD COLUMN` não é `UPDATE`: os
bloqueios de imutabilidade (`0066:443-470`, `REVOKE UPDATE, DELETE` + trigger)
não são tocados nem enfraquecidos, o que respeita a restrição da spec
(§Fora de Escopo) de não afrouxar CHECK existente.

**Alternatives considered**: dobrar o valor dentro de `adiantamentos`/`creditos`
— rejeitado: misturaria app com pago-por-fora e tornaria o congelado
inauditável (`adiantamentos` é exibido ao motorista junto da lista de
solicitações); duas colunas (dedução e crédito separadas) — rejeitado: o
remanescente recebe um termo só.

---

## Decision 9 — RLS: a forma "melhor" não compila com função que devolve array

**Decision**: a política nova usa a forma **da casa**,
`id_empresa = ANY (hub_jwt_escopo_ids())`.

**Rationale**: a intenção era aplicar o guia Supabase
(`security-rls-performance`: *"wrap functions in SELECT … Called once,
cached"*), que evita a avaliação por linha. **Medido ao aplicar a migration no
`hub_homolog`**:

```text
ERROR:  operator does not exist: integer = integer[]
HINT:   No operator matches the given name and argument types.
```

`hub_jwt_escopo_ids()` devolve `int[]`; `= ANY ((SELECT fn()))` é parseado como
a forma **subquery** de `ANY`, que compara o escalar com cada *linha* do
resultado — e a linha é um array inteiro. O exemplo do guia (`(select
auth.uid()) = user_id`) é igualdade escalar, não `ANY`.

Além disso o ganho não teria beneficiário aqui: **todo** caminho de leitura desta
entrega roda dentro de função `SECURITY DEFINER`, que **não passa por RLS** — tanto o
caminho quente (a CTE do repasse) quanto a listagem da tela, que a rodada 3 acrescentou
(FR-056/FR-057) e que vai por `hub_lancamento_externo_listar`, não por leitura direta de
tabela via PostgREST.

⚠️ A premissa original desta decisão era "esta entrega não tem tela de listagem", o que
deixou de ser verdade na rodada 3. A **conclusão** não mudou, mas o motivo é outro: não é
a ausência de tela, é o fato de a tela ler por função. Se algum dia a tabela for lida
direto pelo PostgREST, esta decisão tem de ser reavaliada.

**Dívida de repo registrada, não aplicada**: a forma correta para função que
devolve array é `id_empresa IN (SELECT unnest(hub_jwt_escopo_ids()))`. Aplicá-la
pontualmente só na tabela nova criaria divergência sem ganho; se algum dia valer,
vale para as ~10 políticas da série de uma vez, com medição.

---

## Decision 10 — Transporte do arquivo: na própria rota, nunca no parser global

**Decision**: `express.raw({ limit: '10mb', type: [XLSX_MIME] })` **na rota**,
igual a `routes/hub-adiantamentos.js:1471`.

**Rationale**: medido e já registrado na spec — o `express.json()` global de
100 KB roda **antes** de toda autenticação (`server.js:229`) e o módulo do
repasse só é montado depois (`:2970`). Subir o teto global tornaria qualquer
rota JSON grande alcançável e é precisamente o engano já catalogado no
`CLAUDE.md`. Tetos de verdade (32 MiB descomprimidos, 100 entradas de ZIP,
limite de linhas) seguem no núcleo de leitura, antes de o SheetJS tocar nos
bytes.

---

## Decision 11 — Documentação oficial consultada, e o que ela embasou

| Fonte | Status | O que embasou |
|---|---|---|
| **Supabase Postgres Best Practices** (skill `postgres-best-practices`) | consultada | `query-composite-indexes` → ordem das colunas do índice (Decision 6); `security-rls-performance` → a tentativa de InitPlan e a medição que a refutou (Decision 9); `security-privileges` (least privilege) → `GRANT SELECT` sem `INSERT/UPDATE/DELETE`; `schema-foreign-key-indexes` → índice próprio em `entregador_id`; `lock-advisory` → `pg_advisory_xact_lock` de transação (FR-041) |
| **SheetJS `xlsx@0.20.3`**, tipos instalados (`node_modules/xlsx/types/index.d.ts`) | consultada | `cellDates:115`, `bookProps:227`, `Workbook?:WBProps:339`, `WBProps:374`, `date1904:397` → FR-045/FR-046/FR-052; e o achado de que `parse_date_code` **não é tipado** (Decision 4) |
| `nodejs-backend-patterns`, `nextjs-app-router-patterns` (marketplace) | consultadas, **sem conteúdo aproveitável** | Medido: `SKILL.md` de 1.663 e 1.500 bytes, texto genérico ("apply relevant best practices and validate outcomes"), zero exemplo técnico. **Não embasaram nenhuma decisão** — seria desonesto citá-las. O fundamento das decisões de Node/Next veio dos padrões **vivos do próprio repo** (`hub-adiantamentos.js:1471` para upload, `page.tsx:207-238` para o PageHeader, `adiantamento-fechar-apuracao-dialog.tsx` para o diálogo), que é a fonte mais forte |
| `postgresql-optimization` | não consultada | `postgres-best-practices` já cobriu índice e plano, e a medição foi feita com `EXPLAIN (ANALYZE, BUFFERS)` real; uma segunda skill genérica não acrescentaria fato |

---

## Unknowns restantes

| # | Item | Status |
|---|---|---|
| 1 | Versão major do PostgreSQL de **produção** | `[PROPOSTA]` — medido só no isolado (**13.23**). Não foi lido em produção (regra: o agente não toca produção). Mitigação: o DDL da 0117 usa apenas recursos de PG ≤ 12 (`bigserial`, `numeric`, CHECK, FK, `UNIQUE`, RLS, `FILTER`, `jsonb_array_elements`, `pg_advisory_xact_lock`) — nada de PG 14+. O operador confirma ao aplicar |
| 2 | `ApuracaoRepasse` zerada **no momento do fechamento** | o fato é de 2026-10-22; se outra apuração for fechada antes de 19–25/10, o caminho "sem anterior" deixa de ser o que roda. O runbook manda reconferir imediatamente antes (§4) |

Nenhum `NEEDS CLARIFICATION` estrutural (linguagem, stack, arquitetura,
persistência, ambiente, tier) foi aberto: a feature vive inteiramente dentro da
stack já ratificada do hub.

## Higiene do banco de teste (`hub_homolog`)

A remoção do seed sintético de `"LancamentoExterno"` (229.467 linhas, CNPJ `900000000xxxxx`) é
**passo obrigatório antes de C1**, que parte de "nenhuma apuração/lançamento da empresa 6".
Comando de contagem: `SELECT count(*) FROM "LancamentoExterno"` (esperado **0**) e
`... WHERE cnpj_prestador LIKE '900000000%'` (esperado 0). Medido em 2026-10-22: 0 e 0 (seed já
removido). `"ApuracaoRepasse"` tem 1 linha (id 62, empresa 9001, dado de QA conhecido, não da 6).

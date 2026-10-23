# Quickstart / Cenários de Teste — `lancamento-externo`

Cenários executáveis derivados da spec. Fixtures **sintéticas** (FR-043): CNPJ
derivado de id (`lpad((90000000000000 + id)::text, 14, '0')`) e nomes fictícios —
o repositório é público.

Ambiente: `hub_homolog` isolado. **Produção nunca.**

---

## C1 — Primeira apuração da história, com lançamento externo (OBRIGATÓRIO)

> Este é o **único** caminho que vai rodar na quarta. `ApuracaoRepasse` tem
> **zero** registros em produção, logo a semana 19–25/10 é a primeira apuração
> fechada do sistema — e o fechamento é irreversível.

1. Garantir **nenhuma** apuração para a empresa (`SELECT count(*) FROM "ApuracaoRepasse"` → 0)
2. Motorista A com R$ 100,00 de crédito na semana de **2026-10-19**
3. Importar `ADIANTAMENTO` de R$ 30,00 para o CNPJ de A, data 2026-10-21
4. Fechar a apuração de 2026-10-19

**Expected**:
- repasse de A = **R$ 70,00**, diferença de **zero centavo** (SC-001)
- `saldo_anterior` = **0** (não há apuração anterior; `COALESCE` da CTE `saldo_ant`)
- fechamento **não** levanta `APURACAO_FORA_DE_ORDEM` — `0098:140`, "empresa sem nenhuma apuração: livre"
- item gravado com `valor_pago IS NOT NULL` ⇒ ramo **pós-regra** do
  `apuracaorepasseitem_saldo_conserva`, satisfazendo `remanescente + 0 = valor_pago + valor_transportado`
- `lancamentos_externos` = **−30,00** no item, explicando a diferença entre
  `remanescente` e `creditos − adiantamentos − debitos`
- nenhum outro motorista afetado

---

## C2 — Prévia e fechamento não divergem (US2, SC-002)

1. Importar `ADIANTAMENTO` de R$ 30,00 numa semana **aberta**
2. Abrir a prévia dessa semana **sem fechar nada**; anotar o valor a pagar
3. Fechar a apuração
4. Comparar com o valor congelado

**Expected**: os números são **idênticos**. E o lançamento **não** aparece na
prévia da semana seguinte.

> É o cenário que prova que a alteração foi feita na prévia **viva** (`0100:26`)
> e não na morta (`0098:321-444`). Se tivesse sido feita na morta, este teste
> falha e é o único que falha.

---

## C3 — Reenvio do arquivo inteiro é seguro (US3, SC-004)

1. Subir um arquivo com 10 linhas boas → `aplicadas: 10`
2. Subir **o mesmo** arquivo outra vez

**Expected**: `aplicadas: 0`, 10 × `JA_APLICADO`, e **zero** alteração de valor
de repasse.

### C3.b — mesma chave, valor diferente

1. Após C3, subir arquivo com a mesma chave e valor **diferente**

**Expected**: `VALOR_DIVERGENTE`, e o lançamento **original preservado** — o
sistema nunca sobrescreve (FR-028).

### C3.c — duas linhas idênticas no MESMO arquivo

**Expected**: uma `APLICADA`, outra `DUPLICADA_NO_ARQUIVO`. **Nunca somadas**
(FR-029).

---

## C4 — Boas e ruins no mesmo arquivo (SC-005, SC-006)

Arquivo com: 3 linhas boas · 2 CNPJ órfão · 1 linha em semana **já fechada** ·
1 valor `1.234` · 1 observação com 501 caracteres.

**Expected**:
- `aplicadas: 3`; as outras recusadas, cada uma com motivo nomeado
  (`CNPJ_SEM_MOTORISTA`, `SEMANA_JA_FECHADA`, `VALOR_AMBIGUO`,
  `OBSERVACAO_MUITO_LONGA`)
- **zero** CNPJ e **zero** nome em qualquer campo da resposta — asserção
  explícita sobre o JSON inteiro (FR-031)

---

## C5 — Célula nativa do Excel (FR-051: a matriz completa)

Fixtures **geradas pelo próprio SheetJS**, com célula nativa, nos quatro cruzamentos:

| # | `cellDates` na escrita | epoch | Expected |
|---|---|---|---|
| 1 | desligado | 1900 | data lida correta pelos componentes de calendário |
| 2 | ligado | 1900 | **a mesma** data — nunca deslocada em 1 dia |
| 3 | desligado | **1904** | a mesma data (o epoch é lido do arquivo) |
| 4 | ligado | 1904 | idem |

**Expected adicional**:
- serial `46309` **não** é lido como `2030-10-15` — o deslocamento de 4 anos e 1
  dia entre epochs é o modo de falha que FR-046 fecha
- célula `2026-10-15` **nunca** chega como `2026-10-14` (o erro de ler o dia por
  `toISOString()` num host a oeste de Greenwich)
- `parse_date_code` devolvendo `null` ⇒ `DATA_INVALIDA` (a API é **não-tipada**:
  o `null`-check é obrigatório)
- epoch ilegível ⇒ `EPOCH_ILEGIVEL`, nunca palpite

### C5.b — `bookProps` é o engano a evitar (FR-052)

**Expected**: teste que afirma que as opções de leitura contêm
`bookProps: false` e que `wb.Workbook.WBProps.date1904` é **legível**. Com
`bookProps: true` o objeto `Workbook` não é populado e toda linha com data
nativa cai em `EPOCH_ILEGIVEL`. O teste existe para que "ligar as props para
obter o epoch" falhe alto se alguém tentar.

---

## C6 — Valor em centavo exato (FR-047)

| Entrada (nativa) | Expected |
|---|---|
| `30` | aceita → 3000 centavos |
| `30.5` | aceita → 3050 |
| `100.005` | **`VALOR_FRACAO_DE_CENTAVO`** — meio centavo não é representável |
| `1234.565` | **recusada** pelo mesmo motivo (é o caso que a fronteira literal do "meio centavo" aceitaria por acidente de float) |
| `0.1 + 0.2` (`30.000000000000004`) | **aceita** → 3000 — é erro de representação, não perda de precisão |
| `0` / `-5` | `VALOR_INVALIDO` |
| `5000.01` | **`VALOR_ACIMA_DO_TETO`**, com o teto **nomeado** na mensagem |
| `5000.00` | aceita (o teto é inclusivo) |

> C6 é o **controle negativo** do critério: trocar
> `|v×100 − round(v×100)| <= 1e-6` pela comparação literal de meio centavo faz
> a linha `1234.565` passar. É esse teste que falha, e só ele.

---

## C7 — Crédito tira o motorista da retenção (US4, SC-007)

1. Motorista com remanescente de **R$ 4,00** e `repasse_valor_minimo` = **5,50** (retido)
2. Importar `AJUSTE_CREDITO` de **R$ 3,00** na mesma semana
3. Fechar

**Expected**: remanescente **R$ 7,00**, o motorista **recebe** (não é retido), e
a conservação de saldo do item continua válida.

> Cobertura real no driver (`C7`, `C7.b`, `FR-019`, previa **e** fechamento): 4,00+3,00 = 7,00 **recebe 7,00**;
> 4,00+1,00 = 5,00 retido com 5,00 transportado; 20,00−15,00 = 5,00 retido com 5,00 transportado — todos
> com `remanescente + saldo_anterior = valor_pago + valor_transportado`. (A versão anterior deste cenário
> semeava 4−10+3 = −3, que nunca tocava o piso: o título dizia uma coisa e o teste fazia outra.)

### C7.b — crédito insuficiente

Crédito que o deixa **abaixo** do piso ⇒ permanece retido, valor **transportado
integralmente** para a semana seguinte, sem perda de centavo.

### C7.c — os dois tipos na mesma semana

`ADIANTAMENTO` + `AJUSTE_CREDITO` para o mesmo motorista ⇒ sinais opostos
corretos, **derivados do tipo**, nunca do sinal do valor na planilha (D2).

---

## C8 — Três fontes somam, nenhuma substitui nem conta duas vezes (FR-016)

Motorista com adiantamento pelo **app**, débito de **faturamento** e lançamento
**externo** na mesma semana.

**Expected**: as três são deduzidas; nenhuma substitui outra; **nenhuma contada
duas vezes**. Asserção numérica:
`remanescente = creditos − adiant_app − debitos − externos_deducao + externos_credito`.

---

## C9 — Flag `desconto_adiantamentos` desligada (FR-022 + FR-049)

1. Desligar a flag na configuração do ambiente isolado
2. Importar `ADIANTAMENTO`; abrir a prévia; abrir o diálogo de fechamento

**Expected**:
- a dedução **não** é aplicada (a flag vale para as duas fontes, sem exceção)
- `AJUSTE_CREDITO` **continua** somando (crédito não é desconto)
- aviso visível **na prévia** e **na confirmação do fechamento**, nomeando que
  há valores pagos por fora que não serão descontados e **quantos** são
- o aviso **não bloqueia** e não revela nada identificável

---

## C10 — Erros de arquivo: nada aplicado

| Entrada | Expected |
|---|---|
| Cabeçalho fora do contrato | `400 CABECALHO_INVALIDO` + qual era o esperado; **zero** linha aplicada |
| Só cabeçalho, sem dados | `400 ARQUIVO_VAZIO` — **nunca** "0 aplicadas, sucesso" |
| Não-ZIP / ZIP sem diretório central / ZIP64 | `400 FORMATO_INVALIDO` |
| ZIP com > 100 entradas, ou > 32 MiB descomprimidos | `400 ARQUIVO_MUITO_GRANDE`, recusado **antes** de o SheetJS tocar nos bytes |
| `?tipo=QUALQUER_COISA` | `400 TIPO_INVALIDO`, nada gravado |
| Usuário sem `adiantamentos.pagamento_confirmar` | `403 PERMISSAO_NEGADA` |

---

## C11 — Concorrência com o fechamento (FR-041)

1. Abrir transação que chama `hub_adiantamento_repasse_fechar` e **segurar**
2. Em outra sessão, chamar `hub_lancamento_externo_aplicar` para a mesma semana

**Expected**: a segunda **espera** (mesma `pg_advisory_xact_lock(6,
hashtext('hub_adiantamento_repasse_fechar'))`) e, ao obter a trava com a
apuração já fechada, devolve `SEMANA_JA_FECHADA` — **nunca** grava um lançamento
que não terá efeito.

---

## C12 — Roundtrip End-to-End (obrigatório: borda backend ↔ frontend)

Chamada **real** ao backend do `hub_homolog`, sem mock e sem fixture de resposta.

1. Gerar XLSX pelo SheetJS com 2 linhas boas e 1 CNPJ órfão
2. `POST` real via o proxy `app/api/[...path]`, com cookie de sessão real
3. Capturar o payload **de resposta** e comparar o *shape* contra
   `contracts/import-lancamento-externo.md` §1

**Expected**: `{ aplicadas, ignoradas, ignoradasPorMotivo[{motivo,total}] }`
exatamente — chaves em `camelCase`, motivos em `SCREAMING_SNAKE`, e **nenhuma**
chave a mais.

> Razão de ser deste cenário: drift de convenção entre camadas só aparece contra
> o payload **real**; teste que parseia mock não o expõe.

---

## C13 — Não-regressão da extração (FR-050) — a ordem é parte do teste

1. **Antes de qualquer mudança**, rodar e **anotar** os números de:
   `adiantamento-retorno-transfeera-unit`, `…-arquivo-real`,
   `adiantamento-transfeera-xlsx-unit`, `hub-adiantamentos-rotas-unit`
2. Extrair o núcleo (movimento puro)
3. Rodar as **mesmas** quatro suítes

**Expected**: números **idênticos** aos do passo 1. Qualquer diferença pára a
extração — é código em produção desde 2026-10-22.

**Expected adicional**: `e instanceof RetornoTransfeeraParseError` continua
verdadeiro na rota (`hub-adiantamentos.js:1515`) e cada `motivo` segue com o
mesmo valor — é o que a fábrica de erro injetada preserva.

---

## C14 — Empresa sem lançamento externo não vê diferença (FR-021, SC-008)

1. Fechar uma apuração de empresa **sem nenhum** lançamento externo
2. Comparar com o resultado do comportamento atual

**Expected**: resultado **inalterado**, e `lancamentos_externos` = **0** em todos
os itens (o `DEFAULT 0` é o default seguro). Aritmética byte-a-byte igual à de
hoje.

## C15 / C15.b — o NEGATIVO de escopo (cenário permanente)

- **C15**: usuário de **outra empresa** (escopo sem a 6, ex.: 9001) chama `hub_lancamento_externo_aplicar`
  de ADIANTAMENTO para CNPJ de entregador do próprio escopo. Expected: exceção **`FORA_DE_ESCOPO`**,
  zero linha em `"LancamentoExterno"`, apuração da 6 inalterada.
- **C15.b**: usuário com escopo `[6, 9002]` e CNPJ de entregador da 9002. Expected: linha **`CNPJ_SEM_MOTORISTA`**
  (a resolução exige `e.id_empresa = 6`); nada gravado como empresa 6 para entregador alheio.
- Implementados em `infra/hub/testes/hub-lancamento-externo-integration.sh`, cada metade com controle negativo
  (`LE_NEG=escopo-1`, `LE_NEG=escopo-2`).

---

## C16 — O APP do motorista lê o MESMO valor (a 3ª função viva)

FR-022 nomeia **três** pontos onde o cálculo vive: prévia, fechamento e **detalhe por
motorista** (`hub_adiantamento_repasse_motorista()`, `0098:515`, o que o app do
motorista lê). Sem o termo nesta terceira, o motorista veria um remanescente e
receberia outro.

1. Motorista com crédito de **R$ 50,00** na semana em curso e `ADIANTAMENTO` externo de
   **R$ 15,00** na mesma semana
2. Chamar `hub_adiantamento_repasse_motorista()` com a claim `motorista_cnpj` dele

**Expected**: `remanescente` = **R$ 35,00** (nunca 50,00); e com crédito de 20,00 −
15,00 = **5,00** abaixo do piso 5,50 ⇒ `abaixo_do_minimo = true`.
Controle negativo: `LE_NEG=app-off`.

## C17 — O dia de início mudou DEPOIS do fechamento

`apuracao_dia_inicio` é editável. Se mudar depois de uma apuração, a semana derivada
hoje pode não coincidir com o `periodo_inicio` antigo — e a linha entraria numa semana
**já congelada**, sem efeito e sem aviso.

**Expected**: data dentro de `[periodo_inicio, periodo_fim]` de apuração fechada ⇒
`SEMANA_JA_FECHADA`, mesmo com a semana derivada diferente. Controle negativo:
`LE_NEG=contencao`.

## C10/SQL — As faixas valem NO BANCO também (dec-026)

A RPC `hub_lancamento_externo_aplicar` é chamável direto pelo PostgREST por quem tem
`pagamento_confirmar`, sem passar pelo leitor JS. As faixas valem aqui também, como
**recusa de linha** (mesmos tokens do JS), nunca exceção que aborte o lote:
data fora de `[2024-01-01, hoje+1]` → `DATA_FORA_DA_FAIXA`; valor ≤ 0 →
`VALOR_INVALIDO`; > R$ 5.000,00 → `VALOR_ACIMA_DO_TETO`; observação > 500 →
`OBSERVACAO_MUITO_LONGA`. Controle negativo: `LE_NEG=faixa-sql`.

## C3.c-bis — Reenvio de linha já aplicada em semana já fechada (H5, rodada 2)

A **idempotência vem ANTES da janela**: o reenvio de uma linha que **foi** aplicada, numa semana depois
fechada, devolve `JA_APLICADO` (FR-027). Antes devolvia `SEMANA_JA_FECHADA`, **byte a byte igual** ao de uma linha
nunca aplicada — o operador lia "perdi as 40", relançava na semana seguinte e o motorista era deduzido duas vezes.
Hoje `SEMANA_JA_FECHADA` significa, sem ambiguidade, "esta chave nunca foi aplicada". O driver cobre os três casos:
mesma chave + mesmo valor (`JA_APLICADO`), mesma chave + valor diferente (`VALOR_DIVERGENTE`, original mantido) e chave
nova em semana fechada (`SEMANA_JA_FECHADA`).

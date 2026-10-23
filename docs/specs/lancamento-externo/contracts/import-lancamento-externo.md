# Contract — Importar lançamentos pagos por fora

**Status**: `[PROPOSTA — a validar na implementação]`. A rota, a RPC e o resumo
**ainda não existem**; este contrato é projetado, não observado. O que é
**afirmado como real** aqui vem de fonte citada: o molde de transporte e de
resposta são os de `routes/hub-adiantamentos.js:1471` e `:1525-1586`, já em
produção.

---

## 1. `POST /api/v1/hub/adiantamentos/repasse/lancamentos-externos`

Aplica um arquivo XLSX de valores pagos por fora. `[PROPOSTA]`

### Transporte

| Item | Valor | Fonte |
|---|---|---|
| Content-Type | `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` | `XLSX_MIME`, constante única já existente |
| Body parser | `express.raw({ limit: '10mb', type: [XLSX_MIME] })` **na rota** | igual a `hub-adiantamentos.js:1471` — o `express.json()` global de 100 KB roda antes da autenticação (`server.js:229`) |
| Permissão | `adiantamentos.pagamento_confirmar` | FR-034/D10 — já pertence a `financeiro`, `financeiro_aprovador` e `admin_plataforma` desde a `0115`. **Nada a configurar antes do prazo** |
| Módulo | `requireModuloAtivo('adiantamentos')` | padrão das rotas vizinhas |
| Rate limit | o mesmo molde de `retornoRateLimiter` | import é operação humana e rara |
| Escopo | resolvido do **token** | FR-035, Constitution II (NON-NEGOTIABLE) |

### Query / body

| Param | Onde | Obrigatório | Valores |
|---|---|---|---|
| `tipo` | **querystring** | sim | `ADIANTAMENTO` \| `AJUSTE_CREDITO` |
| (arquivo) | body `raw` | sim | XLSX |

`tipo` vai na querystring porque o body **é** o arquivo. Ele vem da tela e vale
para o arquivo todo (FR-010): **não** é coluna da planilha.

### Layout da planilha (FR-001/FR-002) — contrato exato

5 colunas, nome e ordem exatos:

```text
CNPJ | Data do pagamento | Valor | Nome | Observação
```

`CNPJ`, `Data do pagamento`, `Valor` obrigatórios; `Nome` e `Observação`
opcionais. `Nome` é **ignorado** no casamento e **não aparece em nenhuma
resposta** (FR-004). Cabeçalho fora do contrato ⇒ **arquivo inteiro recusado**,
informando qual era o esperado, sem aplicar nenhuma linha.

### Resposta `200`

Molde idêntico ao já em produção (`hub-adiantamentos.js:1525-1586`):

```json
{
  "aplicadas": 37,
  "ignoradas": 4,
  "ignoradasPorMotivo": [
    { "motivo": "CNPJ_SEM_MOTORISTA", "total": 2 },
    { "motivo": "SEMANA_JA_FECHADA",  "total": 1 },
    { "motivo": "JA_APLICADO",        "total": 1 }
  ],
  "excedentes": [ { "linha": 7, "valor": "100.00", "liquido": "30.00" } ]
}
```

`excedentes` (rodada 3, ALTO 2 / FR-055): uma entrada por linha recusada com `VALOR_EXCEDE_LIQUIDO`, **no máximo 50** (a
contagem completa continua em `ignoradasPorMotivo`). `linha` = linha da **planilha** (cabeçalho = 1, logo `i + 2`). Só número da linha
e dois valores monetários — **nada identificável**. `[]` quando não há.

⚠️ **Nenhum CNPJ, nenhum nome, nenhum id de motorista sai daqui** (FR-031,
SC-006). É a mesma disciplina que o gate owasp de 2026-10-01 impôs neste
caminho, documentada em `hub-adiantamentos.js:1519-1524`: o campo cru trazia
nome completo de terceiros. **Só a contagem por motivo.**

⚠️ **O `motivo` é um token FECHADO e NUNCA carrega conteúdo de célula.**
Achado do gate owasp desta onda: o módulo do retorno da Transfeera **anexa** o
valor lido ao motivo (`VALOR_AMBIGUO:${rotuloStatus(linha.valorAmbiguoTexto)}`,
`adiantamento-retorno-transfeera.js:300`) — ali o campo é do parceiro, mas aqui
a planilha é do financeiro e a célula pode conter qualquer coisa, inclusive dado
de terceiro digitado na coluna errada. Nesta rota o motivo é **só o token**:
`VALOR_AMBIGUO`, nunca `VALOR_AMBIGUO:<texto da célula>`. Exceção única e
deliberada: `VALOR_ACIMA_DO_TETO` nomeia **o teto** (R$ 5.000,00) — que é
constante nossa, não dado do arquivo.

### Motivos de recusa — **de linha** (FR-032: nomeados e estáveis)

| Motivo | Quando | FR |
|---|---|---|
| `CNPJ_INVALIDO` | menos de 14 dígitos após remover máscara. **Célula NUMÉRICA** (coluna "Geral" do Excel perde o zero da frente: `00.000.000/0001-92` vira `192`) é recomposta com `padStart(14,'0')` ANTES do teste — nunca é recusa por truncamento. Célula de texto não é recomposta | FR-005 |
| `CNPJ_SEM_MOTORISTA` | CNPJ sem vínculo (população de órfãos conhecida) | FR-024/D8 |
| `DATA_INVALIDA` | texto não parseável, ou `parse_date_code` devolveu `null` | FR-046 |
| `DATA_FORA_DA_FAIXA` | fora de `[2024-01-01, hoje+1]` | FR-048 |
| `EPOCH_ILEGIVEL` | `date1904` não pôde ser lido do arquivo | FR-046 |
| `VALOR_INVALIDO` | não numérico, ou ≤ 0 | FR-048 |
| `VALOR_AMBIGUO` | `1.234` — ponto de milhar sem decimais (1000× de diferença) | FR-007 |
| `VALOR_FRACAO_DE_CENTAVO` | falhou `\|v×100 − round(v×100)\| <= 1e-6` | FR-047 |
| `VALOR_ACIMA_DO_TETO` | acima de **R$ 5.000,00** — mensagem **nomeia o teto** | FR-048 |
| `OBSERVACAO_MUITO_LONGA` | > 500 caracteres (sem truncar) | FR-008 |
| `SEMANA_JA_FECHADA` | a semana que contém a data já tem apuração | FR-020/D7 |
| `SEMANA_ANTERIOR_A_APURACAO` | a semana é anterior à PRIMEIRA apuração da empresa: passaria piso e teto mas nunca poderia ser fechada (`fechar` exige max+7), virando linha fantasma em tabela append-only (P3, rodada 1 do code review) | P3 |
| `VALOR_EXCEDE_LIQUIDO` | só `ADIANTAMENTO`, com `desconto_adiantamentos` ligada: o valor excede o **líquido disponível** do motorista na semana (créditos − adiantamentos − débitos − lançamentos externos já gravados), lido **no momento da linha** (ordem do arquivo). A resposta nomeia o valor e o líquido (`excedentes`). Avaliada **depois** de `JA_APLICADO`/`VALOR_DIVERGENTE`/`SEMANA_*` | FR-055 (rodada 3) |
| `JA_APLICADO` | mesma chave, **mesmo** valor | FR-027 |
| `VALOR_DIVERGENTE` | mesma chave, valor **diferente** — original preservado | FR-028 |
| `DUPLICADA_NO_ARQUIVO` | 2ª linha com a mesma chave no mesmo arquivo | FR-029 |

### Erros de **arquivo** (`400`, nenhuma linha aplicada)

```json
{ "erro": "ARQUIVO_INVALIDO", "motivo": "CABECALHO_INVALIDO", "esperado": ["CNPJ","Data do pagamento","Valor","Nome","Observação"] }
```

`motivo` ∈ `FORMATO_INVALIDO` · `CABECALHO_INVALIDO` · `ARQUIVO_VAZIO` ·
`ARQUIVO_MUITO_GRANDE` · `TIPO_INVALIDO`. `403 PERMISSAO_NEGADA`,
`409 APURACAO_NAO_CONFIGURADA`.

> `ARQUIVO_VAZIO` cobre o edge case "arquivo sem nenhuma linha de dados": é
> erro de arquivo com mensagem clara, **nunca** `0 aplicadas, sucesso`.

---

## 2. RPC `hub_lancamento_externo_aplicar(p_tipo text, p_linhas jsonb)`

Única porta de escrita (FR-036). **Existe** — criada pela `0117` e aplicada no
`hub_homolog`.

```text
RETURNS TABLE (idx int, situacao text, liquido numeric)   -- liquido: só preenchido em VALOR_EXCEDE_LIQUIDO
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
```

`p_linhas`: `[{ "i": 0, "cnpj": "90000000001001", "data": "2026-10-20", "valor": "30.00", "obs": null }, …]`
— só linhas que já passaram por **toda** a validação de borda.

`situacao` ∈ `APLICADA` · `CNPJ_SEM_MOTORISTA` · `SEMANA_JA_FECHADA` · `SEMANA_ANTERIOR_A_APURACAO` · `DATA_INVALIDA` · `VALOR_INVALIDO` · `VALOR_FRACAO_DE_CENTAVO` ·
`JA_APLICADO` · `VALOR_DIVERGENTE` · `VALOR_EXCEDE_LIQUIDO` (+ `DATA_FORA_DA_FAIXA` · `VALOR_ACIMA_DO_TETO` · `OBSERVACAO_MUITO_LONGA`, ver §1).

**Garantias**:

- permissão `adiantamentos.pagamento_confirmar` ou `PERMISSAO_NEGADA`;
- escopo de `hub_jwt_escopo_ids()`, nunca do argumento;
- **FR-041** — `pg_advisory_xact_lock(6, hashtext('hub_adiantamento_repasse_fechar'))`,
  **a mesma trava** do fechamento (`0098:135`). Sem ela o fechamento poderia
  congelar o retrato entre a checagem "semana aberta" e o `INSERT`, gravando um
  lançamento que nunca teria efeito. Lock de transação: some no `COMMIT`/`ROLLBACK`;
- `p_tipo` fora do domínio ⇒ `TIPO_INVALIDO`, **nada gravado** (é erro de
  arquivo, não de linha — o tipo vale para o arquivo todo).

---

## 3. RPC `hub_lancamento_externo_resumo(p_periodo_inicio date)`

Alimenta o aviso de FR-049. **Existe** (`0117`).

```text
RETURNS TABLE (qtd_deducao int, total_deducao numeric(12,2),
               qtd_credito int, total_credito numeric(12,2),
               flag_desconto_ligada boolean,
               qtd_negativo int, total_negativo numeric(12,2))   -- rodada 4 (A2)
```

`qtd_negativo`/`total_negativo`: motoristas com lançamento por fora na semana cujo líquido está NEGATIVO agora e o total que não seria
pago nem transportado (0 para quem não alcança a empresa 6). A rota os devolve como `qtdNegativo`/`totalNegativo`.

Só contagem, total e o estado da flag. Nenhum dado identificável (FR-031).

**Garantias**:

- permissão **`adiantamentos.pagamentos_consultar`** ou `PERMISSAO_NEGADA` — a
  **mesma** da rota da prévia (`routes/hub-adiantamentos.js:1659`), **não**
  `pagamento_confirmar`. ⚠️ A `0117` nasceu exigindo `pagamento_confirmar`
  (gate dentro do corpo da função): quem abrisse a prévia com a permissão mais
  fraca receberia erro em vez do aviso, e FR-049 proíbe falhar calado. Resolvido
  em dec-036; **execute-task MUST alterar o gate** e provar as duas metades
  (quem tem só `pagamentos_consultar` **vê** o aviso; quem não tem nem essa
  **não** alcança a tela). Degradar o aviso foi rejeitado;
- escopo de `hub_jwt_escopo_ids()`, nunca do argumento;
- `STABLE SECURITY DEFINER` com `search_path` pinado e `REVOKE ALL FROM PUBLIC`
  antes do `GRANT EXECUTE` (`0117:328-329`).

### Onde o aviso de FR-049 aparece — os **dois** momentos

| Momento | Local exato | Condição |
|---|---|---|
| Prévia do repasse | aba Repasse, acima da tabela | `qtd_deducao > 0 AND flag_desconto_ligada = false` |
| Confirmação do fechamento | `components/hub/adiantamento-fechar-apuracao-dialog.tsx` (bloco de aviso já existente, `:97-118`) | idem |

Texto: nomeia que **existem valores pagos por fora que NÃO serão descontados** e
**quantos são**. **Não bloqueia** a operação (FR-049) e não revela nada
identificável. São os dois momentos em que alguém decide sobre o dinheiro
daquela semana — e o repo nunca falha calado.

Hoje em produção `desconto_adiantamentos = t`, logo o aviso fica **inerte**; ele
existe porque a flag é editável pela tela de Configurações.

---

## 3b. Listagem e exclusão (rodada 3 — autorizadas pelo operador em 2026-10-23; FR-056/FR-057)

**`GET /api/v1/hub/adiantamentos/repasse/lancamentos-externos?periodo=YYYY-MM-DD[&busca=][&offset=][&limite=]`** — gate
`adiantamentos.pagamentos_consultar`. `limite` 1..200 (default 50), `offset` ≥ 0, `busca` ≤ 100 caracteres (nome, sem acento/caixa).

```json
{ "total": 8, "itens": [ { "id": 7, "motorista": "Nome", "tipo": "ADIANTAMENTO", "sinal": -1, "dataPagamento": "2026-09-17",
    "valor": "30.00", "observacao": null, "criadoEm": "...", "criadoPor": "Fin", "excluivel": true } ] }
```

⚠️ **Sem CNPJ.** O motorista aparece pelo nome. `excluivel` é **dica de tela** (permissão de escrever **e** semana aberta); quem decide é a exclusão.
RPC: `hub_lancamento_externo_listar(p_periodo_inicio date, p_busca text, p_offset int, p_limite int)`, `SECURITY DEFINER`, escopo do token.

**`DELETE /api/v1/hub/adiantamentos/repasse/lancamentos-externos/:id`** — gate `adiantamentos.pagamento_confirmar` (a mesma da importação).

| HTTP | Corpo | Quando |
|---|---|---|
| 200 | `{ "excluido": true, "id": 7 }` | excluiu |
| 400 | `ID_INVALIDO` | `:id` não é inteiro positivo (≤ 15 dígitos) |
| 403 | `PERMISSAO_NEGADA` / `FORA_DE_ESCOPO` | sem permissão / escopo sem a empresa 6 |
| 404 | `LANCAMENTO_NAO_ENCONTRADO` | não existe (talvez já excluído) |
| **409** | **`SEMANA_JA_FECHADA`** | 🔴 a semana do lançamento já foi fechada: **nunca** se exclui (o valor está congelado) |
| **409** | **`EXCLUSAO_DEIXA_LIQUIDO_NEGATIVO`** | rodada 4 (A1): excluir este **crédito** deixaria o líquido do motorista negativo **e existe um lançamento de dedução (deste módulo) que o operador pode apagar**; apague a dedução primeiro. Rodada 5 (C3): dedução do app e débito de faturamento não contam — não são apagáveis aqui |
| 409 | `APURACAO_NAO_CONFIGURADA` | — |

RPC `hub_lancamento_externo_excluir(p_id bigint)` → `(lancamento_id, tipo_excluido, valor_excluido, data_excluida)`. Mesma trava do fechamento
(`pg_advisory_xact_lock(6, hashtext('hub_adiantamento_repasse_fechar'))`); grava a cópia em `"LancamentoExternoExclusao"` **na mesma transação**
(`lancamento_id, id_empresa, entregador_id, cnpj_prestador, data_pagamento, tipo, valor, observacao, criado_por, criado_em, excluido_por, excluido_em`).
Depois de excluir, **a mesma chave volta a poder ser importada** (`APLICADA`).

---

## 4. Convenções de borda deste contrato

| Camada | Case | Validação | Fonte da verdade |
|---|---|---|---|
| Colunas do banco | `snake_case` | CHECK + FK na migration | `infra/hub/migrations/0117_*.sql` |
| Cabeçalho da planilha | rótulo humano PT-BR, **exato** | comparação por contrato, antes de ler linha | este arquivo, §1 |
| Payload da RPC (`p_linhas`) | chaves curtas `i/cnpj/data/valor/obs` | montado pelo backend, nunca pelo cliente | `lib/lancamento-externo.js` `[PROPOSTA]` |
| Resposta HTTP | `camelCase` (`ignoradasPorMotivo`) | molde já em produção | `hub-adiantamentos.js:1525-1586` |
| Motivos de recusa | `SCREAMING_SNAKE` | enum fechado | §1 deste arquivo |

**Mapper**: não há ORM (o backend fala HTTP com PostgREST). A conversão
planilha → payload da RPC é explícita no leitor novo. Sem Zod no backend (não é
o padrão do repo); a validação é o próprio leitor, com modo de falha **fechado**.

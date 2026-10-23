# Lançamentos pagos por fora do sistema — decisões e medições

Frente aberta em 2026-10-22 a pedido do financeiro. O briefing do ciclo é
`docs/briefing.md`; este arquivo guarda as **decisões do operador** e o que foi
**medido no código**, para a próxima sessão não precisar redescobrir.

## 🔴 O prazo é o FECHAMENTO, não o pagamento

A dedução acontece no fechamento da apuração (`hub_adiantamento_repasse_fechar`,
`0098:218-222`), que grava retrato **imutável** em `ApuracaoRepasseItem`. A semana
19–25/10 fecha a partir de **26/10** e paga em **28/10**. Lançar depois do fechamento
**não tem efeito**.

## As 12 decisões do operador (22/10)

| # | Decisão | Observação |
|---|---|---|
| 1 | Tabela **nova e genérica**, não `AdiantamentoSolicitacao` | *"posso usar essa feature para inputar outros valores pagos por fora"* |
| 2 | **Dois sentidos**, sinal derivado do **TIPO**; valor na planilha sempre **positivo** | evita erro de sinal digitado; CHECK garante tipo↔sentido |
| 3 | A dedução **soma as duas fontes** no fechamento (`0098`) e na prévia (`0100`) | caminho do dinheiro |
| 4 | A semana é a que **contém a data do pagamento** | ⚠️ diferente do app, que usa `data_producao = data_solicitacao - 1` |
| 5 | Casa por **CNPJ do prestador** | não por nome (homônimos), não por id |
| 6 | Idempotência por **empresa + CNPJ + data + TIPO** | um de cada tipo por dia |
| 7 | Semana já fechada ⇒ **recusa só a linha**, nomeando | aplica as demais |
| 8 | CNPJ órfão ⇒ **recusa só a linha**, contando por motivo | ⚠️ o CNPJ **não** volta na resposta |
| 9 | `AJUSTE_CREDITO` entra **antes** do teste do saldo mínimo (R$ 5,50) | quem tinha 4,00 + 3,00 passa a receber |
| 10 | Permissão **`adiantamentos.pagamento_confirmar`** | o financeiro já tem (0115); nada a configurar |
| 11 | **Só** o botão na aba Repasse + diálogo | nenhuma outra tela sem nova aprovação. ⚠️ **Superada com aprovação na rodada 3 (2026-10-23)**: o operador autorizou o diálogo "Ver pagos por fora" (listagem + exclusão, FR-056/FR-057) e a parcela "pago por fora" na prévia/app (FR-053); continua valendo para **qualquer outra** tela |
| 12 | O `ADIANTAMENTO` externo **respeita** `desconto_adiantamentos` | ⚠️ risco aceito: ver abaixo |

### ⚠️ O risco que a decisão 12 aceita, e a mitigação

Com `desconto_adiantamentos = false`, **nem** o adiantamento do app **nem** o pago por
fora descontam — a empresa paga o repasse cheio a quem **já recebeu**, ou seja, paga duas
vezes. O operador escolheu a coerência (a flag significa "esta empresa não desconta
adiantamento", sem exceção).

**Mitigação, que não muda a regra:** quando houver lançamento externo de dedução numa
semana cuja flag está desligada, a tela **avisa**. Padrão do repo: nunca falhar calado.

## O layout aprovado — 5 colunas

O **Tipo não entra na planilha**: é escolhido na tela e vale para todo o arquivo.

| Coluna | Obrigatória | Formato |
|---|---|---|
| `CNPJ` | sim | 14 dígitos, com ou sem máscara |
| `Data do pagamento` | sim | `DD/MM/AAAA` |
| `Valor` | sim | `1.234,56`, sempre positivo |
| `Nome` | não | só para conferência; **ignorada** e **não** volta na resposta |
| `Observação` | não | texto livre, até 500 |

## Medições que corrigem suposições

- ⚠️ **O reuso dos helpers exige EXTRAÇÃO, não import** (achado da onda-001, dec-009): dos
  três que o briefing manda reusar, só **`lerXlsx` é exportado**; `conferirTetoZip` é
  interna (`:91`) e `paraCentavos` vive em `lib/adiantamento-remanescente.js`. E
  `lerXlsx:160` compara contra o cabeçalho **de 21 colunas da Transfeera**. Afirmar reuso
  sem conferir os exports foi erro de quem escreveu o briefing.
- ✅ **CNPJ → entregador é 1:1 provado** (`0021:20` UNIQUE + `0021:57-58` índice único):
  **não existe** CNPJ ambíguo capaz de duplicar dedução. A decisão 8 cobre 100% dos
  desvios.
- ✅ **O ponto de enxerto preserva o CHECK** (dec-010): somar nos termos **existentes**
  (`adiantamentos`/`creditos`), nunca um termo novo fora da identidade
  `remanescente + saldo_anterior = valor_pago + valor_transportado`
  (`apuracaorepasseitem_saldo_conserva`, `0098:71-81`). E `calc` (`0098:264`) roda **antes**
  de `resultado` (`0098:266-282`), então a decisão 9 é satisfeita **por construção**.
- ⚠️ **Não reusar `ImportacaoArquivo`** (dec-011): enum fechado, processor de 2 tabelas e
  mutex de 1 ativa por tipo — o repo já rejeitou isso por escrito. Reusar só o **padrão de
  resposta** `{aplicadas, ignoradas, ignoradasPorMotivo}`.
- ⚠️ **`debitos` não serve**: vem de `FaturamentoLancamento` com `tipo='Debito'` e a flag
  `desconto_debitos` é `DEFAULT false`.
- ⚠️ **`xlsx@0.20.3`: `cellDates` é `false` por default** e `CellObject.v` pode ser
  `number | Date` — a planilha preenchida no Excel **não** chega como texto.

## Pendência do operador

O valor vigente de `apuracao_dia_inicio` em produção (`bash ~/consultar-config-apuracao.sh`).
Esperado `1` (segunda), porque 19/10/2026 é segunda. Não bloqueia o desenho — a função lê
da config e o dia **nunca** é fixado em código —, mas bloqueia o fechamento na segunda.

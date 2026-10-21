# Data Model: retorno-transfeera-xlsx

Feature stateless: **nenhuma tabela, coluna, RPC, permissao ou migration**. Entidades da spec sao estruturas em memoria.

## Entity: Linha de retorno (saida de `lerXlsx`)
| Campo | Tipo | Origem (coluna do XLSX) | Notas |
|-------|------|-------------------------|-------|
| idIntegracao | string | `ID integração` (F) | `String(v).trim()`; casado por `^(ADV\|REP)-(\d+)$` |
| status | string | `Status` (E) | `trim`, caixa exata |
| statusConhecido | boolean | derivado | `STATUS_CONHECIDOS.has(status)` |
| valorCentavos | integer \| null | `Valor` (A) | `paraCentavos`; `null` se vazio ou nao finito |
| motivoFalha | string | `Motivo` (G) | literal; sem traducao |

## Entity: Item do lote (entrada de `casarComItensDoLote`) — inalterado
`{solicitacaoId, colIdIntegracao, situacao, valorCentavos}`.

## Saida do casamento — inalterada
`{aplicaveis[{solicitacaoId,status,motivo}], ignoradas[{idIntegracao,motivo}], faltantes[]}`. Unica mudanca: o sufixo de `STATUS_DESCONHECIDO:<valor>` e saneado (<= 40 chars, `[\p{L}\p{N} ._-]`).

## Estados do lote: sem mudanca (`incluido` -> pago/falhou pela RPC existente).

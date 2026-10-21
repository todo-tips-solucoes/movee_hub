# Contrato: POST retorno do lote (adiantamento e repasse)

Contrato EXISTENTE com o corpo alterado; fonte: `routes/hub-adiantamentos.js:1471` e `routes/hub-repasse-lotes.js:523` (lidas nesta onda). A resposta de sucesso NAO muda.

| | Adiantamento | Repasse |
|---|---|---|
| Rota (via proxy `/api`) | `POST /adiantamentos/lotes/:id/retorno` | `POST /adiantamentos/repasse/lotes/:id/retorno` (`REPASSE_LOTES` em `adiantamentos-api.ts:765`) |
| Prefixo de ID | `ADV-<n>` | `REP-<n>` |
| Permissao | `adiantamentos.pagamento_confirmar` + modulo `adiantamentos` | idem |

## Request (MUDA)
- `Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` (unico aceito); corpo = bytes do `.xlsx`, <= 10 MB.
- Antes: `text/csv` | `text/plain` com string. Agora esses tipos -> 400 `FORMATO_INVALIDO`.

## Respostas
- **200** `{aplicadas:number, ignoradas:number, ignoradasPorMotivo:[{motivo,total}]}` — INALTERADO. `motivo` pode ser `ID_INTEGRACAO_INVALIDO | NAO_PERTENCE_AO_LOTE | JA_APLICADO | VALOR_DIVERGENTE | STATUS_DESCONHECIDO:<valor saneado, <=40>`.
- **400** `{erro:'ARQUIVO_INVALIDO', motivo}` com `motivo` em `FORMATO_INVALIDO` (novo) | `ARQUIVO_VAZIO` | `CABECALHO_INVALIDO` | `ARQUIVO_MUITO_GRANDE` | `LINHA_DUPLICADA`.
- **409** `{erro:'RETORNO_INCOMPLETO', faltantes:[...]}` — inalterado (nada aplicado se faltar item).
- **404** lote inexistente/fora do escopo; **403/401** por permissao/sessao; **413** corpo > 10 MB (HTML do Express).

## Cabecalho do arquivo (21 colunas, nome e ordem exatos — copiado da fixture)
`Valor, Favorecido, Comprovante Transfeera, Comprovante Banco, Status, ID integração, Motivo, CPF ou CNPJ, Email, Banco, Agência, Conta, Dígito da conta, Tipo de Conta (Corrente ou Poupança), Nome do lote, Data transferido, Banco de saída, Data de agendamento, Tentativas de pagamento, Tipo da chave PIX, Chave PIX`
Usadas: `Valor`, `Status`, `ID integração`, `Motivo`. As demais sao conferidas so no cabecalho.

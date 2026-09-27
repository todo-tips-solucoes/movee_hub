# Contrato: Repasse semanal do hub (F1 + F3)

Base: `/api/v1/adiantamentos` (`server.js:2942`), roteador `routes/hub-adiantamentos.js`.
Campos marcados **existente** foram lidos no código em 2026-09-26; campos marcados
**[PROPOSTA — a validar na implementação]** são novos desta feature.

## GET /repasse — `hub-adiantamentos.js:1439`

Permissão: `adiantamentos.pagamentos_consultar` (existente, sem mudança).
Query (existente): `periodo=YYYY-MM-DD`, `page`, `pageSize`, `busca`, `somenteNegativos=true|false`.

Resposta 200 — shape existente (`lib/hub/adiantamentos-api.ts:535-560`) + acréscimos:

```jsonc
{
  "periodo": { "inicio", "fim", "dataRepasse", "situacao": "aberto|fechado", "fechadoEm" },   // existente
  "totais": {
    "creditos", "adiantamentos", "debitos", "remanescente", "motoristas",                    // existente
    "saldoAnterior": "0.00",        // [PROPOSTA] F3 — soma de saldo_anterior
    "aPagar": "0.00",               // [PROPOSTA] F3 — soma de valor_pago
    "transportado": "0.00"          // [PROPOSTA] F3 — soma de valor_transportado
  },
  "itens": [{
    "entregadorId": 123,            // existente
    "idExterno": "uuid",            // [PROPOSTA] F1 — Entregador.id_externo
    "nome", "creditos", "adiantamentos", "debitos", "remanescente", "negativo", "emProcessamento",  // existente
    "saldoAnterior": "0.00",        // [PROPOSTA] F3 — null em semana fechada antes da regra
    "aPagar": "0.00",               // [PROPOSTA] F3 — valor_pago; null idem
    "transportado": "0.00",         // [PROPOSTA] F3 — valor_transportado; null idem
    "retido": false                 // [PROPOSTA] F3 — derivado (remanescente >= 0 AND aPagar = 0 AND transportado > 0)
  }],
  "naoPagosNoPeriodo", "total", "page", "pageSize"                                            // existente
}
```

Semana aberta: `saldoAnterior/aPagar/transportado/retido` são **previsão** (piso da
configuração vigente, saldo da última apuração fechada anterior). Semana fechada: valores
congelados.

Erros: os existentes. F1 acrescenta um caminho de falha: busca de `id_externo` falhou →
`502 { erro: 'ERRO_SERVIDOR' }` (mesmo tratamento das demais leituras do PostgREST na rota)
— nunca devolver linha sem identificador.

## GET /repasse/exportar — `hub-adiantamentos.js:1526`

Permissão e query existentes. CSV via `serializarCsvRemanescente`
(`lib/adiantamento-remanescente.js:124-150`), separador `,`, `\r\n`, escape de injection
existente.

| Versão | Cabeçalho |
|---|---|
| hoje (lido) | `Entregador,Créditos,Adiantamentos,Débitos,Remanescente` |
| F1 [PROPOSTA] | `Identificador,Entregador,Créditos,Adiantamentos,Débitos,Remanescente` |
| F3 | `Identificador,Entregador,Créditos,Adiantamentos,Débitos,Remanescente,Saldo anterior,A pagar,Passou para a próxima semana` |

Regras F3: linha de motorista retido **sempre presente** com `A pagar` = `0,00` e
`Passou para a próxima semana` = valor transportado (FR-024). Semana fechada antes da
regra: as três colunas novas saem vazias. ⚠️ Mudança de cabeçalho quebra planilha que lê
por posição — avisar o financeiro no PR de F1 e de F3.

## POST /repasse/:periodo/fechar — `hub-adiantamentos.js:1580`

Permissão: `adiantamentos.pagamento_confirmar` (existente; após F2 só
`admin_plataforma`/`financeiro_aprovador` a têm).

- 201 (existente): `{ …, motoristas, total }` — **F3 muda a semântica de `total`** para
  `sum(valor_pago)` (o que será pago). Conferir o texto de
  `components/hub/adiantamento-fechar-apuracao-dialog.tsx`.
- 409 novo **[PROPOSTA]**: `{ "erro": "APURACAO_FORA_DE_ORDEM" }` — semana anterior à
  última fechada, ou pula intermediária. Demais 409 existentes inalterados
  (`APURACAO_COM_PENDENCIAS`, `APURACAO_JA_FECHADA`, `APURACAO_NAO_CONFIGURADA`,
  `PERIODO_EM_ABERTO`, `PERIODO_DESALINHADO`); 403 `PERMISSAO_NEGADA` existente.
- `piso_aplicado` **[PROPOSTA — FR-025a]**: `hub_adiantamento_repasse_fechar` grava, no
  `INSERT` de `ApuracaoRepasse`, o `repasse_valor_minimo` vigente **no momento do
  fechamento** (não o do início da semana; block-006). Sem novo campo na resposta 201 —
  auditoria por consulta direta à tabela, mesmo padrão do restante do módulo.

## POST /repasse/:periodo/movimentos — `hub-adiantamentos.js:1654`

Permissão existente. F3 [PROPOSTA]:

- `select` de `ApuracaoRepasseItem` passa a trazer `remanescente, saldo_anterior_nota,
  saldo_anterior_fora, valor_pago, valor_transportado`.
- `planejarGeracao` (`lib/adiantamento-geracao-movimento.js:35`): item retido
  (`valor_pago=0 AND valor_transportado>0 AND remanescente>=0` — a mesma fórmula do
  `retido` derivado em SQL, data-model.md §ApuracaoRepasseItem; dec-055/block-008) →
  recusado com motivo novo `RETIDO` ("Saldo abaixo do mínimo — entra no próximo repasse");
  item pago com saldo (`remanescente>=0`) → `valor = valor_nota + saldo_anterior_nota`,
  `gorjeta = valor_fora_nota + saldo_anterior_fora` (uma nota só, FR-020); **item com
  `remanescente<0` (dec-055/block-008, FR-018) NUNCA é retido** — mesmo com saldo
  carregado (`valor_transportado=saldo_anterior>0` nesse caso, 0098:268) — gera a nota da
  PRÓPRIA semana: `valor = valor_nota`, `gorjeta = valor_fora_nota`, **sem** somar
  `saldo_anterior_nota`/`_fora` (o saldo antigo segue carregado intacto —
  `transportado_nota/_fora = saldo_anterior_nota/_fora`, 0098:279/284 — para a nota
  futura em que finalmente for pago); item com `valor_pago IS NULL` (pré-regra) →
  comportamento de hoje.
- Busca de `Entregador?id=in.(…)` passa a ser em lotes de 100 (helper da F1).

## GET/PUT /configuracoes — `hub-adiantamentos.js:428` / `:484` (F3)

- GET (existente, `adiantamentos.consultar`): acrescenta `repasseValorMinimo: "5.50"`
  **[PROPOSTA]**.
- PUT (existente, `adiantamentos.configurar`): aceita `repasseValorMinimo` (string/número
  decimal, `> 0`) **[PROPOSTA]**. Se presente e diferente do vigente, e o chamador não tem
  `adiantamentos.pagamento_confirmar` na entidade ativa → `403 { erro:
  'PERMISSAO_NEGADA_PISO' }` antes da RPC; `<= 0` ou não numérico → `400 { erro:
  'DADOS_INVALIDOS', motivo: 'repasseValorMinimo' }`. A RPC repete as duas checagens
  (FR-026: backend **e** banco).
- Tela: campo "Valor mínimo para repasse" no card "Repasse semanal"
  (`configuracoes/page.tsx:565`), desabilitado sem a permissão.

## Chamadas SQL (RPC via PostgREST)

| RPC | Mudança | Tipo de retorno |
|---|---|---|
| `hub_adiantamento_repasse` | + `saldo_anterior, valor_pago, valor_transportado, retido` por linha; + `total_saldo_anterior, total_a_pagar, total_transportado`; inclui quem só tem saldo | **muda** → `DROP` + `CREATE` + `GRANT` |
| `hub_adiantamento_repasse_congelado` | idem, lendo as colunas congeladas (NULL em item pré-regra) | **muda** |
| `hub_adiantamento_repasse_fechar` | regra de saldo, CTE `linhas`, ordem estrita, `total = sum(valor_pago)`, grava `piso_aplicado` vigente no fechamento | **não muda** (`CREATE OR REPLACE`) |
| `hub_adiantamento_configuracao_salvar` | copia/valida `repasse_valor_minimo`; exige `pagamento_confirmar` para alterá-lo | não muda (retorna a linha da tabela, que ganha a coluna) |

Argumentos de todas as RPCs: **inalterados**.

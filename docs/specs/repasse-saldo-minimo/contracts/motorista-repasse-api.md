# Contrato: repasse no app do motorista (F3)

Rota: `GET /motorista/repasse` (`server.js:2836` + `:2869`; handler
`routes/motorista-adiantamento.js:852`), autenticada por `authenticateMotorista`.
Chama `rpc/hub_adiantamento_repasse_motorista` e
`rpc/hub_adiantamento_repasse_motorista_ultimo_fechado` (`:863-864`).

## Resposta 200 — existente + acréscimos

```jsonc
{
  "periodoInicio", "periodoFim", "dataRepasse", "situacao",       // existente
  "adiantamentos": [ … ],                                          // existente
  "remanescente": "0.00", "negativo": false,                       // existente
  "saldoAnterior": "3.00",      // [PROPOSTA] saldo carregado que entra nesta semana (0.00 se nenhum)
  "previsaoTotal": "7.00",      // [PROPOSTA] remanescente + saldoAnterior (quando remanescente >= 0)
  "abaixoDoMinimo": false,      // [PROPOSTA] 0 < previsaoTotal < piso → "será somado ao próximo repasse"
  "ultimoFechado": {                                               // existente (null se nenhum)
    "periodoInicio", "periodoFim", "dataRepasse", "fechadoEm", … ,// existente
    "saldoAnterior": "3.00",    // [PROPOSTA] null em apuração pré-regra
    "aPagar": "0.00",           // [PROPOSTA]
    "retido": true,             // [PROPOSTA]
    "transportado": "3.00"      // [PROPOSTA] valor que entra no próximo repasse
  }
}
```

O piso **não** é exposto como número ao motorista — só o booleano `abaixoDoMinimo`
(evita segundo vocabulário para regra interna; o texto explica o efeito).

## RPCs

| RPC | Colunas novas | Tipo de retorno |
|---|---|---|
| `hub_adiantamento_repasse_motorista` | `saldo_anterior`, `abaixo_do_minimo` | muda → `DROP` + `CREATE` + `REVOKE/GRANT` |
| `hub_adiantamento_repasse_motorista_ultimo_fechado` | `saldo_anterior`, `valor_pago`, `valor_transportado`, `retido` | muda → idem |

## Tela (`frontend_motorista/app/(app)/repasse/page.tsx`)

Antes de desenhar: abrir esta tela **e** a home do app (e `app/(app)/movimento/page.tsx`,
que mostra `VALOR DA NOTA FISCAL`) e registrar na proposta onde cada número já aparece
(regra de UI do `CLAUDE.md`). Pontos de mudança lidos: "Outros débitos" `:114`/`:225`,
"Previsão a receber" `:119`, texto `:174` (afirma que nada é transportado — revisar),
card "Semana fechada" a partir de `:200`.

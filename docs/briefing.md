# Project Briefing: importar lançamentos pagos por fora do sistema

> Frente corrente, aberta em 2026-10-22 a pedido do financeiro. Detalhe e decisões
> em `docs/plans/lancamento-externo/BRIEFING.md`.

## 1. Visão e Propósito

O financeiro paga valores aos motoristas **por fora do sistema** (adiantamento feito na
mão, vale, acerto) e hoje **não tem como informar isso ao hub**. O resultado é que o
repasse semanal paga o valor cheio, sem descontar o que já saiu do caixa.

Pedido do operador (22/10): *"o pessoal do financeiro gostaria de um layout de arquivo e
uma forma de subir os adiantamentos que foram feitos de forma manual… para que os
adiantamentos possam ser deduzidos do repasse semanal da semana que vem"*.

⚠️ **A feature não é só de adiantamento.** Decisão do operador na mesma conversa: *"posso
usar essa feature para inputar outros valores pagos por fora"*. Por isso o modelo nasce
genérico, com **tipo** e **sinal derivado do tipo**, e `ADIANTAMENTO` é o primeiro tipo.

### 🔴 O prazo real é o FECHAMENTO, não o pagamento

O pagamento da semana 19–25/10 sai na **quarta, 28/10**. Mas a dedução acontece no
**fechamento da apuração**, que grava um retrato **imutável** em `ApuracaoRepasseItem`
(`0098:218-222`). Fechada a semana, o valor está congelado e **não deduz mais**.

O fechamento só é liberado depois do corte do dia seguinte ao fim da semana, então a
janela real para lançar é **26/10 (segunda) até o fechamento**, antes de 28/10.

## 2. Usuários e Stakeholders

| Quem | Como usa |
|---|---|
| **Financeiro** | sobe a planilha dos valores pagos por fora antes de fechar a apuração. Já tem a permissão `adiantamentos.pagamento_confirmar` (migration 0115). |
| **Motorista** | é o efeito final: o repasse dele passa a descontar o que já recebeu, em vez de pagar duas vezes. |

## 3. Escopo

### MVP (Essencial)

1. **Planilha XLSX de 5 colunas** (contrato fechado em §7), com cabeçalho conferido.
2. **Tabela nova** de lançamento externo, genérica (tipo + sinal), sem tocar nos CHECKs
   do fluxo vivo do app.
3. **A dedução passa a somar as duas fontes** no fechamento (`0098`) e na prévia (`0100`).
4. **Botão + diálogo na aba Repasse** que já existe (aprovado pelo operador).
5. **Idempotência** por `empresa + CNPJ + data do pagamento + tipo`.
6. **Recusa por linha**, nomeando o motivo, com contagem agregada.

### Fora de Escopo

- Página nova ou aba nova (o operador aprovou **só** o botão + diálogo, na aba Repasse
  que já existe).
- **Editar** lançamento pela tela — corrige-se excluindo e reenviando, com a semana aberta.
- Reabrir semana fechada (`ApuracaoRepasse` é imutável por desenho).
- Lançar valor para empresa fora do grupo Movee (o fechamento é `id_empresa = 6`).

⚠️ **Emenda de 2026-10-23 (rodada 3).** A **listagem** dos lançamentos importados e a
**exclusão** de um lançamento **deixaram de estar fora de escopo**: o operador autorizou
as duas como diálogo da aba Repasse (FR-056/FR-057), e o código as entrega. O motivo é
operacional — sem listar não há como achar o lançamento errado antes do fechamento, e
sem excluir não há como corrigi-lo, já que editar continua fora. Quem conferir o escopo
por este arquivo tem de ler esta emenda junto: a lista acima é o escopo de 22/10.

## 4. Prioridades e Trade-offs

**Prazo manda, mas não acima do dinheiro.** A entrega toca a função que calcula o repasse
(`hub_adiantamento_repasse_fechar`), que é o caminho do dinheiro. O trade-off aceito pelo
operador: mexer nessa função em vez de afrouxar os CHECKs de `AdiantamentoSolicitacao` —
porque afrouxar enfraqueceria o fluxo do app para sempre, e a função pode ser alterada
com teste e controle negativo.

## 5. Restrições

### Medido no código (não supor)

- **A dedução hoje**: CTE `pagas` em `0098:218-222` soma `valor_bruto` de
  `AdiantamentoSolicitacao` com `status IN ('PAGA','EXPORTADA')` e
  `data_producao BETWEEN inicio AND inicio+6`. A prévia é `0100:81-89`.
- **`remanescente = creditos - adiantamentos - debitos`**, e a flag
  `desconto_adiantamentos` é `DEFAULT true` (`0066:69`).
- ⚠️ **`debitos` NÃO serve** para isto: vem de `FaturamentoLancamento` com
  `tipo='Debito'` (lançamentos da EntreGô) e a flag `desconto_debitos` é `DEFAULT false`.
- **Saldo mínimo** `repasse_valor_minimo` `DEFAULT 5.50` (`0098:87`), com a regra **paga
  tudo ou retém tudo** e o CHECK `apuracaorepasseitem_saldo_conserva` (`0098:71-81`)
  garantindo `remanescente + saldo_anterior = valor_pago + valor_transportado`.
- **Obstáculos que levaram à tabela nova**: `AdiantamentoSolicitacao` tem NOT NULL em
  `conta_motorista_id`, `aceite_texto_sha256`, `configuracao_id`; CHECK
  `data_producao = data_solicitacao - 1`; CHECK de `PAGA` exigindo `conta_bancaria_id` e
  `valor_liquido > 0`; e UNIQUE de 1 por motorista/dia.
- **RLS**: `AdiantamentoSolicitacao` tem RLS com policy só de SELECT por escopo
  (`0066:366`); escrita passa por `SECURITY DEFINER`. A tabela nova segue o mesmo padrão.
- **A semana é configurável**: `apuracao_dia_inicio` (0-6, `0066:92`), fim sempre
  `inicio + 6`, e o trigger `hub_apuracao_repasse_valida_janela` (`0086:35-68`) recusa
  `PERIODO_DESALINHADO`. ⚠️ O valor vigente em produção **só o banco sabe** — pendência
  do operador (§8).

### Técnicas

- **Modelo mais próximo**: o retorno da Transfeera (`lib/adiantamento-retorno-transfeera.js`),
  entregue hoje. Reusar `lerXlsx`, `conferirTetoZip`, `paraCentavos`, o padrão
  `express.raw` com mime de XLSX, e o diálogo `adiantamento-importar-retorno-dialog.tsx`
  como molde. ⚠️ **Ele está acoplado a `loteId`** — o molde serve, o componente não é
  reutilizável como está.
- ⚠️ **`express.json()` global de 100 KB roda antes do router**: o parser vai na rota.
- ⚠️ **`paraCentavos('1.234,56')` dava NaN** e ganhou ramo para milhar BR hoje; `"1.234"`
  (ponto sem decimais) é **ambíguo** e recusado com `VALOR_AMBIGUO`.
- ⚠️ A resposta **nunca** devolve CNPJ nem nome: só contagem por motivo (gate owasp de
  01/10, comentário em `hub-adiantamentos.js:1517-1523`).

## 6. Stack Técnica

Node 20 + Express (sem ORM) · PostgreSQL via **PostgREST** com função `SECURITY DEFINER` ·
**SheetJS (`xlsx`)**, já dependência · Next.js 16 App Router + React · Tailwind 4 + Base UI
+ shadcn · testes `node --test` (backend), **vitest** (frontend), **Playwright** (E2E).

Skills de consulta à documentação oficial, a usar durante o desenvolvimento: `xlsx`,
`postgresql` / `postgres-best-practices`, `nodejs-backend-patterns`,
`nextjs-app-router-patterns`, `tailwind-patterns`, `vitest-skill`, `typescript-pro`.

## 7. Qualidade e Padrões

- **Deduplicação acima de tudo**: procurar antes de escrever. O leitor de XLSX, o teto de
  ZIP e a conversão de valor **já existem** e devem ser reusados, não reimplementados.
- **Escalabilidade e performance**: a dedução entra numa função que roda sobre a semana
  inteira da empresa; o join novo precisa de índice e de `EXPLAIN` medido.
- **Segurança**: arquivo vem de fora (cabeçalho por contrato, tetos de bytes/linhas/ZIP);
  `SECURITY DEFINER` com `REVOKE` antes do `GRANT`; RLS por escopo; nenhum dado de
  terceiro na resposta.
- **Controle negativo obrigatório** em cada correção, com os testes **nomeados** e a
  prova de que a reversão foi aplicada **antes** de medir.
- **Gates com números**: backend `node --test` (baseline a medir no início), `tsc`,
  `vitest`, `next build`, lint contra a baseline, driver
  `hub-adiantamentos-integration.sh` (hoje **231 PASS / 0 FAIL**).

## 8. Visão de Futuro

Com `tipo` e sinal no modelo, o segundo tipo de valor pago por fora entra por migration de
uma linha, sem redesenho — era a razão de o operador recusar uma tabela só de adiantamento.

## Itens a Definir

**Um só, e não bloqueia o desenho** (a função lê da config; só a validação do período
depende dele): o valor vigente de `apuracao_dia_inicio` em produção. Se for `1` (segunda),
a semana 19–25/10 está alinhada. O agente **não acessa produção** — pendência do operador.

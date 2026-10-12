# Entendimento do processo e retomada da frente

Escrito em 2026-10-12, depois de várias correções do operador. **Este arquivo é a
fonte do entendimento** — o BRIEFING.md tem o plano; aqui está o CONTEXTO que
custou a conversa toda para ficar claro.

## O processo REAL de hoje (confirmado pelo operador)

1. A apuração do que cada motorista produziu é feita **numa planilha Excel, FORA
   do sistema**.
2. Essa planilha é importada na aba **Envio em Massa**, botão **"Importar XLSX"**
   (rota `POST /upload`). Colunas reais (do modelo em
   `docs/documentos_apoio/modelo_upload_envio_em_massa_movee 05.10.xlsx`):
   `number, nome, valor, mensagem1, mensagem2, enviado, retorno_envio_msg_1,
   retorno_envio_msg_2, tribnac, cnpj_tomador, uuid, cnpj_prestador, gorjeta`.
   ⚠️ **Não há banco/agência/conta** — esta planilha NÃO é remessa bancária, ela
   cria o **MOVIMENTO**.
3. O import cria os movimentos da semana na `EnvioMassa`.
4. **O movimento é pré-condição para o motorista ver o valor** no app e saber
   quanto faturar. A nota vem DEPOIS do movimento — nunca antes.
5. O motorista emite a NFS-e e envia o XML pelo app; a FastAPI valida.
6. O pagamento é liberado quando a nota chega (processo humano: **não existe gate
   automático** — `nota_ok` não aparece em nenhuma rota do hub).
7. `POST /close-movimento` fecha o movimento **por `id_empresa`** — a empresa
   inteira de uma vez.

⚠️ **O defeito que originou a frente:** quem não enviou a nota antes do
fechamento perdia o acesso a ela pelo app, **para sempre**. Medido: **13.425**
movimentos do grupo Movee sem nota, **6.394** nos últimos 90 dias, **1.092
motoristas** (média 5,9 cada, máx 11).

## ⚠️ "LOTE" significa DUAS coisas — a confusão que atrasou a conversa

| | o que é | estado |
|---|---|---|
| **A. lote de MOVIMENTOS** | o conjunto semanal que a planilha XLSX cria; faz o motorista ver o valor | existe pela planilha; o repasse já sabe gerar (`POST /repasse/:periodo/movimentos`, PR #215) e **nunca foi usado** |
| **B. lote de PAGAMENTO** | remessa Transfeera que move o dinheiro, com arquivo e confirmação por retorno | existe só para **adiantamento** (8 rotas: prévia, criar, listar, detalhe, arquivo, cancelar, confirmação, retorno). **NÃO existe para repasse** |

Quando o operador diz "o lote do repasse é pré-condição para o motorista ver o
valor", é o **A**. Quando diz "arquivo da Transfeera para confirmar o pagamento",
é o **B**.

## O que JÁ ESTÁ EM PRODUÇÃO (F1–F4b, 12/10)

Ver `BRIEFING.md` e a memória `frente-nota-pendente-motorista`. Resumo: o
motorista lista e regulariza pendências de movimentos fechados (90 dias), a marca
`regularizada_em` (migration 0107) registra, e o hub mostra **"Pagamentos
retidos aguardando liberação"**.

## 🔴 O QUE FALTA — F5, o pedido do operador em 12/10

> "fechar o ciclo para repasse de notas que foram enviadas depois do fechamento
> do movimento atual"

A tela do hub LISTA as notas regularizadas, mas **não há ação**. O operador
precisa poder mandar essas notas para **pagamento** (o lote **B**), com arquivo
Transfeera e confirmação por retorno, espelhando o que o adiantamento já faz.

**Pré-requisito já resolvido:** 99,4% dos motoristas têm CNPJ e conta bancária
(1.220 de 1.276) — é o que o arquivo Transfeera exige.

## Decisões JÁ TOMADAS pelo operador (não reabrir)

- **Uma nota por pendência** (não uma nota cobrindo várias).
- **Recorte de 90 dias** na lista do motorista.
- **Toda pendência é `EnvioMassa` sem `nota_ok`**.
- **FastAPI: parâmetro `id_movimento` opcional**, endpoint antigo intocado.
- **Entrada no app: card na home**, não 5º item na barra (a barra é
  `grid-cols-4` e "Notificações" mede 75,45px; um 5º item derruba a coluna para
  64px).
- **Nada do caminho vivo é alterado** até o operador validar a via nova
  (duplicação aceita, com critério de saída no BRIEFING).
- **O lote NÃO depende de nota** — ao contrário: o movimento vem antes.
- **Não fechar apuração de repasse nesta semana** (12/10). O repasse é o futuro;
  a planilha segue sendo o presente.

## O FUTURO (declarado, fora do escopo atual)

O repasse vai substituir a planilha: apuração dentro do sistema, e os movimentos
gerados por `POST /repasse/:periodo/movimentos` em vez do import XLSX.
Medido em 12/10: há **22.326 lançamentos / 976 entregadores / R$ 674.058,80** na
semana 05–11/10, e a configuração está pronta (versão 16, de 08/10:
`apuracao_dia_inicio=1`, `apuracao_dias_ate_repasse=3`,
`repasse_valor_minimo=5.50`, `repasse_visivel_app=true`).
⚠️ Mas `ApuracaoRepasse`, `ApuracaoRepasseItem` e `ApuracaoRepasseMovimento`
estão **TODAS VAZIAS**: o módulo está em produção desde 23/09 e **nunca
produziu um registro**.

## Ambiente de teste disponível

Motorista de teste criado em 12/10, ainda **ativo** (reverter com
`/root/.claude/jobs/bb227b0e/tmp/teste-nota/reverter.sql`):
CNPJ `99000000000159`, senha `TesteNota@2026`, 2 movimentos fechados sem nota
(R$ 1.234,56 e R$ 789,10), nome "TESTE VALIDACAO NOTA (apagar)". XML que CASA com
o primeiro em `/root/.claude/jobs/bb227b0e/tmp/teste-nota/nota-teste.xml`.

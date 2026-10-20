# Corrigir o valor de um movimento antes do envio da nota

> Pedido do operador em 19/10/2026: *"o movimento da semana ficou faltando um evento a ser
> calculado e preciso recalcular, quero ter a oportunidade de reabrir e gerar o valor de nota
> novamente, para a correção antes do envio das notas dos motoristas."*

## 1. O problema, medido (não suposto)

**Hoje não existe caminho para corrigir o valor de um movimento.**

| Tentativa | O que acontece hoje |
|---|---|
| Editar pela tela | O diálogo mostra **Valor** como editável, responde *"Registro atualizado com sucesso!"* e **não grava**. O `PATCH /update-envio-massa/:id` (`server.js:1079`) lê **apenas** `cnpj_prestador`, `enviado`, `mensagem` e `tipo`. |
| Reimportar a planilha corrigida | **Duplica** as linhas — o `POST /upload` não tem checagem de repetição. |
| Excluir e reimportar | Único caminho real hoje, linha a linha. É o que o operador quer deixar de fazer. |

A tela que **mente** é a pior parte: o operador corrige, recebe confirmação de sucesso, e o valor
continua errado. O motorista emite a nota pelo valor antigo.

## 2. O escopo (e o que NÃO é)

⚠️ **Não é reabrir a apuração do repasse.** Essa hipótese foi levantada, desenhada e **descartada**
em conversa com o operador: o objeto é o **movimento da semana corrente** (`EnvioMassa`), antes do
motorista emitir a nota. A apuração (`ApuracaoRepasse`) não é tocada.

Contexto que torna isso ainda mais claro: **não existe nenhuma apuração fechada em produção**
(medido em 19/10: `ApuracaoRepasse` = 0 linhas). O fluxo real é 100% planilha.

## 3. Decisões do operador (tomadas antes do desenvolvimento)

### D1 — Dois caminhos de correção

| Caminho | Para quê |
|---|---|
| **Reimportar a planilha** | correção em lote: o arquivo corrigido atualiza as linhas que já existem, **em vez de duplicar** |
| **Editar na tela** | correção pontual: faz o botão Editar **finalmente gravar** o que mostra |

Os dois registram **quem alterou, quando e por quê**.

### D2 — Movimento com nota já enviada NÃO é alterado

Quando o motorista já enviou a nota daquele movimento, o valor **fica como está** e a tela informa
quantos foram pulados.

**Por quê:** a nota fiscal já emitida tem o valor antigo. Alterar o movimento faria a nota divergir
e ser **recusada na validação** — criando um problema pior que o original. Para corrigir esses
casos, a nota precisa ser cancelada antes.

### D3 — Só a última apuração fechada poderia ser reaberta (decisão guardada, fora deste escopo)

O operador escolheu "só a última fechada" quando a hipótese de reabrir apuração estava em jogo.
A razão: a apuração de uma semana alimenta a seguinte pelo **saldo transportado**, e reabrir uma do
meio deixaria as semanas posteriores calculadas sobre um valor que deixou de existir.

**Registrado para quando/se a reabertura de apuração voltar à mesa. Não é para implementar agora.**

## 4. Requisitos de qualidade (explícitos do operador)

> *"garantindo que o código tenha deduplicação de código, escalabilidade, segurança e performance"*

- **Deduplicação**: o repositório **já tem** casos de mapa duplicado 3× (corrigido em #278) e de
  tradução espalhada. Antes de escrever qualquer helper, **procurar o que já existe**.
- **Segurança**: alterar valor de movimento é alterar **o que o motorista vai faturar**. Exige
  permissão explícita, escopo por empresa (⚠️ a `EnvioMassa` tem RLS com policy `USING (true)` —
  **não filtra nada**, o filtro é responsabilidade da query) e registro em Auditoria.
- **Performance**: a reimportação precisa casar ~950 linhas sem varredura por linha.
- **Escalabilidade**: o volume hoje é ~980 linhas/semana e cresce.

## 5. O que já se sabe do terreno

- `POST /upload` (`server.js`) — importa a planilha. Regra **tudo ou nada**: uma linha inválida
  impede todas. O modelo tem coluna `uuid`, hoje **não usada** para casar linha.
- `PATCH /update-envio-massa/:id` (`server.js:1079`) — o editar que não grava valor.
- Permissões do Envio em Massa: `.consultar`, `.criar`, `.enviar`, `.aprovar`, `.gerenciar`.
- "Nota enviada" = `nota_ok` preenchido **E** `erro_validacao` vazio (`nota_ok` é gravado mesmo em
  nota **reprovada** — ver `notaAprovada()` em `routes/hub-validacao-xml.js`).
- O movimento pode ter origem **planilha** ou **hub** ("Gerar notas da semana"); hoje só planilha.

## 6. Limitações conhecidas que esta frente deve respeitar

- ⚠️ `express.json()` global de **100 KB** roda **antes** do router — payload grande precisa de
  parser na própria rota (incidente de 2026-10-01).
- ⚠️ O navegador aborta em **10 s** nas chamadas do painel legado; a importação já esbarra nisso.
- ⚠️ `{/* */}` logo após `return (` quebra o build do turbopack.

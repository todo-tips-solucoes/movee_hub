# Project Briefing: Corrigir o valor de um movimento antes do envio da nota

> Briefing da frente corrente. O briefing da frente anterior (push no app do
> motorista, concluída em 14/09) foi preservado em
> `docs/plans/push-motorista/BRIEFING-DISCOVERY.md`.
>
> Detalhe completo, com as medições, em `docs/plans/corrigir-movimento/BRIEFING.md`.

## 1. Visão e Propósito

**Hoje não existe caminho para corrigir o valor de um movimento**, e a tela mente
sobre isso.

O operador fecha a semana importando uma planilha para a `EnvioMassa`. Quando um
evento é lançado errado ou falta no cálculo, o valor do movimento sai errado — e é
esse valor que o motorista usa para emitir a nota fiscal. Corrigir deveria ser
trivial. Medido:

| Tentativa | O que acontece |
|---|---|
| Editar pela tela | O diálogo mostra **Valor** como editável, responde *"Registro atualizado com sucesso!"* e **não grava**. O `PATCH /update-envio-massa/:id` (`server.js:1079`) lê apenas `cnpj_prestador`, `enviado`, `mensagem` e `tipo`. |
| Reimportar a planilha corrigida | **Duplica** as linhas — o `POST /upload` não tem checagem de repetição. |
| Excluir e reimportar | Único caminho real hoje, linha a linha. É o que esta frente elimina. |

A confirmação falsa é a parte mais grave: o operador corrige, recebe "sucesso", e o
motorista emite a nota pelo valor antigo.

**O propósito é permitir a correção antes do envio da nota**, em dois caminhos, com
registro de quem alterou, quando e por quê.

## 2. Usuários e Stakeholders

| Quem | Como usa |
|---|---|
| **Operação** (painel Envio em Massa, `app.moveelog.com.br`) | Importa a planilha da semana e corrige o que saiu errado. Login é **da empresa** — sem controle por pessoa no painel legado. |
| **Financeiro** (Movee Hub) | Acompanha o repasse e os pagamentos retidos. Papéis `financeiro` e `financeiro_aprovador` hoje têm permissões idênticas. |
| **Motorista** (app, `app.motorista.moveelog.com.br`) | Emite a nota pelo valor que o movimento mostra. É quem sofre o erro: nota emitida com valor divergente é recusada na validação. |

## 3. Escopo

### MVP (Essencial)

1. **Reimportação que atualiza em vez de duplicar** — o arquivo corrigido reconhece
   as linhas que já existem e atualiza o valor, em lote.
2. **Edição do valor pela tela** — fazer o botão Editar **gravar o que já mostra**,
   com motivo obrigatório. Hoje ele responde sucesso e não grava.
3. **Movimento com nota já enviada NÃO é alterado** — o valor fica como está e a
   tela informa **quantos foram pulados**.
4. **Registro de auditoria nos dois caminhos** — quem alterou, quando, por quê, de
   qual valor para qual.

### Fora de Escopo (decisão explícita do operador)

- **Reabrir apuração do repasse** (`ApuracaoRepasse`). Foi levantado, desenhado e
  **descartado** em conversa: o objeto é o movimento da semana corrente, antes do
  motorista emitir a nota. Reforço: **não existe nenhuma apuração fechada em
  produção** (medido em 19/10: `ApuracaoRepasse` = 0 linhas) — o fluxo real é 100%
  planilha.
- **Alterar movimento cuja nota já foi enviada.** Ver decisão D2 abaixo.
- Mudar o cálculo do valor, a origem da planilha ou o layout do arquivo.

## 4. Prioridades e Trade-offs

**Decisões já tomadas pelo operador — o clarify NÃO deve reabrir nenhuma delas:**

### D1 — Os dois caminhos, não um

Reimportar a planilha (lote) **e** editar na tela (caso a caso). Não é "ou": a
correção em massa e a pontual têm donos e momentos diferentes.

### D2 — Nota já enviada: não alterar, e avisar

Quando o motorista já enviou a nota daquele movimento, o valor **não muda**; a tela
diz quantos foram pulados.

**Por quê:** a nota fiscal já emitida carrega o valor antigo. Alterar o movimento
faria a nota divergir e **ser recusada na validação** — criando um problema pior que
o original. Para esses casos a nota precisa ser cancelada antes.

Definição operacional de "nota enviada": `nota_ok` preenchido **e** `erro_validacao`
vazio. ⚠️ `nota_ok` é gravado mesmo em nota **reprovada** (ver `notaAprovada()` em
`routes/hub-validacao-xml.js`) — testar só `nota_ok` classificaria errado.

### D3 — Reabertura de apuração (guardada, não implementar)

Se algum dia voltar à mesa: só a **última** apuração fechada poderia ser reaberta,
porque a apuração de uma semana alimenta a seguinte pelo saldo transportado.
**Registrado para memória. Não é para implementar agora.**

## 5. Restrições

### Produto

- O ambiente chamado "homologação" **é produção**: clientes usam. Não há ambiente
  separado.
- O painel legado tem login **por empresa**, não por pessoa — não há como atribuir a
  correção a um indivíduo ali. A auditoria registra o que o sistema sabe, sem inventar
  autoria.
- Volume atual: ~980 linhas por semana, e cresce.

### Técnicas (cada uma veio de um incidente real)

- ⚠️ **`express.json()` global de 100 KB roda ANTES do router** — qualquer rota JSON
  com corpo grande fica inalcançável. Usar `express.text({type})` na própria rota;
  **nunca** subir o limite global.
- ⚠️ **A `EnvioMassa` tem RLS com policy `USING (true)`** — ela **não filtra nada**.
  O escopo por empresa é responsabilidade **explícita** da query.
- ⚠️ O navegador aborta em **10 s** nas chamadas do painel legado; a importação já
  esbarra nisso.
- ⚠️ `{/* */}` imediatamente após `return (` quebra o build do turbopack — usar `//`
  na linha acima.
- Persistência é por **PostgREST**, sem ORM. Migrations em série única
  `infra/hub/migrations/NNNN_*.sql`; nunca editar migration já aplicada.
- O `POST /upload` é **tudo ou nada**: uma linha inválida impede todas. O modelo tem
  coluna `uuid`, hoje **não usada** para casar linha.

## 6. Stack Técnica

- **Backend**: Express (`app_homologacao/backend/`), Node 20, porta 3000. Lógica pura
  testável em `lib/`, suíte `node --test`.
- **Painel legado**: Next.js App Router em `app_homologacao/frontend_v2/`
  (`app/{login,dashboard,…}`), Tailwind 4 + **Base UI** (não Radix) + shadcn, testes
  em vitest.
- **Banco**: PostgreSQL via PostgREST. Tabela central desta frente: `EnvioMassa`.
- **Permissões do Envio em Massa**: `.consultar`, `.criar`, `.enviar`, `.aprovar`,
  `.gerenciar`.

## 7. Qualidade e Padrões

Exigências explícitas do operador para esta frente:

- **Deduplicação** — o repositório já teve o mesmo mapa duplicado 3× (corrigido em
  #278). **Antes de escrever qualquer helper, procurar o que já existe.**
- **Segurança** — alterar valor de movimento é alterar **o que o motorista vai
  faturar**. Exige permissão explícita, escopo por empresa na query (a RLS não
  protege) e registro em auditoria.
- **Performance** — a reimportação precisa casar ~950 linhas sem varredura por linha.
  ⚠️ `::date` numa coluna de data **impede o planner de usar o índice**; usar faixa
  (`>= d AND < d+1`).
- **Escalabilidade** — dimensionar para crescimento do volume semanal.

### Gates do ciclo git (cláusula pétrea do repo)

Branch própria · `tsc --noEmit` · suíte unit · `next build` se tocou frontend · lint
comparado com a **baseline** (erro pré-existente não bloqueia; erro novo bloqueia) ·
`git add` **sempre por caminho explícito** · merge **antes** do deploy · prova de
bundle por string servida.

**Controle negativo é obrigatório** em todo teste que afirma correção: rodar a suíte
nova **contra o código antigo** e conferir **quais** falham, não apenas que alguma
falhou. Um teste que passa nos dois lados não prova nada — já houve teste neste repo
que **afirmava o defeito**, e foi por isso que a suíte verde nunca o pegou.

## 8. Visão de Futuro

- Unificar os dois caminhos de correção numa única porta de escrita, se a duplicação
  de regra entre `/upload` e o PATCH se mostrar custosa.
- Trazer o cadastro/movimento do painel legado para o hub, onde o login é por pessoa
  e a auditoria tem autor real.

## Itens a Definir

Nenhum. As decisões de produto estão fechadas em §4 (D1, D2, D3) e foram tomadas
pelo operador antes do início do desenvolvimento, a pedido dele.

# F5 — lote de pagamento do repasse (fecha o ciclo das notas regularizadas)

> Pedido do operador: *"quero implementar de forma que possamos fechar o ciclo para
> repasse de notas que foram enviadas depois do fechamento do movimento atual."*
>
> Plano **fechado** — todas as decisões tomadas antes da execução, conforme a regra do
> operador (Opus decide, Sonnet executa). Entra em código sem nova rodada de perguntas.

## 1. O problema, medido (não suposto)

| Pergunta | Medição | Conclusão |
|---|---|---|
| A apuração do repasse retém pagamento por falta de nota? | `grep nota_ok\|erro_validacao` em `0088/0092/0098/0100` → **zero ocorrências**. `retido` existe só por saldo mínimo (0098, FR-014/FR-017). | **Não.** O repasse apura e paga sem olhar a nota. |
| O repasse tem ciclo de pagamento no sistema? | `ApuracaoRepasseItem` tem `valor_pago` (valor **a** pagar, calculado) e **nenhuma coluna de confirmação**. A única saída é `GET /repasse/exportar` (CSV). | **Não.** Lote, arquivo Transfeera, confirmação e comprovante **não existem** no repasse — só no adiantamento. |
| O que trava hoje? | "Pagamentos retidos aguardando liberação" (F4b, PR #271) lista quem regularizou, mas **não tem ação**: a liberação é uma pessoa decidindo fora do sistema. | O ciclo morre na notificação. |

É isto que a F5 fecha: **dar ao repasse o ciclo de pagamento que ele não tem**, com a
elegibilidade por nota aprovada como porta. Quem regularizou depois do fechamento não
entrou no lote da sua semana (não tinha nota) e passa a entrar no **lote seguinte**.

### Como isso reconcilia tudo o que o operador disse

| Frase do operador | Onde cai |
|---|---|
| "O lote tem que existir sem condição de nota do motorista. Até porque lote do repasse semanal é pré-condição para motorista ver o valor que precisa para emitir a nota." | É a **apuração/extrato** que existe sem a nota — e continua existindo, intocada. |
| "Só nota aprovada entra no lote." | É o **lote de pagamento** (esta F5) que filtra por nota aprovada. |
| "Todas as aprovadas, por semana." | Cadência semanal de geração; cada lote leva todas as elegíveis pendentes, de **qualquer** semana de apuração. |
| "repasse semanal tem que ter lote para pagamento também... arquivo da transfeera... confirmação posteriormente com os comprovantes. igual em adiantamento." | É o entregável desta F5, espelhando o adiantamento. |

## 2. Decisões travadas

### D1 — O valor pago é `ApuracaoRepasseItem.valor_pago`, nunca `EnvioMassa.valor`

Razão: `valor_pago` é o único número que já desconta adiantamentos (`adiantamentos`),
aplica saldo mínimo e soma saldo transportado (0098/0100). Pagar `EnvioMassa.valor`
pagaria **em duplicidade** com o adiantamento que o motorista já recebeu.

Decorrência medida: `EnvioMassa.valor` é `double precision` (dinheiro em float). Mesmo
onde aparecer, converter com `round(valor::numeric, 2)` — nunca somar o float.

### D2 — O item do lote é por **entregador × apuração**, não por movimento

O pagamento é um PIX por pessoa, e `valor_pago` é agregado por entregador×apuração.
Chave natural do item: `(lote_id, apuracao_id, entregador_id)`.

### D3 — Elegibilidade (o filtro da prévia), toda condição obrigatória

1. `ApuracaoRepasse.fechado_em IS NOT NULL` (apuração fechada)
2. `ApuracaoRepasseItem.valor_pago > 0`
3. **Todos** os movimentos daquele entregador×apuração (via `ApuracaoRepasseMovimento`)
   com nota **aprovada** — `nota_ok` preenchido **E** `erro_validacao` vazio.
   ⚠️ `nota_ok` guarda a URL do XML e é gravado **mesmo quando a nota é reprovada**;
   `nota_ok` sozinho não prova aprovação (mesma regra de `notaAprovada()` em
   `routes/hub-validacao-xml.js`). Faltando **um** movimento, o entregador **não entra** —
   é exatamente a semântica de "pagamento retido aguardando liberação".
4. Conta bancária `APROVADA` para o entregador (`uniq_contabancariamotorista_aprovada`
   garante uma só).
5. Não está em outro lote: nenhum `RepasseLoteItem` com `situacao IN ('incluido','pago')`
   para o mesmo `(apuracao_id, entregador_id)`.

Quem falha em 3 ou 4 **aparece na prévia como bloqueado, com o motivo** (padrão `reason`
do adiantamento) — não entra no lote, mas o operador vê por que.

### D4 — Cadeia CNPJ → conta bancária (a mesma do adiantamento, medida na 0067:547/655)

`EnvioMassa.cnpj_prestador` → `ContaMotorista.cnpj_prestador` (id) →
`Entregador.motorista_id` → `ContaBancariaMotorista.entregador_id` + `status='APROVADA'`.

⚠️ **Não** ligar por `titular_documento = cnpj_prestador`: desde 2026-10-01 existe conta
**PF lançada pelo hub**, cujo `titular_documento` é CPF e **nunca** casa com o CNPJ do
prestador. Ligar por documento perderia silenciosamente esses motoristas.

### D5 — Zero permissão nova

O repasse **já vive no módulo `adiantamentos`** (`GET /repasse`, `/repasse/exportar`,
`/repasse/:periodo/fechar` todas com `requireModuloAtivo('adiantamentos')`). O lote reusa
as permissões existentes:

| Ação | Permissão |
|---|---|
| prévia, listar, detalhe | `adiantamentos.pagamentos_consultar` |
| criar lote | `adiantamentos.lote_criar` |
| baixar arquivo | `adiantamentos.exportar` |
| confirmar / retorno | `adiantamentos.pagamento_confirmar` |
| cancelar | `adiantamentos.reprocessar` |

Razão: permissão nova exigiria **espelho manual** na matriz papel×permissão — o papel
`financeiro_aprovador` (0097) nasceu como CÓPIA do `financeiro`, sem vínculo vivo, e uma
permissão dada a um **não chega** ao outro. Reusar elimina a armadilha inteira.

### D6 — Sem FK para `EnvioMassa`

Existe `DELETE /envio-massa/:id` (`server.js:1185`, permissão `envio_massa.aprovar`). Uma
FK faria esse DELETE passar a estourar violação e devolver 500 com texto cru do Postgres —
**regressão no legado**. O item guarda `apuracao_id`/`entregador_id` (tabelas do hub, com
FK) e o snapshot `col_*`; a auditoria do que foi pago sobrevive mesmo se o movimento for
excluído. Limite conhecido e aceito.

### D7 — O que reusar e o que nasce

| Peça | Decisão |
|---|---|
| `lib/adiantamento-transfeera-xlsx.js` → `montarPlanilhaTransfeera(itens, contrato)` | **Reúso direto.** Já é genérico (itens + contrato). Não renomear — renomear mexe no adiantamento em produção sem ganho. |
| `lib/fixtures/transfeera-contrato.json` (12 colunas) | **Reúso direto.** Mesmo arquivo Transfeera. |
| `lib/adiantamento-retorno-transfeera.js` (parser 23 colunas + `casarComItensDoLote`) | **Reúso com um parâmetro.** `REGEX_ID_INTEGRACAO = /^ADV-(\d+)$/` está hard-coded: passar o prefixo com default `'ADV'` (retrocompatível, adiantamento não muda) e o repasse passa `'REP'`. |
| `AdiantamentoLote` / `AdiantamentoLoteItem` | **Intocados.** `AdiantamentoLoteItem.solicitacao_id` é NOT NULL REFERENCES `AdiantamentoSolicitacao` — não cabe uma apuração. |
| `RepasseLote` / `RepasseLoteItem` + RPCs | **Novos** (migration 0108). |

### D8 — `col_id_integracao` = `REP-<lote_item_id>` com padding de 6

Espelha `hub_adiantamento_integration_id` (`ADV-` + `lpad(id,6,'0')` até 10⁶). Nova
`hub_repasse_integration_id(bigint)` com prefixo `REP-`. Usar o **id do item**, não o do
entregador: um entregador pode ser pago em semanas diferentes e cada linha do CSV precisa
casar com uma linha única.

### D9 — Confirmação manual existe, e compartilha a RPC com o retorno

Uma RPC `hub_repasse_lote_item_situacao(p_item_ids, p_situacao, p_motivo, p_origem)` com
**dois chamadores**: o importador do retorno Transfeera e a confirmação manual. Razão:
sem a manual, um pagamento feito fora do arquivo não tem como ser marcado, e `cancelar`
só devolve ao pool (não marca pago). Uma RPC, dois chamadores — não dois caminhos de
escrita.

### D10 — Fora de escopo, declarado

- Reprocessamento de item (`item_anterior_id` do adiantamento): não entra. Lote errado se
  **cancela** (devolve ao pool) e se gera outro.
- Expurgo do `arquivo` bytea por idade: o adiantamento tem (`0080`); aqui fica para
  depois, com a coluna `arquivo_expurgado_em` já criada para não exigir nova migration.
- Alterar a apuração, o extrato ou o botão "Gerar notas": **nada**. A F5 só lê.
- **Notificar o motorista de que o repasse foi pago**: fora de escopo, declarado tarde (a revisão
  adversarial apontou a omissão). O adiantamento dispara `hub_adiantamento_notificar(…,'lote_pago'/
  'lote_falhou')` por item; `hub_repasse_lote_confirmar` **não notifica nada**. Entra como dívida —
  não como "esquecimento".

## 3. Entregáveis

### 3.1 `infra/hub/migrations/0108_repasse_lote.sql`

Aditiva e idempotente. Espelha 0066 (tabelas) + 0067 (funções) no que se aplica.

**`RepasseLote`** — colunas de `AdiantamentoLote`, menos nada: `id, id_empresa, status,
criado_por, criado_em, chave_idempotencia, quantidade, valor_total, arquivo_nome, arquivo,
arquivo_sha256, arquivo_bytes, arquivo_expurgado_em, gerado_em, primeiro_download_em,
downloads, cancelado_em, cancelado_por, cancelado_motivo, nao_enviado_declarado,
concluido_em`.
- `UNIQUE (criado_por, chave_idempotencia)` — idempotência
- `CHECK status IN (...)` — mesmos estados do adiantamento
- `CHECK quantidade BETWEEN 1 AND 5000`, `CHECK valor_total > 0`
- RLS `id_empresa = ANY (hub_jwt_escopo_ids())`; **GRANT SELECT por COLUNA excluindo
  `arquivo`** (os bytes só saem pela RPC de download) — igual à 0066

**`RepasseLoteItem`** — `id, lote_id, apuracao_id, entregador_id, id_empresa, linha,
col_nome, col_documento, col_email, col_banco, col_agencia, col_conta, col_digito,
col_tipo_conta, valor, col_id_integracao, col_data_agendamento, col_descricao_pix,
conta_bancaria_id, situacao, situacao_motivo, situacao_em, situacao_por, origem_situacao`.
- FK para `RepasseLote`, `ApuracaoRepasse`, `Entregador`, `ContaBancariaMotorista`,
  `Usuario` — **nenhuma** para `EnvioMassa` (D6)
- `UNIQUE (lote_id, apuracao_id, entregador_id)`
- índice parcial em `(apuracao_id, entregador_id) WHERE situacao IN ('incluido','pago')`
  — é o índice que a revalidação "já em outro lote" usa
- `col_documento` **formatado**, nunca mascarado: `hub_adiantamento_formatar_documento(doc)`.
  ⚠️ **Correção de um erro deste plano**, pega na execução: a primeira versão mandava
  `hub_adiantamento_mascarar(doc, 2)` — foi o que a `0067` fez e a **`0074` corrigiu**, porque o
  arquivo de pagamento precisa do CPF/CNPJ **real** e documento mascarado faz o banco recusar o
  arquivo inteiro. O que está vivo no `hub_adiantamento_lote_criar` é `formatar_documento`
  (medido em `0074:17-20,163` e no `prosrc` da função viva).

**RPCs** (todas `SECURITY DEFINER`, `SET search_path = public, pg_temp`,
`REVOKE ALL FROM PUBLIC` + `GRANT EXECUTE TO authenticated`):

| RPC | Espelha | Nota |
|---|---|---|
| `hub_repasse_integration_id(bigint)` | `hub_adiantamento_integration_id` | prefixo `REP-` |
| `hub_repasse_lote_previa(...)` | `hub_adiantamento_lote_previa` | devolve elegíveis **e** bloqueados com motivo (D3) |
| `hub_repasse_lote_criar(p_chaves, p_qtd_esperada, p_total_esperado, p_chave uuid)` | `hub_adiantamento_lote_criar` | **`FOR UPDATE` em ordem de id** (anti-deadlock); revalida "já em outro lote" **sob o lock**; `PREVIA_DESATUALIZADA` se qtd/total divergirem |
| `hub_repasse_lote_arquivo(...)` | `hub_adiantamento_lote_arquivo` | grava bytes + sha256 |
| `hub_repasse_lote_download(bigint)` | `hub_adiantamento_lote_download` | única porta dos bytes; incrementa `downloads` |
| `hub_repasse_lote_cancelar(bigint, text, boolean)` | `hub_adiantamento_lote_cancelar` | devolve os itens ao pool (`situacao='cancelado'`) |
| `hub_repasse_lote_item_situacao(bigint[], text, text, text)` | — | D9: um só ponto de escrita de situação |

⚠️ O `p_chaves` do criar é um array de `(apuracao_id, entregador_id)`. Passar como
`bigint[]` de `RepasseLoteItem.id` não serve (o item ainda não existe). Usar dois arrays
posicionais `p_apuracoes bigint[]` + `p_entregadores int[]`, validando
`cardinality` igual — evita tipo composto no contrato do PostgREST.

### 3.2 `app_homologacao/backend/routes/hub-repasse-lotes.js` (novo)

Montado em `/api/v1/adiantamentos/repasse`. ⚠️ **Correção deste plano**: eu escrevi `/api/v1/repasse`, mas o `GET /repasse` real vive sob `/api/v1/adiantamentos`, então as rotas são `/api/v1/adiantamentos/repasse/lotes…`. Não colidem com `/repasse/:periodo/fechar|movimentos`. É esse o prefixo que o frontend usa. 7 rotas, espelhando
`hub-adiantamentos.js:998-1530`:

| Rota | Permissão | Nota |
|---|---|---|
| `POST /lotes/previa` | `pagamentos_consultar` | rate limiter próprio |
| `POST /lotes` | `lote_criar` | idempotente por `chave_idempotencia`; gera o XLSX e grava por `hub_repasse_lote_arquivo` |
| `GET /lotes` | `pagamentos_consultar` | lista paginada |
| `GET /lotes/:id` | `pagamentos_consultar` | detalhe + itens (**sem** `arquivo`) |
| `GET /lotes/:id/arquivo` | `exportar` | download; `Content-Disposition` com nome do lote |
| `POST /lotes/:id/cancelar` | `reprocessar` | exige motivo (3..500) |
| `POST /lotes/:id/confirmacao` | `pagamento_confirmar` | manual, item a item (D9) |
| `POST /lotes/:id/retorno` | `pagamento_confirmar` | CSV da Transfeera |

⚠️ **O `express.json()` global de 100 KB roda ANTES do router.** A rota `/retorno` precisa
de `express.text({ limit: '12mb', type: ['text/csv','text/plain'] })` **na própria rota** —
nunca subir o limite global (incidente de 2026-10-01). Copiar exatamente o padrão de
`hub-adiantamentos.js:1449`.

⚠️ **Escopo explícito em toda consulta** (`id_empresa=in.(...)`), como em
`hub-validacao-xml.js:115`. A `EnvioMassa` tem RLS com policy `USING (true)` — não filtra
nada.

### 3.3 `app_homologacao/backend/lib/adiantamento-retorno-transfeera.js` (1 parâmetro)

`lerRetornoTransfeeraCsv(csv, { prefixo = 'ADV' } = {})` e `casarComItensDoLote(linhas,
itens, { prefixo = 'ADV' } = {})`. A regex passa a ser construída do prefixo. **Default
preserva o adiantamento byte a byte** — os testes dele devem passar sem alteração (é o
controle negativo desta mudança).

### 3.4 Frontend (`frontend_v2`) — onde o dado JÁ aparece hoje

Medido antes de propor qualquer tela (regra do CLAUDE.md "Propor UI nova"):

| Já existe | Caminho | O que mostra |
|---|---|---|
| Aba **Repasse** | `app/hub/dashboard/adiantamentos/repasse/page.tsx` | o extrato da semana: `valor_pago`, `valor_nota`, `valor_fora_nota`, retido, saldo anterior/transportado. **É onde o operador já vê quem recebe quanto.** |
| Aba **Lotes** | `app/hub/dashboard/adiantamentos/lotes/page.tsx` + `lotes/[id]/page.tsx` | lista e detalhe dos lotes do adiantamento, com download e importação de retorno |
| Seção "Pagamentos retidos aguardando liberação" | `components/hub/notas-regularizadas-section.tsx` (em `validacao_xml`) | quem regularizou a nota depois do fechamento (F4b, PR #271) |
| Dialogs | `components/hub/adiantamento-{cancelar-lote,confirmar-lote,importar-retorno}-dialog.tsx` | cancelar, confirmar manual, importar CSV da Transfeera |

As abas do módulo hoje (`components/hub/adiantamentos-abas.tsx`): Solicitações · Aguardando lote ·
Lotes · **Repasse** · Contas bancárias · Configurações.

**Decisão: nenhuma tela nova, nenhuma aba nova.**

1. O ciclo do lote de repasse mora **dentro da aba Repasse**, logo abaixo do extrato — porque é ali
   que os valores já estão e é ali que o operador decide pagar. Gerar lote → baixar arquivo →
   importar retorno → ver confirmado, tudo na mesma tela, sem navegação.
2. **Os 3 dialogs são reusados como estão** (cancelar, confirmar, importar retorno), passando o
   endpoint do repasse. São genéricos o suficiente — ler antes de copiar.
3. **A aba "Lotes" não é tocada.** Generalizá-la para dois tipos de lote mexeria numa tela do
   adiantamento que está em produção, por nenhum ganho para o operador.
4. A seção "Pagamentos retidos aguardando liberação" ganha só um **link** para a aba Repasse — não um
   segundo botão de gerar lote. Um lugar para gerar, não dois.
5. **Vocabulário**: usar o que o extrato do repasse e o card do app motorista já usam
   (`VALOR DA NOTA FISCAL` / `GORJETA` / `TOTAL PRODUZIDO`). Não inventar rótulo novo para número que
   já tem nome na tela — foi o engano de 2026-09-23.

Armadilhas do repo: `Select` do Base UI exige `items` no Root; comentário JSX `{/* */}` imediatamente
após `return (` quebra o build do turbopack (usar `//` na linha de cima).

### 3.5 Testes

| Suíte | O que prova |
|---|---|
| unit (`node --test`) | `notaAprovada` em todas as combinações; prefixo `REP-`/`ADV-` no parser; `casarComItensDoLote` com os dois prefixos; montagem da planilha (12 colunas, mescla `A1:L1`) |
| integração do hub ✅ **74 PASS / 0 FAIL** | ciclo completo: prévia → criar → arquivo → retorno → concluído; idempotência (2ª chamada com a mesma chave devolve `reutilizado=true`); `PREVIA_DESATUALIZADA`; bloqueado por nota reprovada; bloqueado por falta de conta; cancelar devolve ao pool; **item já em outro lote recusado** |
| **controle negativo** | rodar a suíte **com a condição 3 de D3 desfeita** (aceitar `nota_ok` sem checar `erro_validacao`) e conferir **quais** testes falham. Teste que passa com a lógica desfeita está oco. |
| E2E do hub | o driver que cobre o repasse; rebuildar `hub-frontend:homolog` ou o gate é oco |

## 3.6 Divergências da execução (registro)

Cada uma medida e julgada; o plano acima já está corrigido onde **ele** estava errado.

| # | Divergência | Veredito |
|---|---|---|
| 1 | `col_documento` formatado, não mascarado | **O plano estava errado.** Corrigido em §3.1. Mascarar geraria um lote que o banco recusa. |
| 2 | `ApuracaoRepasseMovimento` tem `UNIQUE (apuracao_id, entregador_id)` — "todos os movimentos" é, hoje, **um** | Aceito. A lógica conta aprovadas contra total, então segue correta se a unicidade cair. Confirmado: índice `apuracaorepassemovimento_uniq`. |
| 3 | Função interna `hub_repasse_lote_avaliar(bigint[], int[])` a mais, **sem GRANT** | Aceito, e melhor que o plano: uma só definição de elegibilidade para a prévia e o criar, em vez de duas que divergem com o tempo. |
| 4 | `hub_repasse_lote_previa` com arrays opcionais (sem argumento = todos os candidatos do escopo) | Aceito; o plano deixara a assinatura aberta. |
| 5 | `hub_repasse_lote_arquivo` exige `adiantamentos.lote_criar`; a do adiantamento **não checa permissão nenhuma** | Aceito — mais restritivo que o original, e quem grava o arquivo é quem acabou de criar o lote. |
| 6 | `col_descricao_pix` guarda o **modelo bruto**; quem renderiza é o Node, via `p_itens` no `lote_arquivo` | **Aceito — e eu errei duas vezes aqui.** Primeiro mandei renderizar no SQL (vendo o `replace` da `0067`/`0074` e não notando que a **`0076` o removeu de propósito**); depois de aplicada a "correção", li `renderizarDescricaoPix` (`lib/adiantamento-transfeera-xlsx.js:37-54`) e a razão da `0076` é **segurança, não formato**: `descricao_pix_modelo` é editável por um operador do hub e o texto vai num arquivo enviado a um **sistema de pagamento de terceiro**, então `PLACEHOLDERS_PERMITIDOS` (só `nome`, `data_producao`, `data_producao:DD.MM.AA`) **lança** em qualquer outro `{...}`. Os dois `replace` do SQL deixariam `{cpf}`/`{conta}` passar literais. Revertido ao desenho da `0076`. ⚠️ **Não "corrija" isto de novo.** |

| 7 | Movimento cuja `EnvioMassa` foi excluída conta como `NOTA_PENDENTE` | Aceito e correto: sem a linha não há como provar nota aprovada, e o conservador é **não pagar**. Decorrência esperada de D6. |
| 8 | Prefixo da rota é `/api/v1/adiantamentos/repasse`, não `/api/v1/repasse` | **O plano estava errado.** Medido: o `GET /repasse` vive sob `/api/v1/adiantamentos`. |
| 9 | `hub_repasse_lote_item_situacao(ids[], situacao, motivo, origem)` → substituída por `hub_repasse_lote_confirmar(lote_id, falhas jsonb, origem)` | **O plano estava errado** e foi a 3ª vez que eu especifiquei sem olhar o que já existe. Um `p_motivo` único por chamada forçava **uma transação por motivo distinto**: um retorno com 50 devoluções de motivos diferentes = 50 chamadas, e entre elas o lote fica meio-confirmado (parte `falhou`, parte `incluido`) — estado financeiro ambíguo. O adiantamento já resolve com `hub_adiantamento_lote_confirmar(p_lote_id, p_falhas jsonb)`: uma transação, N motivos, e o que não está na lista vira `pago`. A `confirmar` atende aos dois chamadores (retorno e manual) **melhor** que a assinatura que eu dei, então a D9 se cumpre com ela. |

**Sobre a janela do snapshot** (a preocupação que me levou ao erro acima, e por que ela já tem dono):
o `col_descricao_pix` fica com o modelo bruto apenas enquanto o lote está em `GERANDO`. O
`lote_arquivo` grava o texto renderizado **na mesma transação** em que marca o lote como `EXPORTADO`,
então em `EXPORTADO` o snapshot está correto por construção. `GERANDO` é estado transitório e já tem
varredura de órfãos (`hub_adiantamento_lote_orfaos`). Fechar essa janela duplicando a validação de
placeholder em SQL custaria duas implementações de uma regra de segurança — pior que a janela.

## 3.7 Achados da revisão adversarial independente (e o que foi feito)

Revisão feita por agente que não escreveu nada da entrega, sobre o diff + os arquivos inteiros, com
prova por HTTP no PostgREST. O núcleo de dinheiro foi provado **correto linha a linha** (nenhum caminho
para pagar valor errado, pagar duas vezes, vazar tenant ou vazar os bytes do arquivo). O que ela achou
não estava na aritmética:

| # | Achado | Gravidade | Desfecho |
|---|---|---|---|
| A1 | **Lote `GERANDO` órfão tranca motoristas para sempre.** O `criar` commita com os itens em `incluido`; o Node então faz 3 chamadas HTTP para gerar o arquivo. Morrendo nessa janela (deploy reinicia o backend em **todo** `service update`, OOM, 502, SIGKILL), o índice parcial mantém cada par como `JA_EM_LOTE` e aqueles motoristas **não entram em nenhum lote futuro**. Com 5000 itens, 5000 pagamentos retidos **em silêncio**. O adiantamento se recupera em ≤5 min; o repasse, nunca. | **ALTA** | ✅ `hub_repasse_lote_orfaos(p_minutos)` + chamada no tick de 60 s do worker que já existe. Provado de ponta a ponta: prévia `apta:true` → lote `GERANDO` → `JA_EM_LOTE` → varredura → **prévia volta a `apta:true`**. |
| A2 | **Teto de 5000 no lugar errado.** Checado no Node, tornava inalcançável o 422 `LOTE_ACIMA_DO_LIMITE` — exatamente o que o espelho proíbe com comentário explícito (`hub-adiantamentos.js:1046-1050`). E a tela **não tinha como gerar lote parcial**: acima de 5000, o operador travava com "Dados inválidos". | **MÉDIA-ALTA** | ✅ teto sai do Node (a RPC recusa, 422 chega) + a tela recorta nas 5000 **mais antigas** e avisa antes de gerar. |
| A3 | **O laço que insere os itens não refiltrava `apta`.** Dois statements, snapshots diferentes em READ COMMITTED: a FastAPI gravando `erro_validacao` no meio faria uma **nota reprovada** entrar no arquivo de pagamento. | MÉDIA | ✅ `WHERE a.apta` no laço. |
| A4 | O teste das 8 rotas estava só no script `test`, não em `test:hub:unit` — a **suíte de regressão oficial do hub** (`regressao-s10.sh`) não cobria nenhuma das rotas novas. | MÉDIA | ✅ acrescentado. |
| A5 | Zero teste de integração, **e o gate "migrate.sh roda 2×" não provava nada**: a `SchemaMigration` registra **por nome, sem checksum**, e a 0108 havia sido editada depois de registrada. | MÉDIA | ✅ registro apagado e `migrate.sh` rodado 2× de verdade (1ª aplica, 2ª pula, rc=0 nas duas, ciclo repetido). Integração: ver §3.5. |
| A6 | Prévia recarrega em **todo mount** da aba, com limitador de 30/15 min — ~30 navegações dão 429. (No adiantamento a prévia é por ação explícita, por isso 30 bastam lá.) | BAIXA-MÉDIA | ✅ limitador para 120/15 min. **Teto na resposta: recusado** — a tela precisa de todos os pares para montar a geração, e pôr teto trocaria um problema de payload por um de correção no lado do dinheiro. O custo real não foi medido (o `hub_homolog` tem 1 `ApuracaoRepasseItem`). |
| A7 | `btrim(x)` sem charset remove **só espaços**, enquanto o `String.trim()` do JS remove TAB/CR/LF — um `nota_ok` com só um TAB contaria como aprovada no SQL e não-aprovada no Node. Divergência de contrato (na prática `nota_ok` é URL). | BAIXA | ✅ `btrim(x, E' \t\r\n')` nas 3 ocorrências. |
| A8 | `/confirmacao` aceitava `falhas` com `id` repetido e motivos diferentes, gravando um motivo **arbitrário**. O `/retorno` já estava protegido. Afeta a trilha, nunca o valor. | BAIXA | ✅ recusa id repetido com 400. |
| A9 | `APURACAO_ABERTA` é **código morto**: `ApuracaoRepasse.fechado_em` é `NOT NULL` e a linha só nasce no fechamento. | BAIXA | Mantido como guarda defensiva. Fica registrado que a condição 1 da D3 é garantida **pelo schema**, não por essa linha. |
| A10 | **Teste de dinheiro OCO**: `0.10 + 0.20` esperando `'0.30'` passa igual se a soma for em float. | BAIXA | ✅ reescrito com 3× `0.145` (centavos `0.42` × float `0.43`), com controle negativo. |
| A11 | O motorista **não é avisado** do pagamento; omissão não declarada. | informativo | ✅ declarado na D10 como dívida. |

**O que a revisão corrigiu no próprio plano**: a nota "sobre a janela do snapshot" (§3.6 #6) justificava
deixar `col_descricao_pix` bruto em `GERANDO` dizendo que *"`GERANDO` é transitório e já tem varredura
de órfãos"* — **a varredura não existia para o repasse**. A decisão continua certa (duplicar a allowlist
de placeholder em SQL custaria duas implementações de uma regra de segurança); o argumento que a
sustentava era falso, e agora a varredura existe de fato.

## 3.8 Contrato de dois arrays paralelos (achado que a revisão não pegou)

Veio do executor, medindo: **o teto de 5000 do lote nunca era alcançável por HTTP.** O
`express.json()` global tem 100 KB (e a regra do repo proíbe subi-lo — incidente de 2026-10-01), e o
corpo no formato `{itens:[{apuracaoId,entregadorId},…]}` estoura muito antes:

| pares | formato antigo (lista de objetos) | formato novo (2 arrays paralelos) |
|---|---|---|
| 2 500 | 105,0 KB ❌ | 26,9 KB ✅ |
| 5 000 | **210,0 KB ❌** | **53,9 KB ✅** |
| 10 000 | 419,9 KB ❌ | 107,5 KB ❌ |

Então o teto **efetivo** era ~2 600 pares, e acima disso o operador recebia **413** — não o 422 de
negócio. Recortar o lote para caber seria tratar o sintoma.

**Decisão**: `POST /lotes` e `POST /lotes/previa` recebem
`{ apuracoes: number[], entregadores: number[] }` — posicionais, índice a índice. É **exatamente** o
que a RPC já consome (`p_apuracoes`/`p_entregadores`), então a mudança:

- deixa os 5 000 da RPC alcançáveis de verdade (53,9 KB, com folga);
- não toca no parser global;
- **remove** código (`chavesParaArrays` deixou de existir; a validação virou `motivoParesInvalidos`,
  uma função com dois chamadores);
- economiza ~75% dos bytes em cada requisição.

⚠️ **Dois testes de tamanho guardam isso**: montam 5 000 pares de verdade e asseguram corpo < 100 KB
(um para o lote, um para a prévia). Sem eles, alguém engorda o payload e o 413 volta em silêncio, só
em produção, só no lote grande. O controle negativo foi feito medindo o formato antigo dentro do
teste — e ele falha, como deve.

A prévia foi unificada no mesmo formato **embora a tela não exercite esse caminho hoje** (ela chama a
prévia sem argumentos). Defeito que ninguém dispara não é defeito resolvido: é o que aparece no dia em
que alguém usar.

## 4. Pré-requisito de ambiente (medido agora)

⚠️ **O `hub_homolog` está em `0106`** — a `0107` (`regularizada_em`, já aplicada em
produção) **não está no ambiente de teste**. Antes de qualquer teste da F5:

```bash
infra/hub/scripts/migrate.sh -f infra/hub/compose.hub.homolog.yml -p hub-homolog \
  -e /var/lib/hub_secrets/.env.hub.homolog
```

e `SIGUSR1` no PostgREST do hub depois (coluna/função nova não aparece sem reload).

Confirmado: `EnvioMassa`, `Entregador`, `ApuracaoRepasse*`, `AdiantamentoLote*` **coexistem**
no `hub_homolog` — o JOIN do plano é possível no ambiente de teste, não só em produção.

### 4.1 Provas feitas no ambiente de teste (não só compilação)

| Prova | Resultado |
|---|---|
| A RPC `hub_repasse_lote_criar` roda **por HTTP no PostgREST** (não só por psql), com JWT assinado pelo helper de produção (`lib/hub-postgrest-jwt.js`), `empresa_ativa=9001` | `{"id":4,"status":"GERANDO","quantidade":1,"valor_total":100.00,"reutilizado":false}` · HTTP 200 |
| O embed `apuracao:ApuracaoRepasse(periodo_fim)` **chega preenchido** (sem ele, `renderizarDescricaoPix` receberia `undefined` e cancelaria **todo** lote — com a suíte unit verde, porque ela simula o campo) | `"apuracao":{"periodo_fim": "2026-10-11"}` · HTTP 200 |
| O `col_descricao_pix` sai com o **modelo bruto**, confirmando o desenho da `0076` no fluxo real | `Repasse {data_producao:DD.MM.AA} - {nome}` → o Node renderiza `Repasse 11.10.26 - Joao da Silva Teste` |

Os lotes criados nessas provas foram **apagados** (`lotes=0 itens=0`) para a integração exercitar o
`criar` do zero — um par `(apuracao, entregador)` com `situacao='incluido'` faria o `criar` recusar com
`ITENS_EM_OUTRO_LOTE` e a suíte falharia por causa do teste, não por regressão.

**Fixture que ficou no `hub_homolog`** (empresa 9001): config `66`, entregador `14183`
("Joao da Silva Teste"), `EnvioMassa` `15104` (nota aprovada), `ApuracaoRepasse` `62`
(2026-10-05 a 2026-10-11, fechada, repasse em 14/10), `ApuracaoRepasseItem` com `valor_pago=100`,
`ApuracaoRepasseMovimento` ligando os dois, `ContaBancariaMotorista` `61` (APROVADA).

### 4.2 Resultado dos gates por fase (números medidos)

| Fase | Gate | Antes | Depois |
|---|---|---|---|
| 2 — parser `REP-` | `npm test` (backend) | 1757 / 0 fail | 1763 / 0 fail |
| 3 — 8 rotas | `npm test` (backend) | 1763 / 0 fail | **1792 / 0 fail** |
| 4 — frontend | `tsc --noEmit` | — | 0 erros |
| 4 — frontend | `npm test` (vitest) | 839 passed / 0 | **862 passed / 0** |
| 4 — frontend | `npm run lint` | 28 problemas (5 erros, 23 avisos) | **idêntico** — nenhum erro novo |
| 4 — frontend | `npm run build` | — | OK (medido antes: 23 GB livres, 6,7 GB RAM, 2,7 GB swap; `--max-old-space-size=3072` + `nice`) |

Todas as fases com **controle negativo**: cada lógica nova foi desfeita e os testes que falharam
estão nomeados nos relatórios. Nenhum teste preexistente foi editado para passar.

### 4.3 Correção de outra instrução minha errada

Mandei a fase 4 usar os rótulos `VALOR DA NOTA FISCAL` / `GORJETA` / `TOTAL PRODUZIDO` "que já existem
na tela". **Não existem em tela nenhuma do hub** — vivem só no card do app motorista, e a prévia do
lote devolve **um** valor por pessoa, não três. Medido e divergido na execução, com razão. O que a
seção reusa de vocabulário existente: "A pagar", "Fechar apuração", "Contas bancárias",
"Validação XML".

### 4.4 E2E: por que é obrigatório aqui

Medido: `tests/e2e-hub-browser/impeccable-rodada9.spec.ts` e `menus-por-papel.spec.ts` cobrem a tela
`validacao_xml`, que ganhou o link; e os 3 dialogs parametrizados são usados pela tela de lotes do
**adiantamento**, que também tem specs. Então a entrega toca caminho coberto por E2E e o rito exige
rodá-lo. ⚠️ Exige **rebuildar `hub-frontend:homolog`** antes — sem isso o E2E roda contra a imagem
antiga e o gate é oco (incidente de 2026-10-01).

### 4.5 Integração: `infra/hub/testes/hub-repasse-lote-integration.sh`

**74 PASS / 0 FAIL**, repetível (duas rodadas seguidas, 74/0 nas duas). Registrado em
`npm run test:hub:integration`, que fecha **15/15, 0 fail** (~19 min) sem quebrar nenhum driver que já
passava.

Roda num projeto **efêmero** `hub-test-<runid>` (db + postgrest em tmpfs, `migrate.sh` até a 0108),
então é repetível por construção e **não escreve no `hub_homolog`**. Cria os próprios usuários
(`financeiro_aprovador`, `financeiro`, operador de outra empresa) e pares completos.

Cobre os 20 cenários da §3.5 mais: `financeiro` recebendo `PERMISSAO_NEGADA` ao confirmar; item
`falhou` devolvendo o par ao pool com lote `CONCLUIDO_COM_FALHAS`; a varredura de órfãos **não**
cancelando lote recém-criado na janela de 5 min; `col_documento` saindo formatado; e a descrição Pix
renderizada pelo Node substituindo o modelo bruto.

**Controle negativo: 11 mutações na `0108`, todas derrubaram o driver** (checks caídos em cada):
órfãos sem cancelar itens (3) · `orfaos` sem guarda de worker (5) · sem filtro de tenant (12) · nota
reprovada passando (12) · sem idempotência (1) · `totalEsperado` ignorado (2+) · `arquivo` no GRANT
(2) · sem "já em outro lote" (2) · `cancelar` sem devolver ao pool (3) · `download` sem incrementar (1)
· `confirmar` sem guarda de estado (11). O sha256 da `0108` voltou ao original depois das mutações.

⚠️ **Um teste oco pego em flagrante**: na 1ª versão o driver passou 73/1 porque um `UPDATE` de fixture
era recusado por **trigger de imutabilidade** da `ApuracaoRepasseItem`, e o check de `VALOR_INVALIDO`
passava **pelo motivo errado** (o `criar` recusava pelo total esperado zero, não pelo valor). Correção
estrutural: o helper de mutação agora **aborta o driver** se uma mutação de fixture for recusada.

**Regras de produto descobertas aqui** (não estavam no plano): `ApuracaoRepasse`/`ApuracaoRepasseItem`
são **imutáveis por trigger**; `ApuracaoRepasse` é única por (empresa, `periodo_inicio`); a conta
bancária vai para `CANCELADA`, não `REJEITADA`; e **o lote vira `GERADO` no `lote_arquivo` e `EXPORTADO`
só no primeiro download** — como `confirmar` exige `EXPORTADO`, **o operador precisa baixar o arquivo
antes de poder confirmar o pagamento** (coerente: não se confirma o que não foi enviado).

**Sem cobertura de integração, declarado** — as 8 rotas Node ficam só com unit (PostgREST simulado):
parser do CSV com `REP-`, `express.text` de 12 MB, geração real do XLSX, `Content-Disposition`,
limitadores. Um driver com backend exige build de ~700 MB e o disco estava no piso de 20 GB, então foi
**recusado deliberadamente**. Também fora: o tick real do worker, concorrência (dois `criar`
simultâneos — e por consequência o achado A3), `LOTE_ACIMA_DO_LIMITE` na integração, e
`ITEM_FORA_DO_LOTE`/`MOTIVO_OBRIGATORIO`.

### 4.6 E2E do hub: 8 drivers, 236 passed / 0 failed / 0 flaky

Rodado **contra a imagem rebuildada** — `hub-frontend:homolog` de `sha256:7a65ad1f5f7f…` para
`sha256:5e18a5fa4e2c…`, com o container recriado e o ID novo confirmado por `docker inspect`. Sem esse
rebuild o E2E rodaria contra a imagem antiga e o gate seria oco.

| Driver | Passed | Tempo |
|---|---|---|
| shell-e2e-browser | 142 | 234 s |
| motorista-adiantamento-e2e-browser | 51 | 99 s |
| motorista-push-e2e-browser | 19 | 50 s |
| adiantamentos-e2e-browser | 13 | 26 s |
| avisos-e2e-browser | 5 | 137 s |
| auditoria-admin-a11y-smoke / envio-massa-a11y-smoke / motorista-360 | 2 cada | 15/8/7 s |

Todos com 0 failed e 0 flaky. Os 8 vieram de `grep -l PLAYWRIGHT_IMAGE` — ⚠️ **não** de
`--network host`, critério que já fez alguém contar 5 em vez de 8.

**O risco que este gate existia para pegar**: `adiantamentos-e2e-browser` (13 passed) exercita a tela
de lotes do **adiantamento**, onde vivem os 3 dialogs parametrizados. Um default mal preservado
quebraria produção, não o repasse. Não quebrou.

⚠️ **O que este gate NÃO prova**: nenhum spec exercita `repasse-lotes-section.tsx`. Ele prova que
**nada existente quebrou** — não que a seção nova funciona. A validação da tela nova depende do
operador ou de spec novo (dívida declarada, não coberta).

Disco: 26 → 24 GB no build, 26 GB após limpeza (`image prune -f` sem `-a`, 683 MB; `builder prune`
rendeu 0 B — o host usa `DOCKER_BUILDKIT=0`). Piso de 20 GB nunca cruzado.
`package-lock.json` limpo (o container do Playwright não o reescreveu nesta rodada).

## 5. Ordem de execução (fases para o Sonnet)

1. **0108** — tabelas + RPCs. Gate: `migrate.sh` idempotente (roda 2× sem erro), aplicada
   no `hub_homolog` (depois de atualizar 0107), `SIGUSR1`, e cada RPC provada por `curl`
   ao PostgREST do hub.
2. **lib** — prefixo parametrizável. Gate: suíte do adiantamento **verde sem alteração**
   (controle negativo da retrocompatibilidade).
3. **rotas** — `hub-repasse-lotes.js` + registro no `server.js`. Gate: unit + integração.
4. **frontend** — botão + tela. Gate: `tsc --noEmit`, `next build`, vitest, detector
   impeccable 0 achados, E2E do hub.
5. **PR** — um só, com números de cada gate e o que ficou de fora (D10).

Sem deploy nesta frente até o operador autorizar a etapa.

---

Decisões tomadas em 2026-10-12 sobre medição direta do banco `hub_homolog` e do código em
`main`. Nada aqui foi suposto: cada afirmação acima tem a medição ao lado.

# Feature Specification: O repasse gera o movimento no Envio em Massa

**Feature**: `repasse-gera-movimento`
**Created**: 2026-10-28
**Status**: Draft
**Fonte autoritativa**: `docs/plans/repasse-gera-movimento/BRIEFING.md` (decisoes D1-D12 do operador, todas tomadas antes da especificacao; nao ha item a definir).

## Contexto e problema

A deducao dos valores pagos por fora (frente `lancamento-externo`) so acontece no **fechamento da apuracao** do repasse. A operacao real nunca fecha apuracao: paga por **planilha** no Envio em Massa. Medido em 2026-10-28: 0 apuracoes fechadas na historia, 0 lancamentos pagos por fora, 116 adiantamentos pendentes na semana 19-25/10. Resultado: a deducao esta em producao e **sem efeito**.

Correcao pedida pelo operador: o financeiro passa a **gerar o movimento do Envio em Massa a partir do repasse**, em vez de fechar a apuracao e subir planilha. Dai em diante (disparo, emissao de nota, validacao de XML, fechamento de movimento) o fluxo e o que ja roda hoje. A unica mudanca e a forma de preencher o Envio em Massa.

Esta feature e um **desacoplamento**: a geracao de movimentos a partir de uma apuracao fechada ja existe e e testada; passa a nao exigir que o financeiro feche a apuracao antes.

## User Scenarios & Testing

### User Story 1 - Gerar as notas da semana direto da tela de Repasse (Priority: P1)

O financeiro abre a tela de Repasse, ve a semana (19-25/10, por exemplo) com os valores por motorista e aciona "Gerar notas da semana". O sistema congela os valores da semana e cria, para cada motorista elegivel, o movimento no Envio em Massa com o valor da nota e a gorjeta. O financeiro nunca precisa saber o que e "apuracao".

**Why this priority**: e o corte minimo que devolve efeito real a toda a cadeia (repasse, deducao de pago por fora, saldo): sem isto, nada do que foi construido chega ao motorista.

**Independent Test**: com a semana na tela em estado aberto (nenhuma apuracao fechada), sem adiantamento pendente e com modelo de mensagem configurado, acionar a geracao e conferir que cada motorista elegivel aparece no Envio em Massa com valor da nota e gorjeta iguais aos exibidos na tela, e que o retrato congelado da semana passou a existir.

**Acceptance Scenarios**:

1. **Given** uma semana sem apuracao fechada e sem adiantamento pendente, **When** o financeiro aciona "Gerar notas da semana", **Then** a apuracao da semana e fechada e os movimentos sao criados na mesma operacao, e o resultado informa quantos foram gerados e quantos recusados com motivo.
2. **Given** a mesma semana ja processada, **When** o financeiro aciona a geracao de novo, **Then** nenhum movimento duplicado e criado (motoristas ja gerados aparecem como "ja gerado").
3. **Given** a geracao falha no meio do fechamento da apuracao, **When** a operacao termina com erro, **Then** nao fica apuracao fechada sem movimentos: o estado volta ao anterior e o financeiro pode tentar de novo.
4. **Given** a tela de Repasse, **When** a semana esta aberta, **Then** o botao "Gerar notas da semana" esta habilitado e nao existe mais o botao manual "Fechar apuracao".
5. **Given** a semana exibida na tela (D9), **When** o financeiro aciona a geracao, **Then** o sistema processa exatamente essa semana, com os mesmos numeros que ele esta vendo.

---

### User Story 2 - Pago por fora abate a nota, e o excedente vira saldo (Priority: P1)

Quando o motorista ja recebeu valores por fora, o sistema abate esse valor **somente da parte da nota** (a gorjeta nunca e tocada). Se o pago por fora for maior que a parte da nota, a nota e zerada (nao e emitida), a gorjeta segue intacta e o excedente vira saldo que reduz o repasse da semana seguinte.

**Why this priority**: e a razao de a frente `lancamento-externo` existir; sem a regra correta no momento da geracao, o dinheiro sai errado ou a deducao continua sem efeito.

**Independent Test**: tres motoristas na mesma semana - pago por fora menor que a nota, igual, e maior. Conferir nota, gorjeta e saldo transportado de cada um; conferir que na semana seguinte o saldo do terceiro chega e reduz o valor dele.

**Acceptance Scenarios**:

1. **Given** um motorista com parte da nota de R$ 100 e pago por fora de R$ 30, **When** a geracao roda, **Then** o movimento sai com nota de R$ 70 e a gorjeta original inalterada.
2. **Given** um motorista com parte da nota de R$ 100 e pago por fora de R$ 130, **When** a geracao roda, **Then** nenhuma nota e emitida para ele, a gorjeta segue intacta (e, havendo gorjeta, e paga por um movimento so-com-gorjeta de nota R$ 0 — FR-022) e R$ 30 de excedente ficam como saldo para a semana seguinte.
3. **Given** o excedente de R$ 30 transportado da semana anterior, **When** a semana seguinte e gerada, **Then** o saldo chega ao calculo da semana e reduz a parte da nota do motorista em R$ 30; sem o transporte do excedente, o valor da semana seguinte seria maior (controle negativo exigido).
4. **Given** um motorista sem pago por fora, **When** a geracao roda, **Then** o resultado e identico ao de antes desta feature.

---

### User Story 3 - Recusa por adiantamento pendente lista quem trava (Priority: P1)

Se ha adiantamentos do app ainda pendentes na semana, a geracao e recusada por inteiro, protegendo contra pagar duas vezes (a nota seria emitida antes de o adiantamento ser pago). A recusa **nomeia** quem trava: quantos adiantamentos, em que status e quais motoristas.

**Why this priority**: a semana atual tem 116 pendentes; sem a lista, o financeiro nao tem como destravar e a feature fica inutilizavel por adivinhacao.

**Independent Test**: com adiantamentos em status pendente na semana, acionar a geracao e conferir que nada foi criado nem fechado e que a resposta traz contagem por status e nomes dos motoristas.

**Acceptance Scenarios**:

1. **Given** adiantamentos pendentes na semana (liberados e exportados), **When** o financeiro aciona a geracao, **Then** a operacao e recusada, nenhum movimento e criado, a apuracao nao e fechada, e a tela mostra a contagem por status e os nomes dos motoristas que travam.
2. **Given** todos os adiantamentos da semana resolvidos, **When** o financeiro aciona a geracao, **Then** ela prossegue normalmente.

---

### User Story 4 - Gerar tambem a partir da tela de Envio em Massa (Priority: P2)

Ao lado do upload de planilha na tela de Envio em Massa, o financeiro encontra o botao "Gerar do repasse", que faz exatamente a mesma geracao da tela de Repasse - um unico componente, uma unica regra - para a semana em exibicao.

**Why this priority**: e onde a operacao ja trabalha; mas a story 1 entrega valor sem ela.

**Independent Test**: acionar a geracao a partir da tela de Envio em Massa e conferir resultado identico ao acionado pela tela de Repasse para a mesma semana, e que ambas as telas usam o mesmo componente.

**Acceptance Scenarios**:

1. **Given** a tela de Envio em Massa com semana selecionada, **When** o financeiro aciona "Gerar do repasse", **Then** o resultado (gerados, recusados, motivos, adiantamentos que travam) e igual ao da tela de Repasse.
2. **Given** um usuario sem permissao de confirmar pagamento, **When** abre qualquer das duas telas, **Then** nao consegue acionar a geracao.

---

### User Story 5 - Casos recusados protegem o dinheiro (Priority: P2)

A geracao recusa, motorista a motorista e com motivo claro, os casos em que emitir seria errado: motorista que ja tem movimento aberto da planilha, valor abaixo do minimo (retido e somado a semana seguinte), motorista sem CNPJ, base zero. Se a empresa nao tem modelo de mensagem configurado, a geracao e recusada e o sistema avisa - nunca inventa texto.

**Why this priority**: preserva comportamentos que ja existem; o risco e regredi-los ao desacoplar.

**Independent Test**: um motorista de cada caso na mesma semana; conferir o motivo de cada recusa e que so os elegiveis geram movimento.

**Acceptance Scenarios**:

1. **Given** um motorista que ja tem movimento aberto vindo da planilha, **When** a geracao roda, **Then** nao gera movimento para ele e avisa o motivo.
2. **Given** um motorista cujo valor esta abaixo do minimo de R$ 5,50, **When** a geracao roda, **Then** nao gera nota e o valor se soma a semana seguinte.
3. **Given** uma empresa sem modelo de mensagem configurado, **When** a geracao e acionada, **Then** a operacao e recusada com aviso explicito e nenhum texto de mensagem e inventado.
4. **Given** uma geracao concluida com linha errada, **When** o financeiro precisa corrigir, **Then** corrige pela tela de Envio em Massa (editar valor com motivo ou apagar a linha); nao existe botao de desfazer a geracao.

---

### Edge Cases

- Dois financeiros acionam a geracao da mesma semana ao mesmo tempo: no maximo uma apuracao e um conjunto de movimentos por motorista; o segundo ve "ja gerado".
- Semana ja com apuracao fechada anteriormente (por outro caminho): a geracao usa a apuracao existente, sem fecha-la de novo.
- Semana em que a unica pendencia e adiantamento resolvido depois da recusa: nova tentativa passa sem estado residual da tentativa recusada.
- Empresa/tenant: a geracao so le e grava dados do grupo da empresa ativa; o Envio em Massa nao tem isolamento proprio no banco, entao todo acesso precisa de filtro explicito de empresa.
- Movimento de fechamento do Envio em Massa ("Fechar movimento") nao e afetado: e outro conceito, manual e opcional.
- Motorista com pago por fora e valor abaixo do minimo apos o abatimento: aplica-se a retencao com o saldo.

## Requirements

### Functional Requirements

- **FR-001**: O sistema MUST permitir gerar os movimentos da semana a partir do repasse sem que o financeiro tenha fechado a apuracao antes (D1).
- **FR-002**: Quando a apuracao da semana nao existir, a geracao MUST fecha-la automaticamente e criar os movimentos na mesma operacao atomica; falha em qualquer parte MUST nao deixar apuracao fechada sem movimentos nem movimentos sem apuracao (D1, risco do caminho do dinheiro).
- **FR-003**: O valor congelado de cada motorista na apuracao MUST ser o usado para criar o movimento, de modo que o movimento gerado coincida com os numeros exibidos na tela de Repasse (D9).
- **FR-004**: A geracao MUST processar exatamente a semana que estiver em exibicao na tela de onde foi acionada (D9).
- **FR-005**: O valor pago por fora MUST ser abatido somente da parte da nota; a gorjeta MUST permanecer intacta (D2).
- **FR-006**: Quando o pago por fora superar a parte da nota, o sistema MUST zerar a nota (nao emiti-la), manter a gorjeta e transportar o excedente como saldo para a semana seguinte pelo mecanismo de transporte existente (D3). "Nao emiti-la" nao significa "nao pagar a gorjeta": o caso em que sobra gorjeta tem tratamento proprio em FR-022.
- **FR-007**: O saldo transportado por excedente MUST chegar ao calculo da semana seguinte e reduzir o valor do motorista, comprovado por teste com controle negativo (D3).
- **FR-008**: Enquanto houver adiantamento do app pendente na semana, a geracao MUST ser recusada por inteiro e nada MUST ser criado nem fechado (D5).
- **FR-009**: A recusa por adiantamento pendente MUST listar quantos adiantamentos travam, em que status e de quais motoristas (nomes) (D5).
- **FR-010**: Motorista que ja tem movimento aberto vindo da planilha MUST nao gerar movimento e MUST ser avisado como recusado com motivo (D6).
- **FR-011**: Valor abaixo do minimo de R$ 5,50 MUST manter a retencao: nao gera nota e soma na semana seguinte (D7).
- **FR-012**: A mensagem ao motorista MUST usar o modelo configurado da empresa; modelo ausente MUST recusar a geracao com aviso, sem nunca inventar texto (D10).
- **FR-013**: A tela de Repasse MUST habilitar "Gerar notas da semana" sem exigir periodo fechado e MUST nao exibir mais o botao manual "Fechar apuracao"; a capacidade de fechar a apuracao MUST permanecer no sistema, acionada apenas pela geracao (D4).
- **FR-014**: A tela de Envio em Massa MUST oferecer, ao lado do upload, o botao "Gerar do repasse" (D8).
- **FR-015**: Os botoes das duas telas MUST ser um unico componente com uma unica chamada, de modo que as duas telas nunca divirjam (D8).
- **FR-016**: Apenas usuarios com a permissao de confirmar pagamento MUST poder acionar a geracao, nas duas telas.
- **FR-017**: A geracao MUST ser idempotente por semana e motorista: repetir nao cria movimento duplicado.
- **FR-018**: Toda leitura e escrita da geracao no Envio em Massa MUST ser restrita explicitamente a empresa do grupo ativo, pois essa tabela nao tem isolamento proprio.
- **FR-019**: Correcao de geracao errada MUST ser feita pelos recursos ja existentes da tela de Envio em Massa (editar valor com motivo, apagar linha); o sistema MUST NOT oferecer desfazer a geracao (D11).
- **FR-020**: O fechamento de movimento do Envio em Massa, a **emissao** e a **validacao de XML** MUST permanecer inalterados (D12).
- **FR-020a** (emenda de FR-020 — `block-004`, autorizacao do operador em 28/10; registrada na onda-017): o **disparo em lote** e a **entrada** (upload de planilha e correcao de movimento) **mudaram**, e a redacao original de FR-020 ("todo o fluxo posterior ao movimento criado, disparo, emissao, validacao de XML, MUST permanecer inalterados") passou a ser **falsa** no instante em que FR-022 criou o movimento so-gorjeta. O motivo e o achado critico do review: sem a mudanca, o WhatsApp mandava *"valor total para emissao da NF e de R\$ 0,00"* para um movimento que o app esconde (FR-023) — o filtro estava em todo caminho que o motorista **le** e em nenhum dos que **mandam ele agir**. O que vale hoje:
  - **Chave unica de "ha nota a emitir" = `EnvioMassa.valor > 0`**, a MESMA do app (`VALOR_EMITIVEL`, FR-023) e do lote do repasse (`lib/disparo-alvo.js:7`, `valorEmissivel`). Esta unificacao e o que fecha a divergencia de duas chaves apontada no review.
  - **Disparo**: `processBatchMessages` MUST alcancar somente linha com `valor > 0` — `server.js:1341` usa `selecionarAlvoDisparo(data, ids)`, onde `ids` so **RESTRINGE**, nunca amplia (`lib/disparo-alvo.js:9`-`:16`). O movimento so-gorjeta existe para **pagamento** e nunca recebe disparo.
  - **Entrada** (`/upload` em `server.js:1963` e correcao em `lib/envio-massa-correcao.js:163`): MUST recusar a linha somente quando **nao ha nada a pagar nem a emitir** — `linhaSemNada(valor, gorjeta)` (`lib/disparo-alvo.js:19`). `valor = 0` **com** gorjeta e planilha legitima (mesma regra de `soGorjetaPorDeducao`); `valor = 0` **sem** gorjeta passa a ser recusado na entrada. No `/upload` a guarda so vale quando o arquivo **tem** a coluna de gorjeta: sem ela nao se pode concluir "nao ha gorjeta", e como o `/upload` e tudo-ou-nada (`server.js:2031`) uma linha de valor 0 derrubaria a planilha inteira.
  - Fora da emenda, D12 segue integral: `POST /repasse/:periodo/fechar`, a emissao e a validacao de XML **nao** foram tocados.
- **FR-021**: As duas centrais de ajuda (app/hub) MUST descrever o novo fluxo de geracao pelo repasse.
- **FR-022** (dec-054, decisao do operador 28/10): Quando a nota do motorista zerar **por deducao do pago por fora** e houver gorjeta, a geracao MUST criar o movimento **so com a gorjeta** — `EnvioMassa` com `valor = 0`, `gorjeta > 0`, `total = gorjeta` — e o motorista MUST NOT receber pedido de nota. Dispara quando `base_nota > 0` (a mesma base do fechamento: `valor_nota` mais o saldo de nota carregado, este ultimo ignorado em semana de remanescente negativo), `nota_a_emitir <= 0` e `gorjeta > 0`. Se a base ja era zero (o motorista nao produziu nota) ou nao ha gorjeta, nao ha o que pagar nem o que emitir e a recusa `VALOR_ZERO` permanece. Como esse movimento nunca tera nota validada, o lote de pagamento MUST NOT devolve-lo como `NOTA_PENDENTE` quando `nota_a_emitir = 0` (migration `0119`; `NULL` mantem o comportamento anterior).
- **FR-023** (dec-056, decisao do operador 28/10): As rotas do app do motorista MUST considerar **nota emitivel** somente o movimento com `valor > 0` (`valor=gt.0`): `0`, negativo e `NULL` nao sao nota emitivel. O filtro MUST valer para **listagem E envio**, para que a tela e o envio resolvam a MESMA linha — sem ele quem tem o id ainda enviaria nota para uma linha oculta, e a nota cairia num movimento diferente do exibido. Sitios: `GET /motorista/movimento-aberto`, `POST /motorista/validar-nota`, `GET /motorista/notas-pendentes` e `POST /motorista/notas-pendentes/:id/validar` (constante `VALOR_EMITIVEL` em `routes/motorista.js`). Efeito: o movimento so-com-gorjeta de FR-022 existe para pagamento e nunca aparece como nota a enviar.

### Key Entities

- **Apuracao do repasse**: retrato imutavel da semana, com valores congelados por motorista (nota, fora-nota, saldo anterior, transportado). Passa a ser criada pela propria geracao, invisivel ao financeiro.
- **Movimento (Envio em Massa)**: linha com valor da nota e gorjeta de um motorista numa semana, a partir da qual o fluxo existente emite a nota.
- **Trilha de geracao**: registro de qual movimento foi gerado para cada motorista em cada apuracao; garante a idempotencia.
- **Pago por fora**: lancamento externo ja registrado que abate a parte da nota.
- **Saldo transportado**: valor retido (por minimo) ou excedente (pago por fora maior que a nota) que passa para a semana seguinte.
- **Adiantamento pendente**: adiantamento do app ainda em status liberado ou exportado na semana; trava a geracao.

## Success Criteria

### Measurable Outcomes

- **SC-001**: O financeiro gera os movimentos de uma semana em um unico acionamento, sem passo previo de fechamento: 1 acao em vez de 2 (fechar + gerar) ou de montar e subir planilha.
- **SC-002**: Em 100% das geracoes, o valor de nota e gorjeta de cada movimento coincide com o exibido na tela de Repasse para a mesma semana.
- **SC-003**: 0 casos **terminais** de apuracao fechada sem movimento correspondente apos uma geracao com falha — ou seja, toda apuracao fechada sem movimento e **retomavel** por um novo acionamento da mesma rota, e a retomada nao duplica.

  ⚠️ **Emenda de artefato** (fase `plan`, `dec-028`; autorizada pelo operador na resposta ao `block-001`). A redacao original — *"0 casos de apuracao fechada sem movimento"* — e **inatingivel por medicao, nao por escolha de desenho**: `ApuracaoRepasse` e `ApuracaoRepasseItem` tem `REVOKE UPDATE, DELETE ... FROM authenticated` (`infra/hub/migrations/0066_adiantamento_tabelas.sql:460`-`:461`) **e** trigger `hub_bloqueia_alteracao_apuracao()`, que faz `RAISE EXCEPTION` incondicional (`:463`, instalado em `:470`-`:478`). Rollback de apuracao **nao existe** neste banco; nenhum desenho possivel entrega "0 casos". O que se mede no lugar e a ausencia de **beco sem saida** — a propria rota e o caminho de volta (`quickstart.md` C3). A emenda troca um criterio impossivel por um criterio **verificavel**; o escopo da feature nao muda.
- **SC-004**: 0 movimentos duplicados ao repetir a geracao da mesma semana.
- **SC-005**: Para cada motorista com pago por fora, 100% do abatimento sai da parte da nota, 0% da gorjeta, e todo excedente reaparece como saldo na semana seguinte.
- **SC-006**: Em 100% das recusas por adiantamento pendente, a mensagem nomeia a quantidade, o status e os motoristas que travam.
- **SC-007**: Os dois botoes (Repasse e Envio em Massa) produzem resultado identico para a mesma semana.
- **SC-008**: Nenhuma regressao nas suites e verificacoes existentes (backend, hub, frontend, E2E, roundtrip, rollback).

## Delta Requirements

**Skip**: Corpus canonico `docs/specs/current/` inexistente neste projeto; as mudancas de comportamento ativo estao documentadas no briefing `docs/plans/repasse-gera-movimento/BRIEFING.md` — Paulo (operador)/feature-00c, 2026-10-28

## Clarifications

### Session 2026-10-28

Nenhuma pergunta aberta. Toda candidata a ambiguidade ja tem resposta no BRIEFING §4 (D1-D12), conferida item a item:

- Quando congela o valor / visibilidade de "apuracao" -> D1, D4
- Base da deducao e excedente -> D2, D3
- Adiantamento pendente -> D5 (recusa + lista)
- Movimento da planilha, minimo, modelo de mensagem -> D6, D7, D10
- Onde dispara e qual semana -> D8, D9
- Correcao e "Fechar movimento" -> D11, D12
- Concorrencia/falha parcial: coberto por FR-002/FR-017 e Edge Cases (transacao unica + idempotencia); detalhe tecnico e do plan.

### Review Findings — revisão adversarial de 3 camadas sobre `1ae29af` (2026-10-28)

Blind Hunter (só o diff) · Edge Case Hunter (diff + projeto) · Acceptance Auditor (diff + spec),
em paralelo, sem contexto da sessão. Convergência em 2 ALTOS; 7 achados refutados por medição
primeira-mão (ver "Descartados" no fim).

- [ ] [Review][Decision] **`/upload` recusa o ARQUIVO INTEIRO por linha de valor 0, e o movimento só-gorjeta não sobrevive ao round trip exportar→reimportar** — 3 camadas (edge A1 + auditor A2 + blind M7). Medido por mim, as três partes: a guarda nova está em `server.js:1962-1965`; a rejeição é **global** (`server.js:2031` `if (errors.length > 0)` ⇒ 400 "Nenhum registro foi inserido"); e `/export-envio-massa` (`server.js:2141`) **não exporta `gorjeta`** (grep = 0). Cenário: o hub gera `valor=0, gorjeta=200`; o operador exporta (CSV sai sem a coluna gorjeta), corrige um CNPJ e reimporta ⇒ `linhaSemNada(0, null)` = true ⇒ arquivo todo recusado, sem caminho de volta. Agravante: a guarda ignora `temColunaGorjeta`, que a ESCRITA honra (`server.js:1983`). Atinge **todos os tenants**, não só a Movee. Autorizado em `block-004`, mas a autorização não previa o tudo-ou-nada nem o export sem gorjeta.
- [ ] [Review][Decision] **O movimento só-gorjeta nasce aberto, é invisível ao motorista, e trava a geração da semana seguinte; a reserva órfã não tem como ser apagada** — 3 camadas (blind A1/A3 + edge A2 + auditor A1). `adiantamento-geracao-movimento.js:172` grava `valor=0, gorjeta>0, mov_fechado=false`; a guarda de abertos (`hub-adiantamentos.js:2346`) não filtra valor; `VALOR_EMITIVEL` esconde a linha do app ⇒ o motorista **não consegue** enviar nota para fechá-la. `0092:63` concede `SELECT, INSERT` em `ApuracaoRepasseMovimento` — **sem DELETE**, nem para o backend. Medido em produção: 937 movimentos abertos no grupo Movee hoje, **0** com `valor<=0` (o caso ainda não existe; passará a existir na 1ª geração).
- [ ] [Review][Patch] **5ª porta sem filtro de valor: `/validate-xml-batch`** [`app_homologacao/backend/server.js:2528`] — casa o movimento aberto mais recente por CNPJ sem `valor=gt.0`, ao contrário das 4 rotas do app (`motorista.js:712/830/1066/1146`). Um `erro_validacao` gravado numa linha só-gorjeta bloqueia o lote, e o motorista não a vê para regularizar.
- [x] [Review][Defer] **`nota_a_emitir` é calculada pelos dois RPCs e ninguém a consome — o CSV e a tela mostram a nota BRUTA** [`routes/hub-adiantamentos.js:2011-2027` e `:2096-2116`] — 2 camadas (edge M1 + blind M1). `grep notaAEmitir` no `frontend_v2` = 0. O financeiro confirma uma ação **irreversível** vendo `valorNota = 100,00` quando a nota sairá `70,00`. **SC-002 da própria `0118` ("a tela mostra o que a geração usará") não está ligado.** — ⚠️ **reclassificado por mim de `patch` para `defer`**: as duas camadas reportaram como esquecimento, mas já era dívida **declarada** em `deferred-work.md:117` (a coluna nova muda o contrato do CSV que o driver de roundtrip verifica, e o rótulo cria um segundo vocabulário para a mesma conta). A severidade que elas mediram foi incorporada ao registro; a decisão do rótulo é do financeiro.
- [x] [Review][Patch] ✅ **RESOLVIDO na onda-017** — **Três documentos afirmavam o OPOSTO do que o código faz sobre FR-020**. A emenda de FR que faltava virou **FR-020a** (acima): separa o que ficou intocado (fechamento, emissão, validação de XML) do que mudou por `block-004` (disparo via `selecionarAlvoDisparo`, `server.js:1341`; entrada via `linhaSemNada`, `server.js:1963` e `lib/envio-massa-correcao.js:163`). Os três documentos foram acertados: `plan.md` (já corrigido em 28/10, agora remete a FR-020a), `tasks.md` 5.4.3 (asserção reescrita e **fechada**) e a linha de rastreio FR-019/FR-020 da matriz. FR-020a também registra que a chave de "há nota a emitir" ficou **única** (`valor > 0`), o que fecha a divergência de duas chaves apontada pelo review.
- [x] [Review][Patch] ✅ **RESOLVIDO** — **Alarme que sobreviveu à causa**: a linha dizia que os 3 achados da onda-013 **não foram corrigidos** e remetia a uma seção "🛑 ABERTO" do `RUNBOOK-DEPLOY.md` que **já não existe** (a seção foi removida justamente porque os achados foram corrigidos). Era a minha própria nota da onda-014 sobrevivendo à causa. O texto foi reescrito em 28/10 e hoje remete a `deferred-work.md` §Onda-015 e `RUNBOOK-DEPLOY.md` §"3 achados" (`dec-073`); conferido de novo na onda-017 e consistente nos três documentos.
- [x] [Review][Defer] Divergência entre a linha da `EnvioMassa` e o que é pago numa semana isolada [`adiantamento-geracao-movimento.js:166`] — deferido: **herdado e REDUZIDO** por esta entrega (o gap cai de 70 para 30), porque a gorjeta nunca é abatida. Fecha em duas semanas (conferido pelo revisor: 270 de caixa contra 270 de documentos).
- [x] [Review][Defer] Botão na `ActionBar` com data livre enquanto a rota usa `GRUPO_MOVEE_ID` fixo [`components/hub/gerar-do-repasse-button.tsx`] — deferido: hoje `requireModuloAtivo('adiantamentos')` segura, e S2 já está registrado com 0 portadores.
- [x] [Review][Defer] `valor=gt.0` é retroativo: linha histórica com valor 0/NULL sai do app e dá 404 em `/notas-pendentes/:id/validar` — deferido: o volume não foi medido (a consulta foi bloqueada pelo classificador); gatilho = medir antes do deploy.

**Descartados por medição primeira-mão** (para não serem reinvestigados):
`EnvioMassa.id` seria `GENERATED ALWAYS` e toda geração falharia — **medido: `identity_generation = BY DEFAULT`**, o INSERT com id explícito funciona. · `LEAST` sem piso inflando a nota — **`0117:75` tem `CHECK (valor > 0)`**. · falta `COALESCE` em `lancamentos_externos` — **coluna é `NOT NULL DEFAULT 0` e o join da `0119` é direto, não LEFT; 0 linhas na tabela**. · "fechar movimento virou pré-requisito semanal e D12 o declara opcional" — **medido: 53.988 fechados contra 937 abertos, a operação já fecha 98,3%**. · o gate da `0119` excluiria movimento de planilha — **diff byte a byte: o ramo (b) do UNION da `0109` está idêntico**. · ficou uma 5ª rota do app sem filtro — **as 4 são as certas** (a 5ª porta é no painel, ver acima). · "apuração fechada sem movimento" seria deadlock — **o botão não depende do estado do período, reapertar relê e gera**.

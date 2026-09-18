# Feature Specification: Adiantamento pelo App, Dados Bancários e Exportação Transfeera

**Feature**: `adiantamento-motorista`
**Created**: 2026-09-17
**Status**: Draft

> Fontes: `docs/plans/adiantamento-motorista/BRIEFING-AGENTE-00C.md` e
> `docs/plans/adiantamento-motorista/PLANO.md` (plano aprovado pelo operador em
> 2026-09-17, decisões D-01..D-22 e propostas Q-N aprovadas). `docs/briefing.md`
> é de outra frente (push-motorista) e não descreve esta feature.

## User Scenarios & Testing

### User Story 1 - Motorista solicita um adiantamento e acompanha o status (Priority: P1)

Hoje o motorista pede adiantamento por um Typebot com aceite em texto livre e cálculo
manual. Esta história substitui isso: o motorista abre o app, vê se pode pedir agora (e
por quê, se não puder), pede com um aceite explícito, e acompanha o status até o
pagamento — sem depender de ninguém calcular ou responder manualmente.

**Why this priority**: é o motivo de existir da feature — elimina o processo manual
(Typebot + Google Forms + cálculo manual) que hoje consome tempo do financeiro em todo
dia útil.

**Independent Test**: com uma configuração vigente e uma conta bancária aprovada
semeadas, um motorista consegue solicitar um adiantamento dentro da janela, ver o
resultado do cálculo após o corte e acompanhar a timeline até `LIBERADA`, sem qualquer
ação manual do financeiro.

**Acceptance Scenarios**:

1. **Given** hoje é um dia habilitado e o horário atual está entre a abertura e o corte,
   **When** o motorista solicita o adiantamento com aceite marcado, **Then** o sistema
   cria a solicitação e mostra a confirmação com a timeline iniciada (FR-001, FR-002,
   FR-005).
2. **Given** o motorista já tem uma solicitação criada hoje, **When** ele tenta
   solicitar de novo, **Then** o sistema recusa informando "já solicitado hoje" e não
   cria uma segunda solicitação (FR-001, FR-003).
3. **Given** o horário atual é antes da abertura ou depois do corte, ou hoje é um dia
   desabilitado, **When** o motorista tenta solicitar, **Then** o sistema recusa com o
   motivo específico e indica a próxima oportunidade (FR-002, FR-003).
4. **Given** uma solicitação está aguardando o corte, **When** o motorista cancela antes
   do horário de corte, **Then** a solicitação vira cancelada e ele pode solicitar de
   novo no mesmo dia (FR-004).
5. **Given** o corte da janela chegou e a produção do dia anterior está disponível,
   **When** o sistema calcula a solicitação, **Then** ela é liberada com o valor líquido
   correto ou marcada inelegível com o motivo, usando a fonte e as categorias vigentes
   no momento em que a solicitação foi criada (FR-008, FR-009, FR-010, FR-012).
6. **Given** a produção do dia anterior ainda não chegou no momento do corte, **When** o
   sistema tenta calcular, **Then** a solicitação fica em estado de espera pela produção
   e o sistema tenta novamente sem intervenção manual (FR-011).
7. **Given** uma solicitação muda de status, **When** a mudança ocorre, **Then** o
   motorista consegue ver o novo status na timeline da solicitação (FR-013, FR-014).

---

### User Story 2 - Motorista cadastra e mantém dados bancários (Priority: P1)

Sem dados bancários aprovados, o motorista não pode solicitar nada. Esta história cobre
o cadastro e a atualização desses dados pelo próprio motorista, incluindo o que acontece
enquanto a nova conta aguarda revisão.

**Why this priority**: é pré-requisito direto da User Story 1 — sem conta aprovada, a
solicitação nunca é liberada nem sequer aceita.

**Independent Test**: um motorista sem conta cadastrada consegue enviar seus dados
bancários e ver o status "pendente"; um motorista com conta aprovada consegue enviar uma
atualização sem perder a capacidade de solicitar com a conta anterior enquanto a nova
está em revisão.

**Acceptance Scenarios**:

1. **Given** o motorista não tem conta bancária cadastrada, **When** ele envia os dados
   completos e válidos, **Then** o sistema cria a conta em status pendente de revisão
   (FR-015, FR-016).
2. **Given** o motorista envia dados com formato inválido (documento, agência, conta,
   banco fora da lista), **When** ele confirma o envio, **Then** o sistema recusa e
   aponta exatamente qual campo está inválido (FR-016).
3. **Given** o motorista já tem uma conta aprovada, **When** ele envia uma nova conta
   para revisão, **Then** a conta aprovada anterior continua valendo para solicitar
   enquanto a nova está pendente (FR-017).

---

### User Story 3 - Financeiro revisa e aprova contas bancárias (Priority: P1)

O financeiro precisa decidir sobre cada conta bancária pendente, confirmando que o
vínculo com o motorista está correto antes de aprovar — essa é a checagem humana que o
plano exige antes de qualquer pagamento.

**Why this priority**: sem aprovação, nenhum motorista consegue solicitar; e a decisão
de origem/vínculo entre entregador e conta é o único ponto de checagem humana de todo o
fluxo de pagamento.

**Independent Test**: com uma lista de contas pendentes semeada, um usuário do
financeiro consegue abrir cada uma, ver os dados completos, e aprovar ou rejeitar com
motivo, sem depender de nenhuma outra tela.

**Acceptance Scenarios**:

1. **Given** uma conta está pendente de revisão, **When** o financeiro abre a revisão,
   **Then** ele vê os dados completos da conta e o entregador vinculado, e essa
   visualização fica registrada (FR-018, FR-019).
2. **Given** o financeiro decide aprovar, **When** ele confirma, **Then** a conta vira
   aprovada, qualquer conta aprovada anterior do mesmo motorista é substituída, e o
   motorista é notificado (FR-018).
3. **Given** o financeiro decide rejeitar, **When** ele informa o motivo obrigatório e
   confirma, **Then** a conta vira rejeitada, a conta anterior (se houver) continua
   valendo, e o motorista é notificado do motivo (FR-018).
4. **Given** existem várias contas pendentes vindas da carga inicial e sem nenhum
   alerta, **When** o financeiro filtra por essa condição e aprova em massa, **Then** o
   sistema aprova todas as contas do filtro e mostra quantas foram afetadas antes de
   confirmar (FR-020).

---

### User Story 4 - Financeiro parametriza as regras de cálculo, a janela e o remanescente (Priority: P2)

Hoje as regras estão fixas em código. Esta história dá ao financeiro uma tela para
configurar quando o motorista pode pedir, como o valor é calculado e como o
remanescente semanal é apurado — com histórico de versões.

**Why this priority**: sem essa tela toda a operação continua dependendo de alguém
mexer em código para qualquer ajuste; mas o sistema já nasce com uma versão inicial
(D-04, D-05, D-21), então não bloqueia a User Story 1.

**Independent Test**: um usuário do financeiro consegue abrir a tela de configuração,
mudar um parâmetro (por exemplo, o horário de corte), salvar, e confirmar que uma nova
versão foi criada sem alterar nenhuma solicitação já existente.

**Acceptance Scenarios**:

1. **Given** o financeiro tem permissão para configurar, **When** ele altera qualquer
   parâmetro (dias habilitados, horários, percentual, taxa, janela de apuração,
   categorias, texto de previsão) e salva, **Then** o sistema cria uma nova versão
   vigente e mantém as versões anteriores no histórico (FR-021, FR-022).
2. **Given** duas pessoas abrem a configuração ao mesmo tempo, **When** a segunda tenta
   salvar depois que a primeira já salvou, **Then** o sistema recusa com um aviso de
   conflito, sem sobrescrever silenciosamente (FR-023).
3. **Given** uma configuração é alterada, **When** a alteração é salva, **Then** o
   sistema registra na auditoria o que mudou e quem mudou (FR-024).
4. **Given** a fonte/categorias da produção ou as categorias do extrato semanal ainda
   não foram definidas pelo financeiro, **When** um motorista tenta solicitar, **Then**
   o sistema recusa com um motivo claro de que a configuração está incompleta (FR-025).

---

### User Story 5 - Financeiro monta lote de pagamento e exporta para a Transfeera (Priority: P1)

Hoje o financeiro monta a planilha à mão. Esta história cobre selecionar solicitações
liberadas, ver o que está apto, gerar o arquivo no layout oficial e baixá-lo — sem
depender de digitação manual.

**Why this priority**: fecha o ciclo de valor da User Story 1 — sem isso, o adiantamento
é calculado mas ninguém consegue pagar pelo caminho novo.

**Independent Test**: com uma lista de solicitações liberadas semeada (algumas aptas,
outras com pendência), um usuário do financeiro consegue gerar um lote só com as aptas,
baixar o arquivo, e confirmar que ele passa na validação estrutural.

**Acceptance Scenarios**:

1. **Given** existem solicitações liberadas selecionadas, **When** o financeiro pede a
   prévia, **Then** o sistema mostra quais estão aptas e quais têm pendência, cada uma
   com o motivo (FR-026).
2. **Given** a prévia mostrou solicitações aptas, **When** o financeiro confirma a
   criação do lote, **Then** o sistema cria o lote só com as aptas, gera o arquivo no
   layout oficial e nenhuma dessas solicitações pode entrar em outro lote ao mesmo tempo
   (FR-027, FR-028).
3. **Given** a geração ou a validação estrutural do arquivo falha, **When** isso
   acontece, **Then** o lote é cancelado automaticamente, as solicitações voltam a
   liberadas, e nada fica disponível para download (FR-029).
4. **Given** um lote já tem arquivo gerado, **When** o financeiro baixa o arquivo mais
   de uma vez, **Then** o conteúdo é sempre idêntico e cada download fica registrado
   (FR-030).
5. **Given** duas pessoas do financeiro tentam gerar lote com solicitações que se
   sobrepõem ao mesmo tempo, **When** ambas confirmam, **Then** só uma tem sucesso e a
   outra recebe aviso de que as solicitações já estão em outro lote (FR-027, FR-051).
6. **Given** a quantidade de itens selecionados excede o limite do parceiro de
   pagamento, **When** o financeiro tenta gerar o lote, **Then** o sistema recusa
   informando o limite (FR-032).
7. **Given** um lote foi exportado, **When** o financeiro confirma o pagamento — seja
   manualmente por lote (FR-033) ou importando o arquivo de retorno da Transfeera
   (FR-056, FASE 11/dec-129) —, **Then** cada item vira pago ou falhou conforme
   informado, com motivo quando aplicável; se a importação não cobrir todos os itens do
   lote, nada é aplicado e os faltantes são informados (FR-056).
8. **Given** um item de um lote falhou o pagamento, **When** o financeiro reprocessa com
   motivo, **Then** a solicitação volta a liberada e pode entrar em um novo lote
   (FR-034).
9. **Given** um lote precisa ser desfeito, **When** o financeiro cancela com motivo
   (antes ou depois do download), **Then** as solicitações voltam a liberadas e, se o
   cancelamento é depois do download, o sistema exige a confirmação explícita de que o
   arquivo não foi enviado ao parceiro (FR-035).
10. **Given** a conta bancária aprovada de uma solicitação liberada muda depois da
    liberação, **When** o financeiro tenta incluí-la em um lote, **Then** o sistema
    aponta a pendência de conta alterada e exige uma ação explícita antes de incluir
    (FR-036).

---

### User Story 6 - Financeiro e motorista acompanham o remanescente semanal (Priority: P3)

O sistema hoje não calcula o valor que sobra ao motorista depois de descontar
adiantamentos e outros débitos no repasse semanal. Esta história fecha essa lacuna.

**Why this priority**: tem valor real para o financeiro (visão do repasse) e para o
motorista (previsibilidade), mas não bloqueia nenhuma das histórias de pagamento acima —
por isso vem depois.

**Independent Test**: com adiantamentos pagos e lançamentos de produção semeados dentro
de uma janela de apuração, o financeiro consegue ver o remanescente calculado por
motorista sem depender de nenhuma outra tela.

**Acceptance Scenarios**:

1. **Given** uma janela de apuração configurada, **When** o financeiro consulta o
   remanescente de um motorista, **Then** o valor mostrado é a soma dos créditos da
   janela menos os adiantamentos pagos (valor bruto) com data de produção na janela e,
   se habilitado, os débitos de terceiros na janela (FR-037, FR-038).
2. **Given** o remanescente calculado é negativo, **When** o financeiro ou o motorista
   visualizam, **Then** o valor aparece negativo com um alerta visível, sem ser somado à
   semana seguinte (FR-040).
3. **Given** a exibição do remanescente no app está habilitada na configuração,
   **When** o motorista abre a tela de previsão, **Then** ele vê o valor previsto; se
   estiver desabilitada, a tela não aparece (FR-039).
4. **Given** um período de apuração termina e todas as solicitações do período estão
   finalizadas, **When** o financeiro fecha a apuração, **Then** o sistema grava um
   retrato definitivo por motorista que não muda depois, mesmo que dados de origem sejam
   corrigidos posteriormente (FR-041).
5. **Given** ainda existe no período uma solicitação liberada, em lote, exportada ou com
   pagamento falho, **When** o financeiro tenta fechar a apuração, **Then** o sistema
   recusa e mostra quantas pendências existem por situação; depois de confirmar os
   pagamentos, reprocessar ou encerrar sem pagamento as falhas, o fechamento é aceito
   (FR-041, FR-034).

---

### User Story 7 - Motorista acompanha a central de notificações (Priority: P2)

O motorista hoje só vê um aviso se tiver ativado push. Esta história dá a ele um
histórico central de tudo que aconteceu — adiantamento, conta bancária e avisos gerais —
independentemente de push estar ativado.

**Why this priority**: aumenta a confiança no fluxo automatizado (o motorista sempre
consegue conferir o que aconteceu), mas o fluxo principal (Stories 1, 2, 5) funciona
mesmo sem essa tela.

**Independent Test**: com eventos de adiantamento e de conta bancária gerados, um
motorista sem push ativado ainda consegue abrir a central de notificações e ver o
histórico completo, marcar itens como lidos e filtrar por categoria.

**Acceptance Scenarios**:

1. **Given** um evento relevante ocorre (solicitação liberada, rejeitada, inelegível,
   pagamento processando/realizado/falhou, conta aprovada/rejeitada), **When** o evento
   acontece, **Then** uma notificação correspondente aparece no histórico do motorista,
   com título, categoria e link para a tela relevante, mesmo sem push ativado (FR-042,
   FR-044).
2. **Given** o motorista tem notificações não lidas, **When** ele abre a central,
   **Then** consegue filtrar por categoria e por não lidas, e marcar uma ou todas como
   lidas (FR-043).

---

### User Story 8 - Migração da base existente de contas bancárias (Priority: P4)

As contas bancárias hoje coletadas fora do sistema (planilha) precisam entrar como ponto
de partida, sem pular a revisão humana.

**Why this priority**: é uma tarefa de preparação de dados, não uma jornada recorrente;
sem ela a operação simplesmente começa com a base vazia (mais lenta, mas funcional).

**Independent Test**: rodando a migração sobre um conjunto de contas de exemplo, cada
uma é criada como pendente de revisão, nenhuma é aprovada automaticamente, e a User
Story 3 consegue revisá-las normalmente.

**Acceptance Scenarios**:

1. **Given** uma base de contas bancárias já coletada fora do sistema, **When** a
   migração roda, **Then** cada conta entra como pendente de revisão, identificada como
   originada da carga inicial (FR-048).

---

### Edge Cases

Numeração alinhada ao PLANO §25 (28 casos mapeados; referência cruzada às FRs desta
spec).

- #1: Solicitação em dia habilitado e dentro da janela cria a solicitação normalmente (FR-001, FR-002).
- #2: Dia da semana desabilitado recusa com motivo e indica a próxima oportunidade (FR-002, FR-003).
- #3: Fronteira exata do corte (a última fração de segundo antes bloqueia, a última fração antes disso permite) — mesma regra vale para a abertura (FR-002).
- #4: Solicitação após o corte é recusada (FR-002, FR-003).
- #5: Solicitação numa segunda-feira usa o domingo como data de produção, inclusive na virada de mês/ano (FR-008).
- #6: Configuração alterada depois de uma solicitação criada não muda essa solicitação; só as novas usam a versão nova (FR-006/FR-022, FR-009).
- #7: Motorista sem produção no dia vira inelegível; se o dado de produção ainda não chegou, a solicitação fica aguardando (FR-011, FR-012).
- #8: Sem conta bancária cadastrada, o motorista não consegue solicitar (FR-006).
- #9: Conta pendente sem conta aprovada anterior bloqueia solicitar; havendo uma aprovada anterior, a solicitação segue normal (FR-006, FR-017).
- #10: Conta rejeitada não afeta uma conta aprovada anterior; sem conta aprovada anterior, o motorista fica sem poder solicitar (FR-006, FR-018).
- #11: Duas tentativas de solicitação simultâneas do mesmo motorista no mesmo dia resultam em uma única solicitação (FR-001, FR-050).
- #12: Tentar incluir num lote uma solicitação já exportada/paga gera pendência (FR-026).
- #13: A mesma solicitação nunca fica ativa em dois lotes ao mesmo tempo (FR-027, FR-051).
- #14: Uma linha de dados bancários inválida no meio de um lote não impede as demais; ela vira pendência isolada (FR-026).
- #15: Valor calculado zero ou negativo é tratado como inelegível/pendência, nunca exportado (FR-012, FR-026).
- #16: Documento (CPF/CNPJ) inválido é recusado no cadastro bancário (FR-016).
- #17: Duas pessoas do financeiro tentando gerar lote com sobreposição — uma vence, a outra recebe aviso com a lista de conflito (FR-027, FR-051).
- #18: Falha ao gerar o arquivo cancela o lote automaticamente e libera as solicitações de volta, sem deixar nada parcialmente exportável (FR-029).
- #19: Baixar o arquivo mais de uma vez sempre devolve o mesmo conteúdo, com o download contado (FR-030).
- #20: Reexportação só acontece por cancelamento explícito do lote ou reprocessamento explícito de uma falha — nunca automaticamente (FR-034, FR-035).
- #21: Valores com zero à esquerda (agência, conta, dígito, banco) chegam ao arquivo exportado exatamente como digitados, sem qualquer conversão numérica; cada linha traz o identificador de integração ADV-, o tipo de conta por extenso, o e-mail para comprovante só quando informado e a data de agendamento vazia (FR-028, FR-055).
- #22: Cancelar uma solicitação depois do corte é recusado (FR-004).
- #23: Se uma importação do dia anterior ainda está em andamento no momento do corte, o sistema espera e tenta de novo, sem calcular com dado incompleto (FR-011).
- #24: Uma correção na fonte de produção depois do cálculo não altera uma solicitação já calculada (snapshot) (FR-009).
- #25: Lote acima do limite do parceiro de pagamento é recusado (FR-032).
- #26: Conta aprovada de uma solicitação liberada muda antes de entrar em lote — gera pendência que exige decisão explícita (FR-036).
- #27: O relógio do aparelho do motorista está errado — a decisão de horário é sempre do servidor, nunca do cliente (FR-002).
- #28: Nome com acento ou caractere especial é preservado no arquivo exportado, com a descrição do pagamento ("Antecipação entregador mei ...") cortada em 140 caracteres (FR-028, FR-055).

## Requirements

### Functional Requirements

**Solicitação de adiantamento (motorista)**

- **FR-001**: Sistema MUST permitir que um motorista do grupo autorizado (hoje, o grupo
  Movee) solicite um adiantamento, no máximo uma solicitação não cancelada por dia.
- **FR-002**: Sistema MUST só aceitar uma nova solicitação quando o dia da semana atual
  estiver habilitado E o instante atual do servidor estiver entre a abertura (inclusive)
  e o corte (exclusive) configurados.
- **FR-003**: Sistema MUST informar ao motorista o motivo específico de recusa (dia não
  permitido, antes da abertura, depois do corte, já solicitado hoje) e a próxima
  oportunidade disponível.
- **FR-004**: Sistema MUST permitir que o motorista cancele a própria solicitação apenas
  enquanto ela estiver aguardando o corte, e permitir uma nova solicitação no mesmo dia
  após o cancelamento.
- **FR-005**: Sistema MUST exigir aceite explícito do motorista no momento da
  solicitação e registrar de forma permanente e verificável o texto aceito (ou uma
  identificação inequívoca dele) junto da solicitação.
- **FR-006**: Sistema MUST exigir, como pré-requisito para solicitar, que a conta do
  motorista esteja vinculada ao entregador correspondente E que exista uma conta
  bancária aprovada; caso falte algum dos dois, o motorista MUST ver qual pré-requisito
  específico está faltando.
- **FR-007**: Sistema MUST exibir ao motorista, antes de solicitar, as regras vigentes
  (janela, percentual, taxa) obtidas em tempo real da configuração corrente — nunca
  fixas no aplicativo.
  - Nota retroativa (FASE 11, 11.4): o bloco `estimate` de
    `hub_adiantamento_disponibilidade` (produção/bruto/líquido não-persistidos,
    sempre `final:false`, antes do corte) é uma extensão desta FR — dá ao
    motorista uma prévia do valor com as mesmas regras vigentes exibidas aqui.
    Mantido deliberadamente; não substitui o cálculo definitivo pós-corte (FR-009).
- **FR-008**: Sistema MUST calcular o adiantamento com base na produção do dia
  corrido imediatamente anterior à data da solicitação, no fuso horário configurado,
  independentemente de feriados ou dias não úteis.
- **FR-009**: Sistema MUST calcular a solicitação somente após o corte da janela em que
  foi criada, usando a fonte e as categorias de produção vigentes no momento em que a
  solicitação foi criada — não a configuração vigente no momento do cálculo, caso tenha
  mudado.
- **FR-010**: Sistema MUST arredondar o valor bruto (produção × percentual) para a casa
  dos centavos pela regra "meio para cima" (ex.: 129,344 → 129,34; 129,345 → 129,35),
  e descontar uma taxa fixa uma única vez do valor bruto para produzir o valor líquido.
- **FR-011**: Sistema MUST colocar uma solicitação em um estado distinto de "aguardando
  produção" quando o dado de produção do dia anterior ainda não estiver disponível, e
  tentar novamente automaticamente até que fique disponível.
- **FR-012**: Sistema MUST marcar uma solicitação como inelegível, com motivo
  específico, quando a produção apurada for zero ou quando o valor líquido resultante
  não for positivo.
- **FR-013**: Sistema MUST notificar o motorista em toda mudança de status relevante da
  solicitação (liberada, inelegível, rejeitada, pagamento em processamento, pagamento
  realizado, pagamento falhou). A inclusão em lote aparece só na timeline (FR-014), sem
  notificação própria (PLANO §19; alinhamento dec-019).
- **FR-014**: Sistema MUST permitir que o motorista visualize o histórico cronológico de
  status da própria solicitação.

**Dados bancários (motorista + financeiro)**

- **FR-015**: Sistema MUST permitir que o motorista cadastre ou atualize seus dados
  bancários (banco, agência, conta e dígito, tipo de conta limitado a corrente ou
  poupança, chave PIX, e-mail opcional para comprovante).
- **FR-016**: Sistema MUST validar os dados bancários no momento do envio (dígito
  verificador do documento, banco pertencente à lista oficial, formato dos demais
  campos) e recusar o envio com um motivo claro quando inválido.
- **FR-017**: Sistema MUST manter qualquer conta bancária previamente aprovada ativa e
  válida para solicitar enquanto uma nova conta enviada pelo motorista está pendente de
  revisão.
- **FR-018**: Sistema MUST exigir que um usuário com a permissão correspondente revise e
  aprove ou rejeite (com motivo obrigatório) cada conta bancária pendente, confirmando
  explicitamente o entregador vinculado como parte da aprovação.
- **FR-019**: Sistema MUST mascarar os dados bancários em listas e revelar os dados
  completos apenas dentro da ação de revisão dedicada, registrando que a visualização
  completa ocorreu.
- **FR-020**: Sistema MUST permitir aprovar em massa contas pendentes originadas da
  carga inicial e sem nenhum alerta, mostrando a quantidade afetada antes de confirmar.

**Configuração e parametrização (financeiro)**

- **FR-021**: Sistema MUST permitir que um papel autorizado configure e versione: a
  janela de solicitação (dias habilitados, horário de abertura e de corte), os
  parâmetros de cálculo (fonte da produção, categorias elegíveis, percentual, taxa
  fixa), o texto de previsão de pagamento, o modelo da descrição do pagamento no
  arquivo de exportação, e os parâmetros do remanescente semanal
  (início/duração da janela, dia do repasse, categorias do extrato, quais descontos
  estão ligados, e se o remanescente aparece no app).
- **FR-022**: Sistema MUST preservar todas as versões anteriores da configuração,
  associar cada solicitação à versão vigente no momento em que foi criada, e nunca
  alterar retroativamente uma solicitação já existente quando a configuração muda.
- **FR-023**: Sistema MUST impedir que dois salvamentos simultâneos da configuração se
  sobrescrevam silenciosamente, apresentando um aviso de conflito quando isso ocorrer.
- **FR-024**: Sistema MUST registrar na trilha de auditoria toda alteração de
  configuração, incluindo o que mudou e quem alterou.
- **FR-025**: Sistema MUST bloquear novas solicitações de adiantamento, com motivo
  claro, enquanto a fonte/categorias da produção, a janela de apuração semanal ou as
  categorias do extrato semanal ainda não tiverem sido definidas pelo financeiro.

**Lote de pagamento e exportação**

- **FR-026**: Sistema MUST permitir que um usuário autorizado selecione solicitações
  liberadas e veja uma prévia de quais estão aptas para lote e quais têm pendência, com
  um motivo legível para cada pendência.
- **FR-027**: Sistema MUST criar um lote de pagamento contendo apenas as solicitações
  aptas, e impedir que qualquer solicitação esteja ativa em mais de um lote ao mesmo
  tempo.
- **FR-028**: Sistema MUST gerar, para cada lote, um arquivo de exportação que reproduz
  exatamente o layout oficial do parceiro de pagamento (colunas, cabeçalho, formatação),
  e MUST NOT permitir que esse arquivo seja baixado antes de passar por uma validação
  estrutural.
- **FR-029**: Sistema MUST cancelar automaticamente um lote e devolver suas
  solicitações ao status liberado quando a geração ou a validação do arquivo falhar, sem
  expor arquivo parcial ou corrompido.
- **FR-030**: Sistema MUST devolver exatamente o mesmo conteúdo de arquivo em todo
  download repetido de um mesmo lote, e registrar cada download na trilha de auditoria.
- **FR-031**: Sistema MUST restringir a criação de lote e o download do arquivo a
  usuários com a permissão específica correspondente, e disponibilizar o arquivo apenas
  por um canal autenticado — nunca por link público ou de longa duração.
- **FR-032**: Sistema MUST impor um número máximo de itens por lote, alinhado ao limite
  do parceiro de pagamento, recusando tentativas que o excedam.
- **FR-033**: Sistema MUST permitir que o financeiro marque manualmente, por lote, o
  resultado do pagamento de cada item (pago ou falhou, com motivo), até que exista um
  canal automatizado de confirmação.
- **FR-034**: Sistema MUST permitir reprocessar, com motivo obrigatório, uma
  solicitação que falhou o pagamento, devolvendo-a ao status liberado para que possa
  entrar em um novo lote; e MUST permitir, alternativamente, encerrar sem pagamento
  (com motivo obrigatório e notificação ao motorista) uma solicitação com pagamento
  falho que não será mais paga, deixando-a finalizada (decisão D-23).
- **FR-035**: Sistema MUST permitir cancelar um lote (antes ou depois do download) com
  motivo obrigatório, exigindo confirmação explícita adicional quando o cancelamento
  ocorre depois do arquivo já ter sido baixado.
- **FR-036**: Sistema MUST detectar quando a conta bancária aprovada de uma solicitação
  liberada muda depois da liberação e antes da criação do lote, sinalizar isso como
  pendência, e exigir uma ação explícita do financeiro antes de incluir a solicitação em
  um lote.

**Remanescente semanal**

- **FR-037**: Sistema MUST calcular, por motorista e por janela de apuração
  configurável, um saldo remanescente a partir dos créditos elegíveis da janela, menos
  (quando habilitado) o valor bruto dos adiantamentos pagos cuja data de produção esteja
  dentro da janela, menos (quando habilitado) débitos de terceiros dentro da janela.
- **FR-038**: Sistema MUST permitir que o financeiro visualize e exporte o saldo
  remanescente por motorista e por semana.
- **FR-039**: Sistema MUST exibir opcionalmente ao motorista, no aplicativo, a previsão
  do remanescente, controlada por uma opção configurável pelo financeiro.
- **FR-040**: Sistema MUST permitir que um saldo remanescente negativo seja exibido com
  um alerta visível, sem transportar automaticamente o valor para a semana seguinte na
  ausência de uma regra explícita de acúmulo.
- **FR-041**: Sistema MUST permitir que o financeiro feche um período de apuração,
  gravando um retrato permanente e imutável por motorista, e MUST recusar o fechamento,
  informando quantas solicitações pendentes existem por situação, enquanto houver no
  período qualquer solicitação ainda não finalizada (aguardando corte, aguardando
  produção, liberada, em lote, exportada ou com pagamento falho). O retrato desconta o
  valor bruto dos adiantamentos pagos (decisão D-23 do operador).

**Central de notificações**

- **FR-042**: Sistema MUST notificar o motorista, dentro do aplicativo, de todo evento
  do sistema relacionado à sua solicitação de adiantamento ou conta bancária, com
  título, mensagem, categoria e um link para a tela relevante.
- **FR-043**: Sistema MUST permitir que o motorista veja um histórico de notificações
  filtrável por categoria e por não lidas, e marque itens como lidos individualmente ou
  todos de uma vez.
- **FR-044**: Sistema MUST registrar uma entrada de histórico de notificação para todo
  aviso emitido pelo financeiro, para todo o público pretendido, independentemente de o
  destinatário ter push habilitado.

**Permissões**

- **FR-045**: Sistema MUST controlar cada capacidade relacionada a adiantamento
  (consultar, gerenciar, configurar, consultar contas, revisar contas, consultar
  pagamentos, criar lote, exportar arquivo, reprocessar, confirmar pagamento) por uma
  permissão própria e distinta.
- **FR-046**: Sistema MUST conceder todas as permissões de adiantamento ao papel do
  financeiro e aos administradores de plataforma/entidade, e a nenhum outro papel
  existente por padrão.

**Auditoria**

- **FR-047**: Sistema MUST registrar uma entrada de auditoria para toda ação que muda
  estado descrita nesta especificação (solicitação criada/cancelada/calculada/
  liberada/rejeitada/reprocessada, conta bancária enviada/revisada, lote
  criado/arquivo gerado/baixado/cancelado/pagamento confirmado, configuração alterada,
  apuração fechada), sem nunca incluir no detalhe da auditoria o documento completo do
  motorista, o número da conta bancária ou o conteúdo do arquivo.

**Carga inicial**

- **FR-048**: Sistema MUST oferecer uma capacidade de migração, executada uma única
  vez, que importa registros de contas bancárias já existentes como pendentes de
  revisão, sem aprová-los automaticamente.

**Decisões de infraestrutura**

- **FR-049**: (scheduling) Sistema MUST executar um processo recorrente automático que
  avalia as solicitações após o corte de cada dia (inclusive as que aguardam produção),
  sem exigir intervenção manual. O fechamento da apuração semanal NÃO é automático: é
  uma ação explícita do financeiro (FR-041).
- **FR-050**: (idempotência) Sistema MUST tratar a criação de solicitação e a criação de
  lote como operações idempotentes, chaveadas por uma chave de idempotência fornecida
  pelo cliente, de forma que um reenvio nunca crie duplicidade.
- **FR-051**: (concorrência) Sistema MUST serializar tentativas concorrentes de incluir a
  mesma solicitação em mais de um lote, garantindo no máximo um vínculo de lote ativo
  por solicitação mesmo sob ações simultâneas do financeiro.
- **FR-052**: (retenção) Sistema MUST manter o conteúdo do arquivo de exportação gerado
  por até 90 dias após o lote ser concluído ou cancelado e então descartá-lo, preservando
  o retrato das linhas exportadas do lote; e MUST reter o histórico de notificações do
  motorista pela mesma janela de 90 dias já usada pelos avisos existentes do sistema.

**Sessão e mensagens de erro**

- **FR-053**: Sistema MUST tentar restaurar silenciosamente uma sessão expirada do
  aplicativo quando o motorista abre qualquer tela relacionada ao adiantamento, antes de
  pedir para ele entrar novamente.
- **FR-054**: Sistema MUST exibir ao motorista uma mensagem de erro específica e
  legível sempre que uma ação falhar por um erro comunicado pelo servidor, em vez de uma
  mensagem genérica de falha.

**Conteúdo de cada linha do arquivo de exportação (decisões D-18 a D-22 do operador)**

- **FR-055**: Sistema MUST preencher cada linha do arquivo de exportação com: o nome do
  titular da conta aprovada; o documento do titular com a máscara usual de CPF/CNPJ; o
  e-mail para comprovante quando informado pelo motorista (vazio caso contrário); o
  código do banco; a agência com 4 dígitos; a conta e o dígito da conta em campos
  separados; o tipo de conta escrito como "Conta Corrente" ou "Conta Poupança"; o valor
  líquido da solicitação; um identificador de integração único e estável por solicitação,
  formado por "ADV-" seguido do número da solicitação com 6 dígitos (ex.: ADV-000123); a
  data de agendamento vazia; e a descrição do pagamento no padrão atual do financeiro
  ("Antecipação entregador mei DD.MM.AA_<nome do titular>", com a data da produção),
  limitada a 140 caracteres. A chave PIX do cadastro NÃO é exportada.

**Importação do retorno de pagamento da Transfeera (FASE 11, converge onda-037,
11.20/11.21 — dec-129, operador entregou um arquivo real em 2026-09-18, desbloqueando
o item antes listado em Out of Scope)**

- **FR-056**: Sistema MUST permitir que o financeiro (permissão
  `adiantamentos.pagamento_confirmar`) importe o arquivo de retorno de pagamento da
  Transfeera para UM lote (`POST /lotes/:id/retorno`, corpo `{csvBase64}`), casando cada
  linha pelo identificador de integração (nunca por nome ou valor) e aplicando o mesmo
  efeito da confirmação manual por lote (FR-033): `Finalizada` vira paga e `Devolvida`
  vira falhou, com o motivo literal do arquivo (sem tradução). A importação nunca aplica
  parcialmente: se sobrar item incluído no lote sem resolução no arquivo (sem linha,
  status desconhecido ou valor divergente), a operação é recusada por inteiro (nenhuma
  linha do lote muda de status) informando os identificadores faltantes. Reimportar o
  mesmo arquivo depois de já aplicado é idempotente — nenhum item já resolvido é
  reprocessado.

> Decisões de infraestrutura: aplicável — ver FR-049 a FR-052 (agendamento periódico,
> idempotência, serialização de concorrência e retenção/backup). Não há rotação de
> chave de criptografia nova nem novo token OAuth externo introduzidos por esta feature.

### Key Entities

- **Solicitação de Adiantamento**: o pedido de um motorista em um dia específico;
  carrega o instantâneo do cálculo (produção, percentual, taxa, valores bruto e
  líquido), a versão de configuração usada, o texto de aceite e o histórico de status
  até o pagamento ou encerramento.
- **Conta Bancária do Motorista**: os dados bancários de um motorista para receber
  pagamentos, com um status de revisão (pendente, aprovada, rejeitada, substituída,
  cancelada) e a origem (cadastro no app ou carga inicial).
- **Configuração de Adiantamento**: o conjunto versionado de parâmetros que governam
  quando e como uma solicitação é avaliada e calculada, com histórico completo de quem
  alterou o quê e quando.
- **Lote de Pagamento** (e seus itens): o agrupamento de solicitações liberadas
  exportado de uma vez para o parceiro de pagamento, com o arquivo gerado, o estado do
  lote e o resultado de pagamento de cada item.
- **Apuração de Repasse**: o retrato semanal, por motorista, do saldo remanescente após
  descontar adiantamentos pagos e débitos de terceiros, com um snapshot imutável quando
  o período é fechado.
- **Notificação**: uma mensagem dirigida a um motorista, associada a uma categoria e a
  um evento do sistema (ou a um aviso emitido pelo financeiro), com estado de lida/não
  lida.
- **Evento de Status**: o registro de cada transição de status de uma solicitação,
  usado tanto para a timeline exibida ao motorista quanto para a auditoria.

## Success Criteria

### Measurable Outcomes

- **SC-001**: Um motorista com conta aprovada consegue concluir uma solicitação de
  adiantamento, do início ao envio, em menos de 2 minutos.
- **SC-002**: 100% das solicitações feitas exatamente no limite da janela (segundo
  imediatamente antes e imediatamente depois da abertura e do corte) recebem o
  resultado correto (aceita ou recusada).
- **SC-003**: O financeiro consegue montar e exportar um lote de até 500 solicitações
  em menos de 5 minutos, do início da seleção ao arquivo pronto para download.
- **SC-004**: Zero lotes duplicados e zero solicitações incluídas em mais de um lote
  ativo, mesmo sob tentativas concorrentes repetidas.
- **SC-005**: 100% dos arquivos de exportação disponibilizados para download passam,
  antes disso, pela validação estrutural.
- **SC-006**: Nenhum dado bancário completo (número de conta, documento) aparece fora
  da tela de revisão dedicada — em nenhuma lista, notificação, log ou trilha de
  auditoria.
- **SC-007**: O financeiro consegue revisar e decidir sobre uma conta bancária
  pendente em menos de 1 minuto por conta.
- **SC-008**: 100% dos eventos de status relevantes de uma solicitação (liberada,
  rejeitada, inelegível, pagamento processando/realizado/falhou) geram uma notificação
  visível ao motorista, mesmo sem push habilitado.
- **SC-009**: As 28 situações de contorno mapeadas para esta iniciativa têm um
  resultado previsível, documentado e testável (ver Edge Cases).
- **SC-010**: Zero ocorrências de dado pessoal ou bancário real (nome, documento,
  conta) em teste, log ou trilha de auditoria.
- **SC-011** (FASE 11, converge onda-037, 11.20): importar um arquivo de retorno da
  Transfeera com todas as linhas do lote resolvidas aplica 100% delas (paga ou falhou,
  conforme o arquivo) numa única operação; um arquivo com QUALQUER item do lote sem
  resolução é recusado por inteiro, sem aplicar as demais linhas.

## Out of Scope

- ~~Importação automática do retorno de pagamento da Transfeera~~ — **superado por
  FR-056** (FASE 11, converge onda-037, 11.20; dec-129, operador entregou um arquivo
  real de exemplo em 2026-09-18). Implementado: `lib/adiantamento-retorno-transfeera.js`
  + `POST /lotes/:id/retorno` (`routes/hub-adiantamentos.js`). A confirmação manual por
  lote (User Story 5, FR-033) continua disponível como alternativa — a importação não a
  substitui, soma-se a ela.
- **Execução das validações V-1 a V-6 contra a Transfeera real**: são conduzidas pelo
  operador fora desta feature.
- **Publicação/deploy em produção, controle de versão (commit/push/PR/merge/build)**:
  são atividades operacionais da sessão responsável, não requisitos de produto desta
  spec.
- **Qualquer capacidade fora do escopo listado nas User Stories acima** que não tenha
  sido explicitamente aprovada pelo operador nesta rodada.

## Delta Requirements

**Skip**: não existe corpus `docs/specs/current/` neste projeto — nenhuma capability
documentada como "hoje ativa" para esta feature alterar; toda a capacidade descrita é
nova. — agente-00c-feature-orchestrator, 2026-09-17.

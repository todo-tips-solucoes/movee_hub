# Feature Specification: Envio em Massa como Módulo do Hub

**Feature**: `hub-envio-massa`
**Created**: 2026-07-09
**Status**: Draft

> Sessão S8 do plano mestre do Hub de Gestão de Frota (`docs/plans/hub-frota/`) — a fase
> de maior risco de regressão do projeto, porque o fluxo migrado é o que o cliente usa
> todos os dias (upload de movimentos → processamento → validação de nota fiscal →
> fechamento → export). O objetivo é **re-hospedar** esse fluxo dentro do shell do hub,
> preservando comportamento observável, e colocar autenticação/permissões novas na
> frente dele — sem tocar a lógica de negócio legada (parser XLSX, regras do grupo Movee,
> roteamento FastAPI). Nada é deployado no ambiente vivo do cliente nesta fase; todo o
> trabalho acontece no ambiente isolado do hub (mocks de n8n/FastAPI já entregues na S1).
>
> **Não inclui**: refatorar o parser XLSX; alterar o schema de `EnvioMassa`/`ProcessControl`;
> mudar o roteamento FastAPI ou a regra `mesmoGrupoQue`; desligar as telas antigas em
> produção (elas continuam servindo o cliente até um cutover que é uma fase futura, fora
> desta feature); qualquer novo caso de uso que o fluxo atual não tenha hoje.

## Clarifications

### Session 2026-07-09

- Q2 (FR-015): Como o "escopo mínimo de mudança" nos pontos de entrada do fluxo legado
  deve ser verificado/atestado como critério de aceite? → **A**: relatório de diff dos
  arquivos legados tocados, anexado às evidências da feature e revisado manualmente linha
  a linha; sem gate automático por quantidade de linhas. Decidido autonomamente
  (score 3, dec-009): briefing S8 exige o diff como evidência ("diff dos arquivos legados
  tocados — esperado: só middleware/flags"), constitution v1.1.0 Princípio IV exige
  revisão de segurança manual para mudanças de autenticação, e o plano técnico (S16.1)
  lista o diff dos endpoints legados como entregável; precedente real na S4 (DIÁRIO:
  `git diff --name-only` + code review do diff).
- Q3 (FR-014 × FR-006 / CHK037, e SC-006 / CHK018): **RESPONDIDAS PELO OPERADOR em
  2026-07-09** (pós-review, junto com a autorização de push/PR#61): (a) FR-014 vale
  independente do estado da flag `HUB_RBAC_ENVIO` (texto do FR-014 atualizado); (b) para
  a S8, SC-006 ("nenhum envio real fora do ambiente isolado") é aceito com a garantia
  atual — infra S1 (mocks/tokens ausentes) + desenho do E2E — SEM asserção de runtime,
  porque o gate `ENVIO_DRY_RUN`/allowlist não existe no código legado (achado
  pré-existente, fora do escopo desta feature por FR-015); a asserção automatizada fica
  condicionada ao follow-up **issue #62** (tornar o gate real em
  `sendMessage`/`validate-xml-batch`), recomendado antes do cutover S10.
- Q1 (FR-004): Comportamento quando não há entidade ativa selecionada na sessão →
  **RESPONDIDA PELO OPERADOR** (block-001, dec-012): **Opção B — redirecionar
  automaticamente para a rota existente de seleção de entidade do shell
  (`/selecionar-entidade`)**. Reaproveita a rota do shell S3, zero UI nova, mudança
  mínima conforme o princípio de escopo mínimo do briefing S8. O marcador
  `[NEEDS CLARIFICATION]` foi removido de FR-004.

## User Scenarios & Testing

### User Story 1 - Operar o fluxo diário de envio em massa dentro do hub (Priority: P1)

Uma pessoa com permissão de operação acessa o módulo de envio em massa pelo menu do hub,
envia uma planilha de movimentos, acompanha o processamento, valida as notas fiscais
recebidas em lote, ajusta um lançamento (ex.: gorjeta) quando necessário, fecha o
movimento e exporta o resultado — tudo dentro do layout do hub, com a mesma experiência
de hoje, mas agora navegando por `/envio-massa/*` em vez do painel avulso.

**Why this priority**: é o valor central da fase — sem isso, não há módulo. Sem o fluxo
completo funcionando de ponta a ponta dentro do hub, a S8 não tem release.

**Independent Test**: pode ser testada isoladamente enviando uma planilha válida no
ambiente do hub e conferindo que o ciclo completo (upload → processo → validação →
fechamento → export) produz o mesmo resultado que o painel legado produziria para a
mesma planilha, sem depender de nenhuma outra story desta feature.

**Acceptance Scenarios**:

1. **Given** uma pessoa autenticada no hub com a entidade ativa selecionada e permissão
   de operação do módulo, **When** ela navega até `/envio-massa` pelo menu do hub e envia
   uma planilha válida de movimentos, **Then** o upload é aceito, os movimentos aparecem
   na listagem do módulo, e o comportamento (validações, mensagens, contagens) é
   idêntico ao do painel legado para a mesma planilha.
2. **Given** movimentos importados e pendentes de processamento, **When** a pessoa inicia
   o processo pela tela do hub, **Then** o progresso é refletido em tempo real (polling)
   e, ao concluir, os status dos movimentos refletem o resultado do processamento.
3. **Given** movimentos com XML de nota fiscal para validar em lote, **When** a pessoa
   envia o lote de XMLs pela tela do hub, **Then** cada movimento recebe o resultado
   correto de validação (válida, inválida, erro de negócio com mensagem real, ou erro de
   infraestrutura genérico) exatamente como o fluxo legado validaria.
4. **Given** um movimento validado, **When** a pessoa edita um campo permitido (ex.:
   gorjeta) e fecha o movimento, **Then** a alteração é persistida e o movimento fechado
   não aceita mais edições pela tela.
5. **Given** um conjunto de movimentos no período corrente, **When** a pessoa solicita a
   exportação, **Then** o arquivo exportado contém os mesmos dados e formato que a
   exportação do painel legado produziria.

---

### User Story 2 - Autenticação única via sessão do hub, sem depender de login duplicado (Priority: P2)

Uma pessoa que já está autenticada no hub (sessão do hub, não a sessão do painel antigo)
consegue usar o módulo de envio em massa sem precisar fazer um segundo login ou informar
credenciais adicionais — a sessão do hub é suficiente para operar todas as telas e chamar
todas as ações do módulo, incluindo as que hoje pertencem ao backend legado.

**Why this priority**: sem essa ponte de autenticação, a User Story 1 simplesmente não
funciona — mas ela é tratada como story separada porque é testável isoladamente: basta
confirmar que uma sessão do hub consegue exercitar uma ação do backend legado sem erro de
autenticação, mesmo sem operar o fluxo de negócio completo. Também garante que a promessa
central do hub — "um login, todos os módulos" — se sustenta para o módulo mais usado do
sistema.

**Independent Test**: autenticar no hub, sem tocar em nenhuma tela do envio em massa,
chamar uma ação simples do módulo (ex.: listar movimentos) e confirmar que a chamada é
aceita sem exigir novas credenciais.

**Acceptance Scenarios**:

1. **Given** uma pessoa com sessão ativa do hub e uma entidade ativa selecionada,
   **When** ela abre qualquer tela do módulo de envio em massa, **Then** o acesso é
   concedido sem pedir login novamente, e todas as ações daquela tela operam sobre a
   entidade correta (nunca uma entidade diferente da selecionada).
2. **Given** uma pessoa com sessão ativa do hub mas **sem** entidade ativa selecionada
   (ex.: pessoa vinculada a múltiplas entidades que ainda não escolheu uma),
   **When** ela tenta acessar o módulo de envio em massa, **Then** o sistema a impede de
   operar sobre dados de negócio até que uma entidade seja selecionada, sem jamais
   assumir uma entidade por conta própria (ver Clarificação 1).

---

### User Story 3 - Controle de acesso por papel dentro do módulo (Priority: P3)

Uma pessoa com papel de "somente leitura" consegue ver a listagem e o histórico de
movimentos do módulo, mas qualquer tentativa de criar, enviar, aprovar ou administrar é
recusada; uma pessoa com papel de "operação" consegue fazer o trabalho diário completo,
mas ações de aprovação/administração continuam fora do alcance; uma pessoa com papel de
administração da entidade consegue tudo, incluindo aprovar e gerenciar.

**Why this priority**: fecha o objetivo de segurança da fase (permissões na frente do
fluxo legado) — mas o fluxo em si (US1) e a ponte de autenticação (US2) têm que existir
primeiro para esta story fazer sentido; é testável isoladamente comparando o
comportamento das mesmas ações entre os três perfis.

**Independent Test**: com três contas de teste (uma por papel), repetir a mesma sequência
de ações no módulo e confirmar que cada uma recebe exatamente o resultado esperado para
seu papel (permitido ou bloqueado), sem depender de rodar o fluxo de negócio completo.

**Acceptance Scenarios**:

1. **Given** uma conta com papel de administração da entidade, **When** ela executa
   qualquer ação do módulo (visualizar, criar, enviar, aprovar, gerenciar), **Then**
   todas são permitidas.
2. **Given** uma conta com papel de operação, **When** ela tenta visualizar, criar ou
   enviar, **Then** a ação é permitida; **When** ela tenta aprovar ou gerenciar
   configurações do módulo, **Then** a ação é recusada com uma resposta clara de
   permissão insuficiente.
3. **Given** uma conta com papel de somente leitura, **When** ela tenta visualizar,
   **Then** a ação é permitida; **When** ela tenta qualquer ação de escrita (criar,
   enviar, aprovar, gerenciar), **Then** a ação é recusada.
4. **Given** o controle de acesso desligado por configuração (modo de compatibilidade),
   **When** qualquer conta autenticada executa qualquer ação, **Then** o comportamento
   volta a ser idêntico ao do fluxo legado sem a camada de permissões (permite reverter
   instantaneamente se algo no controle de acesso quebrar o fluxo em produção futura).

---

### User Story 4 - Histórico leve de importações do módulo (Priority: P4)

Uma pessoa com acesso ao módulo consegue ver, no histórico de importações do hub, que
cada envio de planilha do módulo de envio em massa foi registrado (quando entrou, quantos
registros, resultado), do mesmo jeito que já acontece para os outros tipos de importação
do hub — sem que isso mude em nada como a planilha é processada.

**Why this priority**: é um valor de observabilidade incremental, não crítico ao fluxo
operacional; pode ser adiado ou desligado sem impedir as demais stories.

**Independent Test**: enviar uma planilha pelo módulo e conferir que uma entrada
correspondente aparece no histórico de importações do hub, com dados coerentes com o que
foi enviado — sem depender de completar o restante do fluxo (processo/validação/fechamento).

**Acceptance Scenarios**:

1. **Given** o registro de histórico ligado por configuração, **When** uma planilha é
   enviada pelo módulo, **Then** uma entrada aparece no histórico de importações do hub
   identificando o tipo como sendo do módulo de envio em massa, com contagem de registros
   e status coerentes com o resultado do upload.
2. **Given** o registro de histórico desligado por configuração, **When** uma planilha é
   enviada pelo módulo, **Then** o upload processa normalmente e nenhuma entrada nova
   aparece no histórico (comportamento reversível instantaneamente).

---

### Edge Cases

- O que acontece quando a sessão do hub expira no meio de um processamento em
  andamento (upload feito, processo iniciado, mas o token expira antes do fechamento)?
  O sistema deve pedir reautenticação sem perder o estado do processamento em curso
  (o processamento continua no backend; a pessoa só precisa autenticar de novo para
  seguir acompanhando/agindo).
- O que acontece quando o controle de acesso está ligado, mas a pessoa perdeu a
  permissão no meio de uma sessão já aberta (ex.: um administrador revogou o papel
  enquanto ela trabalhava)? A próxima ação que exigir aquela permissão deve ser recusada
  imediatamente, sem esperar um novo login.
- O que acontece se o upload de planilha falhar antes de qualquer linha ser processada
  (arquivo corrompido, cabeçalho incompatível)? O comportamento e a mensagem devem ser
  idênticos aos do fluxo legado — esta feature não pode alterar o tratamento de erro
  existente do parser.
- O que acontece com o histórico de importações se o próprio registro de histórico
  falhar (ex.: indisponibilidade momentânea)? O upload de negócio não pode ser bloqueado
  ou revertido por causa disso — o histórico é estritamente observacional.
- Como o sistema distingue, na validação de XML em lote, um erro de regra de negócio
  (ex.: nota já validada, CNPJ não pertence ao prestador) de uma falha de infraestrutura
  do serviço de validação (timeout, indisponibilidade)? A pessoa usuária precisa ver a
  mensagem real no primeiro caso e uma mensagem genérica de indisponibilidade no segundo
  — nunca uma no lugar da outra.
- O que acontece quando alguém do grupo Movee (matriz ou filial) opera o módulo versus
  alguém de outro grupo? As regras de roteamento e de cadastro que hoje dependem do
  grupo Movee continuam se aplicando sem alteração, para qualquer pessoa, através do
  módulo re-hospedado.

## Requirements

### Functional Requirements

- **FR-001**: O sistema MUST apresentar o fluxo de envio em massa (upload de planilha,
  acompanhamento de processamento, validação de nota fiscal em lote, edição de
  movimento, fechamento, exportação) dentro da navegação do hub, sob um agrupamento de
  telas próprio do módulo — preservando as mesmas capacidades, campos e comportamento
  observável que o fluxo legado oferece hoje.
- **FR-002**: O sistema MUST permitir que uma pessoa autenticada no hub, com uma
  entidade ativa selecionada, opere todas as ações do módulo sem exigir uma segunda
  autenticação distinta para o fluxo legado.
- **FR-003**: O sistema MUST resolver a identidade da entidade/empresa sobre a qual cada
  ação do módulo opera exclusivamente a partir da sessão autenticada da pessoa (nunca de
  um valor informado por ela na tela ou na requisição), preservando o isolamento entre
  empresas que o fluxo legado já garante hoje.
- **FR-004**: O sistema MUST negar qualquer ação de negócio do módulo quando a pessoa
  não tem uma entidade ativa selecionada na sessão, sem jamais inferir ou assumir uma
  entidade por conta própria, redirecionando automaticamente para a rota existente de
  seleção de entidade do shell (`/selecionar-entidade`) em vez de bloquear na própria
  tela do módulo.
- **FR-005**: O sistema MUST oferecer um controle de acesso por papel para as ações do
  módulo, com pelo menos os níveis: visualizar, criar/enviar, aprovar, e administrar —
  aplicado a cada ação de negócio existente do fluxo legado.
- **FR-006**: O sistema MUST permitir desligar o controle de acesso do módulo (FR-005)
  por uma configuração dedicada, retornando instantaneamente ao comportamento de acesso
  do fluxo legado (qualquer pessoa autenticada pode agir) quando desligado.
- **FR-007**: O sistema MUST registrar, para toda ação de negócio do módulo recusada por
  falta de permissão, uma resposta que deixe claro à pessoa usuária que o motivo foi
  permissão insuficiente (não confundir com falha técnica).
- **FR-008**: O sistema MUST manter, para as três combinações de papel descritas na User
  Story 3 (administração, operação, leitura), o conjunto de ações permitidas e recusadas
  exatamente como descrito nos Acceptance Scenarios daquela story.
- **FR-009**: O sistema MUST oferecer um registro de histórico de importação para cada
  envio de planilha feito pelo módulo, identificável como pertencente ao módulo de envio
  em massa, com pelo menos: identificação do arquivo, contagens de registros processados,
  e status do processamento — sem alterar o resultado do processamento em si.
- **FR-010**: O sistema MUST permitir desligar o registro de histórico (FR-009) por uma
  configuração dedicada, sem que isso afete o processamento da planilha.
- **FR-011**: O sistema MUST garantir que uma falha ao registrar o histórico de
  importação (FR-009) nunca impeça, atrase de forma perceptível, ou reverta o
  processamento de negócio da planilha.
- **FR-012**: O sistema MUST preservar, sem alteração de comportamento observável, todas
  as regras de negócio existentes do fluxo legado tocadas por esta feature — incluindo
  (não se limitando a) a regra de identificação do grupo empresarial usada para cadastro
  automático de pessoa entregadora, e o roteamento do serviço de validação de nota fiscal
  conforme o grupo empresarial da pessoa operadora.
- **FR-013**: O sistema MUST distinguir, na validação de nota fiscal em lote, uma
  recusa por regra de negócio (com a mensagem real do motivo) de uma falha de
  infraestrutura do serviço de validação (com uma mensagem genérica de indisponibilidade)
  — preservando essa distinção exatamente como o fluxo legado já faz.
- **FR-014**: O sistema MUST manter, para toda a extensão desta feature, as proteções de
  envio já existentes no fluxo legado (modo de simulação sem efeito externo por padrão no
  ambiente isolado, lista de destinos permitidos, limite de itens por lote, e registro
  auditável de qualquer envio bloqueado por essas proteções). **FR-014 é independente de
  FR-006**: desligar o controle de acesso do módulo (`HUB_RBAC_ENVIO=off`) NÃO desliga
  nem enfraquece as proteções de envio — autorização de ação e efeito externo de envio
  são camadas ortogonais (ratificado pelo operador em 2026-07-09, CHK037; confirmado
  empiricamente no E2E: com RBAC off nenhuma chamada externa é disparada — evidências
  `e2e-run-20260709T082218Z.log` e `6.2.3-decisao-fr014-fr006-insumo.txt`).
- **FR-015**: O sistema MUST permitir verificar, como critério de aceite desta feature,
  que as mudanças aplicadas aos pontos de entrada do fluxo legado (backend) se limitam a
  autenticação/permissão e às configurações citadas nesta spec — sem alteração de lógica
  de negócio. A verificação é feita por um **relatório de diff dos arquivos legados
  tocados, anexado às evidências da feature e revisado manualmente linha a linha** (sem
  gate automático por quantidade de linhas): o diff esperado contém somente
  middleware/adaptador de autenticação-permissão e leituras das configurações desta spec
  (ver Clarifications, sessão 2026-07-09, Q2).
- **FR-016**: O sistema MUST cobrir, com um teste de ponta a ponta executado no ambiente
  isolado do hub, o fluxo completo descrito na User Story 1 (upload → processamento →
  validação → edição → fechamento → exportação) para os três papéis da User Story 3,
  confirmando os bloqueios esperados de cada papel.
- **FR-017**: O sistema MUST continuar passando, sem nenhuma modificação em seus
  arquivos, a suíte de testes automatizados já existente do fluxo legado.
- **FR-018**: O sistema MUST manter as telas do fluxo legado (fora do hub) funcionando
  sem alteração para quem ainda as utiliza — esta feature não desliga, redireciona nem
  descontinua o acesso a elas.

> **Decisões de infraestrutura**: esta feature introduz duas flags de configuração
> (controle de acesso do módulo — FR-005/FR-006; registro de histórico — FR-009/FR-010),
> ambas com efeito reversível e imediato. Não há scheduler, sessão persistente de longa
> duração própria, criptografia de dados em repouso, refresh de token externo, nem mutex
> multi-instância introduzidos por esta feature — a sessão usada é a sessão do hub já
> entregue em fases anteriores. A aposentadoria dessas flags (remoção definitiva depois
> que o módulo se provar estável em produção) é uma pendência de uma fase futura, fora do
> escopo desta feature.

### Key Entities

- **Registro de importação do módulo**: representa um envio de planilha feito pelo
  módulo de envio em massa, identificado como pertencente a este módulo dentro do
  histórico geral de importações do hub. Atributos-chave: identificação do arquivo
  enviado, contagem de registros processados, resultado/status do processamento, quando
  ocorreu. Não duplica nem substitui os dados de negócio do movimento em si — é só o
  registro do evento de importação.
- **Papel de acesso ao módulo**: representa o conjunto de ações que uma pessoa pode
  executar dentro do módulo (visualizar, criar/enviar, aprovar, administrar),
  vinculado à pessoa dentro do contexto da entidade ativa da sua sessão.

## Success Criteria

### Measurable Outcomes

- **SC-001**: O teste de ponta a ponta do fluxo completo (upload até exportação) passa
  100% no ambiente isolado do hub, para os três papéis de acesso definidos.
- **SC-002**: 100% da suíte de testes automatizados já existente do fluxo legado continua
  passando, sem nenhuma alteração nos arquivos de teste.
- **SC-003**: Uma pessoa autenticada apenas uma vez no hub consegue completar o fluxo
  inteiro de envio em massa (upload até exportação) sem nenhum pedido adicional de
  credenciais.
- **SC-004**: Toda tentativa de ação além do papel de acesso da pessoa é recusada em
  100% dos casos testados (nenhum falso-permitido), e nenhuma ação dentro do papel da
  pessoa é indevidamente recusada (nenhum falso-negado).
- **SC-005**: As duas configurações reversíveis desta feature (controle de acesso e
  registro de histórico) podem ser desligadas e o comportamento correspondente volta a
  ser idêntico ao do fluxo legado em menos de um novo ciclo de implantação (sem exigir
  mudança de código).
- **SC-006**: Nenhum envio real (fora do ambiente isolado) é disparado durante o
  desenvolvimento e os testes desta feature — toda comunicação com os serviços externos
  de processamento e validação usa os substitutos do ambiente isolado.

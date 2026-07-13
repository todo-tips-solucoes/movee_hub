# Feature Specification: Motorista canônico do hub + correções de navegação e filtros

**Feature**: `hub-motorista-canonico`
**Created**: 2026-07-12
**Status**: Draft

> Escopo restrito aos recursos `hub-*` do ambiente de homologação (exceção standing
> G1). O ambiente de produção existente (base legada, aplicativo do motorista em
> produção) não é alterado por esta feature — ver FR-023 e SC-007.

## Clarifications

### Session 2026-07-12

- Q: O acesso às ações de cadastro/edição de motorista e de gestão de credencial
  deve ser controlado por uma única permissão ou por duas permissões separadas? →
  A: Duas permissões granulares separadas — uma para cadastro/edição de motorista
  e outra para gestão de credencial (criar, redefinir senha, ativar/desativar),
  concedidas de forma aditiva e independente (fonte: plano D-C1).
- Q: A visualização do histórico de atividades do motorista (FR-022) exige a mesma
  permissão usada para cadastro/gestão de credencial? → A: Não — a leitura do
  histórico fica disponível a qualquer usuário autenticado da empresa (escopo por
  empresa), no mesmo nível de acesso das telas de faturamento/performance; a
  restrição de FR-020 aplica-se somente às ações de escrita.
- Q: Ao marcar um motorista como inativo (FR-015), o sistema desativa
  automaticamente sua credencial de acesso ao aplicativo (FR-018)? → A: Não — as
  duas situações são independentes; desativar o acesso exige ação explícita
  separada, espelhando as ações independentes da tela legada.
- Q: O que acontece quando uma planilha importada traz um identificador de
  motorista que ainda não existe no cadastro canônico do hub? → A: A atividade é
  registrada normalmente (a importação não é bloqueada nem sinaliza erro) e fica
  sem correlação no histórico até que o motorista correspondente seja cadastrado;
  nunca há criação automática de motorista (FR-014 preservado).
- Q: O histórico de atividades do motorista (US6/FR-022) deve aplicar um limite
  padrão de período/quantidade? → A: Não — sem limite fixo de período ou
  quantidade; o histórico completo fica disponível, com paginação técnica
  decidida na fase de plano.

## User Scenarios & Testing

### User Story 1 - Navegar até o Painel Geral sem erro (Priority: P1)

Um usuário do hub clica em "Painel Geral" (na barra lateral ou no atalho da própria
página inicial) e espera chegar à página inicial do hub. Hoje recebe uma página de
"não encontrado".

**Why this priority**: É o bug de navegação mais visível e recorrente — acontece a
cada sessão de qualquer usuário que usa o atalho. Correção pequena, valor imediato,
sem dependência de nenhuma outra frente desta feature.

**Independent Test**: Autenticar no hub, clicar em "Painel Geral" na barra lateral e
depois no card equivalente da página inicial; confirmar que ambos levam à página
inicial e que o item de navegação aparece marcado como ativo.

**Acceptance Scenarios**:

1. **Given** um usuário autenticado em qualquer página do hub, **When** ele clica em
   "Painel Geral" na barra lateral, **Then** ele chega à página inicial do hub (sem
   erro de página não encontrada) e o item "Painel Geral" aparece destacado como
   ativo.
2. **Given** um usuário autenticado na página inicial do hub, **When** ele clica no
   card/atalho "Painel Geral" dessa mesma página, **Then** ele permanece na página
   inicial sem erro.
3. **Given** um usuário autenticado, **When** ele clica em qualquer outro item de
   navegação (não "Painel Geral"), **Then** o comportamento de rota desses itens
   permanece exatamente como hoje (nenhuma regressão).

---

### User Story 2 - Ver e editar o próprio perfil sem sair da tela (Priority: P1)

Um usuário do hub clica no seu avatar/ícone de conta e escolhe "Meu perfil" para ver
seu nome e e-mail, e opcionalmente trocar a senha. Hoje isso navega para uma página
separada; o pedido é que essa informação apareça em uma janela sobreposta, sem
navegação.

**Why this priority**: Mudança pequena e isolada, sem dependência de outras frentes;
elimina navegação desnecessária e o risco de link quebrado percebido pelo operador.

**Independent Test**: Autenticar no hub, abrir o menu de conta, clicar em "Meu
perfil" e confirmar que os dados aparecem em uma janela sobreposta (sem trocar de
página), com a ação de trocar senha funcional.

**Acceptance Scenarios**:

1. **Given** um usuário autenticado, **When** ele abre o menu de conta e clica em
   "Meu perfil", **Then** uma janela sobreposta exibe seu nome e e-mail, sem navegar
   para uma página diferente da atual.
2. **Given** a janela de perfil aberta, **When** o usuário aciona "Trocar senha",
   **Then** o sistema confirma o envio da solicitação de troca de senha com
   mensagem de sucesso, ou exibe uma mensagem clara de erro caso a solicitação
   falhe.
3. **Given** a janela de perfil aberta, **When** o usuário a fecha, **Then** ele
   permanece exatamente na página em que estava antes de abri-la.
4. **Given** um usuário que acessa o endereço direto da página de perfil (fora do
   menu de conta), **When** a página carrega, **Then** ele continua vendo as mesmas
   informações de perfil (a página direta não é removida).

---

### User Story 3 - Encontrar um entregador pelo nome nos filtros (Priority: P2)

Um usuário do hub, ao consultar faturamento ou performance, quer filtrar por um
entregador específico. Hoje precisa saber e digitar o identificador numérico do
entregador — informação que ele não tem de cabeça. O pedido é poder digitar o nome.

**Why this priority**: Melhoria de usabilidade em duas telas de uso frequente
(faturamento e performance); depende apenas de capacidade de busca, sem exigir a
reestruturação de dados da User Story 4/5/6.

**Independent Test**: Na tela de faturamento, digitar 3 ou mais letras do nome de um
entregador conhecido, confirmar que ele aparece na lista de sugestões, selecioná-lo e
confirmar que a tabela/indicadores passam a refletir apenas esse entregador. Repetir
na tela de performance.

**Acceptance Scenarios**:

1. **Given** a tela de faturamento aberta, **When** o usuário digita 3 ou mais
   letras do nome de um entregador da própria empresa, **Then** o sistema mostra os
   entregadores correspondentes para seleção.
2. **Given** menos de 3 letras digitadas, **When** o usuário observa o campo de
   busca, **Then** o sistema não realiza a busca (evita chamadas desnecessárias) e
   indica que faltam caracteres.
3. **Given** um entregador selecionado no filtro, **When** o usuário confirma,
   **Then** a listagem e os indicadores da tela passam a refletir somente aquele
   entregador; o filtro exibe o nome escolhido (não o identificador numérico).
4. **Given** um filtro de entregador aplicado, **When** o usuário aciona "limpar",
   **Then** o filtro é removido e a tela volta a mostrar todos os entregadores da
   empresa.
5. **Given** a mesma capacidade de busca, **When** o usuário está na tela de
   performance, **Then** o comportamento de busca por nome é o mesmo descrito para
   faturamento.
6. **Given** o filtro por entregador específico já aplicado, **When** o usuário
   tenta também marcar a opção "sem entregador vinculado", **Then** o sistema
   continua impedindo essa combinação contraditória (comportamento já existente
   hoje, preservado).

---

### User Story 4 - Cadastrar e manter motoristas com identidade única no hub (Priority: P3)

Um gestor da empresa quer que o hub seja o lugar onde os motoristas da empresa são
efetivamente cadastrados e mantidos, usando o mesmo identificador único que já vem
das planilhas de performance/faturamento — para que não existam cadastros
duplicados ou desencontrados entre planilha e hub.

**Why this priority**: É o alicerce das User Stories 5 e 6 (credencial e atividades
só fazem sentido sobre um motorista com identidade única já estabelecida); maior
escopo e risco desta feature, por isso vem depois das melhorias mais simples.

**Independent Test**: No módulo de motoristas do hub, cadastrar manualmente um
motorista novo informando nome e o identificador único correspondente da planilha,
confirmar que ele aparece na listagem com esse identificador visível, editar seu
nome/situação, e tentar cadastrar outro motorista com o mesmo identificador para
confirmar que o sistema recusa com mensagem clara.

**Acceptance Scenarios**:

1. **Given** um gestor autorizado no módulo de motoristas, **When** ele cadastra um
   motorista novo informando nome e o identificador único da planilha, **Then** o
   motorista passa a existir na listagem com esse identificador visível.
2. **Given** um identificador em formato inválido, **When** o gestor tenta cadastrar
   o motorista, **Then** o sistema recusa o cadastro com mensagem explicando o
   problema de formato.
3. **Given** um identificador que já pertence a outro motorista da mesma empresa,
   **When** o gestor tenta cadastrar um novo motorista com esse mesmo identificador,
   **Then** o sistema recusa o cadastro informando que o identificador já está em
   uso.
4. **Given** um motorista já cadastrado, **When** o gestor edita seu nome ou sua
   situação (ativo/inativo), **Then** a alteração é refletida na listagem e no
   detalhe do motorista.
5. **Given** qualquer cadastro ou edição de motorista, **When** a ação é concluída,
   **Then** fica registrado quem a realizou e quando, disponível para consulta de
   auditoria.
6. **Given** um motorista com o mesmo identificador presente numa planilha
   importada, **When** a planilha é processada, **Then** os dados dela se
   correlacionam automaticamente a esse motorista pelo identificador único, sem
   qualquer tentativa automática de casar motoristas por semelhança de nome.

---

### User Story 5 - Conceder e gerenciar acesso do motorista ao aplicativo (Priority: P4)

Um gestor quer, a partir do cadastro do motorista no hub, criar a credencial que o
motorista usará para entrar no aplicativo do motorista, e poder redefinir a senha ou
desativar o acesso quando necessário — sem depender de uma tela separada do sistema
legado.

**Why this priority**: Depende da User Story 4 (motorista já cadastrado e
identificado de forma única); é o que efetivamente conecta a gestão do hub à
experiência do motorista no aplicativo.

**Independent Test**: A partir do detalhe de um motorista já cadastrado, criar uma
credencial de acesso, confirmar que o motorista consegue entrar no aplicativo com
ela, redefinir a senha e confirmar que a senha anterior deixa de funcionar, e
desativar a credencial e confirmar que o acesso deixa de ser permitido.

**Acceptance Scenarios**:

1. **Given** um motorista cadastrado sem credencial, **When** o gestor cria uma
   credencial de acesso para ele, **Then** o motorista passa a poder entrar no
   aplicativo do motorista com essa credencial.
2. **Given** um motorista com credencial ativa, **When** o gestor redefine a senha,
   **Then** a senha anterior deixa de funcionar e uma nova é necessária para
   acessar.
3. **Given** um motorista com credencial ativa, **When** o gestor desativa a
   credencial, **Then** o motorista deixa de conseguir entrar no aplicativo até que
   a credencial seja reativada.
4. **Given** um usuário sem a permissão específica de gestão de credencial,
   **When** ele tenta criar, redefinir ou desativar uma credencial, **Then** o
   sistema nega a ação.
5. **Given** qualquer criação, redefinição ou mudança de situação de credencial,
   **When** a ação é concluída, **Then** fica registrado quem a realizou e quando.

---

### User Story 6 - Ver o histórico de atividades do motorista no hub (Priority: P5)

Um gestor, ao abrir o detalhe de um motorista no hub, quer ver as atividades mais
recentes desse motorista (valores de faturamento, indicadores de performance,
validações feitas no aplicativo) reunidas num só lugar, mesmo vindo de fontes
diferentes.

**Why this priority**: É o valor final da correlação por identificador único
(Users Stories 4 e 5); depende de ambas já estarem em funcionamento para ter dados
reais a exibir.

**Independent Test**: Registrar uma atividade do motorista pelo aplicativo (após ele
ter credencial ativa), abrir o detalhe desse motorista no hub e confirmar que a
atividade aparece no histórico, correlacionada corretamente e sem possibilidade de
edição pelo gestor.

**Acceptance Scenarios**:

1. **Given** um motorista com atividades registradas (faturamento, performance e/ou
   validações do aplicativo), **When** o gestor abre o detalhe desse motorista,
   **Then** ele vê essas atividades listadas, organizadas por tipo e data,
   somente para leitura.
2. **Given** o histórico de atividades exibido, **When** o gestor tenta alterar
   qualquer item dele, **Then** o sistema não oferece nenhuma ação de edição (é
   estritamente informativo).
3. **Given** uma nova atividade registrada pelo motorista através do aplicativo
   após esta feature estar em uso, **When** o gestor consulta o detalhe do
   motorista, **Then** essa atividade aparece corretamente correlacionada a ele.
4. **Given** um motorista sem nenhuma atividade registrada ainda, **When** o gestor
   abre seu detalhe, **Then** o sistema mostra um estado vazio claro, sem erro.

---

### Edge Cases

- O que acontece quando a busca por nome de entregador não encontra nenhum
  resultado? O sistema mostra um estado vazio claro, sem tratar como erro.
- O que acontece quando a busca por nome de entregador falha por indisponibilidade
  temporária? O sistema degrada para o comportamento atual (filtro por
  identificador numérico), sem quebrar a tela (FR-010).
- O que acontece quando alguém tenta cadastrar um motorista sem informar o
  identificador único? O sistema recusa o cadastro — o identificador é sempre
  obrigatório (FR-012, D-C6).
- O que acontece quando duas planilhas diferentes trazem o mesmo identificador de
  motorista para empresas diferentes? Não há conflito — o identificador é único por
  empresa, não globalmente (FR-013).
- O que acontece quando uma planilha importada traz um identificador de motorista
  que ainda não existe no cadastro canônico do hub? A atividade é registrada
  normalmente — a importação não é bloqueada nem tratada como erro — e fica sem
  correlação no histórico até que o motorista correspondente seja cadastrado;
  nunca há criação automática de motorista (FR-014).
- O que acontece quando um motorista tem credencial desativada e tenta registrar
  uma atividade pelo aplicativo? O acesso é negado antes de qualquer atividade ser
  registrada (a credencial ativa é pré-requisito de acesso ao aplicativo).
- O que acontece com motoristas e atividades que já existiam antes desta feature
  (histórico anterior sem identificador único correlacionado)? Continuam visíveis
  pelos caminhos já existentes hoje; o histórico de atividades por identificador
  único (User Story 6) mostra a partir do que passa a ser correlacionado após a
  implantação, sem prometer reconstrução retroativa de dados antigos.
- O que acontece com o ambiente de produção existente durante e após esta feature?
  Nada muda — nenhum dado, tela ou comportamento de produção é alterado (FR-023,
  SC-007).
- O que acontece com a tela de gestão de motoristas do sistema legado? Continua
  existindo e funcionando exatamente como hoje, para quem ainda depende dela
  (FR-024, SC-008).

## Requirements

### Functional Requirements

**Navegação (User Stories 1-2)**

- **FR-001**: Sistema MUST direcionar o usuário para a página inicial do hub ao
  acionar "Painel Geral", tanto pela barra lateral quanto pelo atalho da própria
  página inicial.
- **FR-002**: Sistema MUST indicar visualmente "Painel Geral" como item ativo
  quando o usuário está na página inicial do hub.
- **FR-003**: Sistema MUST exibir os dados de perfil do usuário logado (nome,
  e-mail) em uma janela sobreposta, sem navegar para uma página diferente, ao
  acionar "Meu perfil" no menu de conta.
- **FR-004**: Users MUST be able to solicitar troca de senha a partir da janela de
  perfil, recebendo confirmação de sucesso ou mensagem de erro clara.
- **FR-005**: Sistema MUST continuar respondendo corretamente ao endereço direto da
  página de perfil (acesso fora do menu de conta).

**Busca de entregador por nome (User Story 3)**

- **FR-006**: Users MUST be able to localizar um entregador digitando parte do
  nome (mínimo de 3 caracteres) nos filtros das telas de faturamento e de
  performance, sem precisar conhecer um identificador numérico.
- **FR-007**: Sistema MUST retornar apenas entregadores da própria empresa do
  usuário autenticado, em uma quantidade limitada de resultados por busca (até 20).
- **FR-008**: Users MUST be able to limpar a seleção de entregador e remover o
  filtro aplicado, voltando a ver todos os entregadores da empresa.
- **FR-009**: Sistema MUST impedir a combinação simultânea de "filtrar por
  entregador específico" e "sem entregador vinculado" (regra já existente,
  preservada com o novo filtro).
- **FR-010**: Sistema MUST degradar para o comportamento de filtro por
  identificador numérico já existente caso a busca por nome fique indisponível,
  sem interromper o uso da tela.

**Motorista canônico — cadastro e manutenção (User Story 4)**

- **FR-011**: Sistema MUST tratar o identificador único de cada motorista (já
  presente na planilha de origem) como a chave que correlaciona esse motorista a
  toda atividade registrada, tanto no hub quanto no aplicativo do motorista.
- **FR-012**: Users MUST be able to cadastrar manualmente um motorista informando
  nome e o identificador único correspondente da planilha de origem; o
  identificador é sempre obrigatório neste cadastro.
- **FR-013**: Sistema MUST recusar o cadastro de motorista quando o identificador
  informado estiver em formato inválido, ou já pertencer a outro motorista da
  mesma empresa, informando o motivo de forma clara.
- **FR-014**: Sistema MUST NOT gerar identificadores automaticamente nem unir/
  mesclar motoristas automaticamente por semelhança de nome — a correlação de
  dados importados com motoristas cadastrados ocorre sempre e somente pelo
  identificador único.
- **FR-015**: Users MUST be able to editar nome e situação (ativo/inativo) de um
  motorista já cadastrado. A situação do motorista é independente do status da
  credencial de acesso (FR-018): inativar um motorista NÃO desativa
  automaticamente sua credencial — a desativação de acesso exige ação explícita
  separada.
- **FR-016**: Sistema MUST exibir o identificador único do motorista de forma
  visível e copiável na listagem e no detalhe do motorista.

**Motorista canônico — credencial de acesso (User Story 5)**

- **FR-017**: Users MUST be able to criar, a partir do cadastro do motorista no
  hub, uma credencial de acesso ao aplicativo do motorista para ele.
- **FR-018**: Users MUST be able to redefinir a senha de um motorista e ativar/
  desativar sua credencial de acesso a qualquer momento.
- **FR-019**: Sistema MUST invalidar a senha anterior imediatamente após uma
  redefinição de senha.
- **FR-020**: Sistema MUST restringir as ações de escrita a usuários com a
  permissão correspondente concedida, por meio de DUAS permissões granulares
  separadas: uma para cadastro/edição de motorista e outra para gestão de
  credencial (criar, redefinir senha, ativar/desativar). Um usuário pode receber
  uma sem a outra. A leitura (listagem, detalhe e histórico de atividades) NÃO
  exige essas permissões — fica disponível a qualquer usuário autenticado da
  empresa, sempre escopada à própria empresa.

**Motorista canônico — auditoria e atividades (User Stories 4-6)**

- **FR-021**: Sistema MUST registrar, para toda criação, edição, redefinição de
  senha ou mudança de situação de motorista ou de credencial, quem realizou a
  ação e quando, disponível para consulta.
- **FR-022**: Sistema MUST exibir, no detalhe do motorista, um histórico somente-
  leitura das atividades associadas a ele (faturamento, performance, validações
  realizadas no aplicativo), correlacionadas pelo identificador único, ordenadas
  da mais recente para a mais antiga. Não há limite fixo de período ou
  quantidade — o histórico completo fica disponível (paginação técnica definida
  na fase de plano). A visualização segue o mesmo nível de acesso das telas de
  faturamento/performance (qualquer usuário autenticado da empresa), sem exigir
  as permissões de escrita de FR-020.
- **FR-022A**: Sistema MUST associar toda nova atividade registrada pelo motorista
  através do aplicativo ao identificador único do motorista autenticado no
  momento do registro.

**Restrições de ambiente**

- **FR-023**: Sistema MUST manter o comportamento e os dados do ambiente de
  produção existente idênticos e não afetados por qualquer mudança desta feature;
  nenhuma alteração desta feature é observável fora do ambiente de homologação
  onde ela é implantada.
- **FR-024**: Sistema MUST manter a tela de gestão de motoristas do sistema
  legado funcionando sem alteração de comportamento, para uso continuado por
  quem já depende dela hoje.

> **Decisões de infraestrutura**: N/A para scheduler, sessão persistente de longa
> duração, refresh de token externo ou rotação de chave — esta feature reaproveita
> o padrão de sessão/autenticação já existente do hub. O único ponto de
> idempotência relevante é a correlação de dados importados por identificador
> único (FR-011, FR-014), já coberta pela unicidade desse identificador por
> empresa.

### Key Entities

- **Motorista (canônico)**: pessoa prestadora de serviço de uma empresa,
  identificada de forma única e imutável por um identificador vindo da planilha de
  origem; possui nome e situação (ativo/inativo). É a entidade de referência para
  toda gestão e correlação de atividades no hub.
- **Credencial de acesso do motorista**: identificação e senha que permitem a um
  motorista entrar no aplicativo do motorista; sempre vinculada a exatamente um
  motorista; pode estar ativa ou desativada.
- **Atividade do motorista**: registro histórico (ex.: valor de faturamento,
  indicador de performance, validação de nota fiscal feita no aplicativo)
  associado a um motorista através do seu identificador único; somente leitura na
  visão do hub.

## Success Criteria

### Measurable Outcomes

- **SC-001**: 100% das tentativas de acessar "Painel Geral" (sidebar ou atalho da
  home) chegam à página inicial do hub sem erro de página não encontrada.
- **SC-002**: 100% dos acessos a "Meu perfil" exibem os dados do usuário sem sair
  da página em que ele estava.
- **SC-003**: Usuários encontram um entregador digitando seu nome (3+ caracteres)
  em menos de 3 segundos após parar de digitar, sem precisar conhecer um
  identificador numérico.
- **SC-004**: 100% dos motoristas cadastrados manualmente no hub possuem
  identificador único válido e sem duplicidade dentro da mesma empresa.
- **SC-005**: Um gestor consegue concluir o fluxo de cadastrar um motorista e
  conceder sua credencial de acesso em menos de 2 minutos.
- **SC-006**: 100% das atividades registradas pelo motorista pelo aplicativo,
  após a implantação, aparecem corretamente correlacionadas no histórico do
  motorista correspondente no hub.
- **SC-007**: Zero mudanças de comportamento observadas no ambiente de produção
  existente atribuíveis a esta feature após a implantação.
- **SC-008**: A tela de gestão de motoristas do sistema legado permanece
  disponível e funcional, sem interrupção percebida por quem a utiliza.

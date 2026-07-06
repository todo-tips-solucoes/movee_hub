# Feature Specification: Fundações — Contas, Papéis e Trilha de Auditoria do Hub

**Feature**: `hub-fundacoes`
**Created**: 2026-07-06
**Status**: Draft

> Sessão S2 do plano mestre do Hub de Gestão de Frota (`docs/plans/hub-frota/`). Constrói,
> no ambiente isolado `hub-homolog` (G2 já ratificado), a base de contas de usuário, papéis
> e permissões, trilha de auditoria e proteção por entidade sobre a qual todos os módulos
> futuros do hub (S3–S9) serão erguidos. Não inclui nenhuma tela — apenas as capacidades de
> backend/dados que os módulos futuros consumirão.

## Clarifications

### Session 2026-07-06 (onda-002 — mediação asker/answerer)

- Q: Qual a postura da camada adicional de proteção por entidade (FR-026/FR-027) quando a
  informação de qual entidade está autorizada está ausente ou não pode ser verificada
  (FR-028)? → A: **Nega por padrão** — o acesso aos dados cobertos por esta camada é
  recusado sempre que a informação de entidade não estiver presente/verificável. O risco de
  quebrar capacidades existentes é eliminado porque a cobertura desta camada (FR-027) se
  restringe aos dados NOVOS desta fundação; vias de acesso a dados já existentes da
  plataforma não recebem esta camada nesta fase (evolução expand-only). (score 3)
- Q: A migração de contas (FR-001–FR-005) abrange também a base de login do aplicativo de
  entregadores? → A: **Não** — apenas as contas de login do painel (entidade/empresa) são
  migradas nesta fundação; a base de login do aplicativo de entregadores fica fora do
  escopo. (score 2)
- Q: O limite de taxa por origem citado em FR-016 precisa de um número explícito nesta
  spec? → A: **Não** — o threshold por origem é decisão de implementação a ser definida no
  plano técnico; a spec quantifica apenas o bloqueio por conta (FR-017: 5 falhas
  consecutivas / 15 minutos). (score 2)
- Q: Esta fundação inclui capacidade de criar/convidar novos usuários além dos migrados?
  → A: **Não** — nesta fundação existem apenas os usuários trazidos pela migração;
  criação/convite de novos usuários fica para sessão futura (S3+). (score 2)
- Q: A imutabilidade do registro de auditoria (FR-024) deve ser reforçada também na camada
  de dados (além de nenhuma capacidade normal do hub permitir edição/remoção)?
  → A: **Sim, reforçada também no banco** — REVOKE de UPDATE/DELETE ao role usado pelo
  PostgREST na tabela de auditoria, mais um trigger bloqueador nas operações de UPDATE/
  DELETE, além de nenhum endpoint do hub expor edição/remoção. Decisão do operador
  (block-001; score 1 — ambas as opções eram compatíveis com a constitution — devolvida
  ao humano), coerente com a postura nega-por-padrão de FR-028 (defesa em profundidade,
  expand-only).

## User Scenarios & Testing

### User Story 1 - Cliente existente entra no hub sem trocar de senha (Priority: P1)

Uma pessoa que já tem uma conta na plataforma atual (login por empresa/CNPJ e senha)
precisa conseguir acessar o novo hub usando exatamente as mesmas credenciais que já usa
hoje — sem qualquer ação de "migrar minha conta" ou redefinir senha.

**Why this priority**: É o alicerce de tudo. Sem isso não existe usuário autenticado no
hub e nenhuma outra capacidade (papéis, auditoria, módulos futuros) tem quem autenticar.
Também é o requisito de continuidade de negócio: nenhum cliente pode ficar "trancado para
fora" por causa da evolução da plataforma.

**Independent Test**: Pegar uma conta que já existe hoje na plataforma, autenticar no
endpoint do novo hub com o e-mail e a senha atuais, e confirmar acesso concedido — sem
nenhuma etapa extra de configuração de conta.

**Acceptance Scenarios**:

1. **Given** uma conta que já existe na plataforma hoje com login e senha ativos, **When**
   a fundação de contas do hub é colocada em produção (ambiente isolado), **Then** essa
   conta passa a existir também como conta de usuário do hub, com acesso à mesma entidade
   (empresa) de antes, sem que ninguém precise redefinir senha.
2. **Given** uma conta migrada, **When** a pessoa autentica no hub com e-mail e senha
   originais, **Then** o acesso é concedido com sucesso na primeira tentativa.
3. **Given** uma conta migrada, **When** a pessoa continua usando a tela de login antiga
   (fluxo já existente hoje), **Then** o acesso antigo continua funcionando normalmente,
   sem qualquer diferença perceptível.

---

### User Story 2 - Administrador da entidade controla quem acessa o quê (Priority: P2)

Um administrador de uma empresa (entidade) cliente precisa que cada pessoa da sua equipe
tenha acesso apenas ao que sua função permite (por exemplo: alguém de operação não deveria
conseguir ver a trilha de auditoria administrativa, e alguém de apenas consulta não deveria
conseguir alterar dados). Quando a pessoa atua em mais de uma filial, precisa poder alternar
entre elas sem sair e entrar de novo.

**Why this priority**: É o que torna a plataforma seguindo de multi-usuário/multi-papel
seguro para operar — sem isso, todo usuário autenticado teria acesso irrestrito a tudo,
inviabilizando qualquer módulo sensível (faturamento, dados de motoristas) planejado para
as próximas sessões.

**Independent Test**: Criar duas contas com papéis diferentes na mesma entidade, confirmar
que cada uma só enxerga as capacidades do seu papel; dar a uma pessoa acesso a duas
entidades e confirmar que ela consegue trocar de uma para outra dentro da mesma sessão.

**Acceptance Scenarios**:

1. **Given** uma pessoa com papel de "somente leitura", **When** ela tenta executar uma
   ação de escrita/gestão em qualquer capacidade do hub, **Then** o sistema recusa a ação
   informando falta de permissão.
2. **Given** uma pessoa com acesso a mais de uma entidade (matriz e filial, por exemplo),
   **When** ela consulta seu perfil logo após autenticar, **Then** o sistema lista todas as
   entidades às quais ela tem acesso e qual está ativa no momento.
3. **Given** uma pessoa com acesso a mais de uma entidade, **When** ela solicita trocar a
   entidade ativa para uma das outras que já tem acesso, **Then** a troca é aplicada
   imediatamente e as próximas ações passam a valer para a entidade recém-selecionada.
4. **Given** uma pessoa sem nenhum vínculo com uma entidade, **When** ela tenta trocar para
   essa entidade, **Then** o sistema recusa a troca.
5. **Given** um administrador altera o papel de uma pessoa da sua equipe, **When** essa
   mudança é salva, **Then** em no máximo 60 segundos a pessoa afetada já opera sob o novo
   conjunto de permissões (mesmo sem deslogar).

---

### User Story 3 - Pessoa recupera o acesso quando esquece a senha (Priority: P3)

Uma pessoa que esqueceu sua senha precisa conseguir recuperá-la de forma segura, sem
depender de suporte manual, e sem que o processo revele a terceiros se um determinado
e-mail está ou não cadastrado.

**Why this priority**: É uma jornada de autoatendimento essencial para adoção — sem ela,
qualquer esquecimento de senha vira ticket de suporte. Prioridade abaixo das duas
anteriores porque o acesso básico (US1) e o controle de permissões (US2) são pré-requisitos
funcionais mais urgentes para o restante do hub.

**Independent Test**: Solicitar recuperação para um e-mail cadastrado e para um e-mail não
cadastrado e confirmar que a resposta observável é idêntica nos dois casos; completar o
fluxo com o link/token recebido e confirmar login com a nova senha.

**Acceptance Scenarios**:

1. **Given** um e-mail cadastrado no hub, **When** a pessoa solicita recuperação de senha,
   **Then** ela recebe um meio de redefinir a senha, válido por tempo limitado e utilizável
   uma única vez.
2. **Given** um e-mail que não existe no hub, **When** alguém solicita recuperação para
   esse e-mail, **Then** a resposta do sistema é indistinguível da resposta dada a um
   e-mail que existe (nenhuma confirmação nem negação de cadastro é revelada).
3. **Given** um pedido de redefinição válido e ainda dentro do prazo, **When** a pessoa
   define uma nova senha, **Then** a senha é trocada e todas as sessões anteriores dessa
   conta (em qualquer dispositivo) deixam de funcionar, exigindo novo login.
4. **Given** um pedido de redefinição expirado ou já utilizado, **When** alguém tenta
   usá-lo novamente, **Then** o sistema recusa e a senha não é alterada.

---

### User Story 4 - Tentativas indevidas de acesso são contidas e registradas (Priority: P4)

A operação da plataforma precisa que tentativas repetidas e malsucedidas de login sejam
automaticamente contidas (sem intervenção manual) e que todo evento de login — sucesso ou
falha — fique registrado de forma auditável, para investigação futura de incidentes.

**Why this priority**: É uma proteção de fundo (defesa em profundidade e conformidade),
necessária antes de o hub crescer para módulos com dados mais sensíveis, mas não bloqueia
a operação básica das três jornadas anteriores — por isso vem depois.

**Independent Test**: Simular 5 tentativas de login malsucedidas seguidas para a mesma
conta e confirmar bloqueio temporário; consultar a trilha de auditoria e confirmar que
tentativas de sucesso e falha aparecem registradas com quem, quando e resultado.

**Acceptance Scenarios**:

1. **Given** uma conta válida, **When** ocorrem 5 tentativas de login malsucedidas
   seguidas, **Then** novas tentativas (mesmo com a senha correta) são recusadas por um
   período de espera antes de o login voltar a ser permitido.
2. **Given** uma conta temporariamente bloqueada por tentativas malsucedidas, **When** o
   período de espera termina, **Then** um login com a senha correta volta a funcionar
   normalmente.
3. **Given** qualquer tentativa de login (bem-sucedida ou não), **When** ela ocorre,
   **Then** fica registrado um evento de auditoria com o resultado, sem expor a senha
   utilizada.
4. **Given** uma pessoa autenticada, **When** ela encerra a sessão (logout), **Then** essa
   sessão específica deixa de poder ser usada para renovar acesso.

---

### User Story 5 - Dados de uma entidade nunca ficam visíveis para outra, mesmo sob falha de código (Priority: P5)

A plataforma opera múltiplas empresas clientes (entidades) sobre a mesma base de dados.
O negócio precisa de uma garantia adicional, independente da lógica de aplicação, de que
um bug em uma tela ou endpoint futuro não pode expor dados de uma entidade para outra.

**Why this priority**: É uma camada de segurança de reforço ("cinto e suspensório") sobre
capacidades que as User Stories 1–4 já entregam com segurança primária no backend. Tem
prioridade mais baixa porque não é percebida diretamente por nenhum usuário em uso normal
— só se manifesta como proteção adicional caso algo mais falhe.

**Independent Test**: Com credenciais de acesso restritas à Entidade A, tentar consultar
diretamente um recurso de dados pertencente à Entidade B e confirmar que nenhum dado é
retornado, mesmo contornando a camada de aplicação.

**Acceptance Scenarios**:

1. **Given** um acesso legitimamente restrito à Entidade A, **When** uma tentativa de
   leitura de dados é feita fora da checagem normal de aplicação (diretamente na camada de
   dados) buscando registros da Entidade B, **Then** zero registros da Entidade B são
   retornados.
2. **Given** o mesmo cenário, **When** a mesma tentativa busca registros da própria
   Entidade A, **Then** os registros são retornados normalmente (a proteção não quebra o
   uso legítimo).

---

### Edge Cases

- Uma conta existente hoje sem senha definida (ex.: filial cadastrada sem login ativo)
  não gera conta de usuário utilizável no hub nesta migração — ela precisa primeiro ter uma
  senha definida pelo fluxo legado existente; nenhuma conta "quebrada" (sem meio de
  autenticar) é criada.
- Repetir a operação de trazer contas existentes para o hub uma segunda vez não duplica
  contas nem re-executa efeitos colaterais — cada conta de origem gera no máximo uma conta
  no hub.
- Uma pessoa sem nenhum vínculo ativo com qualquer entidade não consegue efetivamente usar
  o hub após autenticar (autenticação sozinha não implica acesso a nada).
- Quando o único vínculo ativo de uma pessoa com uma entidade é desativado enquanto ela
  está com sessão aberta, a próxima ação sensível deve refletir a perda de acesso (não
  apenas a próxima vez que fizer login).
- Solicitar recuperação de senha repetidamente para a mesma conta em curto intervalo não
  deve permitir contornar o limite de tentativas nem gerar múltiplos pedidos válidos
  simultâneos conflitantes — apenas o pedido mais recente é válido.
- Envio de e-mail de recuperação indisponível (falha do serviço de e-mail) não deve
  vazar essa falha de um jeito que diferencie "e-mail existe, mas o envio falhou" de
  "e-mail não existe" — a resposta ao solicitante permanece idêntica em ambos os casos.

## Requirements

### Functional Requirements

**Contas e migração de login**

- **FR-001**: O sistema MUST permitir que qualquer conta hoje ativa na plataforma (login +
  senha) passe a autenticar no hub sem que a senha original precise ser redefinida.
- **FR-002**: O sistema MUST vincular, para cada conta migrada, acesso à mesma entidade
  (empresa) à qual ela já pertence hoje, com um papel administrativo dessa entidade.
- **FR-003**: O sistema MUST manter o fluxo de login já existente hoje funcionando sem
  nenhuma alteração perceptível durante todo o período de convivência entre o login antigo
  e o novo do hub.
- **FR-004**: O processo de trazer contas existentes para o hub MUST ser seguro para
  repetir (executar mais de uma vez não duplica contas nem corrompe as já trazidas).
- **FR-005**: O sistema MUST excluir da migração contas de origem que hoje não têm meio de
  autenticar (sem senha definida) — elas não recebem conta utilizável no hub até que a
  situação de origem seja corrigida pelo fluxo já existente.

**Papéis, permissões e troca de entidade**

- **FR-006**: O sistema MUST associar a cada pessoa um ou mais papéis, cada um vinculado a
  uma entidade específica (ou, para papéis de administração da plataforma como um todo,
  válido em qualquer entidade).
- **FR-007**: O sistema MUST fornecer, para cada combinação de capacidade e ação, uma
  permissão nomeada que pode ser concedida a um papel (por exemplo: consultar, listar,
  criar, editar, excluir, importar, exportar, enviar, aprovar, gerenciar — aplicadas às
  capacidades hoje conhecidas: painel geral, motoristas/entregadores, faturamento,
  performance, importações, envio em massa, gestão de usuários, auditoria, administração).
- **FR-008**: O sistema MUST fornecer, na criação da fundação, pelo menos quatro papéis
  prontos para uso: um de administração de toda a plataforma, um de administração de uma
  entidade específica, um operacional e um de apenas consulta — cada um com um conjunto de
  permissões coerente com seu propósito.
- **FR-009**: Quando uma pessoa acumula mais de um papel aplicável (por vínculo direto ou
  por escopo mais amplo), o sistema MUST conceder a ela a união de todas as permissões
  desses papéis (nenhuma permissão concedida por um papel é anulada por outro).
- **FR-010**: O sistema MUST permitir que uma pessoa com vínculo ativo a mais de uma
  entidade consulte quais entidades tem acesso e troque qual delas está ativa na sessão
  corrente, sem precisar autenticar novamente.
- **FR-011**: O sistema MUST recusar a troca de entidade ativa quando a pessoa não tem
  vínculo ativo com a entidade solicitada.
- **FR-012**: Toda ação de qualquer capacidade nova entregue por esta fundação MUST
  verificar que a pessoa possui a permissão específica exigida antes de executá-la — não
  deve existir ação exposta sem essa verificação.
- **FR-013**: O sistema MUST refletir uma mudança de papel ou de vínculo feita por um
  administrador na sessão da pessoa afetada em no máximo 60 segundos, mesmo que ela não
  tenha feito logout.

**Autenticação e proteção de conta**

- **FR-014**: O sistema MUST permitir login por e-mail e senha para as contas do hub, com
  uma sessão válida por um período curto e renovável sem exigir novo login enquanto a
  pessoa estiver ativa.
- **FR-015**: O sistema MUST responder de forma indistinguível a uma tentativa de login
  com e-mail inexistente e a uma tentativa com e-mail existente e senha errada (nenhuma das
  duas deve revelar se o e-mail está cadastrado).
- **FR-016**: O sistema MUST limitar a taxa de tentativas de login por origem e por conta,
  de forma a dificultar tentativas automatizadas de adivinhação de senha.
- **FR-017**: O sistema MUST bloquear temporariamente novas tentativas de login para uma
  conta após 5 tentativas malsucedidas consecutivas, pelo período de 15 minutos, voltando a
  permitir login normalmente depois desse período.
- **FR-018**: O sistema MUST permitir que uma pessoa encerre sua sessão atual (logout), e a
  partir desse momento essa sessão específica não pode mais ser usada para renovar acesso.
- **FR-019**: O sistema MUST permitir que uma pessoa que esqueceu a senha solicite
  recuperação por e-mail, sem exigir estar autenticada.
- **FR-020**: O sistema MUST responder de forma idêntica a um pedido de recuperação de
  senha para e-mail cadastrado e para e-mail não cadastrado, e essa mesma resposta idêntica
  MUST valer também quando o envio do e-mail falha por qualquer motivo de infraestrutura.
- **FR-021**: O meio de redefinição de senha enviado MUST expirar após um tempo limitado e
  MUST deixar de ser utilizável assim que usado uma vez.
- **FR-022**: Ao concluir uma redefinição de senha bem-sucedida, o sistema MUST invalidar
  todas as sessões ativas daquela conta em qualquer dispositivo, exigindo novo login em
  todos eles.

**Auditoria**

- **FR-023**: O sistema MUST registrar todo evento de login (sucesso ou falha) de forma
  que fique disponível para consulta posterior, identificando quando ocorreu e a que conta
  se refere, sem registrar a senha utilizada.
- **FR-024**: O sistema MUST manter um registro de auditoria que, uma vez gravado, não pode
  ser alterado nem removido. Esta imutabilidade MUST ser reforçada em duas camadas
  independentes: (a) nenhum endpoint do hub expõe capacidade de edição/remoção do registro
  de auditoria; (b) reforço na camada de dados — o role usado pelo PostgREST para acessar a
  tabela de auditoria MUST ter os privilégios UPDATE/DELETE revogados (`REVOKE`), e um
  trigger de banco MUST bloquear (`RAISE EXCEPTION`) qualquer tentativa de UPDATE ou DELETE
  na tabela, mesmo que a camada de aplicação seja contornada ou tenha falha não prevista
  (defesa em profundidade, decisão do operador — clarify Q2/block-001).
- **FR-025**: O registro de auditoria MUST nunca conter dados sensíveis em texto aberto
  (ex.: senhas, tokens de recuperação) mesmo quando descreve alterações de dados.

**Isolamento entre entidades (defesa em profundidade)**

- **FR-026**: Além da verificação de permissão feita a cada ação (FR-012), o sistema MUST
  ter uma camada adicional e independente de proteção que impede a leitura de dados de uma
  entidade por quem tem acesso restrito a outra, mesmo que a camada de verificação de
  permissão seja contornada ou tenha uma falha não prevista.
- **FR-027**: Esta camada adicional de proteção MUST cobrir, no mínimo, todos os dados
  novos introduzidos por esta fundação (contas, vínculos, papéis, permissões e trilha de
  auditoria) que carregam associação a uma entidade específica.
- **FR-028**: A camada adicional de proteção (FR-026) MUST adotar postura "nega por
  padrão": sempre que a informação de qual entidade está autorizada não estiver presente ou
  não puder ser verificada, o acesso aos dados cobertos por esta camada MUST ser recusado
  (zero registros retornados). Essa postura aplica-se exclusivamente aos dados novos
  introduzidos por esta fundação (cobertura definida em FR-027); os dados e vias de acesso
  já existentes da plataforma NÃO recebem esta camada nesta fase (evolução expand-only) e
  permanecem protegidos apenas pelas verificações que já possuem hoje — nenhuma capacidade
  existente é afetada.

### Key Entities

- **Usuário**: pessoa que acessa o hub. Tem e-mail (identificador de login), uma senha (
  armazenada de forma irreversível), estado ativo/inativo, contador de tentativas de login
  malsucedidas e período de bloqueio quando aplicável, e um meio de recuperação de senha
  quando solicitado.
- **Vínculo Usuário–Entidade**: liga uma pessoa a uma entidade (empresa) com um papel
  específico; uma pessoa pode ter vários vínculos (várias entidades, com papéis distintos
  em cada uma).
- **Papel**: conjunto nomeado de permissões, aplicável a uma entidade específica ou a toda
  a plataforma (papéis de administração geral).
- **Permissão**: uma capacidade nomeada e concedível (ex.: "consultar motoristas",
  "exportar faturamento"), sempre associada a uma área/capacidade do hub.
- **Capacidade do hub (módulo)**: agrupador das permissões e da navegação futura (ex.:
  painel, motoristas, faturamento, performance, importações, envio em massa, usuários,
  auditoria, administração); pode estar habilitado ou não por entidade.
- **Registro de auditoria**: evento imutável descrevendo uma ação relevante (quem, quando,
  o quê, resultado), sem dados sensíveis em texto aberto.
- **Sessão**: representa um acesso autenticado ativo de uma pessoa; pode ser encerrada
  individualmente (logout) ou em massa (troca de senha).

> Decisões de infraestrutura auditáveis (aplicável a esta feature, que introduz sessões
> persistentes e um processo de migração de dados):
> - **Política de renovação de sessão**: renovação sob demanda pela própria pessoa
>   enquanto ativa (sem job periódico); sessão de acesso de vida curta, sessão de
>   renovação de vida mais longa, com possibilidade de revogação individual (logout) ou
>   em massa (troca de senha).
> - **Idempotência**: tanto a criação das capacidades novas quanto o processo de trazer
>   contas existentes para o hub (FR-004) devem poder ser repetidos sem duplicar efeitos.
> - **Rotação de chaves, agendamento periódico e trava multi-instância**: N/A explícito —
>   esta feature não introduz criptografia de dados em repouso com chave rotacionável,
>   não dispara trabalho periódico agendado, e não há hoje mais de uma instância do
>   backend do hub rodando simultaneamente sobre o mesmo estado.
> - **Backup/restore**: coberto pela rotina diária já existente do ambiente isolado
>   (backup do banco completo); nenhuma rotina adicional específica desta feature.

## Success Criteria

### Measurable Outcomes

- **SC-001**: 100% das contas hoje ativas na plataforma (com senha definida) conseguem
  autenticar no hub usando exatamente as mesmas credenciais, sem qualquer ação adicional.
- **SC-002**: Repetir o processo de trazer contas existentes para o hub uma segunda vez
  resulta em zero contas adicionais ou alteradas (nenhum efeito colateral de repetição).
- **SC-003**: Uma pessoa sem a permissão exigida recebe recusa em 100% das tentativas de
  executar uma ação restrita, sem exceção.
- **SC-004**: Uma mudança de papel ou vínculo feita por um administrador passa a valer para
  a pessoa afetada em até 60 segundos, mesmo sem logout/login.
- **SC-005**: Uma solicitação de recuperação de senha produz a mesma resposta observável
  esteja o e-mail cadastrado ou não, em 100% dos casos testados.
- **SC-006**: Após 5 tentativas de login malsucedidas consecutivas para a mesma conta, a
  6ª tentativa (mesmo com senha correta) é recusada; passados os 15 minutos, um login com
  senha correta é aceito na primeira tentativa seguinte.
- **SC-007**: Após uma redefinição de senha bem-sucedida, 100% das sessões anteriormente
  ativas daquela conta deixam de conseguir renovar acesso.
- **SC-008**: Uma tentativa de leitura de dados de uma entidade feita com credenciais
  restritas a outra entidade, mesmo contornando a camada normal de verificação de
  permissão, retorna zero registros em 100% das tentativas testadas.
- **SC-009**: 100% dos eventos de login (sucesso e falha) ficam disponíveis para consulta
  em uma trilha de auditoria, sem exceção e sem exposição de senha.

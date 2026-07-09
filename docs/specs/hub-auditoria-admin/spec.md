# Feature Specification: Auditoria e Administração da Plataforma

**Feature**: `hub-auditoria-admin`
**Created**: 2026-07-09
**Status**: Draft

## Clarifications

### Session 2026-07-09 (onda-002 — clarify, dec-008/dec-009)

- Q: Um administrador de entidade pode criar/editar papéis personalizados da
  própria entidade, ou os papéis são um catálogo fixo da plataforma?
  → A: **Catálogo fixo da plataforma.** Os papéis são os 4 papéis-sistema
  seedados na S2 (`admin_plataforma`, `admin_entidade`, `operador`,
  `leitura` — migration 0007, todos `is_sistema=true`, sem coluna de
  entidade em `Papel`/`PapelPermissao`). O administrador de entidade apenas
  ATRIBUI papéis existentes aos usuários da própria entidade; não cria,
  edita nem exclui papéis, nem altera o conjunto de permissões de um papel.
  A tela `/papeis` (FR-010) é matriz papel×permissão; qualquer ajuste da
  matriz é restrito a quem tem administração da plataforma. (score 3,
  dec-008)
- Q: A habilitação/desabilitação de módulos por entidade é exclusiva do
  admin_plataforma, ou o admin_entidade também visualiza/solicita?
  → A: **Exclusiva do admin_plataforma (leitura E escrita).** GET e PUT dos
  endpoints de módulos ficam sob a mesma permissão de administração da
  plataforma (`admin.manage`; migration 0007 exclui `admin.gerenciar` do
  papel admin_entidade). O administrador de entidade não tem tela nem
  endpoint de módulos: percebe o efeito apenas indiretamente (item de
  navegação aparece/some; acesso liberado/bloqueado — FR-008). Nenhum fluxo
  de solicitação nesta feature. (score 3, dec-009)

## User Scenarios & Testing

### User Story 1 - Consultar trilha de auditoria da própria entidade (Priority: P1)

Como administrador de uma entidade (cliente/tenant do Hub), quero consultar a
trilha de ações realizadas dentro da minha entidade — quem fez o quê, quando,
sobre qual recurso — com filtros por ação, usuário, recurso e período, para
investigar incidentes, esclarecer dúvidas de clientes internos e confirmar que
uma operação (importação, edição de motorista, alteração de papel, etc.)
realmente aconteceu, sem precisar de acesso direto ao banco de dados.

**Why this priority**: É o valor central da feature e o motivo de existir uma
trilha de auditoria: transformar um registro que hoje só existe no banco em
algo consultável por quem tem responsabilidade sobre a entidade. Sem isso, a
auditoria acumulada nas fases anteriores (S2–S8) não tem uso prático.

**Independent Test**: Provocar uma ação real (ex.: editar um motorista, criar
uma importação) na própria entidade, depois abrir a tela de auditoria, aplicar
filtros de ação/recurso/período e confirmar que o evento aparece com os dados
corretos e sem dados sensíveis expostos.

**Acceptance Scenarios**:

1. **Given** um administrador autenticado com uma entidade ativa selecionada,
   **When** ele abre a tela de auditoria sem aplicar nenhum filtro, **Then** vê
   uma lista paginada dos eventos mais recentes pertencentes apenas à sua
   entidade.
2. **Given** uma lista de eventos exibida, **When** o administrador filtra por
   tipo de ação, usuário responsável e intervalo de datas, **Then** a lista é
   restrita aos eventos que atendem a todos os filtros combinados.
3. **Given** um evento na lista, **When** o administrador abre o detalhe do
   evento, **Then** vê os dados do evento (ação, recurso, responsável, data)
   sem que documentos, senhas ou nomes completos apareçam em texto claro.
4. **Given** um administrador sem nenhuma entidade ativa selecionada na sessão,
   **When** ele tenta consultar a trilha de auditoria, **Then** o sistema nega
   o acesso por padrão (retorna lista vazia/erro de escopo), nunca uma lista
   com eventos de todas as entidades.

---

### User Story 2 - Visão global de auditoria para administração da plataforma (Priority: P2)

Como administrador da plataforma (equipe que opera o Hub para todos os
clientes), quero consultar a trilha de auditoria de qualquer entidade, com os
mesmos filtros disponíveis para o administrador de entidade, para investigar
incidentes que atravessam clientes, dar suporte e confirmar o comportamento do
sistema como um todo.

**Why this priority**: Sem essa visão, o suporte da plataforma fica dependente
de acesso direto ao banco para qualquer investigação cross-tenant, o que
contradiz o objetivo de ter uma trilha consultável e aumenta o risco de erro
manual em consultas ad-hoc.

**Independent Test**: Como administrador de plataforma, consultar a trilha de
auditoria informando o filtro de entidade e confirmar que eventos de entidades
diferentes da própria aparecem; repetir sem filtro de entidade e confirmar que
eventos de múltiplas entidades aparecem juntos.

**Acceptance Scenarios**:

1. **Given** um administrador de plataforma autenticado, **When** ele consulta
   a trilha de auditoria sem informar uma entidade específica, **Then** vê
   eventos de todas as entidades, paginados e ordenados por data.
2. **Given** um administrador de plataforma autenticado, **When** ele filtra
   por uma entidade específica, **Then** vê apenas os eventos daquela
   entidade, incluindo eventos que um administrador daquela entidade também
   veria.

---

### User Story 3 - Gerenciar usuários e papéis por telas completas (Priority: P3)

Como administrador (de entidade ou de plataforma, conforme sua permissão),
quero gerenciar usuários (criar, editar, vincular a entidades, atribuir
papéis) e visualizar/ajustar a matriz de papéis e permissões através de telas
dedicadas, para não depender de operações diretas no banco para tarefas de
administração do dia a dia.

**Why this priority**: A capacidade de gerenciar usuários e papéis já existe
por trás de endpoints desde fases anteriores; sem telas completas, cada
alteração exige uma pessoa técnica operando diretamente no banco ou via
chamadas manuais de API, o que é lento e arriscado.

**Independent Test**: Criar um usuário novo pela tela, vinculá-lo a uma
entidade com um papel específico, depois alterar o papel desse usuário e
confirmar (em uma sessão ativa desse usuário, ou numa nova chamada autenticada
por ele) que as permissões efetivas mudaram imediatamente.

**Acceptance Scenarios**:

1. **Given** um administrador com permissão de gestão de usuários, **When**
   ele cria um novo usuário e o vincula a uma entidade com um papel, **Then**
   o usuário passa a existir com aquele vínculo e pode autenticar-se com as
   permissões daquele papel.
2. **Given** um usuário existente com um papel atribuído, **When** o
   administrador altera o papel desse usuário na tela de usuários, **Then** as
   permissões efetivas do usuário mudam imediatamente, sem depender do prazo
   de expiração do cache de permissões.
3. **Given** a tela de matriz papel × permissão, **When** o administrador
   visualiza a matriz, **Then** vê claramente quais permissões cada papel
   concede, através de indicadores marcáveis (checkboxes) organizados por
   papel e por permissão.

---

### User Story 4 - Administrar módulos habilitados por entidade (Priority: P4)

Como administrador da plataforma, quero habilitar ou desabilitar módulos
(funcionalidades) para cada entidade individualmente, para controlar quais
capacidades cada cliente enxerga e pode usar, refletindo isso imediatamente
no menu de navegação da entidade afetada.

**Why this priority**: O Hub é modular por desenho (cada fase anterior
entregou um módulo); sem uma administração central de habilitação por
entidade, não há como oferecer planos/pacotes diferentes por cliente nem
desativar um módulo problemático para uma entidade específica sem intervenção
manual no banco.

**Independent Test**: Desabilitar um módulo para uma entidade específica e
confirmar que (a) o item correspondente desaparece do menu de navegação de
quem acessa por aquela entidade e (b) uma tentativa de uso direto da
funcionalidade daquele módulo é bloqueada.

**Acceptance Scenarios**:

1. **Given** um administrador de plataforma na tela de configuração de
   módulos, **When** ele desabilita um módulo para uma entidade, **Then** o
   item de menu correspondente deixa de aparecer para usuários daquela
   entidade na próxima interação com o sistema.
2. **Given** um módulo desabilitado para uma entidade, **When** um usuário
   daquela entidade tenta acessar a funcionalidade correspondente diretamente,
   **Then** o acesso é recusado.
3. **Given** um administrador de plataforma, **When** ele reabilita um módulo
   para uma entidade, **Then** o item volta a aparecer no menu e a
   funcionalidade volta a responder normalmente.

---

### Edge Cases

- O que acontece quando um administrador consulta a trilha de auditoria sem
  ter uma entidade ativa selecionada na sessão? O sistema nega por padrão
  (nunca retorna a trilha completa do usuário nem de todas as entidades).
- O que acontece quando um administrador de entidade tenta forçar, via
  filtro, a visualização de eventos de outra entidade? O sistema ignora ou
  recusa o filtro fora do escopo permitido — o resultado nunca extrapola a
  própria entidade.
- O que acontece quando uma tentativa de alteração ou exclusão de um evento de
  auditoria é feita (por engano ou intencionalmente)? A operação é negada; a
  trilha é imutável por construção, não apenas por convenção de uso.
- O que acontece quando o período informado no filtro é inválido (data
  inicial posterior à data final)? O sistema recusa o filtro com uma
  mensagem clara, sem quebrar a consulta.
- O que acontece quando a paginação é solicitada além do total de resultados
  disponíveis? O sistema retorna uma lista vazia para aquela página, sem erro.
- O que acontece quando um evento de auditoria não tem uma entidade associada
  (eventos de autenticação anteriores à resolução da entidade)? Esses eventos
  só aparecem na visão global do administrador de plataforma, nunca na visão
  de um administrador de entidade.
- O que acontece quando um módulo é desabilitado para uma entidade enquanto
  usuários dessa entidade estão com sessão ativa? O bloqueio de acesso à
  funcionalidade e o desaparecimento do item de menu acontecem de forma
  imediata, não apenas na próxima autenticação.
- O que acontece com endpoints de fases anteriores que ainda não registravam
  eventos de auditoria? Passam a registrar como parte desta feature; nenhuma
  ação de escrita relevante das fases anteriores fica fora da trilha.

## Requirements

### Functional Requirements

- **FR-001**: O sistema MUST permitir consultar a trilha de auditoria com
  filtros combináveis por tipo de ação, usuário responsável, recurso afetado
  e intervalo de datas, com resultados paginados.
- **FR-002**: O sistema MUST restringir o escopo da consulta de auditoria
  conforme o papel de quem consulta: administrador de entidade vê somente
  eventos da própria entidade; administrador de plataforma vê eventos de
  todas as entidades.
- **FR-003**: O sistema MUST negar por padrão (nunca retornar a trilha
  completa) quando uma consulta de auditoria é feita sem uma entidade ativa
  determinável no contexto de quem consulta.
- **FR-004**: O sistema MUST apresentar os detalhes de cada evento de
  auditoria sem expor dados sensíveis (documentos de identificação, senhas,
  tokens, nomes completos de terceiros) em texto claro.
- **FR-005**: O sistema MUST garantir que a trilha de auditoria seja
  imutável — nenhuma alteração ou remoção de um evento já registrado é
  permitida, por qualquer via.
- **FR-006**: O sistema MUST garantir que toda ação de escrita realizada
  pelas áreas já existentes da plataforma (fundações/autenticação,
  importações, motoristas, faturamento, performance, envio em massa) gere um
  evento correspondente na trilha de auditoria, fechando lacunas
  identificadas nas fases anteriores.
- **FR-007**: O sistema MUST permitir que um administrador de plataforma
  habilite ou desabilite módulos (funcionalidades) individualmente para cada
  entidade.
- **FR-008**: O sistema MUST refletir a habilitação/desabilitação de um
  módulo para uma entidade imediatamente: o item de navegação correspondente
  aparece/desaparece e o acesso à funcionalidade é permitido/bloqueado sem
  depender de nova autenticação.
- **FR-009**: O sistema MUST oferecer uma tela de gestão de usuários que
  permita criar, editar, vincular usuários a entidades e atribuir papéis,
  restrita a quem tem permissão de administração de usuários.
- **FR-010**: O sistema MUST oferecer uma tela de visualização da matriz de
  papéis e permissões, organizada por papel e por permissão; qualquer
  capacidade de ajuste dessa matriz é restrita a quem tem permissão de
  administração da plataforma — um administrador de entidade a acessa em
  modo somente leitura (consistente com FR-016). [Clarifications
  2026-07-09, dec-008]
- **FR-011**: O sistema MUST garantir que uma alteração de papel de um
  usuário reflita nas permissões efetivas desse usuário de forma imediata,
  não dependente do prazo de expiração de qualquer cache de permissões.
- **FR-012**: O sistema MUST oferecer uma tela de consulta da trilha de
  auditoria com filtros e visualização de detalhes, sem qualquer capacidade
  de edição — consistente com a imutabilidade da trilha (FR-005).
- **FR-013**: O sistema MUST oferecer uma tela de administração de módulos
  habilitados por entidade, restrita a quem tem permissão de administração da
  plataforma.
- **FR-014**: O sistema MUST NOT implementar retenção ou expurgo automático
  de eventos de auditoria nesta feature — a trilha é preparada para uma
  política futura de retenção, mas o expurgo em si fica fora de escopo.
- **FR-015**: O sistema MUST NOT oferecer exportação da trilha de auditoria
  nesta feature (capacidade futura, fora de escopo).
- **FR-016**: O sistema MUST manter o catálogo de papéis (nome, escopo e
  conjunto de permissões associado) como definido e mantido exclusivamente
  pela plataforma — papéis-sistema fixos (admin_plataforma, admin_entidade,
  operador, leitura). Um administrador de entidade MUST apenas atribuir
  papéis já existentes desse catálogo aos usuários vinculados à própria
  entidade, sem capacidade de criar, editar ou excluir papéis, nem de
  alterar o conjunto de permissões associado a um papel. [Clarifications
  2026-07-09, dec-008]
- **FR-017**: O sistema MUST restringir toda capacidade de administração de
  módulos por entidade — tanto leitura quanto escrita — exclusivamente a
  quem tem permissão de administração da plataforma. Um administrador de
  entidade MUST NOT ter acesso a tela ou endpoint de administração de
  módulos, percebendo o efeito de uma habilitação/desabilitação apenas
  indiretamente, pelo aparecimento/desaparecimento do item de navegação
  correspondente e pelo bloqueio/liberação de acesso à funcionalidade
  (consistente com FR-008). [Clarifications 2026-07-09, dec-009]

> Decisões de infraestrutura: N/A — esta feature não introduz scheduler,
> criptografia de dados persistentes, refresh de token externo, novo
> mecanismo de lock multi-réplica, nem nova política de backup. Reaproveita
> a tabela de auditoria e o modelo de permissões já existentes.

### Key Entities

- **Evento de Auditoria**: registro imutável de uma ação relevante ocorrida
  na plataforma — quem realizou, que tipo de ação, sobre qual recurso, em
  qual entidade (quando aplicável), quando ocorreu e detalhes adicionais sem
  dados sensíveis. É a unidade central consultada pelas telas de auditoria.
- **Módulo**: uma funcionalidade/capacidade da plataforma que pode ser
  habilitada ou desabilitada independentemente para cada entidade.
- **Habilitação de Módulo por Entidade**: o vínculo que determina se um
  módulo específico está ativo para uma entidade específica, refletido na
  navegação e no acesso à funcionalidade.
- **Usuário**: pessoa com acesso à plataforma, potencialmente vinculada a uma
  ou mais entidades, cada vínculo com um papel associado.
- **Papel**: conjunto nomeado de permissões que pode ser atribuído a um
  usuário em uma entidade, determinando o que ele pode ver e fazer.
- **Permissão**: capacidade individual (ex.: administrar usuários, consultar
  auditoria, administrar módulos) que compõe um papel.

## Success Criteria

### Measurable Outcomes

- **SC-001**: Um administrador de entidade localiza um evento específico da
  própria entidade em menos de 30 segundos usando os filtros disponíveis na
  tela de auditoria.
- **SC-002**: 100% das ações de escrita relevantes realizadas pelas áreas já
  existentes da plataforma (fundações/autenticação, importações, motoristas,
  faturamento, performance, envio em massa) aparecem na trilha de auditoria.
- **SC-003**: 0% das tentativas de alteração ou exclusão de um evento de
  auditoria já registrado são bem-sucedidas.
- **SC-004**: Uma alteração de papel de usuário reflete nas permissões
  efetivas em menos de 2 segundos, sem depender do ciclo de expiração de
  cache.
- **SC-005**: 100% das tentativas de acesso a uma funcionalidade cujo módulo
  foi desabilitado para a entidade são bloqueadas, e o item de menu
  correspondente some da navegação da entidade.
- **SC-006**: 0% dos detalhes de eventos de auditoria expõem documentos de
  identificação, senhas ou nomes completos de terceiros em texto claro,
  verificado por checagem automatizada de padrões.
- **SC-007**: Um administrador de plataforma consulta a trilha de auditoria
  de qualquer entidade sem precisar trocar de sessão ou de credenciais.
- **SC-008**: Administradores conseguem criar um usuário, vinculá-lo a uma
  entidade com um papel e confirmar que ele acessa a plataforma com as
  permissões corretas, em um único fluxo dentro das telas de administração
  (sem operação direta em banco de dados).

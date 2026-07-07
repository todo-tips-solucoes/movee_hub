# Feature Specification: Shell Modular do Hub — Navegação por Permissão

**Feature**: `hub-shell`
**Created**: 2026-07-07
**Status**: Draft

> Sessão S3 do plano mestre do Hub de Gestão de Frota (`docs/plans/hub-frota/`). Sobre as
> fundações da S2 (contas, papéis, permissões, entidades — já mergeada), esta fase entrega o
> **shell de navegação** do painel: o esqueleto que os módulos de negócio futuros (S4–S9)
> vão plugar sem tocar em código de navegação. Não inclui nenhuma tela de módulo de negócio
> (motoristas, faturamento, performance, importações) — apenas a casca (nav, troca de
> entidade, identificação de ambiente, autenticação, dashboard, perfil).

## Clarifications

### Session 2026-07-07

Ambiguidades de escopo e contrato resolvidas na etapa `clarify` (mediação
asker/answerer, ancorada em briefing S3, `docs/constitution.md`, esta spec e o
contrato já mergeado da fundação S2 — `docs/specs/hub-fundacoes/contracts/` e
`docs/plans/hub-frota/01-plano-tecnico.md`). Decisões auditadas em `state.json`
(dec-007 a dec-011).

- **Q1 — Contrato de `modulos[]` e permissão de visualização** (dec-007, score 3):
  Cada item de `modulos[]` retornado por `GET /api/v1/me` traz os campos
  `{codigo, nome, icone, ordem, habilitado}`. A permissão de visualização de um
  módulo segue a convenção `<codigo>.view` dentro de `permissoes[]` (mesmo padrão
  `modulo.acao` da fundação S2, ex.: `motoristas.view`, `usuarios.gerenciar` — código
  real seedado pela fundação S2, confirmado em
  `docs/specs/hub-fundacoes/quickstart.md` linhas 35/52/55; correção CHK010). A
  navegação (FR-001) e o `PermissionGate` usam essa convenção — sem mapa estático
  código→permissão no frontend.
- **Q2 — Login/`GET /me` sem vínculo em nenhuma entidade** (dec-008, score 3): O
  login sempre sucede com credenciais válidas (o `/auth/login` da S2 só recusa por
  `CREDENCIAIS_INVALIDAS`/`CONTA_BLOQUEADA`/`RATE_LIMIT`, nunca por ausência de
  vínculo). O `GET /me` retorna `entidades: []` e `entidade_ativa: null`; o shell
  então apresenta uma tela dedicada de "sem acesso" pós-login (FR-016) — a
  autenticação não é bloqueada nessa condição.
- **Q3 — Mecanismo de reverificação de sessão para perda de vínculo** (dec-009,
  score 2): A perda de vínculo com a entidade ativa (FR-015) é detectada por
  refetch de `GET /me` acoplado à navegação entre rotas do shell (guard de rota),
  sem polling temporizado adicional. Nenhuma fonte pede um timer de verificação
  para o shell.
- **Q4 — Fronteira de "ajuste trivial de contrato do `/me`"** (dec-010, score 3):
  Nesta fase é permitido apenas completar/corrigir campos já contratados em
  `GET /me` (o contrato já foi fechado pela S2), sem nova lógica de permissão nem
  novos endpoints. Qualquer alteração de backend além disso fica fora de escopo e
  vira bloqueio para o operador resolver antes.
- **Q5 — Perfil, troca de senha e logout: infraestrutura ou módulo** (dec-011,
  score 3): São infraestrutura do shell — sempre visíveis/acessíveis a qualquer
  pessoa autenticada, independentemente de `modulos[]`/`permissoes[]`. Não contam
  no N de blocos do dashboard (FR-009) nem aparecem como item do `ModuleNav`
  (FR-001). O `/auth/logout` da S2 é gateado apenas por "autenticado", e o catálogo
  de permissões não contém código de conta/perfil.

## User Scenarios & Testing

### User Story 1 - Pessoa com um papel vê só o que pode acessar (Priority: P1)

Uma pessoa autentica no painel do hub e enxerga, no menu de navegação, apenas os módulos
que ela tem permissão de ver naquela entidade. Um módulo para o qual ela não tem nenhuma
permissão simplesmente não aparece — não existe um item de menu "desabilitado" ou
"bloqueado" que ela precise notar e ignorar.

**Why this priority**: É o núcleo do shell — sem navegação correta por permissão, nenhuma
outra capacidade (troca de entidade, dashboard, módulos futuros) tem como se apoiar com
segurança. Sem isso, a plataforma expõe (ou esconde incorretamente) capacidades por engano.

**Independent Test**: Autenticar com duas contas de papéis diferentes (uma com acesso amplo,
outra restrita) e comparar os itens de menu vistos por cada uma — devem diferir exatamente
conforme as permissões de cada papel.

**Acceptance Scenarios**:

1. **Given** uma pessoa autenticada cujo papel concede permissão de visualização de um
   módulo habilitado para a entidade ativa, **When** ela acessa o painel, **Then** o item de
   menu daquele módulo aparece na navegação.
2. **Given** uma pessoa autenticada cujo papel NÃO concede nenhuma permissão sobre um
   módulo (mesmo que o módulo esteja habilitado para a entidade), **When** ela acessa o
   painel, **Then** o item de menu daquele módulo não aparece em lugar nenhum da navegação.
3. **Given** um item de menu ausente por falta de permissão, **When** a pessoa tenta acessar
   a rota daquele módulo diretamente pela URL, **Then** o sistema back-end recusa o acesso
   (a ausência no menu é só uma conveniência de navegação — nunca a única barreira).

---

### User Story 2 - Pessoa com vínculo em mais de uma entidade escolhe onde trabalhar (Priority: P1)

Uma pessoa que atua em mais de uma entidade (empresa/filial) precisa indicar, ao entrar,
com qual entidade quer trabalhar — e pode trocar essa escolha a qualquer momento sem sair
da sessão. Toda a navegação e os dados exibidos refletem a entidade selecionada no momento.

**Why this priority**: Sem seleção/troca de entidade confiável, uma pessoa com múltiplos
vínculos não consegue operar com segurança — corre o risco de agir ou ver dados da entidade
errada, ou fica trancada na primeira entidade que o sistema escolher por ela.

**Independent Test**: Autenticar com uma conta vinculada a duas entidades, confirmar que o
sistema pede a escolha explícita, escolher uma, verificar os dados exibidos, trocar para a
outra entidade e confirmar que os dados exibidos mudam de acordo — sem precisar autenticar
de novo.

**Acceptance Scenarios**:

1. **Given** uma pessoa com vínculo ativo em mais de uma entidade, **When** ela conclui o
   login, **Then** o sistema apresenta a lista de entidades disponíveis antes de liberar o
   restante da navegação.
2. **Given** uma pessoa com vínculo ativo em exatamente uma entidade, **When** ela conclui o
   login, **Then** o sistema segue direto para a navegação normal, sem exigir uma escolha
   manual.
3. **Given** uma pessoa já navegando com uma entidade selecionada, **When** ela troca para
   outra entidade em que tem vínculo ativo, **Then** os dados exibidos em toda a navegação
   passam a refletir a nova entidade, sem exigir novo login.
4. **Given** uma pessoa tenta selecionar uma entidade para a qual não tem vínculo ativo
   (ex.: perda de acesso recente), **When** ela solicita a troca, **Then** o sistema recusa
   a troca e mantém a entidade anterior.

---

### User Story 3 - Qualquer pessoa identifica de imediato que está no ambiente de teste (Priority: P2)

Ao navegar em qualquer tela do ambiente de homologação, a pessoa vê, de forma clara e
constante, um aviso de que está no ambiente de testes com dados fictícios — para nunca
confundir esse ambiente com o ambiente real que atende clientes.

**Why this priority**: Reduz risco operacional (confundir ambientes) desde a primeira
sessão do shell, mas depende das Stories 1 e 2 já existirem (navegação e sessão) para ter
onde aparecer — por isso vem depois delas em prioridade, embora seja simples de entregar.

**Independent Test**: Acessar o ambiente de homologação isolado e confirmar que o aviso de
ambiente aparece em toda tela do shell; comparar com o comportamento esperado no ambiente
de produção (aviso ausente).

**Acceptance Scenarios**:

1. **Given** o ambiente configurado como não-produção, **When** a pessoa acessa qualquer
   tela do shell, **Then** um aviso permanente e visível informa que o ambiente é de testes
   com dados fictícios.
2. **Given** o ambiente configurado como produção, **When** a pessoa acessa qualquer tela do
   shell, **Then** nenhum aviso de ambiente de teste aparece.

---

### User Story 4 - Pessoa chega a uma visão geral do que pode fazer, sem precisar decorar rotas (Priority: P2)

Depois do login (e da eventual seleção de entidade), a pessoa chega a uma tela inicial que
resume, em blocos, os módulos aos quais ela tem acesso — sem precisar já saber os nomes das
rotas ou navegar pelo menu para descobrir o que existe.

**Why this priority**: Melhora a usabilidade e comunica o valor da plataforma modular, mas
não é bloqueante — a navegação pelo menu (Story 1) já permite acesso a tudo que a visão
geral resumiria.

**Independent Test**: Autenticar e verificar que a tela inicial mostra um bloco por módulo
habilitado e visível para a pessoa, e nenhum bloco para módulos que ela não pode ver.

**Acceptance Scenarios**:

1. **Given** uma pessoa autenticada com acesso a N módulos, **When** ela chega à tela
   inicial, **Then** vê exatamente N blocos, um por módulo, cada um levando à respectiva
   área.
2. **Given** uma pessoa sem acesso a nenhum módulo além do próprio perfil, **When** ela
   chega à tela inicial, **Then** vê uma indicação clara de que não há módulos disponíveis
   (nunca uma tela vazia sem explicação).

---

### User Story 5 - Pessoa gerencia a própria conta e encerra a sessão com segurança (Priority: P3)

A pessoa consegue ver e conferir os próprios dados de conta (nome, e-mail), trocar a
própria senha, recuperar o acesso caso esqueça a senha, e encerrar a sessão ativa quando
quiser — sem depender de outra pessoa para isso.

**Why this priority**: São capacidades de suporte à própria conta — importantes para a
autonomia da pessoa usuária, mas não bloqueiam o uso do restante do shell no dia a dia.

**Independent Test**: A partir de uma sessão autenticada, acessar a área de perfil, trocar a
senha, sair, e então usar o fluxo de recuperação de senha para readquirir acesso.

**Acceptance Scenarios**:

1. **Given** uma pessoa autenticada, **When** ela acessa a área de perfil, **Then** vê seus
   próprios nome e e-mail e tem a opção de trocar a senha.
2. **Given** uma pessoa que esqueceu a senha, **When** ela solicita recuperação informando
   o e-mail, **Then** o sistema aceita a solicitação sem revelar se aquele e-mail existe ou
   não na base (nem confirmar nem negar a existência da conta).
3. **Given** uma pessoa autenticada, **When** ela solicita logout, **Then** a sessão é
   encerrada e ela precisa autenticar novamente para voltar a navegar.

---

### Edge Cases

- O que acontece quando uma pessoa perde o vínculo com a entidade ativa enquanto a sessão
  segue aberta (ex.: um administrador revoga o acesso)? A navegação deve refletir a perda
  de acesso na próxima verificação de sessão, sem exigir que a pessoa descubra isso por
  tentativa e erro.
- Como o sistema se comporta quando a pessoa não tem vínculo ativo em NENHUMA entidade no
  momento do login (ex.: todos os vínculos foram revogados)? A pessoa deve receber uma
  explicação clara, não uma tela quebrada ou vazia sem contexto.
- O que acontece se a lista de módulos vier vazia para a entidade ativa (nenhum módulo
  habilitado)? O dashboard e a navegação devem comunicar isso claramente, não ficar em
  branco sem explicação (mesmo caso da Story 4, cenário 2).
- Como o sistema trata uma tentativa de acessar diretamente pela URL uma rota de módulo sem
  a permissão correspondente? Deve ser recusada da mesma forma que qualquer outra tentativa
  de acesso sem permissão — a ausência no menu nunca é a única proteção.
- O que acontece quando a sessão expira enquanto a pessoa está no meio de uma ação (ex.:
  trocando de entidade, preenchendo o perfil)? A pessoa deve ser levada de volta à
  autenticação sem perder a clareza sobre o que houve, e sem expor dados da sessão anterior
  a quem usar o mesmo dispositivo em seguida.
- O que acontece se a solicitação de recuperação de senha for feita repetidamente em curto
  intervalo (possível abuso)? O sistema deve conter o abuso sem quebrar a experiência de uso
  legítimo isolado.

## Requirements

### Functional Requirements

- **FR-001**: O sistema MUST exibir, na navegação principal, exclusivamente os módulos que
  estão habilitados para a entidade ativa da sessão **e** para os quais a pessoa autenticada
  possui ao menos uma permissão de visualização — nenhum item de navegação pode ser
  determinado por uma lista fixa independente desses dois fatores.
- **FR-002**: O sistema MUST recusar, no lado do sistema (não apenas ocultar na navegação),
  qualquer tentativa de acesso a uma área cuja permissão a pessoa não possui, mesmo quando
  acessada diretamente sem passar pelo menu.
- **FR-003**: O sistema MUST, ao concluir a autenticação de uma pessoa com vínculo ativo em
  mais de uma entidade, solicitar a escolha explícita da entidade de trabalho antes de
  liberar o restante da navegação.
- **FR-004**: O sistema MUST, ao concluir a autenticação de uma pessoa com vínculo ativo em
  exatamente uma entidade, prosseguir automaticamente para a navegação normal sem exigir
  escolha manual.
- **FR-005**: Users MUST conseguir trocar a entidade de trabalho a qualquer momento durante
  a sessão, sem precisar autenticar novamente, desde que possuam vínculo ativo com a
  entidade de destino.
- **FR-006**: O sistema MUST recusar uma solicitação de troca para uma entidade com a qual a
  pessoa não tem vínculo ativo, mantendo a entidade anteriormente selecionada.
- **FR-007**: O sistema MUST refletir, em toda a navegação e nos dados exibidos, a entidade
  atualmente selecionada — sem misturar dados de entidades diferentes na mesma visão.
- **FR-008**: O sistema MUST exibir um aviso permanente e visível em toda tela do shell
  informando que o ambiente é de testes com dados fictícios sempre que o ambiente corrente
  não for o ambiente de produção; MUST omitir esse aviso quando o ambiente for produção.
- **FR-009**: O sistema MUST apresentar, após login (e eventual seleção de entidade), uma
  tela inicial com um resumo em blocos dos módulos aos quais a pessoa tem acesso na entidade
  ativa.
- **FR-010**: O sistema MUST comunicar de forma clara e explícita, tanto na tela inicial
  quanto na navegação, os casos em que não há módulo algum disponível para a pessoa/entidade
  — nunca apresentar uma área vazia sem explicação.
- **FR-011**: Users MUST conseguir consultar os próprios dados de conta (nome, e-mail) e
  trocar a própria senha a partir de uma área de perfil.
- **FR-012**: Users MUST conseguir solicitar recuperação de senha informando apenas o
  e-mail, e o sistema MUST responder da mesma forma esteja o e-mail cadastrado ou não (sem
  revelar a existência da conta).
- **FR-013**: Users MUST conseguir encerrar a própria sessão (logout) a qualquer momento, o
  que MUST impedir a continuidade de navegação autenticada até nova autenticação.
- **FR-014**: O sistema MUST conter tentativas repetidas de solicitação de recuperação de
  senha em curto intervalo, sem impedir o uso legítimo isolado (limite exato de imple-
  mentação é decisão do plano técnico, já registrada na fundação S2 desta iniciativa).
- **FR-015**: O sistema MUST, quando o vínculo com a entidade ativa deixa de ser válido
  enquanto a sessão permanece aberta, refletir essa perda de acesso na navegação assim que a
  sessão for reverificada — sem exigir que a pessoa descubra isso por erro ao tentar agir.
- **FR-016**: O sistema MUST comunicar de forma clara o caso em que a pessoa autenticada não
  possui vínculo ativo em nenhuma entidade, em vez de apresentar uma navegação quebrada ou
  vazia sem contexto.
- **FR-017**: O sistema MUST preservar, em toda tela nova entregue por esta fase, a
  identidade visual (incluindo variação por tenant/cliente e os modos claro/escuro) já
  estabelecida para o restante do painel — nenhuma tela nova pode romper essa identidade
  visual ou introduzir uma linguagem visual paralela.
- **FR-018**: O sistema MUST manter, durante esta fase, o comportamento das áreas de
  funcionalidade de negócio já existentes fora do escopo desta navegação modular — esta fase
  não MUST alterar o funcionamento observável dessas áreas.

> **Decisões de infraestrutura**: N/A parcial — a única política de infraestrutura tocada
> por esta fase é o limite de tentativas de recuperação de senha (FR-014), cujo valor
> numérico já foi decidido e implementado na fundação anterior (S2). **Correção CHK015**
> (verificado por leitura de `app_homologacao/backend/routes/hub-auth.js` linhas ~151-160):
> o mecanismo que de fato protege `/recuperar-senha` (e `/login`) é o `authRateLimiter`
> — `max: 10` tentativas / `windowMs: 15 * 60 * 1000` (15 minutos), chave composta
> `${ip}:${email normalizado}` — e não "5 falhas consecutivas / 15 minutos". Esse número
> de 5 falhas existe, mas é um mecanismo DIFERENTE e continua correto: bloqueio de CONTA
> por falhas consecutivas de LOGIN (S2, `BLOQUEIO_FALHAS_LIMITE = 5` /
> `BLOQUEIO_JANELA_MS = 15 * 60 * 1000` em `hub-auth.js`) — não deve ser confundido com o
> rate-limit de requisições (FR-014) corrigido acima; esta fase não introduz scheduling,
> rotação de chaves, refresh de token externo, mutex multi-processo ou backup novos.

### Key Entities

- **Módulo**: unidade de funcionalidade da plataforma (ex.: um módulo de negócio futuro)
  identificada por um código estável, um nome de exibição, um ícone e uma posição de ordem
  na navegação; pode estar habilitada ou não para uma entidade específica.
- **Entidade**: a empresa/filial sobre a qual uma pessoa pode ter um vínculo de acesso;
  exatamente uma entidade está "ativa" na sessão a cada momento.
- **Vínculo (pessoa↔entidade)**: relação que autoriza uma pessoa a atuar sobre uma entidade,
  associada a um papel que determina as permissões efetivas naquela entidade; pode estar
  ativo ou não.
- **Permissão**: capacidade nomeada e concedida via papel que autoriza uma ação sobre um
  módulo (ex.: visualizar); a navegação e o sistema usam a mesma fonte de permissões para
  decidir o que mostrar e o que autorizar.

## Success Criteria

### Measurable Outcomes

- **SC-001**: 100% dos itens exibidos na navegação principal correspondem a módulos
  habilitados para a entidade ativa com permissão de visualização concedida à pessoa — zero
  itens fixos/hardcoded, verificado por inspeção comparando dois papéis com conjuntos de
  permissão diferentes.
- **SC-002**: Toda tentativa de acesso direto (via URL) a uma área sem a permissão
  correspondente é recusada pelo sistema, mesmo quando o item não aparece na navegação —
  taxa de recusa de 100% nos casos testados.
- **SC-003**: Uma pessoa com vínculo em múltiplas entidades consegue trocar de entidade e
  ver os dados da nova entidade refletidos em menos de 5 segundos, sem precisar autenticar
  novamente.
- **SC-004**: O aviso de ambiente de testes está presente em 100% das telas do shell quando
  o ambiente não é produção, e ausente em 100% das telas quando o ambiente é produção.
- **SC-005**: Pessoas com papéis diferentes, ao serem comparadas lado a lado, veem conjuntos
  de itens de navegação que diferem exatamente conforme as permissões de cada papel — sem
  nenhum item em comum que deveria estar ausente para um dos dois papéis.
- **SC-006**: 100% das telas novas entregues nesta fase preservam a identidade visual (temas
  claro/escuro e variação por cliente) sem regressão perceptível em relação ao padrão já
  estabelecido no restante do painel.
- **SC-007**: Zero mudança no comportamento observável das áreas de funcionalidade de
  negócio já existentes fora do escopo desta fase, verificado por comparação antes/depois.

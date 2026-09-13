# Feature Specification: Notificações push no app do motorista

**Feature**: `envioMassa_homologacao`
**Created**: 2026-09-11
**Status**: Draft
**Fonte medida**: `docs/plans/push-motorista/BRIEFING-PUSH-MOTORISTA.md` (medição de 2026-09-11)
**Governança**: `docs/constitution.md` v1.1.0 (princípios I–V); sem constitution própria
da feature (decisão do operador, block-001)

## Clarifications

### Session 2026-09-11

- Q: Ao tocar na notificação, para onde o app leva o motorista — tela de detalhe
  dedicada do aviso ou a tela inicial do app? (FR-013) → A: Tela de detalhe dedicada do
  aviso (rota própria, ex. `/avisos/:id`), que busca o conteúdo autenticado e mostra
  "aviso não disponível" quando expurgado ou inexistente (dec-015, clarify-answerer,
  score 2 — decorre do próprio requisito de FR-013).
- Q: Qual a granularidade de escolha de destinatários que a equipe deve ter na criação
  do aviso? (FR-016) → A: Toda a base, motoristas individuais OU por empresa/filial do
  grupo Movee — resposta do operador (block-002, dec-020).
- Q: Qual o prazo de retenção para avisos e registros de entrega antes do expurgo
  automático? (FR-030) → A: 90 dias, com expurgo automático; não altera a retenção de 12
  meses já existente na trilha de auditoria do hub — resposta do operador (block-003,
  dec-021).

## User Scenarios & Testing

### User Story 1 - Motorista ativa as notificações no aparelho (Priority: P1)

O motorista autenticado no app vê um passo de contexto que explica para que servem os
avisos. Só quando ele toca na ação de ativar o navegador pede a permissão. Concedida, o
aparelho fica inscrito para receber avisos, vinculado ao motorista da sessão. Quem está
num iPhone sem o app instalado na tela de início recebe a orientação de instalação em vez
de um pedido que não funcionaria; quem já recusou a permissão vê como reativar, sem
insistência.

**Why this priority**: sem aparelho inscrito nenhum aviso chega. A permissão só pode ser
pedida uma vez com chance real de aceite, e a base iOS só é alcançável com o app
instalado. Por isso a ativação é a fundação do canal.

**Independent Test**: com um aparelho de teste, entrar no app, passar pelo contexto,
ativar e conferir que o estado exibido é "ativas" e que existe uma inscrição vinculada ao
motorista logado. Repetir em iOS sem instalação e com permissão negada.

**Acceptance Scenarios**:

1. **Given** um motorista autenticado que nunca ativou as notificações, **When** o app
   carrega, **Then** nenhum pedido de permissão do navegador é disparado e o passo de
   contexto fica disponível com a ação de ativar.
2. **Given** o passo de contexto aberto, **When** o motorista toca em ativar e concede a
   permissão, **Then** a inscrição do aparelho é registrada vinculada ao motorista
   identificado pelo token da sessão e o estado passa a "ativas".
3. **Given** uma requisição de inscrição que traz no corpo o identificador de outro
   motorista, **When** o servidor a processa, **Then** o identificador do corpo é
   ignorado e a inscrição fica vinculada apenas ao motorista do token.
4. **Given** um iPhone com o app aberto no navegador, sem instalação na tela de início,
   **When** o motorista abre o app, **Then** a ativação não é oferecida e aparece a
   orientação de instalar o app na tela de início, explicando que sem isso os avisos não
   chegam.
5. **Given** a permissão negada ou bloqueada no navegador, **When** o motorista abre o
   app, **Then** o app não tenta pedir de novo e mostra o estado "bloqueadas" com
   orientação de como reativar nas configurações do navegador/aparelho.
6. **Given** um navegador sem suporte a push (incluindo iOS anterior ao suporte a push em
   app instalado), **When** o motorista abre o app, **Then** o app informa que o
   aparelho não recebe avisos e não oferece a ativação.
7. **Given** um motorista que dispensou o contexto, **When** ele volta ao app, **Then**
   existe um ponto de entrada visível para ativar depois, sem pedido automático.
8. **Given** um aparelho já inscrito cuja inscrição foi renovada ou trocada pelo
   navegador, ou após a substituição das chaves do servidor, **When** o motorista abre o
   app autenticado com a permissão concedida, **Then** a inscrição é conferida e o
   registro atualizado sem novo pedido de permissão.
9. **Given** um motorista com notificações ativas, **When** ele faz logout, **Then** a
   inscrição do aparelho é revogada e avisos seguintes endereçados a ele não chegam
   àquele aparelho.
10. **Given** um motorista com notificações ativas em dois aparelhos, **When** um aviso é
    endereçado a ele, **Then** os dois aparelhos recebem, cada um como inscrição
    independente.
11. **Given** um motorista que ativou, recusou ou está em iOS sem instalação, **When** o
    app abre, **Then** o app reporta ao servidor o estado de ativação e a categoria de
    plataforma do aparelho, sem outro dado pessoal.

---

### User Story 2 - Equipe cria e dispara um aviso que chega com o app fechado (Priority: P2)

Um usuário do hub com a permissão de avisos escreve um título e uma mensagem curta,
escolhe os destinatários dentro do escopo permitido, vê quantas inscrições ativas serão
alcançadas e dispara. O hub confirma na hora, sem esperar a entrega. O motorista recebe a
notificação no celular mesmo com o app fechado e, ao tocar, é levado ao destino no app.

**Why this priority**: é o valor da feature, a comunicação ativa hub → motorista. Depende
de existir ao menos uma inscrição (US1), mas pode ser testada com uma inscrição de teste
já registrada.

**Independent Test**: com uma inscrição de teste ativa, criar e disparar um aviso no hub,
conferir a confirmação imediata, a notificação no aparelho com o app fechado e a
navegação ao tocar.

**Acceptance Scenarios**:

1. **Given** um usuário do hub com a permissão dedicada de avisos e escopo no grupo
   Movee, **When** ele cria um aviso com título e mensagem e o dispara, **Then** o hub
   confirma o disparo em até 3 segundos, sem aguardar a entrega, e o processamento segue
   em segundo plano.
2. **Given** um usuário do hub sem a permissão dedicada, **When** ele tenta criar ou
   disparar um aviso (inclusive chamando o servidor diretamente), **Then** o servidor
   recusa e nenhum aviso é criado ou enviado.
3. **Given** um usuário do hub com a permissão, mas cujo escopo resolvido pelo token não
   pertence ao grupo Movee (empresa 6 e suas filiais), **When** ele tenta disparar,
   **Then** o servidor recusa; uma filial do grupo Movee é aceita, e o critério nunca é a
   igualdade estrita com a empresa 6.
4. **Given** a tela de criação de aviso, **When** o usuário escolhe os destinatários,
   **Then** o hub mostra, antes do disparo, quantas inscrições ativas serão alcançadas;
   com zero inscrições o disparo é impedido com mensagem clara.
5. **Given** um motorista com notificações ativas e o app fechado, **When** o aviso é
   processado, **Then** a notificação aparece no aparelho com o título e a mensagem
   curta.
6. **Given** um aviso qualquer, **When** o conteúdo enviado ao serviço de push é
   inspecionado, **Then** ele contém só a referência do aviso e o texto curto escrito pela
   equipe, sem nome, CNPJ, documento ou dado financeiro de motorista.
7. **Given** uma notificação recebida, **When** o motorista toca nela com sessão válida,
   **Then** o app abre no destino definido para o aviso e busca o conteúdo já
   autenticado; **When** a sessão está expirada, **Then** o motorista passa pelo login e
   depois é levado ao mesmo destino.
8. **Given** um aviso disparado, **When** o usuário clica duas vezes em disparar, a
   requisição é repetida ou o backend reinicia no meio do processamento, **Then** cada
   inscrição visada recebe no máximo um envio, inclusive com mais de uma instância do
   backend em execução.
9. **Given** uma mensagem acima do limite de tamanho do canal, **When** o usuário tenta
   disparar, **Then** o hub recusa antes do disparo com mensagem clara em português; a
   tela avisa que o texto trafega por serviço de terceiro e não deve conter dado pessoal.
10. **Given** limites de taxa configurados, **When** um usuário excede o limite de
    disparos ou um aparelho excede o limite de registros de inscrição, **Then** a
    requisição é recusada com mensagem clara e sem efeito colateral.

---

### User Story 3 - Equipe vê o resultado da entrega, com inscrições mortas limpas (Priority: P3)

Depois do disparo, a equipe acompanha cada aviso: em que estado está o processamento,
quantas inscrições foram visadas, quantas o serviço de push aceitou, quantas falharam e
quantas estavam mortas e foram removidas. Inscrição morta sai sozinha e não entra no
próximo aviso, então a métrica não mente e a fila não entope.

**Why this priority**: sem o resultado a equipe não sabe se o canal funciona. Sem a
limpeza a base apodrece com o tempo. É necessário para operar o canal, mas não para o
primeiro aviso chegar.

**Independent Test**: com inscrições de teste válidas, uma expirada (resposta 404/410) e
uma com falha transitória simulada, disparar um aviso e conferir contagens, estado e
remoção da inscrição morta; disparar um segundo aviso e conferir que a morta não é
visada.

**Acceptance Scenarios**:

1. **Given** um aviso em processamento, **When** a equipe abre o resultado, **Then** vê o
   estado (na fila, em andamento, concluído) e as contagens parciais de visados, aceitos,
   falhas e inscrições mortas.
2. **Given** um aviso concluído, **When** a equipe confere o resultado, **Then** aceitos +
   falhas + mortas é igual ao total de visados, e "aceitos" aparece rotulado como aceito
   para entrega pelo serviço de push (não como lido ou exibido).
3. **Given** uma inscrição para a qual o serviço de push responde 404 ou 410, **When** o
   aviso é processado, **Then** a inscrição é removida automaticamente no mesmo
   processamento, contada como morta e não é visada no aviso seguinte.
4. **Given** uma falha transitória do serviço de push (sobrecarga, limite ou erro
   temporário), **When** o envio falha, **Then** ele é re-tentado automaticamente um
   número limitado de vezes com espera crescente e só então é contado como falha.
5. **Given** um aviso para toda a base elegível, **When** ele é processado, **Then** o
   envio ocorre em lotes com concorrência limitada e as demais telas do hub e do app
   continuam respondendo.
6. **Given** a criação, o disparo de um aviso ou a substituição das chaves do servidor,
   **When** a equipe consulta a trilha de auditoria do hub, **Then** encontra autor,
   momento, aviso e escopo de destinatários.

---

### User Story 4 - Equipe mede a cobertura do canal por plataforma (Priority: P4)

A equipe vê quantos motoristas têm notificações ativas por plataforma e quantos estão
impedidos de receber, e por quê (iOS sem instalação, permissão bloqueada, sem suporte).
Com isso dá para tratar a instalação como parte da adoção, e não descobrir tarde que
metade da base não recebe nada.

**Why this priority**: a restrição do iOS é de adoção. Sem medir, a feature pode "existir"
para quem envia e não existir para boa parte de quem deveria receber. Depende dos estados
reportados na US1.

**Independent Test**: com aparelhos de teste em estados diferentes (ativo Android, ativo
iOS instalado, iOS sem instalação, bloqueado), abrir a visão de cobertura e conferir as
contagens.

**Acceptance Scenarios**:

1. **Given** estados de ativação reportados por aparelhos em plataformas diferentes,
   **When** a equipe abre a cobertura, **Then** vê as contagens de ativos por plataforma
   (Android, iOS instalado, desktop/outros) e de impedidos por motivo (iOS sem instalação,
   bloqueadas, sem suporte).
2. **Given** um motorista que passou de "iOS sem instalação" para "ativas" depois de
   instalar o app, **When** a cobertura é consultada, **Then** ele conta apenas como
   ativo.

---

### Edge Cases

- **Aparelho compartilhado**: o motorista A sai sem logout (sessão expira) e o motorista B
  entra no mesmo aparelho. Quando B abre o app autenticado, a inscrição do aparelho passa
  a ser de B e deixa de ser de A. Se A tocar numa notificação antiga, o conteúdo só é
  exibido se o motorista autenticado for destinatário.
- **Permissão revogada nas configurações** depois da ativação: o serviço de push passa a
  responder que a inscrição não existe (404/410), ela é removida, e o app mostra
  "bloqueadas" na próxima abertura.
- **Conta de motorista desativada**: as inscrições dela deixam de ser visadas e nenhum
  aviso chega a ela.
- **Aviso expurgado ou inexistente** quando a notificação é tocada: o app mostra "aviso
  não disponível", sem erro técnico.
- **Reinício do backend no meio do processamento**: o processamento retoma sem reenviar
  para as inscrições já processadas.
- **Chave privada VAPID sob suspeita de vazamento**: o par de chaves é substituído, as
  inscrições da chave antiga deixam de ser usadas e os apps re-assinam na próxima
  abertura autenticada, sem novo pedido de permissão.
- **Serviço de push fora do ar por longo período**: esgotadas as re-tentativas, os envios
  contam como falha e o aviso conclui com o resultado real, sem ficar "em andamento" para
  sempre.
- **Mensagem com dado pessoal digitado pela equipe**: o sistema não acrescenta dado de
  motorista ao conteúdo enviado; a tela de criação alerta que o texto trafega por serviço
  de terceiro.
- **Chave privada VAPID ausente ou inválida** no servidor: o disparo é recusado com
  mensagem clara; nenhum aviso fica "em andamento" silenciosamente.

## Requirements

### Functional Requirements

**Ativação no app do motorista**

- **FR-001**: O app MUST apresentar ao motorista autenticado um passo de contexto que
  explica o valor dos avisos antes de qualquer pedido de permissão de notificação do
  navegador.
- **FR-002**: O pedido de permissão do navegador MUST ocorrer somente em resposta a um
  gesto explícito do motorista no passo de contexto; o app MUST NOT pedir permissão
  automaticamente (por exemplo, no carregamento da página).
- **FR-003**: Concedida a permissão, o sistema MUST registrar a inscrição do aparelho
  vinculada ao motorista identificado pelo token da sessão, e MUST ignorar qualquer
  identificador de motorista vindo do corpo ou da query. Uma inscrição pertence a um único
  motorista por vez: registrá-la sob outro motorista transfere o vínculo. O registro de
  inscrição MUST exigir sessão autenticada de motorista.
- **FR-004**: Em iOS com o app aberto no navegador, sem instalação na tela de início, o
  app MUST NOT oferecer a ativação e MUST mostrar orientação de instalação na tela de
  início, explicando que sem isso os avisos não chegam.
- **FR-005**: Com a permissão negada ou bloqueada, o app MUST NOT tentar pedir de novo e
  MUST mostrar o estado "bloqueadas" com orientação de reativação nas configurações do
  navegador/aparelho.
- **FR-006**: Em navegador ou sistema sem suporte a push, o app MUST informar que o
  aparelho não recebe avisos e MUST NOT oferecer a ativação.
- **FR-007**: O app MUST mostrar o estado atual das notificações no aparelho (ativas,
  bloqueadas, iOS sem instalação, sem suporte, não ativadas), MUST manter um ponto de
  entrada visível para ativar depois e MUST reportar ao servidor esse estado com a
  categoria de plataforma do aparelho, sem outro dado pessoal.
- **FR-008**: A cada abertura autenticada com permissão concedida, o app MUST conferir a
  inscrição do aparelho e atualizar o registro quando ela tiver mudado, sumido ou sido
  feita com chave de servidor substituída, sem pedir permissão de novo.
- **FR-009**: No logout, o sistema MUST revogar a inscrição do aparelho, de modo que ele
  deixe de receber avisos endereçados àquele motorista.
- **FR-010**: O sistema MUST aceitar inscrições em mais de um aparelho por motorista,
  cada aparelho como inscrição independente, e todas MUST receber os avisos endereçados a
  ele.

**Recebimento**

- **FR-011**: Com notificações ativas, o motorista MUST receber o aviso como notificação
  do sistema com título e mensagem curta, mesmo com o app fechado.
- **FR-012**: O conteúdo transmitido ao serviço de push MUST conter apenas a referência do
  aviso e o texto curto escrito pela equipe; MUST NOT conter dado pessoal de motorista
  (nome, CNPJ, documento, dado financeiro) nem dado buscado da base. O serviço de push é
  tratado como canal público.
- **FR-013**: Ao tocar na notificação, o app MUST abrir uma tela de detalhe dedicada do
  aviso (rota própria, ex. `/avisos/:id`); sem sessão válida, MUST passar pelo login e
  depois levar ao mesmo destino. Qualquer conteúdo do aviso MUST ser buscado já
  autenticado e exibido só se o motorista autenticado for destinatário; aviso inexistente
  ou expurgado MUST gerar a mensagem "aviso não disponível". (Resolvido em clarify,
  dec-015: decorre do próprio requisito de buscar conteúdo autenticado e tratar
  aviso expurgado/inexistente, que só é implementável com tela própria.)

**Criação e disparo no hub**

- **FR-014**: Usuários do hub com uma permissão dedicada de avisos, nova no RBAC do hub,
  MUST poder criar um aviso (título e mensagem curta) e dispará-lo; sem essa permissão, o
  servidor MUST recusar criação e disparo. Ver o resultado e a cobertura MUST exigir
  acesso ao mesmo módulo.
- **FR-015**: O escopo de quem pode disparar e de quem recebe MUST ser resolvido no
  servidor a partir do token. Só usuários cujo escopo pertence ao grupo Movee (empresa 6
  e filiais, pelo critério de mesmo grupo e nunca pela igualdade estrita com a empresa 6)
  podem disparar. Só inscrições de contas de motorista ativas podem ser visadas.
- **FR-016**: A equipe MUST escolher os destinatários do aviso em um de três modos: toda
  a base ativa do grupo Movee, motoristas individuais selecionados manualmente, ou por
  empresa/filial do grupo Movee. O escopo do grupo MUST ser sempre resolvido pelo
  critério de mesmo grupo (`mesmoGrupoQue(idEmpresa, 6, cache)`), nunca por
  `id_empresa === 6` estrito — hoje a Movee não tem filiais, mas o modo por
  empresa/filial MUST funcionar corretamente quando existirem. O hub MUST mostrar, antes
  do disparo, quantas inscrições ativas serão alcançadas, e MUST impedir o disparo
  quando esse número for zero. (Resolvido em clarify, dec-020: resposta do operador em
  block-002.)
- **FR-017**: O disparo MUST ser persistido e confirmado à equipe sem aguardar a entrega;
  o envio MUST ser processado em segundo plano, em lotes com concorrência limitada, nunca
  em laço dentro da requisição de disparo. Não há agendamento de aviso para data futura
  (INFRA-SCHED: processamento disparado pelo evento de disparo).
- **FR-018**: Cada inscrição visada MUST receber no máximo um envio por aviso. Duplo
  clique, repetição da requisição ou retomada após falha ou reinício MUST NOT reenviar a
  inscrições já processadas, e com mais de uma instância do backend uma mesma entrega
  MUST NOT ser processada em duplicidade (INFRA-IDEMP / INFRA-LOCK).
- **FR-019**: Falha transitória do serviço de push MUST ser re-tentada automaticamente um
  número limitado de vezes, com espera crescente, antes de contar como falha; esgotadas
  as tentativas, o aviso MUST concluir com o resultado real.
- **FR-020**: Resposta 404 ou 410 do serviço de push MUST remover a inscrição
  automaticamente no mesmo processamento, contá-la como morta e excluí-la dos avisos
  seguintes.
- **FR-021**: O hub MUST recusar, antes do disparo e com mensagem clara em português, uma
  mensagem acima do limite de tamanho compatível com o canal, e MUST alertar na tela de
  criação que o texto trafega por serviço de terceiro e não deve conter dado pessoal.

**Resultado e cobertura**

- **FR-022**: Para cada aviso, o hub MUST mostrar o estado do processamento (na fila, em
  andamento, concluído) e as contagens de visados, aceitos, falhas e inscrições mortas.
  Ao concluir, aceitos + falhas + mortas MUST ser igual ao total de visados, e "aceitos"
  MUST aparecer rotulado como aceito para entrega pelo serviço de push, não como lido ou
  exibido.
- **FR-023**: O hub MUST mostrar a cobertura por plataforma, com os estados reportados
  pelo app (FR-007): ativos por plataforma (Android, iOS instalado, desktop/outros) e
  impedidos por motivo (iOS sem instalação, bloqueadas, sem suporte), contando cada
  motorista pelo estado mais recente de cada aparelho.

**Segurança e plataforma**

- **FR-024**: O canal de entrega MUST ser Web Push nativo, com identificação do servidor
  por chaves VAPID (decisão do operador), sem SDK ou conta de mensageria de terceiro.
- **FR-025**: A chave privada VAPID MUST existir somente no armazenamento de segredos
  fora do versionamento (`/var/lib/hub_secrets/`) e MUST NOT aparecer em repositório,
  imagem, log, resposta de API ou bundle do app; só a chave pública é exposta ao app.
  Chave privada ausente ou inválida MUST fazer o disparo ser recusado com mensagem clara.
- **FR-026**: O sistema MUST permitir substituir o par de chaves VAPID. Após a
  substituição, inscrições feitas com a chave antiga MUST deixar de ser usadas e os apps
  MUST re-assinar na próxima abertura autenticada, conforme FR-008 (INFRA-KEY).
- **FR-027**: O registro de inscrição e o disparo de aviso MUST ter limite de taxa;
  excedido, a requisição MUST ser recusada com mensagem clara e sem efeito colateral.
- **FR-028**: Os dados novos (avisos, inscrições, registros de entrega e estados de
  ativação) MUST ser protegidos por políticas de acesso por linha no mesmo padrão das
  tabelas existentes do hub.
- **FR-029**: Criação, disparo e substituição de chaves MUST gerar registro na trilha de
  auditoria do hub, com autor, momento, aviso e escopo de destinatários.
- **FR-030**: Avisos e registros de entrega (quem recebeu o quê e quando) MUST ser
  expurgados automaticamente após 90 dias; o prazo MUST ser fixado junto com o modelo de
  dados. Essa retenção é própria dos dados novos desta feature e MUST NOT alterar a
  política de 12 meses já existente na trilha de auditoria do hub
  (`infra/hub/migrations/0041_auditoria_expurgo_d5.sql`); se o registro de auditoria de
  criação/disparo/rotação de chaves (FR-029) for gravado na trilha já existente, ele
  segue a política daquela trilha, não os 90 dias — um conflito real entre as duas
  políticas volta ao operador. (Resolvido em clarify, dec-021: resposta do operador em
  block-003.)
- **FR-031**: Mensagens ao motorista e à equipe MUST estar em português, claras e
  acionáveis; logs técnicos MUST NOT conter segredos, tokens ou o endpoint completo da
  inscrição.
- **FR-032**: O passo de contexto do app motorista e o formulário de criação de aviso no
  hub MUST oferecer acessibilidade básica: foco visível em todo controle interativo,
  nome/rótulo acessível (`<label>` ou ARIA) em cada campo e ação, e navegação completa por
  teclado, sem depender de mouse/toque. (Resolvido em checklist, dec-046: resposta do
  operador em block-007 — entra nesta entrega; não é auditoria completa de acessibilidade.)

> Decisões de infraestrutura: scheduling = processamento em segundo plano disparado pelo
> evento de disparo, sem agendamento (FR-017); idempotência e exclusão entre instâncias
> (FR-018); rotação de chave (FR-026); renovação da inscrição pelo navegador (FR-008);
> retenção e expurgo (FR-030). Backup/restauração: sem requisito novo (ver Assumptions).

### Key Entities

- **Aviso**: comunicação criada pela equipe. Tem título, mensagem curta, autor, momento
  de criação e de disparo, escopo de destinatários e estado de processamento (na fila, em
  andamento, concluído).
- **Inscrição de push**: vínculo entre um aparelho (inscrição do navegador) e um único
  motorista. Guarda a categoria de plataforma, a chave de servidor com que foi feita e se
  está ativa ou foi removida (logout, morta, transferida).
- **Registro de entrega**: resultado de um aviso para uma inscrição (aceito, falha após
  re-tentativas, morta), com o momento. É a base das contagens e está sujeito ao expurgo
  (FR-030).
- **Estado de ativação**: último estado reportado por aparelho do motorista (ativas,
  bloqueadas, iOS sem instalação, sem suporte, não ativadas) com a categoria de
  plataforma. É a base da cobertura (FR-023).

## Success Criteria

### Measurable Outcomes

- **SC-001**: 0 pedidos de permissão do navegador disparados sem gesto do motorista no
  passo de contexto, verificado em teste automatizado do fluxo de ativação.
- **SC-002**: em iOS sem instalação, 100% das aberturas mostram a orientação de
  instalação e 0 pedidos de permissão.
- **SC-003**: com o aparelho online e o app fechado, a notificação aparece em até 1 minuto
  após o disparo em pelo menos 95% das entregas aceitas pelo serviço de push, em teste
  controlado.
- **SC-004**: a equipe recebe a confirmação do disparo em até 3 segundos,
  independentemente do número de destinatários.
- **SC-005**: durante o processamento de um aviso para toda a base elegível, as demais
  telas do hub e do app continuam respondendo sem erros atribuíveis ao envio.
- **SC-006**: em 100% dos avisos concluídos, aceitos + falhas + mortas = visados; 100%
  das inscrições mortas identificadas não são visadas no aviso seguinte.
- **SC-007**: 0 dados pessoais de motorista no conteúdo enviado ao serviço de push, na
  inspeção de todos os conteúdos gerados nos testes.
- **SC-008**: 100% das tentativas de criar ou disparar aviso sem a permissão dedicada, ou
  com escopo fora do grupo Movee, são recusadas; 0 avisos chegam ao aparelho de um
  motorista depois do logout dele.
- **SC-009**: 0 ocorrências da chave privada VAPID em repositório, imagem, logs ou bundle,
  na varredura feita antes da entrega.
- **SC-010**: 0 envios duplicados por inscrição em teste com duplo disparo e com reinício
  no meio do processamento.
- **SC-011**: a equipe obtém a cobertura por plataforma (ativos por plataforma e impedidos
  por motivo) na própria tela do hub, sem consulta manual à base.
- **SC-012**: 100% dos controles interativos do passo de contexto (app) e do formulário
  "Novo aviso" (hub) são operáveis só por teclado, com foco sempre visível, verificado em
  teste manual ou automatizado antes da entrega.

## Assumptions

- **Canal**: Web Push nativo (VAPID) é decisão do operador e não está em aberto;
  impedimento técnico real ao canal é devolvido ao operador com evidência medida.
- **"Aceito" não é "exibido"**: o canal confirma a aceitação pelo serviço de push, não a
  exibição no aparelho. Confirmação de exibição não faz parte deste escopo.
- **Fora do escopo por não constar da fonte**: caixa de entrada ou histórico de avisos no
  app, reenvio seletivo, templates de aviso, agendamento para data futura, segmentação
  além da granularidade que o FR-016 fixar, controle de desativação no app além do logout
  (o motorista pode desligar pelo navegador/aparelho) e qualquer canal fora do PWA.
- **Backup/restauração**: sem requisito novo; os dados novos seguem a rotina de backup da
  base onde o hub vive (a confirmar no plan).
- **Processo** (não é requisito de produto): validação no ambiente isolado `hub-homolog`
  antes de produção; nenhuma escrita em produção sem os 5 gates do rito (`CLAUDE.md`).

## Delta Requirements

**Skip**: corpus canônico `docs/specs/current/` inexistente; a feature introduz capacidade nova (push hub → motorista) sem comportamento ativo documentado em corpus a modificar — agente-00c-orchestrator, 2026-09-11

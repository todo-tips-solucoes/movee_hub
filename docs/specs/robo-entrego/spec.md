# Feature Specification: Robô de Importação EntreGô

**Feature**: `robo-entrego`
**Created**: 2026-08-27
**Status**: Draft

## Clarifications

### Session 2026-08-27

- Q: Quantas tentativas automáticas (e com que intervalo) diante de falha
  transitória antes de a rotina desistir da rodada? → A: até 3 tentativas,
  com backoff crescente de 1, 5 e 15 minutos (aplicado em FR-012).
- Q: Qual servidor/protocolo IMAP deve ser usado para acessar a caixa
  paulo@todo-tips.com (FR-002)? → A: Google Workspace/Gmail —
  `imap.gmail.com:993`, TLS implícito, autenticação por senha de app (a conta
  tem 2FA); credenciais em `/var/lib/hub_secrets/`, fora do git, com template
  `.example`. Filtrar por assunto "Código de Acesso" e aceitar somente
  mensagem recebida após o disparo do `POST authentication/validate`, para
  nunca reaproveitar código antigo (`block-001`, resposta do operador,
  2026-08-27).
- Q: Qual entidade (empresa) do hub deve receber as importações desta
  franquia EntreGô (FR-007)? → A: `id_empresa = 6` (MOVEE SOLUCOES
  LOGISTICAS LTDA), confirmado por consulta ao histórico real de
  `ImportacaoArquivo` em produção (única entidade com importações de
  faturamento e performance). O valor mora em arquivo de configuração — nunca
  hardcoded — e a identidade de serviço precisa da permissão
  `importacoes.criar` nessa entidade, ativa como claim do token (o endpoint
  nunca escopa pelo corpo da requisição) (`block-002`, resposta do operador,
  2026-08-27).
- Q: Como determinar a duração da sessão autenticada no portal antes de
  exigir novo login (FR-013)? → A: requisito dissolvido — não medir. A
  sessão é persistida em disco e sempre reutilizada; a rotina tenta a
  chamada de API direto com a sessão salva e só executa o fluxo de login
  completo (e-mail, senha, código via IMAP) ao receber `401`. A duração deixa
  de ser um dado necessário (formalizado em FR-016) (`block-003`, resposta do
  operador, 2026-08-27).
- Q: Para qual endereço de e-mail a rotina deve enviar o alerta de falha
  definitiva (FR-013)? → A: `paulo@todo-tips.com` — mesma caixa que já lê o
  código de acesso, sem infraestrutura de e-mail nova; parametrizável em
  configuração para aceitar mais destinatários futuramente, sem alteração de
  código (`block-004`, resposta do operador, 2026-08-27).

## User Scenarios & Testing

### User Story 1 - Importação diária automática dos relatórios (Priority: P1)

Hoje alguém precisa entrar manualmente no portal do franqueado EntreGô todo dia,
baixar os relatórios de Performance e Financeiro do dia anterior e subir cada um no
hub. A rotina assume esse trabalho: em horários configurados, ela busca os dois
relatórios do dia anterior e os entrega prontos no histórico de importações do hub,
sem que ninguém precise tocar no portal.

**Why this priority**: é o valor central da feature — sem isso não há robô, só
infraestrutura. Sozinha já substitui o trabalho manual diário.

**Independent Test**: configurar um horário de execução, deixar a rotina rodar no
dia seguinte e conferir no histórico de importações do hub que os dois arquivos
referentes ao dia anterior aparecem processados com sucesso.

**Acceptance Scenarios**:

1. **Given** o horário configurado chega e o portal está acessível sem desafio de
   verificação, **When** a rotina executa, **Then** os relatórios Performance e
   Financeiro do dia anterior aparecem importados no histórico do hub.
2. **Given** um relatório do dia já foi importado anteriormente (reexecução ou
   reagendamento do mesmo dia), **When** a rotina tenta importá-lo de novo,
   **Then** o sistema reconhece que já existe e não cria um registro duplicado.
3. **Given** o dia anterior não teve nenhum movimento registrado no portal,
   **When** a rotina roda, **Then** ela reconhece a ausência de dados e não trata
   isso como uma falha.

---

### User Story 2 - Parada segura diante de proteção anti-bot (Priority: P2)

O portal é protegido por mecanismos de detecção de automação. Se a rotina disparar
um desafio de verificação, ela precisa parar imediatamente e avisar — nunca tentar
adivinhar, resolver ou repetir a ação de um jeito que pareça contornar a proteção.

**Why this priority**: é uma restrição de segurança inegociável; falhar nisso pode
comprometer o acesso do franqueado ao próprio portal. Vem logo depois do valor
central porque protege a viabilidade de tudo o resto.

**Independent Test**: provocar (em ambiente controlado) uma resposta equivalente a
um desafio de verificação e confirmar que a rotina interrompe a execução e emite
alerta, sem nenhuma tentativa adicional de repetir a mesma ação.

**Acceptance Scenarios**:

1. **Given** o portal apresenta um desafio de verificação humana durante o login,
   **When** a rotina detecta esse sinal, **Then** ela interrompe a execução
   imediatamente e registra um alerta, sem tentar preencher ou resolver o desafio.
2. **Given** o portal apresenta um desafio de verificação ao chamar a API de
   relatórios, **When** isso ocorre, **Then** a rotina para o restante da execução
   daquela rodada e alerta, sem repetir a mesma chamada em loop.

---

### User Story 3 - Resiliência e alerta em caso de falha (Priority: P3)

Falhas acontecem (rede instável, portal fora do ar, hub indisponível). A rotina
deve tentar se recuperar sozinha primeiro; se não conseguir, o operador precisa
saber por mais de um canal, sem precisar vasculhar logs de servidor todo dia para
descobrir se algo quebrou.

**Why this priority**: eleva a importação automática de "funciona quando dá certo"
para algo confiável o suficiente para rodar sem supervisão diária.

**Independent Test**: provocar uma falha transitória (ex.: indisponibilidade de
rede simulada) e verificar que houve nova tentativa automática; depois provocar uma
falha persistente e verificar que existe, ao final, um registro em arquivo de log,
um e-mail de alerta e um evento na auditoria do hub — os três juntos.

**Acceptance Scenarios**:

1. **Given** uma tentativa falha por erro transitório (rede, timeout), **When** a
   rotina detecta a falha, **Then** ela tenta novamente automaticamente antes de
   desistir.
2. **Given** todas as tentativas se esgotam sem sucesso, **When** a rotina desiste,
   **Then** ela grava um registro em arquivo de log, envia um e-mail de alerta e
   registra o evento na auditoria do hub — as três reações, nunca só uma.
3. **Given** o hub rejeita um arquivo (ex.: tipo ou conteúdo inválido), **When**
   isso acontece, **Then** o motivo da rejeição fica registrado de forma que o
   operador entenda a causa sem precisar investigar logs brutos do servidor.

---

### User Story 4 - Agendamento configurável sem alterar código (Priority: P4)

Os horários ideais de execução podem mudar (ex.: o portal publica os relatórios
mais cedo ou mais tarde, ou passa a valer a pena rodar duas vezes por segurança). O
operador precisa poder ajustar isso editando uma configuração, não pedindo uma
mudança de código.

**Why this priority**: reduz atrito operacional, mas o sistema já entrega valor
com um horário fixo definido na configuração inicial — por isso vem por último.

**Independent Test**: alterar o arquivo de configuração para adicionar um segundo
horário no mesmo dia e confirmar que a rotina passa a rodar nos dois horários, sem
qualquer alteração de código ou novo deploy.

**Acceptance Scenarios**:

1. **Given** o arquivo de configuração define um horário, **When** o operador
   adiciona um segundo horário no mesmo dia, **Then** a rotina passa a executar
   nos dois horários sem necessidade de alteração de código.
2. **Given** dois horários configurados no mesmo dia se sobrepõem no tempo de
   execução, **When** ambos disparam, **Then** apenas uma execução roda por vez —
   a segunda aguarda ou é descartada, nunca roda em paralelo com a primeira.

---

### Edge Cases

- O que acontece quando a sessão do portal expira no meio de uma execução (entre o
  login e a chamada dos relatórios)? A rotina deve perceber e refazer a
  autenticação antes de desistir, sem tratar isso como o mesmo tipo de falha de um
  desafio anti-bot.
- O que acontece quando o e-mail com o código de acesso não chega dentro de um
  tempo razoável de espera? A rotina trata como falha (fluxo de retry/alerta da
  User Story 3), não fica esperando indefinidamente.
- O que acontece se a caixa de e-mail tiver mais de uma mensagem com o mesmo
  assunto de código de acesso não lida? A rotina usa a mais recente e não reaproveita
  um código já consumido em outra tentativa.
- O que acontece quando a geração do relatório no portal demora mais que o
  esperado? A rotina trata como falha de tentativa (aciona retry), não fica presa
  esperando indefinidamente.
- O que acontece quando o hub já tem o mesmo arquivo importado (mesmo conteúdo)?
  Tratado como sucesso idempotente (User Story 1, cenário 2), nunca como erro.

## Requirements

### Functional Requirements

- **FR-001**: A rotina MUST se autenticar automaticamente no portal do franqueado
  EntreGô, sem exigir que um humano digite credenciais durante a execução normal.
- **FR-002**: A rotina MUST obter o código de acesso de segundo fator exigido pelo
  login lendo automaticamente, via IMAP (`imap.gmail.com:993`, TLS implícito,
  autenticação por senha de app), a mensagem de assunto "Código de Acesso" mais
  recente recebida na caixa `paulo@todo-tips.com` **após** o disparo do
  `POST authentication/validate` da tentativa corrente — nunca reaproveitando
  mensagem recebida antes desse disparo.
- **FR-003**: Para cada tipo de relatório suportado (Performance e Financeiro), a
  rotina MUST solicitar ao portal o relatório referente ao dia imediatamente
  anterior à data de execução.
- **FR-004**: A rotina MUST aguardar a conclusão da geração do relatório antes de
  tentar obtê-lo, tratando demora além de um tempo limite como falha de tentativa.
- **FR-005**: A rotina MUST obter o arquivo do relatório assim que ele estiver
  pronto.
- **FR-006**: A rotina MUST enviar cada arquivo obtido para o mecanismo de
  importação já existente do hub, identificando corretamente o tipo do relatório
  (performance ou financeiro) para que o hub o processe como tal.
- **FR-007**: A rotina MUST se autenticar junto ao hub como uma identidade de
  serviço dedicada, com a permissão `importacoes.criar` autorizada somente na
  entidade `id_empresa = 6` (MOVEE SOLUCOES LOGISTICAS LTDA, valor mantido em
  arquivo de configuração, nunca hardcoded) — a entidade nunca é informada pela
  própria rotina no pedido de importação; ela é sempre resolvida a partir da
  claim de entidade ativa do token de quem está autenticado.
- **FR-008**: A rotina MUST tratar uma resposta do hub indicando que o arquivo já
  foi importado anteriormente como sucesso, não como falha.
- **FR-009**: A rotina MUST permitir configurar um ou mais horários de execução por
  dia através de um arquivo de configuração, sem exigir alteração de código para
  mudar, adicionar ou remover horários.
- **FR-010**: A rotina MUST impedir que duas execuções agendadas rodem ao mesmo
  tempo, mesmo que os horários configurados coincidam ou se sobreponham.
- **FR-011**: A rotina MUST, ao detectar qualquer sinal de desafio de verificação
  humana (proteção anti-automação) em qualquer etapa do fluxo, interromper a
  execução daquela rodada imediatamente e emitir alerta, sem tentar resolver,
  repetir de forma automatizada, ou de qualquer outra forma contornar essa
  proteção.
- **FR-012**: A rotina MUST, diante de uma falha classificada como transitória
  (indisponibilidade momentânea de rede, timeout), tentar novamente
  automaticamente até 3 vezes, com backoff crescente de 1, 5 e 15 minutos entre
  as tentativas, antes de desistir da rodada.
- **FR-013**: A rotina MUST, ao esgotar as tentativas de uma rodada sem sucesso,
  produzir simultaneamente as três reações a seguir — nunca apenas uma delas:
  registrar a falha em um arquivo de log, enviar um alerta por e-mail ao operador,
  e registrar o evento na trilha de auditoria do hub.
  **Nota complementar (falha parcial, CHK011, decisão do operador
  2026-08-27)**: quando dos 2 relatórios da rodada 1 tem sucesso e o outro
  falha definitivamente, as três reações de FR-013 disparam ISOLADAMENTE só
  para o relatório que falhou — o relatório bem-sucedido é importado
  normalmente, sem gerar alerta nem log de falha. A rotina retenta o
  relatório que falhou na próxima janela agendada; isso é seguro contra
  duplicação porque `POST /api/v1/importacoes` dedupe por
  `UNIQUE(id_empresa, tipo, hash_sha256)` — reenviar o mesmo arquivo já
  aceito não cria uma segunda importação.
- **FR-014**: A rotina MUST armazenar toda credencial que utiliza (acesso ao
  portal, acesso à caixa de e-mail, identidade de serviço do hub, e um ou mais
  destinos do e-mail de alerta) fora do controle de versão do código-fonte.
- **FR-015**: A rotina MUST registrar o resultado de cada execução (sucesso, falha
  parcial ou falha total, e o motivo quando houver falha) de forma consultável pelo
  operador sem precisar acessar logs brutos do servidor.
- **FR-016**: A rotina MUST persistir em disco a sessão autenticada do portal e
  reutilizá-la em execuções subsequentes, tentando a chamada à API diretamente
  com a sessão salva; o fluxo de login completo (usuário, senha, código de
  segundo fator via IMAP) só MUST rodar quando essa tentativa retornar `401`
  (sessão ausente ou expirada). A duração da sessão não é medida nem assumida —
  a rotina nunca reloga preventivamente.

### Key Entities

- **Execução Agendada**: uma rodada da rotina disparada por um dos horários
  configurados; carrega o momento em que rodou, quais relatórios processou e o
  resultado de cada um (sucesso, falha e motivo).
- **Relatório do Franqueado**: um arquivo de dados (Performance ou Financeiro)
  referente a uma data específica, obtido do portal e destinado à importação no
  hub; tem tipo, data de referência e status de importação.
- **Sessão Persistida**: credencial de sessão do portal EntreGô salva em disco
  entre execuções; tem estado (válida/expirada) descoberto pela resposta da
  chamada à API (`401` = expirada), nunca por medição de tempo.
- **Identidade de Serviço do Hub**: usuário dedicado da rotina no hub, com
  permissão `importacoes.criar` restrita à entidade `id_empresa` definida em
  configuração; a entidade é sempre resolvida pela claim do token, nunca pelo
  corpo da requisição.

## Success Criteria

### Measurable Outcomes

- **SC-001**: Em pelo menos 95% dos dias em que o portal está normalmente
  acessível, os relatórios Performance e Financeiro do dia anterior aparecem no
  histórico de importações do hub sem qualquer intervenção manual.
- **SC-002**: Quando uma execução falha de forma definitiva, o operador recebe o
  alerta por e-mail em até 15 minutos após a última tentativa fracassada.
- **SC-003**: Zero execuções em que a rotina tenta resolver, repetir de forma
  automatizada ou contornar um desafio de verificação apresentado pelo portal — a
  reação observada é sempre parar e alertar.
- **SC-004**: Reenviar o mesmo relatório (por reexecução, reagendamento ou retry)
  nunca produz um segundo registro para o mesmo dia no hub.
- **SC-005**: Adicionar, remover ou alterar um horário de execução é feito só
  editando configuração — nenhuma mudança de código nem novo empacotamento da
  rotina é necessária para isso.

## Delta Requirements

<!--
  Feature nova. Não há corpus `docs/specs/current/` neste projeto (verificado:
  diretório inexistente) e o robô consome o endpoint `POST /hub/importacoes` já
  existente sem alterar seu contrato — nada de comportamento ativo documentado é
  adicionado, mudado, removido ou renomeado por esta feature.
-->

**Skip**: feature nova, sem corpus `docs/specs/current/` no projeto e sem alteração
de contrato de comportamento já documentado (o robô é um novo consumidor do
endpoint `/hub/importacoes` já existente) — agente-00c-feature-orchestrator,
2026-08-27

# Feature Specification: Enriquecimento automático de entregadores novos

**Feature**: `hub-enriquecimento-automatico`
**Created**: 2026-09-08
**Status**: Draft

## Clarifications

### Session 2026-09-08

- Q: O campo que registra o desfecho da última tentativa de enriquecimento
  deve ter 4 valores distintos (nunca tentado / pessoa não encontrada /
  outra falha / sucesso — alinhado a Key Entities) ou 3 valores agrupando
  outra-falha-ou-sucesso (texto anterior de FR-006/SC-002, sucesso inferido
  pela presença dos dados)? → A: 4 valores distintos e consultáveis —
  nunca-tentado, pessoa-não-encontrada, outra-falha, sucesso. O campo é
  autoexplicativo: a decisão de retentar sai direto dele, sem cruzar
  colunas. A redundância entre o valor "sucesso" deste campo e o campo
  separado de dados enriquecidos é aceita porque os dois são gravados no
  MESMO PATCH (`routes/hub-robo-entrego.js`) — não há janela para
  divergirem.
- Q: Esta feature inclui expor visualmente no frontend_v2 o novo estado de
  enriquecimento (ex.: badge "pessoa não encontrada") para o operador, ou o
  escopo é somente backend (enfileiramento automático + persistência do
  desfecho via API), deixando a UI para feature futura? → A: Somente
  backend nesta feature — enfileiramento automático na inserção e
  persistência do desfecho via API. UI no frontend_v2 fica para uma
  feature futura com escopo próprio.

- Q: (Gate `owasp-security`, fase plan — `block-003`/`dec-022`) Como
  mitigar os 2 achados HIGH e os 2 MEDIUM de desenho: volume de PII sem
  prazo de expurgo (H1), ausência de teto de enfileiramento (H2),
  starvation do pedido manual (M1) e fila morta em tenant sem robô (M2)?
  → A: As quatro decisões do operador, em 2026-09-08:
  **(H1)** implementar e testar **sem ligar em produção** — código,
  mudança de esquema e testes validados apenas no ambiente isolado; o
  gatilho **não** é criado em produção nesta entrega e o cutover de
  produção fica **condicionado à definição prévia do prazo de
  retenção/expurgo** de CPF/RG/CNH. Não ampliar a coleta de PII agora
  (FR-013).
  **(H2)** teto de **100** novos enfileirados por importação/dia,
  **configurável** e nunca constante mágica; o excedente não é perdido,
  fica sem enfileirar e entra na importação seguinte (FR-010).
  **(M1)** o pedido manual **fura a fila** dos auto-enfileirados
  (FR-011).
  **(M2)** o enfileiramento fica **condicionado a empresa habilitada**,
  nega-por-padrão (FR-012).

> Nota (CHK016, onda-008): o formato de FR-010..FR-013 foi corrigido nesta
> onda — a cláusula `(mitigação X, decisão do operador em \`block-003\`)`
> passou a vir imediatamente após os dois-pontos, no padrão
> `- **FR-0NN**: (mitigação X, ...) <texto MUST>` que o gate
> `requirement-coverage.sh` reconhece. Texto normativo inalterado; dec-022
> não é reaberta por esta nota.

## User Scenarios & Testing

### User Story 1 - Entregador novo entra na fila sozinho (Priority: P1)

Quando uma importação de planilha cria um entregador que nunca existiu
antes para aquela empresa, o sistema o coloca automaticamente na fila de
enriquecimento de dados — sem que nenhum operador precise abrir a tela do
entregador e disparar o enriquecimento manualmente.

**Why this priority**: É o problema medido em produção — hoje 100% dos
entregadores novos ficam permanentemente sem dados enriquecidos a menos
que um operador lembre de tratá-los um a um. Sem esta story não há
automação nenhuma; é o MVP da feature.

**Independent Test**: Rodar uma importação que cria pelo menos um
entregador com identificador externo nunca visto antes para a empresa, e
verificar — sem qualquer ação manual — que esse entregador aparece na
fila de processamento de enriquecimento já na primeira rodada seguinte do
processamento automático existente.

**Acceptance Scenarios**:

1. **Given** uma importação contém um entregador cujo identificador
   externo nunca existiu antes para aquela empresa, **When** a importação
   termina de processar essa linha, **Then** o entregador passa a constar
   na fila de enriquecimento automaticamente, sem intervenção manual.
2. **Given** uma importação contém um entregador cujo identificador
   externo já existia para aquela empresa (ex.: reimportação de um
   período já processado antes, ou uma planilha nova que repete um
   entregador conhecido), **When** a importação atualiza esse registro,
   **Then** o estado de fila de enriquecimento desse entregador permanece
   exatamente como estava antes da importação (nem é forçado a entrar na
   fila, nem é removido dela).
3. **Given** o mesmo identificador externo novo aparece mais de uma vez
   dentro do mesmo lote de importação (ex.: duas linhas do mesmo entregador
   em datas diferentes), **When** a importação processa o lote, **Then**
   esse entregador é tratado como uma única criação e entra na fila uma
   única vez (nunca duplicado, nunca com estado ambíguo).

---

### User Story 2 - Diferenciar "nunca tentado" de "tentado e não encontrado" (Priority: P2)

Quando o processamento automático tenta enriquecer um entregador e o
serviço externo informa que aquela pessoa não é reconhecida, o sistema
registra esse desfecho específico no próprio registro do entregador — de
forma que, olhando para aquele entregador depois, dá para saber que já
houve uma tentativa e ela não encontrou a pessoa, em vez de parecer que
ele simplesmente nunca foi processado.

**Why this priority**: Depende da fila existir e ser alimentada (US1) para
ter volume relevante de tentativas automáticas. Sem esta story, qualquer
rotina futura que precise saber "quem ainda falta tentar" não consegue
excluir os casos mortos e ficaria retentando indefinidamente os mesmos
entregadores que o serviço externo nunca vai reconhecer.

**Independent Test**: Provocar (ou simular) uma tentativa de
enriquecimento cujo desfecho seja "pessoa não encontrada" para um
entregador especificamente marcado para esse cenário de teste, e
verificar que o registro desse entregador passa a mostrar esse desfecho
de forma distinguível tanto de "nunca tentado" quanto de qualquer outro
tipo de falha (ex.: erro temporário de comunicação).

**Acceptance Scenarios**:

1. **Given** um entregador nunca foi submetido a uma tentativa de
   enriquecimento, **When** alguém consulta o estado desse entregador,
   **Then** o sistema mostra claramente que não houve tentativa (estado
   distinto de qualquer tipo de falha).
2. **Given** um entregador é submetido a uma tentativa de enriquecimento e
   o serviço externo responde que não reconhece essa pessoa, **When** a
   tentativa termina, **Then** o registro do entregador passa a indicar
   esse desfecho específico ("tentado, pessoa não encontrada"), de forma
   diferente de "nunca tentado" e de outros tipos de falha.
3. **Given** um entregador é submetido a uma tentativa de enriquecimento e
   ela falha por um motivo diferente de "pessoa não encontrada" (ex.: erro
   temporário de comunicação com o serviço externo), **When** a tentativa
   termina, **Then** o registro do entregador indica uma falha, mas NÃO a
   classifica como "pessoa não encontrada".
4. **Given** um entregador já está marcado com o desfecho "pessoa não
   encontrada" de uma tentativa anterior, **When** uma nova tentativa de
   enriquecimento é feita para ele (automática ou disparada manualmente
   por um operador) e o desfecho dessa nova tentativa é diferente
   (sucesso, ou outro tipo de falha), **Then** o desfecho antigo é
   substituído pelo desfecho da tentativa mais recente — a marca de
   "pessoa não encontrada" não é permanente.

---

### Edge Cases

- O que acontece quando a mesma linha de importação chega mais de uma vez
  no mesmo lote com o mesmo identificador externo novo? O entregador deve
  ser contado como uma única criação (ver Acceptance Scenario 3 da US1).
- O que acontece quando um entregador que nunca teve dados enriquecidos
  (nem tentativa, nem sucesso, nem falha) é atualizado por uma
  reimportação? O estado de fila dele não muda por causa da atualização —
  só a criação original dispara a entrada na fila (US1, Scenario 2).
- O que acontece com um entregador marcado "pessoa não encontrada" quando
  um operador dispara manualmente uma nova tentativa pela tela existente?
  O novo desfecho substitui o antigo (US2, Scenario 4) — a marca nunca
  trava o entregador permanentemente fora de novas tentativas manuais.
- O que acontece quando uma tentativa de enriquecimento tem sucesso depois
  de uma tentativa anterior ter falhado (de qualquer tipo, incluindo
  "pessoa não encontrada")? Os dados enriquecidos com sucesso substituem
  qualquer classificação de falha anterior — sucesso sempre é o desfecho
  mais recente refletido.
- O que acontece quando um operador reduz o teto configurado de uma
  empresa que já tem pedidos pendentes acima do novo valor (FR-010)? Os
  pedidos já pendentes não são descartados nem re-classificados — a fila
  não é um contador por importação, é "no máximo `teto` pendentes a
  qualquer instante" (`data-model.md` §O teto é de fila pendente); o
  excedente apenas aguarda o processamento existente drenar, sem meta de
  tempo.
- O que acontece quando o serviço/cliente externo envia um `sinalFalha`
  malicioso ou muito grande (ex.: trecho de página com PII, ou 4 KB de
  texto) no `PATCH` de falha (FR-014)? O valor bruto nunca chega à
  auditoria — o servidor só grava o desfecho já mapeado (um dos 4 tokens
  de FR-006) em `detalhes`, e `motivoFalha` é truncado antes de gravar;
  nada além do mapeamento fechado atravessa para o registro auditável.
- O que garante que "pessoa não encontrada" não regride sozinho para
  "nunca tentado" (SC-004)? O gatilho `trg_entregador_enfileira_import`
  só enfileira em `INSERT` (criação nova) ou no ramo específico de
  `UPDATE` coberto por FR-002 — nenhum caminho do processamento
  automático volta `dados_entrego_desfecho` para `nunca-tentado`; a
  janela de verificação empírica é de 7 dias corridos (SC-004).

## Requirements

### Functional Requirements

- **FR-001**: O sistema MUST colocar automaticamente na fila de
  enriquecimento todo entregador que seja criado pela primeira vez (nunca
  existiu antes para aquela empresa) através de uma importação, sem
  exigir nenhuma ação manual de um operador — subordinado à habilitação
  por empresa (FR-012) e ao teto por empresa (FR-010), que **adiam**, mas
  nunca cancelam, o enfileiramento.
- **FR-002**: O sistema MUST NOT alterar o estado de fila de
  enriquecimento de um entregador que já existia antes da importação,
  mesmo quando essa mesma importação atualiza outros dados desse
  entregador (ex.: nome). **Única exceção** (introduzida por FR-010): um
  entregador que foi criado por uma importação **posterior à habilitação
  da empresa** (FR-012), que nunca foi enfileirado nem teve tentativa
  alguma, e que ficou de fora apenas por ter excedido o teto, MUST
  continuar elegível e ser enfileirado numa importação seguinte. Nenhum
  entregador existente **antes** da habilitação é alcançado por esta
  exceção — retroatividade permanece fora de escopo.
- **FR-003**: O sistema MUST tratar cada identificador externo distinto
  como uma única criação dentro de um mesmo lote de importação, mesmo que
  esse identificador apareça em múltiplas linhas do lote (FR-001 dispara
  no máximo uma vez por identificador novo por lote).
- **FR-004**: O enfileiramento automático (FR-001) MUST ser consumido
  pelo mesmo canal de processamento sob-demanda que hoje já atende pedidos
  de enriquecimento disparados manualmente — nenhum canal de consumo novo
  é necessário.
- **FR-005**: Quando uma tentativa de enriquecimento falhar porque o
  serviço externo não reconhece/não encontra a pessoa correspondente ao
  entregador, o sistema MUST registrar esse desfecho especificamente no
  registro do entregador, de forma que ele fique distinguível tanto de
  "nunca tentado" quanto de outros tipos de falha (ex.: erro temporário).
- **FR-006**: O sistema MUST permitir, para qualquer entregador, saber em
  qual dos quatro valores o desfecho da última tentativa se encontra:
  nunca tentado / pessoa não encontrada / outra falha / sucesso — os
  quatro valores MUST ser mutuamente exclusivos e distinguíveis sem
  ambiguidade (Clarifications, Session 2026-09-08).
- **FR-007**: O desfecho registrado por FR-005 MUST refletir apenas a
  tentativa mais recente — uma nova tentativa (automática ou manual) cujo
  desfecho seja diferente MUST substituir a classificação anterior, nunca
  acumulá-la.
- **FR-008**: Uma tentativa de enriquecimento que falhar por qualquer
  motivo (incluindo "pessoa não encontrada") MUST NUNCA descartar dados
  de um enriquecimento bem-sucedido anterior daquele entregador — apenas
  uma nova tentativa bem-sucedida substitui dados já enriquecidos.
- **FR-009**: Toda operação desta feature (enfileiramento automático,
  consulta e gravação do desfecho de tentativa) MUST ter seu escopo de
  empresa/tenant resolvido a partir do contexto autenticado da sessão que
  a executa, nunca de um valor informado livremente na requisição.
- **FR-010**: (mitigação H2, decisão do operador em `block-003`) O
  enfileiramento automático MUST respeitar um **teto de pedidos
  automáticos por empresa**, cujo valor é **configurável por empresa** e
  MUST NOT ser uma constante embutida no código. Valor inicial escolhido
  e justificado pelo operador: **100** — o volume normal é ~6 entregadores
  novos/dia, então o teto só morde em importação histórica grande; 100
  pedidos drenam em ~100 min na cadência real do consumidor (1 por
  minuto), terminando antes da janela da importação seguinte. O excedente
  MUST NOT ser descartado nem perdido: permanece elegível (FR-002) e é
  enfileirado numa importação seguinte, respeitando o mesmo teto. Reduzir
  o teto de uma empresa MUST NOT descartar nem re-classificar pedidos já
  pendentes; o excedente permanece na fila, sem meta de tempo, até ser
  drenado pelo processamento existente.
- **FR-011**: (mitigação M1, decisão do operador em `block-003`) Um pedido
  de enriquecimento disparado **manualmente** por uma pessoa operadora
  MUST ser servido pelo processamento antes de qualquer pedido criado
  pelo enfileiramento automático, independentemente de quando cada um
  entrou na fila. Sem isso, o botão "enriquecer agora" passaria a
  significar "enriquecer em alguns dias".
- **FR-012**: (mitigação M2, decisão do operador em `block-003`) O
  enfileiramento automático MUST ocorrer **somente** para empresa
  explicitamente habilitada, com semântica **nega-por-padrão** (empresa
  sem registro de habilitação nunca enfileira automaticamente). Isso
  impede que uma empresa cujo consumo da fila não está configurado
  acumule uma fila permanente que nunca drena.
- **FR-013**: (mitigação H1, decisão do operador em `block-003`) Ligar o
  enfileiramento automático para uma empresa MUST ser um ato explícito,
  reversível e auditável, **separado** do deploy do código e da aplicação
  da mudança de esquema — de modo que código e esquema possam existir no
  ambiente sem que nenhuma coleta automática de dados pessoais comece. O
  critério de "auditável" satisfeito por este requisito é a própria linha
  da tabela `EnriquecimentoAutomatico` (`ativo`/`desde`/`atualizado_em`)
  somada ao registro no runbook de cutover — sem endpoint de administração
  nem linha formal em `"Auditoria"`, por desenho (`research.md` Decision 9).

> **Pendência de cutover (CHK004/CHK020, `plan.md` §Riscos/§Fora de
> escopo)**: o prazo de retenção/expurgo de CPF/RG/CNH coletados por este
> enriquecimento (dívida herdada de `dec-038`/migration `0057`) **não é
> definido por esta feature**. O cutover de produção (aplicar a `0060` no
> `chatmasterveloz` e habilitar a empresa) fica **condicionado** à
> definição prévia desse prazo pelo dono do produto — esta feature apenas
> torna a pendência rastreável, não a resolve.

- **FR-014**: (mitigação achado `owasp-security` M4, `plan.md` §Achados) O
  valor bruto de `sinalFalha` (controlado pelo serviço externo/cliente)
  MUST NOT ser gravado sem sanitização em nenhum registro de auditoria —
  apenas o valor já mapeado para um dos 4 desfechos (FR-006) MUST ser
  persistido em `detalhes`, e `motivoFalha` MUST ser truncado antes de
  gravar.

> Decisões de infraestrutura: N/A para scheduling/rotação de chave/mutex
> multi-pod/backup — esta feature reutiliza o processamento sob-demanda e
> a autenticação já existentes (nenhum scheduler novo, nenhuma
> criptografia nova, nenhum lock novo). Não introduz política de retry
> nova: comportamento de nova tentativa após qualquer falha (exceto o que
> FR-005/FR-007 exigem sobre classificação) permanece o mesmo já em vigor
> hoje. Escopo desta feature é somente backend (enfileiramento automático +
> persistência do desfecho via API) — nenhuma FR/SC de UI no frontend_v2
> (Clarifications, Session 2026-09-08); exposição visual do desfecho fica
> para feature futura.

> **Invariante de consistência (Clarifications, Session 2026-09-08)**: o
> valor `sucesso` do campo de desfecho (FR-006) e o campo separado que
> registra os dados enriquecidos (`dados_entrego_enriquecidos_em` — ver
> Key Entities) são gravados no MESMO PATCH (`routes/hub-robo-entrego.js`).
> Não existe janela em que um esteja preenchido e o outro não. Este design
> é deliberado: o `/plan` MUST NOT tentar "simplificar" removendo um dos
> dois campos sob alegação de redundância — a redundância é a garantia de
> consistência, não um descuido.

### Key Entities

- **Entregador**: pessoa entregadora identificada por um identificador
  externo dentro de uma empresa. Já existe hoje; esta feature adiciona a
  ele dois aspectos observáveis — (a) se está atualmente na fila de
  enriquecimento, e (b) o desfecho da última tentativa de enriquecimento
  (nunca tentado / pessoa não encontrada / outra falha / enriquecido com
  sucesso), e (c) se o pedido pendente de enriquecimento é de origem
  **manual** ou **automática** (FR-011).
- **Habilitação do enfileiramento automático**: registro por empresa que
  diz se o enfileiramento automático está ligado para ela (FR-012), qual
  o teto de pedidos automáticos que ela admite (FR-010) e desde quando
  está habilitada — este último delimita quais entregadores são elegíveis
  (só os criados a partir dali), preservando a exclusão de retroatividade
  de FR-002. Sem registro, nada é enfileirado automaticamente.

## Success Criteria

### Measurable Outcomes

- **SC-001**: Em empresa habilitada (FR-012), 100% dos entregadores
  criados por uma importação entram na fila de enriquecimento
  automaticamente **até o teto vigente** (FR-010) — verificável checando
  o estado de fila imediatamente após qualquer importação que crie
  entregadores novos, sem qualquer clique ou ação manual de operador. O
  excedente do teto entra numa importação seguinte, e a soma ao longo das
  importações continua sendo 100% (nenhum entregador novo fica
  permanentemente fora).
- **SC-002**: Para qualquer entregador, é possível responder corretamente e
  sem ambiguidade, em 100% dos casos, qual dos 4 valores do desfecho da
  última tentativa se aplica — "nunca tentado", "pessoa não encontrada no
  serviço externo", "outro tipo de falha" ou "sucesso" (Clarifications,
  Session 2026-09-08).
- **SC-003**: A quantidade de entregadores recém-criados (últimas 24h)
  sem nenhuma tentativa de enriquecimento e fora da fila de processamento
  tende a zero, medido a qualquer momento após a implantação — hoje esse
  número cresce continuamente sem intervenção manual (67 → 75 em 1 hora
  medido em produção).
- **SC-004**: A quantidade de entregadores classificados como "pessoa não
  encontrada" nunca é reprocessada como se fosse "nunca tentado" pelo
  próprio processamento automático — verificável comparando o total de
  tentativas registradas para um mesmo entregador nesse estado ao longo
  do tempo sem intervenção manual (deve permanecer com uma única
  classificação de última tentativa, nunca voltar a "nunca tentado"
  sozinho). Janela de verificação: observação de pelo menos **7 dias
  corridos** de execução do processamento automático (ambiente de teste,
  ou pós-cutover em produção) sem nenhuma reversão automática de
  "pessoa-nao-encontrada" para "nunca-tentado".
- **SC-005**: O número de pedidos automáticos pendentes de uma empresa
  nunca excede o teto configurado para ela (FR-010), verificável a
  qualquer instante contando os pendentes daquela empresa — inclusive
  logo após uma importação que traga muito mais entregadores novos do que
  o teto.
- **SC-006**: Um pedido manual criado **depois** de N pedidos automáticos
  é processado **antes** de todos eles (FR-011), verificável pela ordem em
  que o processamento consome a fila.
- **SC-007**: Com o esquema aplicado e o código no ar, uma empresa **sem
  registro de habilitação** não tem nenhum entregador enfileirado
  automaticamente por importação alguma (FR-012/FR-013) — verificável
  importando para essa empresa e conferindo que a fila dela permanece
  inalterada.

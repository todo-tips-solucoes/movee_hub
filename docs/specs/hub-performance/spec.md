# Feature Specification: Módulo Performance do Hub de Frota

**Feature**: `hub-performance`
**Created**: 2026-07-08
**Status**: Draft

> Sessão S7 do plano mestre do Hub de Gestão de Frota (`docs/plans/hub-frota/`). Sobre a
> dimensão de pessoas entregadoras da S5 e o fato `PerformanceTurno` já populado pelo
> pipeline de importações da S4 (append-only, ~2,7 mil linhas/dia, granularidade de 1
> linha por combinação de entregador × turno × dia, podendo repetir por área de atuação),
> esta fase entrega a consulta de performance operacional dentro do hub: lista filtrável e
> paginada por turno, agregados por dia/turno/entregador com indicadores calculados na
> consulta, e exportação em CSV — sempre em modo somente-leitura sobre dados já
> importados.
>
> Diferente do faturamento (S6), aqui **todo registro pertence a uma pessoa entregadora
> específica** — o CSV de origem exige o identificador do entregador em toda linha, então
> não existe (nesta fase) um conceito de registro "agregado/sem entregador" a preservar
> nos totais.
>
> Os indicadores de desempenho (taxa de aceitação, taxa de conclusão, taxa de rejeição)
> não são colunas persistidas — são sempre calculados no momento da consulta a partir das
> contagens brutas de corridas, e a forma de calculá-los quando o filtro agrega várias
> linhas é o ponto de maior risco de corretude desta fase: a taxa agregada de um conjunto
> de linhas é a razão entre as somas (Σaceitas / Σofertadas), nunca a média aritmética das
> taxas individuais de cada linha.
>
> **Não inclui**: metas ou alertas de performance (ex.: destacar entregadores abaixo de um
> limiar) — possível fase futura; comparativos de desempenho entre entidades/tenants;
> qualquer nova estrutura de pré-cálculo/agregação persistida (só entra em consideração se
> a consulta de agregados for medida como lenta demais com um volume de dados equivalente
> a um ano de operação — a decisão e a medição ficam registradas como parte desta fase, não
> presumidas antes dela); qualquer gráfico ou biblioteca de visualização nova sem aprovação
> explícita do operador; qualquer alteração na importação, na dimensão de pessoas
> entregadoras ou no fato já persistido (fases anteriores, preservadas sem mudança).

## Clarifications

### Sessão 2026-07-08

- **Q2 — Granularidade de permissão (FR-008)**: Esta fase deve introduzir
  `performance.listar` como terceira permissão dedicada (separando lista de agregados),
  ou lista e agregados continuam sob `performance.consultar`? → **A: introduzir
  `performance.listar` como terceira permissão dedicada; `performance.exportar` segue
  separado.** (decisão autônoma, score 3 — evidência: o briefing S7 já lista
  `performance.list/view/export` como três ações distintas; o seed 0007 já mantém
  `motoristas.consultar` + `motoristas.listar` convivendo; a migration corretiva 0026
  fechou exatamente o mesmo gap no módulo de faturamento; research.md da S6, Decision 1,
  exige as três permissões independentes. Registrada como dec-009 no state da execução.)
- **Q1 — Ponderação da média de tempo disponível (FR-003)**: A média de tempo disponível
  do período deve ser (A) aritmética simples dos `tempo_disponivel_pct` informados, (B)
  ponderada por corridas ofertadas, ou (C) ponderada pela duração do turno? → **C:
  ponderada pela duração do turno** (Σ(pct × duração) / Σduração), com **fallback
  documentado para média aritmética simples** quando a duração do turno não for
  derivável do atributo `periodo` para um ou mais registros do conjunto, ou quando
  `tempo_disponivel_pct` for `NULL` (registro excluído do cálculo em ambos os casos,
  simples ou ponderado). (Decisão do operador via bloqueio block-001, registrada como
  dec-011 no state da execução, score 2 — fundamento: gotcha do briefing S7 "não fazer
  média de percentuais linha a linha — ponderar pelo denominador"; o denominador natural
  de um percentual de tempo disponível é a duração do turno de origem do próprio
  percentual. Como as durações de turno são quase constantes na prática, C converge
  numericamente para A na maioria dos casos, minimizando o risco da escolha.)

## User Scenarios & Testing

### User Story 1 - Consultar e filtrar a performance de um período (Priority: P1)

Uma pessoa responsável pela operação abre a tela de performance do hub e vê, para o
período recente (30 dias por padrão), um resumo com o total de corridas completadas, a
taxa de aceitação, a taxa de conclusão e o tempo disponível médio dos entregadores no
período — e pode refinar essa visão filtrando por intervalo de datas, por turno
(período do dia), por área de atuação (subpraça) e por entregador específico. Abaixo do
resumo, navega pela lista detalhada de registros de performance por turno, paginada.

**Why this priority**: É o valor mínimo e independente desta fase — sem a lista filtrável
e os indicadores confiáveis, nenhuma das capacidades seguintes (analisar por dimensão,
exportar) faz sentido. É também o requisito com maior risco de corretude (taxas
ponderadas, conversão de centavos) e por isso o que mais precisa de validação isolada.

**Independent Test**: Pode ser testada sozinha com os dados já importados pela S4:
aplicar cada filtro isoladamente e em combinação, conferir que os indicadores exibidos
batem exatamente com um cálculo feito diretamente no banco para o mesmo filtro
(somas de corridas e razão entre somas, nunca média de percentuais), e confirmar que a
paginação da lista é calculada no lado do sistema (não apenas sobre o que já chegou à
tela).

**Acceptance Scenarios**:

1. **Given** existem milhares de registros de performance importados para a entidade
   ativa, **When** a pessoa usuária abre a tela sem aplicar nenhum filtro, **Then** vê os
   últimos 30 dias por padrão, com corridas completadas, taxa de aceitação, taxa de
   conclusão e tempo disponível médio, todos calculados no sistema (não no navegador).
2. **Given** a lista está sendo exibida, **When** a pessoa usuária filtra por um turno
   específico e um intervalo de datas, **Then** tanto o resumo quanto a lista detalhada
   refletem apenas os registros daquele filtro, e os indicadores exibidos batem
   exatamente com o cálculo direto desses mesmos registros no banco.
3. **Given** o período filtrado tem duas ou mais linhas para o mesmo entregador no mesmo
   dia e turno (ex.: uma linha por área de atuação distinta), **When** o resumo agrega o
   período, **Then** todas as linhas são somadas — nenhuma é descartada por parecer
   duplicada.
4. **Given** a pessoa usuária filtra especificamente por um entregador, **When** a
   consulta é aplicada, **Then** apenas os registros daquele entregador aparecem no resumo
   e na lista, sem afetar o resultado de outras consultas sem esse filtro.
5. **Given** o filtro aplicado não tem nenhum registro correspondente, **When** a consulta
   retorna vazia, **Then** a tela mostra um estado de "período sem dados" claro (não um
   erro nem uma tela em branco).
6. **Given** um registro do período tem o número de corridas aceitas mais rejeitadas maior
   que o número de corridas ofertadas (inconsistência de dado já importado), **When** o
   resumo agrega esse registro, **Then** o valor é somado normalmente junto aos demais —
   a tela não trava, não rejeita a linha e não tenta "corrigir" o dado (a correção, se
   necessária, é responsabilidade de uma nova importação, fora do escopo desta fase).

---

### User Story 2 - Analisar a performance agrupada por dimensão (Priority: P2)

A partir dos mesmos filtros da User Story 1, uma pessoa usuária consulta um agregado por
dia, por turno (período) ou por entregador — por exemplo, comparando a taxa de aceitação
de cada turno do dia, ou o volume de corridas completadas por entregador no período.

**Why this priority**: Depende da capacidade de filtrar (User Story 1) mas entrega valor
analítico isolado — é a diferença entre "ver o total do período" e "entender onde o
período está concentrado ou onde a operação está com pior desempenho". Fica em segunda
prioridade porque a operação consegue funcionar apenas com o resumo geral da User Story 1
enquanto essa capacidade não existe.

**Independent Test**: Pode ser testada isoladamente acionando a consulta agregada com cada
uma das três dimensões (dia, turno, entregador) e conferindo que a soma dos valores de
todos os grupos retornados bate exatamente com o total geral não agrupado do mesmo
filtro, e que a taxa de cada grupo é a razão entre as somas do grupo (nunca a média das
taxas das linhas daquele grupo).

**Acceptance Scenarios**:

1. **Given** um filtro de período está aplicado, **When** a pessoa usuária pede o
   agregado por turno, **Then** vê um valor por turno presente no período, cada um com
   suas próprias somas de corridas e taxas ponderadas pelas somas daquele turno.
2. **Given** o mesmo filtro de período, **When** a pessoa usuária pede o agregado por
   entregador, **Then** vê um valor por entregador com registro no período, e a soma de
   corridas completadas de todos os entregadores listados bate exatamente com o total
   geral do resumo da User Story 1 para o mesmo filtro.
3. **Given** o agregado é pedido por dia, **When** o intervalo filtrado abrange múltiplos
   dias, **Then** cada dia aparece com seus próprios totais, na ordem cronológica do
   período.

---

### User Story 3 - Exportar a performance filtrada em CSV (Priority: P3)

A partir da mesma tela e dos mesmos filtros das User Stories anteriores, uma pessoa
usuária autorizada exporta a lista de registros de performance filtrada em um arquivo
CSV para uso fora do hub, com garantia de que o arquivo é seguro para abrir em programas
de planilha.

**Why this priority**: Depende da capacidade de filtrar (User Story 1) mas entrega valor
isolado e é um requisito de segurança explícito do escopo — o export é o único ponto
desta fase em que dado do sistema vira um arquivo consumido fora dele, o que introduz
risco (CSV injection) que precisa de tratamento dedicado. Fica em terceira prioridade
porque a consulta (Stories 1 e 2) já entrega o valor central da fase sem depender da
exportação.

**Independent Test**: Pode ser testada isoladamente acionando a exportação com um filtro
aplicado, conferindo que o arquivo resultante contém exatamente os registros daquele
filtro (mesma contagem e mesmos totais da tela) e que nenhuma célula cujo conteúdo comece
com um caractere de fórmula é interpretada como fórmula ao abrir o arquivo em um
programa de planilha comum.

**Acceptance Scenarios**:

1. **Given** um filtro está aplicado na lista, **When** a pessoa usuária autorizada aciona
   a exportação, **Then** recebe um arquivo CSV cujas linhas correspondem exatamente aos
   registros daquele filtro (mesma contagem exibida na tela).
2. **Given** um registro tem um valor de texto que começa com um dos caracteres
   `= + - @` em qualquer célula exportada, **When** o arquivo é gerado, **Then** essa
   célula é neutralizada (prefixada) de forma que, ao abrir o arquivo em um programa de
   planilha comum, o conteúdo aparece como texto simples e nunca é executado como fórmula.
3. **Given** uma pessoa usuária não tem a permissão de exportação, **When** ela abre a
   tela de performance com um filtro aplicado, **Then** não vê nenhum controle de
   exportação na interface.
4. **Given** uma pessoa sem a permissão de exportação tenta acionar a exportação
   diretamente (contornando a interface), **When** a tentativa chega ao sistema, **Then**
   é recusada com um erro de acesso negado e nenhum arquivo é gerado.

---

### Edge Cases

- O que acontece quando o intervalo de datas filtrado abrange um volume muito grande de
  registros (ex.: um ano inteiro de operação)? O resumo e o agregado por dimensão
  continuam respondendo dentro de um tempo aceitável (ver Success Criteria); se a medição
  mostrar degradação relevante com esse volume, a decisão sobre introduzir pré-cálculo
  fica registrada como parte desta fase, não implementada por antecipação.
- Como o sistema trata um registro cuja taxa de tempo disponível (`tempo_disponivel_pct`)
  não foi informada na importação (valor ausente)? Esse registro é excluído do cálculo da
  média de tempo disponível do período — não é tratado como zero, para não distorcer a
  média para baixo.
- Como o sistema trata o cálculo da média de tempo disponível quando a duração do turno
  não pode ser derivada do atributo `periodo` para um ou mais registros do conjunto
  filtrado (ex.: valor fora do padrão conhecido de descrição de turno)? O cálculo cai no
  fallback documentado (FR-003, Clarifications Q1): média aritmética simples dos
  `tempo_disponivel_pct` informados no conjunto, em vez de interromper o cálculo com erro
  ou omitir o indicador.
- Como o sistema trata um registro cujo valor de taxas (`taxas_centavos`) não foi
  informado (valor ausente)? É tratado como zero na soma do período — nenhuma taxa
  ausente quebra o cálculo do total.
- O que acontece quando um registro tem corridas aceitas mais rejeitadas maior que
  corridas ofertadas, ou corridas completadas maior que corridas aceitas (inconsistência
  já existente no dado importado)? O sistema soma o registro normalmente nos agregados —
  esta fase é somente leitura sobre o fato já persistido pela importação (S4) e não
  valida, rejeita ou corrige essas linhas; qualquer correção necessária entra
  exclusivamente por uma nova importação.
- Como a exportação se comporta quando o filtro aplicado não retorna nenhum registro? O
  arquivo é gerado mesmo assim, contendo apenas o cabeçalho de colunas — não é tratado
  como erro.
- O que acontece se o valor de uma célula exportada já começa com um apóstrofo ou outro
  caractere neutro? Nenhuma neutralização adicional é aplicada — só os caracteres de
  fórmula (`= + - @`) no início da célula disparam o prefixo de proteção.
- Como o sistema se comporta quando a entidade ativa ainda não tem nenhum registro de
  performance importado (cenário anterior à primeira importação, ou logo após ela)? A
  tela mostra o estado de "período sem dados", nunca um erro.
- Como o agregado por turno (`periodo`) trata um valor de turno que não está entre os 16
  turnos documentados do domínio? O registro aparece normalmente no agregado sob o
  próprio texto do turno como veio da importação — o sistema não recusa nem esconde
  turnos fora de uma lista fechada (o texto de `periodo` é livre, proveniente da origem).

## Requirements

### Functional Requirements

- **FR-001**: O sistema MUST permitir que uma pessoa autorizada visualize uma lista
  paginada de registros de performance por turno restrita ao escopo da entidade ativa,
  com paginação calculada e aplicada no lado do sistema.
- **FR-002**: O sistema MUST permitir filtrar a lista e os agregados por intervalo de
  datas (com um padrão de 30 dias quando nenhum intervalo é informado), por turno
  (período do dia), por área de atuação (subpraça) e por entregador específico —
  isoladamente ou em combinação. O filtro de datas MUST usar a data do turno (dia a que o
  registro se refere) como campo padrão. O filtro por subpraça MUST usar o atributo de
  área de atuação já existente no fato desde a fase S4/S5 (com estrutura de consulta
  dedicada já entregue) — nenhuma estrutura nova de índice é introduzida por esta fase.
- **FR-003**: O sistema MUST exibir, para o período e filtros aplicados, um resumo
  calculado no sistema (não no cliente) contendo pelo menos: o total de corridas
  completadas, a taxa de aceitação (razão entre a soma de corridas aceitas e a soma de
  corridas ofertadas do período), a taxa de conclusão (razão entre a soma de corridas
  completadas e a soma de corridas aceitas) e o tempo disponível médio dos registros do
  período. Toda razão MUST ser protegida contra divisão por zero (denominador zero produz
  um estado explícito de indicador indisponível, nunca um erro ou um valor calculado
  incorretamente como zero ou cem por cento). Nenhuma taxa agregada MUST ser calculada
  como média aritmética das taxas individuais de cada registro — toda taxa agregada de um
  conjunto de registros MUST ser a razão entre as somas desse conjunto (Σaceitas/Σofertadas
  e Σcompletadas/Σaceitas). O tempo disponível médio do período MUST ser calculado como
  média ponderada pela duração do turno de cada registro (Σ(tempo_disponivel_pct × duração
  do turno) / Σ(duração do turno)), onde a duração do turno é derivada do atributo
  `periodo` do registro (ex.: "ALMOCO 11H30-15H29" → 3h59min); registros sem
  `tempo_disponivel_pct` informado MUST ser excluídos do numerador e do denominador dessa
  média (conforme Edge Cases). Quando a duração do turno não puder ser derivada de forma
  confiável para um ou mais registros do conjunto (ex.: valor de `periodo` fora do padrão
  conhecido) MUST aplicar-se um fallback documentado de média aritmética simples dos
  `tempo_disponivel_pct` informados para o cálculo (ver Clarifications, Sessão
  2026-07-08, Q1) — nunca erro nem indicador ausente por esse motivo.
- **FR-004**: O sistema MUST também oferecer um agregado por dia, por turno (período) e
  por entregador, para o intervalo de datas e demais filtros informados, com as mesmas
  taxas do FR-003 calculadas por grupo (ponderadas pelas somas de cada grupo, nunca médias
  de percentuais linha a linha). A soma de qualquer métrica de corridas em qualquer
  agrupamento MUST somar todos os registros correspondentes, mesmo quando dois ou mais
  registros compartilham o mesmo entregador, dia e turno (ex.: por terem áreas de atuação
  distintas) — o sistema MUST NUNCA assumir unicidade dessa combinação como chave.
- **FR-005**: Todo valor monetário de taxas (`taxas_centavos`, armazenado em centavos)
  exibido ou somado MUST ser convertido para reais exatamente uma vez, no momento da
  consulta/apresentação — nunca re-persistido nem tratado como se já estivesse em reais
  em nenhuma etapa intermediária do cálculo. Um registro sem valor de taxas informado
  MUST ser tratado como zero na soma do período (conforme Edge Cases), nunca como um erro
  que interrompe o cálculo.
- **FR-006**: O sistema MUST permitir exportar em CSV a lista de registros resultante dos
  filtros correntes, com o mesmo conjunto e a mesma contagem de linhas que a lista exibida
  na tela para aquele filtro.
- **FR-007**: Toda célula exportada em CSV cujo conteúdo comece com um dos caracteres
  `=`, `+`, `-` ou `@` MUST ser neutralizada com um prefixo que impeça sua interpretação
  como fórmula por um programa de planilha comum, preservando o conteúdo original como
  texto visível.
- **FR-008**: O sistema MUST restringir a visualização da lista de registros de
  performance, a visualização dos resumos/agregados e a exportação em CSV a três
  permissões independentes deste módulo (listagem, consulta de agregados e exportação),
  cada uma controlável separadamente. Uma pessoa sem a permissão correspondente MUST não
  ver o controle correspondente na interface (lista, resumo, ou botão de exportação,
  conforme o caso) e MUST receber um erro de acesso negado caso a ação seja solicitada
  diretamente, contornando a interface. Esta fase introduz a terceira permissão dedicada
  (`performance.listar`, separando lista de agregados), somando-se às duas já seedadas
  (`performance.consultar` para os resumos/agregados, `performance.exportar` para a
  exportação) — mesmo padrão já corrigido no módulo de faturamento pela migration
  corretiva 0026 e presente em `motoristas` desde o seed 0007 (ver Clarifications,
  Sessão 2026-07-08, Q2).
- **FR-009**: Toda consulta (lista, resumo, agregado, exportação) MUST ser restrita ao
  escopo da entidade ativa da sessão — um registro de outra entidade MUST NUNCA aparecer
  em nenhuma dessas respostas, independente dos filtros aplicados.
- **FR-010**: O sistema MUST NOT permitir, por esta fase, nenhuma criação, edição ou
  remoção de registro de performance — toda a superfície entregue é somente leitura sobre
  os dados já trazidos pela importação (S4); qualquer correção necessária MUST continuar
  entrando exclusivamente por uma nova importação.
- **FR-011**: Quando a consulta de lista, resumo ou agregados não retornar nenhum registro
  para o filtro aplicado, o sistema MUST comunicar isso como um estado de "período sem
  dados" distinto de um erro — nunca uma tela em branco ou uma falha.
- **FR-012**: Toda tela nova entregue por esta fase MUST preservar a identidade visual
  (incluindo variação por tenant/cliente e os modos claro/escuro) já estabelecida no
  restante do painel. Um gráfico visual (ex.: evolução por dia/turno) MAY ser incluído
  apenas se o design system do painel já tiver um padrão estabelecido de gráfico
  reutilizável; caso contrário, a tela MUST se limitar a indicadores numéricos (cards) e
  tabela — nenhuma dependência nova de biblioteca de gráficos MUST ser introduzida sem
  aprovação explícita do operador.

> **Decisões de infraestrutura**: esta fase não introduz scheduling periódico, rotação de
> chaves de criptografia, refresh de token externo, ou mecanismo de backup novo. Toda a
> superfície é de leitura (consulta e exportação) sobre um fato já persistido por uma fase
> anterior — não há escrita e, portanto, nenhuma chave de idempotência é necessária. A
> única decisão de infraestrutura em aberto é se um mecanismo de pré-cálculo/agregação
> persistida se torna necessário para os agregados — decisão condicionada à medição
> descrita no Success Criteria SC-004, MUST ser registrada com evidência (tempo medido)
> independentemente do resultado, e MUST NOT ser implementada de forma preventiva antes
> dessa medição.
> Decisões de infraestrutura: N/A além do parágrafo acima (feature stateless de leitura,
> sem scheduling, sobre dados já existentes).

### Key Entities

- **Registro de Performance por Turno**: registro individual e imutável de indicadores
  operacionais de uma pessoa entregadora em um turno de um dia específico (podendo se
  repetir por área de atuação), já existente a partir da fase anterior (S4/S5). Sempre
  vinculado a uma pessoa entregadora específica — não existe, nesta fase, um registro sem
  entregador equivalente ao caso de agregados/bônus do faturamento. Carrega contagens
  brutas de corridas (ofertadas, aceitas, rejeitadas, completadas, canceladas), pedidos
  concluídos, um valor de taxas em centavos, um percentual de tempo disponível e o texto
  do turno do dia. Esta fase apenas consulta e exporta; nunca cria, altera ou remove esse
  registro.
- **Resumo Agregado do Período**: conjunto de somatórios, contagens e taxas ponderadas
  calculado sob demanda a partir dos registros que atendem a um filtro — não é um registro
  persistido, é sempre recalculado a partir dos dados correntes no momento da consulta.

## Success Criteria

### Measurable Outcomes

- **SC-001**: Para qualquer combinação de filtros testada, os indicadores exibidos na
  tela (corridas completadas, taxa de aceitação, taxa de conclusão) batem exatamente com
  o cálculo direto no banco para o mesmo filtro.
- **SC-002**: Em 100% dos casos testados, uma taxa agregada de qualquer agrupamento
  (turno, dia, entregador, ou período geral) é igual à razão entre as somas do grupo —
  nunca à média aritmética das taxas individuais das linhas daquele grupo.
- **SC-003**: Uma pessoa usuária localiza e confirma os indicadores de um período filtrado
  (intervalo de datas + turno) em menos de 15 segundos.
- **SC-004**: Ao consultar o resumo agregado de um período extenso (equivalente a um ano
  de operação em volume de dados), o resultado retorna em menos de 1 segundo; caso a
  medição mostre tempo superior, essa evidência fica registrada junto com a decisão sobre
  introduzir ou não uma estrutura de pré-cálculo.
- **SC-005**: 100% das células exportadas em CSV cujo conteúdo começa com um caractere de
  fórmula (`= + - @`) aparecem neutralizadas no arquivo resultante, verificado por
  abertura em um programa de planilha comum sem nenhuma fórmula sendo executada.
- **SC-006**: Uma pessoa usuária sem a permissão de exportação tem o controle de
  exportação ocultado em 100% das visualizações da tela e recebe acesso negado em 100%
  das tentativas diretas de exportação.
- **SC-007**: Zero registros de fora da entidade ativa aparecem em qualquer resposta de
  lista, resumo, agregado ou exportação, verificado por teste cruzando múltiplas
  entidades.
- **SC-008**: A tela nova entregue por esta fase preserva a identidade visual (branding
  por cliente e temas claro/escuro) sem regressão perceptível em relação ao restante do
  painel.
- **SC-009**: Nenhuma divisão por zero (ex.: período sem corridas ofertadas) produz erro
  visível, tela quebrada ou valor calculado incorretamente (como 0% ou 100% indevidos) —
  em 100% dos casos testados o indicador exibe um estado explícito de indisponível.

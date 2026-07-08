# Feature Specification: Módulo Faturamento do Hub de Frota

**Feature**: `hub-faturamento`
**Created**: 2026-07-08
**Status**: Draft

> Sessão S6 do plano mestre do Hub de Gestão de Frota (`docs/plans/hub-frota/`). Sobre a
> dimensão de pessoas entregadoras da S5 e o fato `FaturamentoLancamento` já populado pelo
> pipeline de importações da S4 (append-only, ~4 mil linhas/dia, granularidade de 1 linha
> por lançamento de crédito), esta fase entrega a consulta desse faturamento dentro do
> hub: lista filtrável e paginada, agregados por período/categoria/entregador, e
> exportação em CSV — sempre em modo somente-leitura sobre dados já importados.
>
> Uma parcela dos lançamentos (bônus e incentivos agregados) não pertence a nenhuma
> pessoa entregadora individual — vem identificada apenas por um rótulo de recebedor
> agregado. Esses lançamentos são tão válidos quanto os demais e esta fase garante que
> eles nunca desapareçam dos totais gerais, mesmo quando a consulta está filtrada por
> entregador.
>
> Existem três datas com semânticas distintas em cada lançamento — a data de competência
> (período a que o valor se refere), a data em que o lançamento foi registrado, e a data
> em que o repasse efetivamente ocorre. Esta fase usa a data de competência como filtro
> padrão e deixa essa escolha explícita para quem consulta.
>
> **Não inclui**: edição ou estorno manual de qualquer lançamento (uma correção só entra
> no sistema por uma nova importação, conforme a regra do pipeline entregue na S4);
> dashboards executivos além dos cards de totais do período; qualquer nova estrutura de
> pré-cálculo/agregação persistida (só entra em consideração se a consulta de agregados
> for medida como lenta demais com um volume de dados equivalente a um ano de operação —
> a decisão e a medição ficam registradas como parte desta fase, não presumidas antes
> dela); qualquer alteração na importação, na dimensão de pessoas entregadoras ou no
> vínculo com contas de acesso (fases anteriores, preservadas sem mudança).

## Clarifications

### Session 2026-07-08

- Q: Subpraça é coluna própria em `FaturamentoLancamento` ou derivada via join com a
  dimensão de pessoa entregadora (S5)? → A: Coluna própria (`subpraca`, migration 0013),
  com índice dedicado já entregue na S5 (`idx_faturamento_empresa_subpraca`, migration
  0020) — não é derivada via join e nenhum índice novo é criado nesta fase. (dec-009)
- Q: No resumo `group_by=entregador`, lançamentos sem `entregador_id` são consolidados em
  bucket único ou separados por valor de `recebedor_agregado`? → A: Bucket ÚNICO
  consolidado "agregados/bônus", independente do rótulo específico de
  `recebedor_agregado`. (dec-010)
- Q: A exportação CSV tem teto de linhas/período ou suporta qualquer volume filtrado? →
  A: Sem teto explícito nesta fase — a resposta é gerada via streaming, sem carregar
  todas as linhas em memória. (dec-011)
- Q: O link do lançamento para o detalhe do entregador (módulo S5) fica visível para quem
  não tem permissão do módulo de motoristas? → A: Fica OCULTO quando a pessoa usuária não
  tem a permissão de visualização do módulo de motoristas; o backend do módulo de destino
  permanece a autoridade final (padrão RBAC vigente do hub: frontend oculta, backend
  nega). (dec-012)
- Q: Critério de desempate do card "categoria de maior valor" quando há empate exato
  entre categorias? → A: Desempate determinístico pela primeira categoria em ordem
  alfabética da `descricao`, dentre as empatadas no maior valor total do período; o card
  sempre exibe uma única categoria (dec-014, decisão do operador — empate exato em
  `numeric(12,2)` é raro; opção A mantém a UI simples e estável frente à alternativa de
  exibir múltiplas categorias empatadas).

## User Scenarios & Testing

### User Story 1 - Consultar e filtrar o faturamento de um período (Priority: P1)

Uma pessoa responsável pela operação abre a tela de faturamento do hub e vê, para o
período recente (30 dias por padrão), o total geral, a categoria de maior valor e o
número de entregadores com lançamento no período — e pode refinar essa visão filtrando
por intervalo de datas, categoria, entregador específico, área de atuação (subpraça), e
se quer ver apenas lançamentos vinculados a um entregador ou também os agregados/bônus
sem entregador. Abaixo dos totais, navega pela lista detalhada de lançamentos, paginada.

**Why this priority**: É o valor mínimo e independente desta fase — sem a lista filtrável
e os totais confiáveis, nenhuma das capacidades seguintes (exportar, navegar até o
detalhe do entregador) faz sentido. É também o requisito com maior risco de corretude
(somas financeiras) e por isso o que mais precisa de validação isolada.

**Independent Test**: Pode ser testada sozinha com os dados já importados pela S4:
aplicar cada filtro isoladamente e em combinação, conferir que os totais exibidos batem
exatamente com uma soma feita diretamente no banco para o mesmo filtro, e confirmar que a
paginação da lista é calculada no lado do sistema (não apenas sobre o que já chegou à
tela).

**Acceptance Scenarios**:

1. **Given** existem milhares de lançamentos de faturamento importados para a entidade
   ativa, **When** a pessoa usuária abre a tela sem aplicar nenhum filtro, **Then** vê os
   últimos 30 dias por padrão, com o total geral do período, a categoria de maior valor e
   o número de entregadores distintos com lançamento, todos calculados no sistema (não no
   navegador).
2. **Given** a lista está sendo exibida, **When** a pessoa usuária filtra por uma
   categoria específica e um intervalo de datas, **Then** tanto os cards de totais quanto
   a lista detalhada refletem apenas os lançamentos daquele filtro, e o total exibido bate
   exatamente com a soma direta desses mesmos lançamentos no banco.
3. **Given** o período filtrado inclui lançamentos de bônus/agregados sem entregador
   individual, **When** a pessoa usuária consulta os totais gerais (sem filtrar por
   entregador), **Then** esses lançamentos aparecem somados ao total geral, sob uma
   rubrica explícita que os identifica como agregados/bônus — nunca omitidos nem
   confundidos com um entregador específico.
4. **Given** a pessoa usuária filtra especificamente por um entregador, **When** a
   consulta é aplicada, **Then** apenas os lançamentos daquele entregador aparecem — os
   lançamentos agregados/bônus sem entregador ficam de fora desse filtro específico, sem
   que isso afete o total geral quando o filtro por entregador não está ativo (cenário 3).
5. **Given** o filtro aplicado não tem nenhum lançamento correspondente, **When** a
   consulta retorna vazia, **Then** a tela mostra um estado de "período sem dados" claro
   (não um erro nem uma tela em branco).
6. **Given** a pessoa usuária está prestes a aplicar um filtro de datas, **When** olha
   para a tela, **Then** fica explícito que o filtro usa a data de competência do
   lançamento (não a data de registro nem a data de repasse) — a UI nomeia essa distinção
   de forma clara, sem exigir que a pessoa usuária conheça o schema do banco.

---

### User Story 2 - Exportar o faturamento filtrado em CSV (Priority: P2)

A partir da mesma tela e dos mesmos filtros da User Story 1, uma pessoa usuária
autorizada exporta a lista de lançamentos filtrada em um arquivo CSV para uso fora do
hub (planilha, conciliação), com garantia de que o arquivo é seguro para abrir em
programas de planilha.

**Why this priority**: Depende da capacidade de filtrar (User Story 1) mas entrega valor
isolado e é um requisito de segurança explícito do escopo — o export é o único ponto
desta fase em que dado do sistema vira um arquivo consumido fora dele, o que introduz
risco (CSV injection) que precisa de tratamento dedicado.

**Independent Test**: Pode ser testada isoladamente acionando a exportação com um filtro
aplicado, conferindo que o arquivo resultante contém exatamente os lançamentos daquele
filtro (mesma contagem e mesmos totais da tela) e que nenhuma célula cujo conteúdo comece
com um caractere de fórmula é interpretada como fórmula ao abrir o arquivo em um
programa de planilha comum.

**Acceptance Scenarios**:

1. **Given** um filtro está aplicado na lista, **When** a pessoa usuária autorizada aciona
   a exportação, **Then** recebe um arquivo CSV cujas linhas correspondem exatamente aos
   lançamentos daquele filtro (mesma contagem exibida na tela).
2. **Given** um lançamento tem um valor de texto que começa com um dos caracteres
   `= + - @` em qualquer célula exportada, **When** o arquivo é gerado, **Then** essa
   célula é neutralizada (prefixada) de forma que, ao abrir o arquivo em um programa de
   planilha comum, o conteúdo aparece como texto simples e nunca é executado como fórmula.
3. **Given** uma pessoa usuária não tem a permissão de exportação, **When** ela abre a
   tela de faturamento com um filtro aplicado, **Then** não vê nenhum controle de
   exportação na interface.
4. **Given** uma pessoa sem a permissão de exportação tenta acionar a exportação
   diretamente (contornando a interface), **When** a tentativa chega ao sistema, **Then**
   é recusada com um erro de acesso negado e nenhum arquivo é gerado.

---

### User Story 3 - Ir do lançamento até o detalhe da pessoa entregadora (Priority: P3)

A partir de um lançamento da lista (ou de um agrupamento por entregador nos agregados), a
pessoa usuária navega diretamente para o detalhe dessa pessoa entregadora no módulo de
motoristas (entregue na S5), sem precisar sair da tela de faturamento e procurá-la
manualmente lá.

**Why this priority**: É uma conveniência de navegação que depende das duas capacidades
anteriores mas não é essencial ao valor central da fase (consultar e exportar
faturamento) — por isso fica em terceira prioridade, entregável de forma incremental
depois que a consulta e a exportação já funcionam.

**Independent Test**: Pode ser testada isoladamente a partir de um lançamento vinculado a
um entregador conhecido, acionando a navegação e confirmando que o detalhe aberto é o da
pessoa entregadora correta — sem depender de nenhum filtro ou exportação específicos.

**Acceptance Scenarios**:

1. **Given** um lançamento da lista está vinculado a uma pessoa entregadora, **When** a
   pessoa usuária aciona o link a partir desse lançamento, **Then** é levada ao detalhe
   dessa pessoa entregadora especificamente (módulo de motoristas), sem ambiguidade.
2. **Given** um lançamento é agregado/bônus sem entregador, **When** a pessoa usuária o
   vê na lista, **Then** não existe nenhum link de navegação para detalhe de entregador
   nesse lançamento (não há para onde navegar).

---

### Edge Cases

- O que acontece quando o intervalo de datas filtrado abrange um volume muito grande de
  lançamentos (ex.: um ano inteiro de operação)? Os cards de totais e o `resumo` por
  categoria/entregador continuam respondendo dentro de um tempo aceitável (ver Success
  Criteria); se a medição mostrar degradação relevante com esse volume, a decisão sobre
  introduzir pré-cálculo fica registrada como parte desta fase, não implementada por
  antecipação.
- Como o sistema trata um filtro por entregador combinado com a exclusão explícita de
  agregados/bônus (ou vice-versa)? Os dois filtros combinam de forma previsível: agregados
  nunca aparecem quando o filtro exige um entregador específico, e um filtro que pede
  explicitamente só agregados nunca traz lançamentos com entregador.
- O que acontece quando alguém aplica um filtro de datas usando a data de competência,
  mas o mesmo lançamento tem a data de repasse fora desse intervalo? O filtro usa
  exclusivamente a data de competência por padrão (conforme escopo) — a data de repasse
  não interfere no resultado desse filtro.
- Como a exportação se comporta quando o filtro aplicado não retorna nenhum lançamento?
  O arquivo é gerado mesmo assim, contendo apenas o cabeçalho de colunas — não é tratado
  como erro.
- O que acontece se o valor de uma célula exportada já começa com um apóstrofo ou outro
  caractere neutro? Nenhuma neutralização adicional é aplicada — só os caracteres de
  fórmula (`= + - @`) no início da célula disparam o prefixo de proteção.
- Como o sistema se comporta quando a entidade ativa ainda não tem nenhum lançamento de
  faturamento importado (cenário anterior à primeira importação, ou logo após ela)? A
  tela mostra o estado de "período sem dados", nunca um erro.
- O que acontece com um lançamento cujo `recebedor_agregado` está presente mas cuja
  categoria não é reconhecida entre as categorias documentadas do domínio? O lançamento
  aparece normalmente nos totais e na lista — a categoria (`descricao`) é sempre um texto
  livre proveniente da importação, o sistema não recusa nem esconde categorias fora de
  uma lista fechada.

## Requirements

### Functional Requirements

- **FR-001**: O sistema MUST permitir que uma pessoa autorizada visualize uma lista
  paginada de lançamentos de faturamento restrita ao escopo da entidade ativa, com
  paginação calculada e aplicada no lado do sistema.
- **FR-002**: O sistema MUST permitir filtrar a lista e os agregados por intervalo de
  datas (com um padrão de 30 dias quando nenhum intervalo é informado), por categoria de
  lançamento, por entregador específico, por área de atuação (subpraça), e pela presença
  ou ausência de vínculo com um entregador individual (para incluir ou excluir os
  lançamentos agregados/bônus) — isoladamente ou em combinação. O filtro de datas MUST
  usar a data de competência do lançamento como campo padrão, e a interface MUST deixar
  explícito que essa é a data usada (distinguindo-a das demais datas existentes no
  lançamento, que não participam deste filtro). O filtro por subpraça MUST usar o
  atributo de área de atuação próprio do lançamento (já existente no fato desde a fase
  S4/S5, com estrutura de consulta dedicada já entregue) — não derivado do cadastro da
  pessoa entregadora; nenhuma estrutura nova de índice é introduzida por esta fase.
- **FR-003**: O sistema MUST exibir, para o período e filtros aplicados, um resumo
  agregado calculado no sistema (não no cliente) contendo pelo menos: o total geral em
  valor, a categoria de maior valor no período, e o número de entregadores distintos com
  ao menos um lançamento no período. O cálculo de somatórios MUST ser feito preservando a
  precisão decimal do valor monetário original — nenhuma soma de valores monetários MUST
  ser realizada com aritmética de ponto flutuante. Em caso de empate exato no maior valor
  total do período entre duas ou mais categorias, o sistema MUST desempatar
  deterministicamente escolhendo a primeira categoria em ordem alfabética (lexicográfica)
  da `descricao` dentre as empatadas — o card de "categoria de maior valor" MUST sempre
  exibir exatamente uma categoria, nunca múltiplas.
- **FR-004**: O sistema MUST também oferecer um resumo agregável por dia, por categoria e
  por entregador, para o intervalo de datas e demais filtros informados. No agrupamento
  por entregador, todos os lançamentos sem vínculo com entregador individual MUST ser
  consolidados em um único bucket rotulado "agregados/bônus" — não separados por cada
  valor distinto do rótulo de recebedor agregado.
- **FR-005**: Lançamentos agregados/bônus que não pertencem a nenhuma pessoa entregadora
  individual MUST permanecer incluídos nos totais gerais e nos resumos por dia/categoria
  sempre que o filtro não excluir explicitamente a ausência de vínculo — MUST NUNCA ser
  omitidos silenciosamente apenas por não terem entregador associado. Quando exibidos, MUST
  ser identificáveis sob uma rubrica explícita (ex.: "agregados/bônus"), nunca atribuídos
  a um entregador que não é o seu.
- **FR-006**: O sistema MUST permitir exportar em CSV a lista de lançamentos resultante
  dos filtros correntes, com o mesmo conjunto e a mesma contagem de linhas que a lista
  exibida na tela para aquele filtro. A exportação MUST NOT impor teto de linhas ou de
  período nesta fase e MUST ser gerada de forma incremental (streaming), sem carregar o
  conjunto completo de linhas em memória.
- **FR-007**: Toda célula exportada em CSV cujo conteúdo comece com um dos caracteres
  `=`, `+`, `-` ou `@` MUST ser neutralizada com um prefixo que impeça sua interpretação
  como fórmula por um programa de planilha comum, preservando o conteúdo original como
  texto visível.
- **FR-008**: O sistema MUST restringir a visualização da lista de lançamentos à
  permissão de listagem deste módulo, a visualização dos resumos/agregados à permissão de
  visualização deste módulo, e a exportação em CSV à permissão de exportação deste
  módulo — de forma independente entre si. Uma pessoa sem a permissão correspondente MUST
  não ver o controle correspondente na interface (lista, cards de resumo, ou botão de
  exportação, conforme o caso) e MUST receber um erro de acesso negado caso a ação seja
  solicitada diretamente, contornando a interface.
- **FR-009**: Toda consulta (lista, resumo, exportação) MUST ser restrita ao escopo da
  entidade ativa da sessão — um lançamento de outra entidade MUST NUNCA aparecer em
  nenhuma dessas respostas, independente dos filtros aplicados.
- **FR-010**: O sistema MUST permitir navegar, a partir de um lançamento vinculado a uma
  pessoa entregadora, diretamente para o detalhe dessa pessoa entregadora no módulo de
  motoristas. Lançamentos agregados/bônus sem entregador MUST NOT oferecer esse controle
  de navegação (não há detalhe individual para o qual navegar). O controle de navegação
  MUST também ficar oculto quando a pessoa usuária não possui a permissão de visualização
  do módulo de motoristas — seguindo o padrão de permissões vigente do hub (a interface
  oculta o controle; o módulo de destino permanece a autoridade final de acesso).
- **FR-011**: O sistema MUST NOT permitir, por esta fase, nenhuma criação, edição ou
  remoção de lançamento de faturamento — toda a superfície entregue é somente leitura
  sobre os dados já trazidos pela importação (S4); qualquer correção necessária MUST
  continuar entrando exclusivamente por uma nova importação.
- **FR-012**: Quando a consulta de resumo/agregados não retornar nenhum lançamento para o
  filtro aplicado, o sistema MUST comunicar isso como um estado de "período sem dados"
  distinto de um erro — nunca uma tela em branco ou uma falha.
- **FR-013**: Toda tela nova entregue por esta fase MUST preservar a identidade visual
  (incluindo variação por tenant/cliente e os modos claro/escuro) já estabelecida no
  restante do painel.

> **Decisões de infraestrutura**: esta fase não introduz scheduling periódico, rotação de
> chaves de criptografia, refresh de token externo, ou mecanismo de backup novo. Toda a
> superfície é de leitura (consulta e exportação) sobre um fato já persistido por uma fase
> anterior — não há escrita e, portanto, nenhuma chave de idempotência é necessária. A
> única decisão de infraestrutura em aberto é se um mecanismo de pré-cálculo/agregação
> persistida (ex.: uma estrutura de leitura otimizada) se torna necessário para os
> agregados — decisão condicionada à medição descrita no Success Criteria SC-004, MUST ser
> registrada com evidência (tempo medido) independentemente do resultado, e MUST NOT ser
> implementada de forma preventiva antes dessa medição.
> Decisões de infraestrutura: N/A além dos parágrafos acima (feature stateless de leitura,
> sem scheduling, sobre dados já existentes).

### Key Entities

- **Lançamento de Faturamento**: registro individual e imutável de um crédito financeiro
  em um dia de competência, já existente a partir da fase anterior (S4); pode estar
  associado a uma pessoa entregadora específica ou, quando é um bônus/incentivo agregado,
  identificado apenas por um rótulo de recebedor agregado. Carrega uma categoria (texto
  proveniente da origem, sem lista fechada), um valor monetário com precisão decimal
  fixa, e três datas de semânticas distintas — competência (usada como filtro padrão),
  registro do lançamento, e repasse. Esta fase apenas consulta e exporta; nunca cria,
  altera ou remove esse registro.
- **Resumo Agregado do Período**: conjunto de somatórios e contagens calculado sob
  demanda a partir dos lançamentos que atendem a um filtro — não é um registro persistido,
  é sempre recalculado a partir dos dados correntes no momento da consulta.

## Success Criteria

### Measurable Outcomes

- **SC-001**: Para qualquer combinação de filtros testada, o total geral exibido na tela
  bate exatamente (sem arredondamento divergente) com o total calculado diretamente no
  banco para o mesmo filtro.
- **SC-002**: Lançamentos agregados/bônus sem entregador aparecem corretamente incluídos
  nos totais gerais em 100% dos casos testados, sem exceção, quando o filtro não os
  exclui explicitamente.
- **SC-003**: Uma pessoa usuária localiza e confirma o total de um período filtrado
  (intervalo de datas + categoria) em menos de 15 segundos.
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
- **SC-007**: Zero lançamentos de fora da entidade ativa aparecem em qualquer resposta de
  lista, resumo ou exportação, verificado por teste cruzando múltiplas entidades.
- **SC-008**: A tela nova entregue por esta fase preserva a identidade visual (branding
  por cliente e temas claro/escuro) sem regressão perceptível em relação ao restante do
  painel.

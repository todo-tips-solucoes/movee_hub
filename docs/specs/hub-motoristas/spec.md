# Feature Specification: Módulo Motoristas do Hub de Frota

**Feature**: `hub-motoristas`
**Created**: 2026-07-08
**Status**: Draft

> Sessão S5 do plano mestre do Hub de Gestão de Frota (`docs/plans/hub-frota/`). Sobre as
> fundações da S2 (contas, papéis, permissões, entidades, RLS), o shell da S3 (navegação
> por permissão) e o pipeline de importações da S4 (que povoa a dimensão de pessoas
> entregadoras a partir dos arquivos de faturamento e performance), esta fase entrega a
> tela e a API de gestão dessas pessoas dentro do hub: localizar, filtrar, revisar
> indicadores, editar dados básicos, ativar/desativar, e — a capacidade central desta
> fase — associar manualmente cada pessoa entregadora a uma conta de acesso do aplicativo
> do motorista já existente, com sugestões automáticas por semelhança de nome para acelerar
> essa associação sem nunca executá-la sozinha.
>
> Existem duas populações relacionadas mas distintas no sistema: a base de contas de acesso
> do aplicativo do motorista (login/validação de nota fiscal, exclusiva de um grupo
> específico de empresas, povoada por um fluxo de upload legado e preservada nesta fase
> sem nenhuma alteração) e a dimensão de pessoas entregadoras trazida pelos arquivos de
> faturamento/performance (sem identificador fiscal, portanto sem correspondência
> automática confiável com a base de contas). Esta fase entrega o meio de ligar as duas,
> sempre com confirmação humana.
>
> **Não inclui**: qualquer alteração na base de contas de acesso do aplicativo do
> motorista, no fluxo de login desse aplicativo, ou no fluxo legado que povoa essa base a
> partir do envio em massa; cadastro ou gestão de veículos; a importação de arquivos em si
> (entregue pela fase anterior); consulta ou agregados de faturamento/performance (fases
> futuras dedicadas).

## Clarifications

### Session 2026-07-08

- Q: Uma conta de acesso Motorista com cadastro incompleto (sem senha, pré-cadastro) ou
  marcada como inativa é elegível para vínculo, ou só contas ativas e com cadastro
  completo? → A: Qualquer conta do grupo é elegível, independente de situação ou
  completude do cadastro — a elegibilidade é definida SOMENTE pelo critério de grupo.
- Q: As contagens exibidas no resumo do detalhe cobrem todo o histórico de registros
  associados ou apenas uma janela recente? → A: Contagens all-time (todo o histórico); a
  data do registro mais recente já cobre a noção de recência.
- Q: Quando os registros associados a uma pessoa entregadora têm áreas de atuação
  (subpraças) diferentes entre si, qual valor a representa para filtro e exibição no
  detalhe? → A: Todas as áreas distintas são listadas; o filtro por área casa se qualquer
  uma delas corresponder; o detalhe pode destacar a mais recente entre as áreas listadas.
- Q: A lista de sugestões de vínculo por nome deve ter limite fixo ou incluir todos os
  candidatos acima de um limiar de similaridade, sem limite? → A: Top N fixo (entre 5 e
  10, sugestão de 10) ordenado por similaridade decrescente, combinado com um limiar
  mínimo de similaridade abaixo do qual um candidato não é sugerido (evita poluir a lista
  com candidatos irrelevantes só para completar o N).
- Q: Uma edição manual do nome de uma pessoa entregadora deve prevalecer indefinidamente
  mesmo que reimportações futuras (fase de importação) tragam um nome diferente para o
  mesmo identificador externo, ou a reimportação pode sobrescrever a edição manual? → A:
  A edição manual prevalece — o upsert de reimportação nunca sobrescreve um nome editado
  manualmente; o sistema mantém uma marcação (flag/carimbo) de edição manual na pessoa
  entregadora para essa distinção.

## User Scenarios & Testing

### User Story 1 - Localizar e revisar pessoas entregadoras (Priority: P1)

Uma pessoa responsável pela operação abre a tela de motoristas do hub e precisa encontrar
rapidamente uma pessoa entregadora específica, ou entender o panorama geral (quantas estão
ativas, quantas ainda não têm conta de acesso vinculada), usando busca por nome e filtros
(situação ativa/inativa, área de atuação, com ou sem conta vinculada). Ao abrir o detalhe
de uma pessoa, vê um resumo de sua atividade recente.

**Why this priority**: É o valor mínimo e independente desta fase — sem conseguir
encontrar e visualizar as pessoas entregadoras importadas, nenhuma das capacidades
seguintes (editar, vincular) tem como ser utilizada. Também é, sozinha, a evolução mais
direta sobre a tela legada de motoristas hoje existente (que opera sobre outra base e usa
apenas filtros no navegador).

**Independent Test**: Pode ser testada sozinha com os dados já trazidos pela fase anterior
(importação de faturamento/performance): abrir a lista, aplicar cada filtro isoladamente e
em combinação, confirmar que a paginação reflete o total real do lado do sistema (não
apenas o que está carregado na tela), e abrir o detalhe de uma pessoa confirmando que os
indicadores exibidos batem com a contagem de registros associados a ela.

**Acceptance Scenarios**:

1. **Given** existem centenas de pessoas entregadoras importadas para a entidade ativa,
   **When** a pessoa usuária busca por um trecho do nome, **Then** a lista mostra apenas as
   correspondências, com contagem total e páginas calculadas no lado do sistema (não
   limitadas ao que já foi carregado no navegador).
2. **Given** a lista está sendo exibida, **When** a pessoa usuária aplica o filtro "sem
   conta vinculada", **Then** apenas pessoas entregadoras sem vínculo aparecem — cenário
   esperado como maioria dos registros logo após a fase anterior.
3. **Given** uma pessoa entregadora tem registros de faturamento e performance
   associados, **When** a pessoa usuária abre seu detalhe, **Then** vê um resumo com as
   contagens desses registros e a data de atividade mais recente, sem precisar navegar
   para outra tela.
4. **Given** a entidade ativa não tem nenhuma pessoa entregadora com o filtro aplicado,
   **When** a busca ou filtro não retorna resultados, **Then** a tela mostra um estado
   vazio claro (não um erro nem uma lista simplesmente ausente).

---

### User Story 2 - Manter dados básicos e situação de uma pessoa entregadora (Priority: P2)

A partir do detalhe de uma pessoa entregadora, uma pessoa usuária autorizada corrige o
nome (quando a origem trouxe um valor incompleto ou incorreto) e alterna sua situação
entre ativa e inativa — por exemplo, ao saber que a pessoa não trabalha mais na operação.

**Why this priority**: Depende da capacidade de localizar (User Story 1) mas entrega valor
por si só: manter os dados corretos e a situação atualizada é necessário mesmo antes de
qualquer vínculo existir, e afeta diretamente os filtros e listas usados no dia a dia.

**Independent Test**: Pode ser testada isoladamente editando nome e alternando a situação
de uma pessoa entregadora existente e confirmando que a mudança persiste, aparece
imediatamente na lista e nos filtros de situação, e fica registrada na trilha de
auditoria — sem depender de nenhum vínculo com conta de acesso.

**Acceptance Scenarios**:

1. **Given** uma pessoa entregadora está com o nome incompleto, **When** uma pessoa
   usuária autorizada edita o nome e salva, **Then** o novo nome aparece imediatamente na
   lista, no detalhe e em qualquer busca subsequente por esse nome.
2. **Given** uma pessoa entregadora está ativa, **When** uma pessoa usuária autorizada a
   marca como inativa, **Then** ela passa a aparecer no filtro "inativas" e some do
   filtro "ativas", mas seus registros históricos de faturamento/performance permanecem
   intactos e visíveis no detalhe.
3. **Given** uma pessoa sem a permissão de edição está autenticada, **When** ela abre o
   detalhe de uma pessoa entregadora, **Then** não vê nenhum controle de edição de nome ou
   situação na tela.
4. **Given** uma pessoa sem a permissão de edição tenta forçar a alteração diretamente
   (fora da tela, contornando a interface), **When** a tentativa chega ao sistema,
   **Then** é recusada com um erro de acesso negado e nenhuma alteração ocorre.

---

### User Story 3 - Vincular e desvincular pessoa entregadora a uma conta de acesso (Priority: P3)

A partir do detalhe de uma pessoa entregadora sem conta de acesso vinculada, uma pessoa
usuária autorizada vê sugestões de contas de acesso com nome semelhante, escolhe (ou
descarta todas e busca manualmente) a conta correta, e confirma o vínculo. Pode também
desfazer um vínculo existente quando ele foi feito por engano.

**Why this priority**: É a capacidade diferencial desta fase — sem ela, o valor entregue
se resume a uma tela de consulta. Depende de User Story 1 (localizar a pessoa) mas é
testável de forma isolada e representa a maior complexidade de regra de negócio da fase
(a decisão de que a associação nunca é automática).

**Independent Test**: Pode ser testada isoladamente acionando a sugestão de candidatos
para uma pessoa entregadora com nome semelhante a uma conta de acesso existente na mesma
entidade, confirmando manualmente o vínculo, verificando que ele aparece no detalhe de
ambos os lados, e então desfazendo o vínculo e confirmando que ambos os lados voltam ao
estado sem vínculo — sem precisar de nenhuma outra capacidade desta fase.

**Acceptance Scenarios**:

1. **Given** uma pessoa entregadora sem vínculo tem nome igual ou muito parecido ao de uma
   conta de acesso existente e elegível, **When** a pessoa usuária pede sugestões de
   vínculo, **Then** essa conta aparece entre os candidatos apresentados.
2. **Given** uma lista de candidatos sugeridos foi apresentada, **When** a pessoa usuária
   escolhe um candidato e confirma, **Then** o vínculo é criado apenas nesse momento — em
   nenhuma circunstância o sistema cria um vínculo sozinho, mesmo diante de uma
   correspondência exata de nome.
3. **Given** nenhuma sugestão automática é satisfatória, **When** a pessoa usuária busca
   manualmente por uma conta de acesso elegível e a seleciona, **Then** o vínculo é
   criado da mesma forma que via sugestão.
4. **Given** uma pessoa entregadora já está vinculada, **When** a pessoa usuária desfaz o
   vínculo, **Then** a pessoa entregadora volta a aparecer no filtro "sem conta vinculada"
   e a conta de acesso volta a ficar disponível para um novo vínculo (com qualquer pessoa
   entregadora elegível).
5. **Given** a entidade ativa não pertence ao grupo de empresas dono da base de contas de
   acesso do aplicativo do motorista, **When** a pessoa usuária tenta obter sugestões ou
   buscar candidatos, **Then** o sistema responde com uma lista vazia (não um erro) e a
   tela comunica que não há contas elegíveis nesse contexto.
6. **Given** uma pessoa sem a permissão de edição está autenticada, **When** ela abre o
   detalhe de uma pessoa entregadora sem vínculo, **Then** não vê nenhum controle de
   sugestão, busca ou confirmação de vínculo na tela.

---

### Edge Cases

- O que acontece quando uma conta de acesso já está vinculada a outra pessoa entregadora e
  alguém tenta vinculá-la a uma segunda? O sistema deve recusar, informando a qual pessoa
  entregadora ela já está vinculada — uma conta de acesso nunca fica vinculada a mais de
  uma pessoa entregadora ativa simultaneamente.
- Como o sistema trata a busca de nome com acentuação, caixa alta/baixa ou espaçamento
  diferente entre a grafia na origem dos arquivos e a grafia na base de contas de acesso
  (ex.: "José da Silva" vs. "jose da silva")? A busca e a sugestão de candidatos devem
  considerar essas variações equivalentes, sem exigir grafia idêntica.
- O que acontece quando duas pessoas entregadoras diferentes têm nomes idênticos e ambas
  são candidatas plausíveis para a mesma conta de acesso? Ambas aparecem entre as
  sugestões — a escolha final é sempre humana.
- Como o sistema se comporta quando a pessoa usuária tenta vincular uma pessoa entregadora
  de uma entidade a uma conta de acesso fora do escopo permitido (fora do grupo de
  empresas dono da base)? A tentativa é recusada como inválida, mesmo que a conta exista
  no sistema.
- O que acontece com uma pessoa entregadora marcada como inativa que segue tendo registros
  de faturamento/performance recentes? A situação inativa é apenas uma marcação — nenhum
  registro histórico é ocultado, apagado ou reprocessado.
- Como a tela se comporta na primeira utilização desta fase, quando a esmagadora maioria
  das pessoas entregadoras ainda não tem vínculo (estado esperado logo após a importação
  inicial)? A ausência de vínculo é o estado normal — não é tratada como erro nem gera
  aviso incômodo repetido.
- O que acontece quando uma reimportação futura da fase de importação traz um nome
  diferente do atual para o mesmo identificador externo de uma pessoa entregadora cujo
  nome já foi editado manualmente? O upsert de reimportação não sobrescreve o nome — a
  marcação de edição manual prevalece e o nome permanece o definido pela edição humana.
- O que acontece quando os registros associados a uma pessoa entregadora têm mais de uma
  área de atuação (subpraça) distinta? Todas as áreas distintas são consideradas para
  filtro (basta uma corresponder) e listadas no detalhe, sem descartar nenhuma.

## Requirements

### Functional Requirements

- **FR-001**: O sistema MUST permitir que uma pessoa autorizada visualize uma lista
  paginada de pessoas entregadoras restrita ao escopo da entidade ativa, com paginação
  calculada e aplicada no lado do sistema (não apenas sobre os dados já entregues à tela).
- **FR-002**: O sistema MUST permitir filtrar a lista por nome (busca parcial,
  case-insensitive e tolerante a acentuação), situação (ativa/inativa), área de atuação
  (quando disponível nos registros associados), e presença ou ausência de vínculo com
  conta de acesso — isoladamente ou em combinação. Quando os registros associados a uma
  mesma pessoa entregadora têm áreas de atuação (subpraças) distintas entre si, todas
  essas áreas são consideradas para o filtro: uma pessoa entregadora aparece no resultado
  se qualquer uma de suas áreas distintas corresponder ao valor filtrado.
- **FR-003**: O sistema MUST permitir visualizar o detalhe de uma pessoa entregadora
  específica, incluindo um resumo de indicadores (contagens de registros de faturamento e
  de performance associados a ela, cobrindo todo o histórico — all-time, sem janela
  temporal — e a data do registro mais recente, que expressa a noção de recência). Quando
  há mais de uma área de atuação distinta entre os registros associados, o detalhe MUST
  listar todas as áreas distintas, podendo destacar a mais recente entre elas.
- **FR-004**: O sistema MUST permitir que uma pessoa com a permissão adequada edite o nome
  e alterne a situação (ativa/inativa) de uma pessoa entregadora, sem afetar nenhum
  registro histórico de faturamento ou performance já associado a ela. Uma vez que o nome
  de uma pessoa entregadora tenha sido editado manualmente, o sistema MUST marcar essa
  edição (flag/carimbo de edição manual) e MUST preservar esse nome diante de
  reimportações futuras da fase de importação para o mesmo identificador externo — o
  upsert de reimportação MUST NOT sobrescrever um nome marcado como editado manualmente.
- **FR-005**: O sistema MUST restringir toda ação de edição (nome, situação, vínculo,
  desvínculo) à permissão específica de atualização deste módulo — pessoas sem essa
  permissão MUST ver a tela em modo somente-leitura (sem os controles de edição) e MUST
  receber um erro de acesso negado caso a ação seja solicitada diretamente, contornando a
  interface.
- **FR-006**: O sistema MUST permitir vincular uma pessoa entregadora sem vínculo a uma
  conta de acesso elegível do aplicativo do motorista, e MUST permitir desfazer esse
  vínculo a qualquer momento, restaurando ambos os lados ao estado sem vínculo.
- **FR-007**: O sistema MUST oferecer, para uma pessoa entregadora sem vínculo, uma lista
  de contas de acesso candidatas calculada por semelhança de nome normalizado (tolerante a
  acentuação, caixa e variações de espaçamento) entre o nome da pessoa entregadora e o
  nome da conta de acesso. A lista MUST ser limitada a um top N fixo (entre 5 e 10
  candidatos, com 10 como valor sugerido), ordenada por similaridade decrescente, e MUST
  aplicar um limiar mínimo de similaridade abaixo do qual um candidato não é incluído —
  evitando preencher a lista com candidatos irrelevantes apenas para completar o N.
- **FR-008**: O sistema MUST NUNCA criar ou alterar um vínculo automaticamente — mesmo
  diante de uma sugestão com correspondência exata de nome, a criação ou alteração de um
  vínculo MUST sempre exigir uma confirmação explícita de uma pessoa usuária autorizada.
- **FR-009**: O sistema MUST também permitir localizar manualmente uma conta de acesso
  elegível para vínculo (fora da lista de sugestões automáticas), para os casos em que a
  semelhança de nome não é suficiente para gerar uma boa sugestão.
- **FR-010**: O sistema MUST restringir toda conta de acesso elegível para vínculo (seja
  via sugestão, busca manual, ou confirmação) àquelas que pertencem ao mesmo grupo de
  empresas da entidade ativa, usando o mesmo critério de grupo (por associação de
  filiais/matriz, nunca por comparação direta e exclusiva com uma única empresa) já
  aplicado nas demais regras do sistema para essa base de contas. A elegibilidade é
  definida SOMENTE por esse critério de grupo: contas com cadastro incompleto (sem
  credencial definida, pré-cadastro) ou marcadas como inativas permanecem elegíveis para
  vínculo.
- **FR-011**: Para entidades ativas fora desse grupo, o sistema MUST retornar uma lista
  vazia de sugestões e de resultados de busca manual (sem erro), e a tela MUST comunicar
  claramente que não há contas elegíveis nesse contexto — a capacidade de vínculo permanece
  presente na interface, apenas sem candidatos.
- **FR-012**: O sistema MUST impedir que uma mesma conta de acesso fique vinculada a mais
  de uma pessoa entregadora simultaneamente — uma tentativa de vincular uma conta já
  vinculada a outra pessoa entregadora MUST ser recusada, informando a qual pessoa
  entregadora ela já está associada.
- **FR-013**: O sistema MUST permitir vincular diretamente uma pessoa entregadora que já
  possui vínculo a uma nova conta de acesso, substituindo o vínculo anterior em uma única
  ação (sem exigir uma etapa manual prévia de desvínculo).
- **FR-014**: O sistema MUST registrar, na trilha de auditoria, cada criação, substituição
  e remoção de vínculo, cada edição de nome e cada alternância de situação — identificando
  quem realizou a ação e quando.
- **FR-015**: O sistema MUST NOT criar, alterar ou apagar qualquer registro da base de
  contas de acesso do aplicativo do motorista além do próprio campo de vínculo com a
  pessoa entregadora — nenhum outro dado dessa base (identificador fiscal, credencial,
  nome, situação) MUST ser modificado por esta fase.
- **FR-016**: O sistema MUST manter, durante esta fase, o comportamento observável do
  fluxo de login e validação do aplicativo do motorista e do fluxo legado que povoa a base
  de contas de acesso a partir do envio em massa — esta fase não MUST alterar esse
  comportamento.
- **FR-017**: Toda tela nova entregue por esta fase MUST preservar a identidade visual
  (incluindo variação por tenant/cliente e os modos claro/escuro) já estabelecida no
  restante do painel.

> **Decisões de infraestrutura**: esta fase não introduz scheduling periódico, rotação de
> chaves de criptografia, refresh de token externo, mutex entre réplicas, ou mecanismo de
> backup novo. A ação de vínculo/desvínculo é idempotente por natureza (repetir a mesma
> associação, ou desfazer um vínculo já desfeito, não produz efeito adicional nem erro) —
> não há necessidade de uma chave de idempotência dedicada além do identificador da própria
> pessoa entregadora.
> Decisões de infraestrutura: N/A além do parágrafo acima (feature majoritariamente
> stateless sobre dados já existentes, sem scheduling).

### Key Entities

- **Pessoa Entregadora**: indivíduo trazido pelos arquivos de faturamento/performance,
  identificado por um identificador externo consolidado por entidade; possui nome,
  situação (ativa/inativa) e, opcionalmente, um vínculo com uma conta de acesso do
  aplicativo do motorista. Já existe a partir da fase anterior — esta fase adiciona a
  capacidade de gerenciá-la e vinculá-la. Passa a carregar também uma marcação
  (flag/carimbo) de edição manual de nome: quando presente, protege o nome atual contra
  sobrescrita por reimportações futuras da fase de importação para o mesmo identificador
  externo.
- **Conta de Acesso do Aplicativo do Motorista**: registro pré-existente e preservado sem
  alteração nesta fase, usado para login e validação de nota fiscal no aplicativo do
  motorista, exclusivo do grupo de empresas dono dessa base; pode estar associada a, no
  máximo, uma pessoa entregadora por vez.
- **Sugestão de Vínculo**: lista de contas de acesso elegíveis calculada sob demanda por
  semelhança de nome normalizado com uma pessoa entregadora — não é um registro persistido,
  apenas um resultado de consulta apresentado para confirmação humana.

## Success Criteria

### Measurable Outcomes

- **SC-001**: Uma pessoa usuária localiza uma pessoa entregadora específica, entre
  centenas de registros importados, em menos de 15 segundos usando busca e/ou filtros.
- **SC-002**: Listas com milhares de pessoas entregadoras permanecem navegáveis sem
  degradação perceptível de velocidade entre uma página e outra, independente do total de
  registros da entidade.
- **SC-003**: Para pares de nomes idênticos ou quase idênticos entre pessoa entregadora e
  conta de acesso elegível, a conta correta aparece entre as sugestões apresentadas em
  100% dos casos testados.
- **SC-004**: Zero vínculos são criados sem uma ação de confirmação humana explícita,
  verificado por inspeção da trilha de auditoria após uma bateria de testes de sugestão.
- **SC-005**: Uma pessoa usuária completa a jornada completa — localizar, revisar
  indicadores, editar dados, vincular via sugestão e desvincular — inteiramente pelas
  telas desta fase, sem precisar de nenhuma ação fora delas.
- **SC-006**: Uma pessoa usuária sem permissão de edição tem 100% dos controles de edição
  e vínculo ocultos na interface e recebe acesso negado em 100% das tentativas diretas.
- **SC-007**: Zero alterações observáveis na base de contas de acesso do aplicativo do
  motorista (fora do campo de vínculo) e no comportamento do fluxo de login desse
  aplicativo, verificado por comparação antes/depois.
- **SC-008**: Todas as telas novas entregues nesta fase preservam a identidade visual
  (branding por cliente e temas claro/escuro) sem regressão perceptível em relação ao
  restante do painel.

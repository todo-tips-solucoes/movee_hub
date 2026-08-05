# Feature Specification: Refresh de UI/UX do Hub de Frota

**Feature**: `hub-uiux-refresh`
**Created**: 2026-08-05
**Status**: Draft

> Escopo: telas autenticadas do hub de frota (módulos acessados a partir do
> painel do hub). Painel legado e app motorista **não** são tocados por esta
> feature. Referências visuais aprovadas pelo operador ficam anexadas ao
> diretório de discovery da feature (`docs/plans/hub-uiux-refresh/`).
> Busca global na topbar e o toggle Table View / Card View (referência 1)
> **não** entram no escopo desta feature. Screenshots antes/depois de cada
> tela (evidência de revisão) ficam versionados em
> `docs/plans/hub-uiux-refresh/screenshots/`, no branch local da feature.

## Clarifications

### Session 2026-08-05

- Q: A topbar do hub deve ganhar busca global nesta feature? → A: Não
  incluir busca global — apenas o controle de colapso da sidebar e o
  toggle de tema.
- Q: O toggle Table View / Card View da referência 1 entra no escopo? →
  A: Fora de escopo — só o padrão visual (superfícies, indicadores,
  filtros) é extraído da referência, não a alternância de visualização.
- Q: Qual mecanismo de persistência a preferência de colapso da sidebar
  deve usar? → A: localStorage, reaproveitando o padrão do theme-toggle
  existente; o "flash" de estado errado no carregamento é mitigado com
  transição suave em vez de bloqueio de renderização.
- Q: Como validar visualmente telas que a conta QA padrão
  (qa.importacoes@moveelog.local, admin_entidade, empresa 9001) não
  acessa, se houver telas restritas por papel/permissão? → A: Elevar
  temporariamente o papel dessa conta via psql no `hub_homolog_db`
  (dentro da exceção standing hub-*), validar todas as telas e reverter
  o papel ao final.
- Q: Onde os screenshots antes/depois de cada tela devem ser entregues?
  → A: Versionados em `docs/plans/hub-uiux-refresh/screenshots/`, no
  branch local da feature (sem PR automático).

## User Scenarios & Testing

### User Story 1 - Colapsar a barra lateral para ganhar espaço de tela (Priority: P1)

Como usuária que trabalha em telas de dados densos (muitas colunas, listas
longas), quero recolher a barra lateral de navegação para uma versão
compacta (só ícones), para que o conteúdo principal — tabelas e painéis —
ganhe mais largura útil, e quero que essa preferência seja lembrada da
próxima vez que eu entrar.

**Why this priority**: É o ganho de espaço mais direto e visível nas telas
mais densas (ex.: performance, com muitas colunas de tabela); resolve a
queixa mais citada sobre a experiência atual (barra fixa "rouba" espaço
horizontal).

**Independent Test**: Entrar em qualquer tela autenticada do hub em
resolução desktop, acionar o controle de colapso, confirmar que a barra
reduz para a versão compacta (ícones) e o conteúdo principal reflui
ocupando o espaço liberado; recarregar a página e confirmar que o estado
colapsado persiste; expandir de volta e confirmar que os rótulos voltam.

**Acceptance Scenarios**:

1. **Given** a barra lateral está expandida em uma tela desktop, **When**
   a usuária aciona o controle de colapso, **Then** a barra reduz para a
   versão compacta (apenas ícones) com transição suave e o conteúdo
   principal ocupa o espaço liberado.
2. **Given** a barra lateral está colapsada, **When** a usuária passa o
   foco/mouse sobre um item, **Then** o nome do módulo aparece como dica
   (tooltip), sem exigir expansão da barra.
3. **Given** a usuária colapsou a barra numa sessão anterior, **When** ela
   recarrega a página ou navega para outra tela, **Then** a barra
   permanece colapsada (preferência lembrada), sem piscar no estado
   errado durante o carregamento.
4. **Given** a usuária está em um dispositivo móvel (tela estreita),
   **When** ela abre a navegação, **Then** o comportamento atual de menu
   deslizante (drawer) continua idêntico — o colapso é um recurso apenas
   de tela larga.
5. **Given** a barra está colapsada, **When** a usuária navega só por
   teclado, **Then** cada item continua alcançável e identificável (dica
   visível também ao receber foco por teclado, não só ao passar o mouse).

---

### User Story 2 - Alternar entre tema claro e escuro no hub (Priority: P1)

Como usuária do hub, quero alternar entre tema claro e escuro a partir da
barra superior, para que eu possa escolher a aparência mais confortável
para o meu ambiente de trabalho — hoje essa opção existe no painel antigo
mas não no hub.

**Why this priority**: Recurso simples, autocontido, alta visibilidade nas
referências aprovadas; parte da barra superior junto com o controle de
colapso (US1).

**Independent Test**: Entrar em qualquer tela do hub, acionar o controle
de tema na barra superior, confirmar que a aparência muda entre claro e
escuro imediatamente e que a preferência persiste ao navegar/recarregar.

**Acceptance Scenarios**:

1. **Given** o hub está no tema padrão (escuro), **When** a usuária aciona
   o controle de tema, **Then** a interface muda para o tema claro
   instantaneamente, sem recarregar a página.
2. **Given** a usuária escolheu o tema claro, **When** ela navega para
   outra tela do hub ou recarrega, **Then** o tema escolhido permanece.
3. **Given** a empresa da usuária tem cores de marca personalizadas
   (white-label), **When** ela alterna entre claro e escuro, **Then** as
   cores de marca continuam aplicadas corretamente em ambos os temas.
4. **Given** qualquer um dos dois temas, **When** o texto e os elementos
   de interface são avaliados quanto a contraste, **Then** ambos atendem
   ao padrão mínimo de acessibilidade de contraste (texto e elementos não
   textuais).

---

### User Story 3 - Ver as telas com hierarquia visual mais leve (Priority: P2)

Como usuária que passa o dia navegando entre listas, tabelas e painéis do
hub, quero que cartões e tabelas usem separação visual suave (sombra leve,
divisores discretos) em vez de bordas grossas por toda parte, para que eu
consiga focar no conteúdo importante sem cansaço visual e sem a sensação
de "grade pesada".

**Why this priority**: Ganho transversal (aplicado via os elementos
visuais de base) que beneficia todas as telas de uma vez, mas depende de
ajustes mais amplos de estilo do que US1/US2 — value ainda alto, mas
verificado por auditoria visual em vez de uma ação pontual do usuário.

**Independent Test**: Abrir uma tela com tabela (ex.: lista de
performance ou motoristas) e uma tela com cartões (ex.: início/dashboard);
confirmar visualmente e por inspeção de estilo que não há mais
combinação de "cartão com borda grossa contendo tabela com linhas
grossas"; confirmar que os textos permanecem legíveis nos dois temas.

**Acceptance Scenarios**:

1. **Given** uma tela com tabela de dados, **When** a usuária observa as
   linhas, **Then** a separação entre linhas é discreta (não uma borda
   grossa em toda linha) e o cabeçalho se destaca por fundo, não por
   borda pesada.
2. **Given** uma tela com cartões de conteúdo, **When** a usuária observa
   os cartões, **Then** eles se destacam do fundo por sombra suave (não
   por borda grossa), mantendo-se visíveis nos dois temas.
3. **Given** o tema escuro (padrão), **When** qualquer divisor ou borda é
   observado, **Then** ele é discreto o suficiente para não competir
   visualmente com o conteúdo, mas ainda perceptível o bastante para
   separar seções.

---

### User Story 4 - Reconhecer padrões consistentes de indicadores e filtros (Priority: P2)

Como usuária que compara métricas entre diferentes telas do hub (visão
geral, performance, faturamento), quero que os indicadores numéricos
(KPIs) e os filtros de busca sigam sempre o mesmo padrão visual — mesmo
lugar, mesmo destaque, mesma forma de limpar filtros — para que eu não
precise reaprender a interface a cada tela.

**Why this priority**: Reduz a carga cognitiva ao repetir um padrão
reconhecível; depende parcialmente de US3 (superfícies) mas é
observável e testável isoladamente numa única tela.

**Independent Test**: Abrir duas telas distintas que exibam indicadores
numéricos e filtros (ex.: visão geral e uma lista qualquer); confirmar
que o indicador segue o mesmo layout (rótulo, valor, ícone, variação) e
que a área de filtros segue o mesmo padrão (busca + filtros + limpar) nas
duas telas.

**Acceptance Scenarios**:

1. **Given** duas telas diferentes que exibem indicadores numéricos,
   **When** a usuária compara os cartões de indicador, **Then** ambos
   seguem o mesmo padrão visual (rótulo discreto, valor em destaque,
   ícone, indicação opcional de tendência).
2. **Given** uma tela de listagem com busca e filtros, **When** a usuária
   observa a área de filtros, **Then** ela está organizada em um bloco
   visualmente destacado e consistente com as demais listagens.
3. **Given** um indicador de status (badge), **When** exibido em
   qualquer tela, **Then** segue o mesmo padrão visual (cor suave de
   fundo compatível com o significado, texto legível) nos dois temas.

---

### User Story 5 - Ter a mesma experiência refinada em qualquer tela do hub (Priority: P3)

Como usuária que transita entre todos os módulos do hub (visão geral,
performance, faturamento, motoristas, importações, usuários, auditoria,
administração, perfil), quero que o refinamento visual (barra lateral,
tema, superfícies, padrões de indicador/filtro) esteja presente em
**todas** as telas autenticadas, sem exceção, e sem que nenhum
comportamento ou dado mude — só a aparência.

**Why this priority**: É a consolidação/abrangência das stories
anteriores; depende delas estarem prontas, e seu teste é justamente a
cobertura completa, por isso vem por último.

**Independent Test**: Percorrer cada tela autenticada do hub (listagens,
detalhes, formulários, diálogos) e confirmar visualmente que o padrão de
US1–US4 está presente, sem alteração de comportamento funcional (mesmos
dados, mesmas ações, mesmos fluxos de navegação). Para telas restritas a
papéis que a conta QA padrão não possui, o papel dessa conta é elevado
temporariamente (via psql no ambiente isolado do hub) só para o período
da inspeção visual, revertendo ao papel original ao final.

**Acceptance Scenarios**:

1. **Given** qualquer tela autenticada do hub, **When** a usuária a
   visita, **Then** ela reflete o mesmo padrão visual refinado (barra
   lateral colapsável, tema, superfícies suaves, indicadores/filtros
   consistentes).
2. **Given** uma tela com um diálogo ou assistente em etapas (ex.:
   importação, cadastro de credencial), **When** a usuária o abre,
   **Then** o diálogo herda o mesmo padrão visual das telas ao redor,
   sem estilo conflitante isolado.
3. **Given** qualquer tela após o refinamento, **When** comparada à
   versão anterior em termos de dados exibidos e ações disponíveis,
   **Then** não há nenhuma diferença de comportamento ou informação —
   apenas de aparência.

---

### Edge Cases

- O que acontece quando o navegador da usuária bloqueia o armazenamento
  local da preferência (colapso da barra / tema)? O sistema assume o
  estado padrão (barra expandida, tema escuro) sem erro visível e sem
  travar a navegação.
- Como o sistema evita o "flash" de estado errado (barra expandida
  aparecendo antes de colapsar, ou tema errado aparecendo antes de
  trocar) durante o carregamento inicial da página? Não há bloqueio de
  renderização: a leitura do `localStorage` (mesmo padrão do
  theme-toggle) acontece o mais cedo possível e a mudança de estado é
  suavizada por transição, em vez de aparecer de forma abrupta.
- O que acontece em uma tela com tabela muito larga (muitas colunas)
  quando a barra lateral está colapsada? O espaço adicional deve ser
  aproveitado pela tabela; se ainda não couber, a rolagem horizontal
  existente continua funcionando normalmente.
- Como o comportamento muda para uma empresa com cores de marca
  personalizadas (white-label) ao alternar entre os dois temas? As cores
  personalizadas devem continuar refletidas corretamente nos dois temas,
  sem "vazar" a cor padrão do sistema.
- O que acontece quando a usuária tem a preferência do sistema
  operacional configurada para "reduzir movimento"? As transições de
  colapso/expansão de barra e de troca de tema devem respeitar essa
  preferência, reduzindo ou eliminando animação.
- Como o padrão visual se comporta em uma tela de detalhe (ex.: detalhe
  de um motorista ou de uma importação) que hoje tem menos densidade de
  dados que uma listagem? O padrão de superfícies/indicadores se aplica
  igualmente, sem forçar elementos que não fazem sentido no contexto
  (ex.: filtros numa tela sem lista).
- O que acontece com o painel legado e com o aplicativo do motorista
  durante e depois deste refinamento? Ambos permanecem inalterados —
  nenhuma tela, estilo ou comportamento fora do hub é tocado por esta
  feature.

## Requirements

### Functional Requirements

- **FR-001**: O sistema MUST oferecer um controle, visível na barra
  superior, para colapsar e expandir a barra lateral de navegação em
  telas largas (desktop).
- **FR-002**: Quando colapsada, a barra lateral MUST exibir apenas os
  ícones dos módulos, mantendo cada item alcançável e identificável (por
  dica textual ao focar/passar o mouse).
- **FR-003**: A preferência de colapso/expansão da barra MUST ser
  lembrada entre navegações e recarregamentos de página, para a mesma
  usuária/sessão, persistida em `localStorage` reaproveitando o mesmo
  padrão já usado pelo controle de tema (theme-toggle) existente.
- **FR-004**: A transição entre os estados expandido e colapsado da barra
  lateral MUST ser suave (não instantânea/abrupta), respeitando a
  preferência do sistema por movimento reduzido quando ativa.
- **FR-005**: Em telas estreitas (mobile), a navegação MUST continuar
  usando o comportamento atual de menu deslizante, sem alteração.
- **FR-006**: O sistema MUST oferecer um controle, visível na barra
  superior, para alternar entre tema claro e escuro em qualquer tela
  autenticada do hub.
- **FR-007**: A escolha de tema MUST ser lembrada entre navegações e
  recarregamentos de página, para a mesma usuária/sessão.
- **FR-008**: O tema escuro MUST continuar sendo a aparência padrão para
  quem ainda não escolheu explicitamente o tema claro.
- **FR-009**: Cores de marca personalizadas por empresa (white-label)
  MUST continuar sendo aplicadas corretamente em ambos os temas após a
  troca.
- **FR-010**: Em ambos os temas, textos e elementos de interface MUST
  atender aos padrões mínimos reconhecidos de contraste de acessibilidade
  (para texto e para elementos não textuais).
- **FR-011**: Tabelas de dados MUST usar separação discreta entre linhas
  (não uma borda de destaque forte em cada linha), com o cabeçalho
  diferenciado por preenchimento em vez de borda pesada.
- **FR-012**: Cartões de conteúdo MUST se destacar do fundo por
  profundidade (sombra) sutil em vez de borda de contorno forte, em
  ambos os temas.
- **FR-013**: Nenhuma tela MUST combinar cartão com borda de destaque
  forte contendo, dentro dele, uma tabela com linhas de destaque forte
  (dupla ênfase de contorno).
- **FR-014**: O sistema MUST apresentar um padrão único e reutilizável de
  cartão de indicador numérico (rótulo, valor em destaque, ícone e,
  quando aplicável, indicação de tendência), consistente em todas as
  telas que exibem indicadores.
- **FR-015**: O sistema MUST apresentar um padrão único e reutilizável de
  área de busca e filtros (busca, filtros e ação de limpar),
  visualmente destacado do restante do conteúdo, consistente em todas as
  listagens.
- **FR-016**: Indicadores de status (badges) MUST seguir um padrão visual
  único (cor suave associada ao significado + texto legível) em todas as
  telas e em ambos os temas.
- **FR-017**: O refinamento visual (barra lateral colapsável, tema,
  superfícies suaves, padrões de indicador/filtro) MUST estar presente em
  todas as telas autenticadas do hub, incluindo diálogos e assistentes em
  etapas, sem exceção.
- **FR-018**: Nenhuma tela MUST sofrer alteração de comportamento
  funcional, dados exibidos, contratos com o backend ou fluxo de
  navegação em decorrência deste refinamento — a mudança é
  exclusivamente de aparência.
- **FR-019**: A navegação lateral MUST continuar sendo inteiramente
  determinada pelos módulos habilitados para a usuária autenticada (sem
  nenhum item de navegação fixo/estático introduzido pelo recurso de
  colapso).
- **FR-020**: O painel legado e o aplicativo do motorista MUST permanecer
  inalterados por esta feature.

> Decisões de infraestrutura: N/A — feature é puramente de apresentação
> (frontend), sem scheduling, sessões novas, rotação de chaves, refresh
> de token externo, mutex multi-processo ou backup/idempotência
> associados.

### Key Entities

- **Preferência de navegação da usuária**: estado (colapsada/expandida)
  associado à sessão da usuária, usado para restaurar a barra lateral
  entre visitas.
- **Preferência de tema da usuária**: escolha (claro/escuro) associada à
  sessão da usuária, usada para restaurar a aparência entre visitas.

## Success Criteria

### Measurable Outcomes

- **SC-001**: Em uma tela de tabela densa, colapsar a barra lateral libera
  espaço horizontal perceptível para o conteúdo principal (aumento
  mensurável de largura útil disponível para a tabela).
- **SC-002**: 100% das telas autenticadas do hub oferecem o controle de
  tema e refletem a escolha imediatamente, sem necessidade de
  recarregar a página.
- **SC-003**: Em ambos os temas, 100% dos textos e elementos de
  interface avaliados atendem aos padrões mínimos reconhecidos de
  contraste de acessibilidade.
- **SC-004**: Zero telas autenticadas apresentam a combinação "cartão com
  contorno forte + tabela com linhas de contorno forte" após o
  refinamento (auditoria visual tela a tela).
- **SC-005**: 100% das telas com indicadores numéricos usam o mesmo
  padrão de cartão de indicador; 100% das listagens usam o mesmo padrão
  de área de busca/filtros.
- **SC-006**: Empresas com cores de marca personalizadas continuam
  exibindo suas cores corretamente em 100% das combinações de tema
  (claro/escuro) após o refinamento.
- **SC-007**: Zero regressão de comportamento — todas as ações e fluxos
  existentes (navegação, filtros, ações em lote, formulários) continuam
  funcionando exatamente como antes do refinamento.
- **SC-008**: Zero mudança de comportamento observável no painel legado
  ou no aplicativo do motorista, decorrente desta feature.

## Delta Requirements

**Skip**: feature é puramente nova em termos de refinamento visual — não
há corpus canônico ativo em `docs/specs/current/` (diretório inexistente
no momento da criação desta spec) para registrar ADDED/MODIFIED/REMOVED
contra comportamento hoje documentado — agente-00c-feature-orchestrator,
2026-08-05.

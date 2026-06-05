# Feature Specification: Configuração de UI por Tenant (White-label) + Grupo de CNPJs

**Feature**: `config-ui-tenant`
**Created**: 2026-06-05
**Status**: Draft

## Decisões Travadas (não reabrir em clarify)

As decisões abaixo foram acordadas com o usuário antes do pipeline SDD e são tratadas
como resolvidas em todas as fases seguintes:

1. **Marca no AppMotorista**: exibir a marca do TOMADOR do movimento consultado
   (white-label real por movimento). O backend resolve a branding a partir do
   `id_empresa` do movimento, em um GET leve dedicado ao PWA.
2. **Modelo do Grupo**: nova entidade "Grupo" com associação pai→filhos. O usuário do
   CNPJ pai gerencia e visualiza dados dos CNPJs filhos. Revisão intencional do
   Princípio II da constituição (ver §Amendment abaixo).
3. **Escopo UI do MVP**: somente branding (logo, cores, nome de exibição). Sem
   layout-switches nem toggles de funcionalidade.
4. **Pipeline de construção**: SDD completo via cstk.

## Amendment à Constitution — Princípio II (MINOR bump v1.1.0)

O Princípio II atual (v1.0.0) restringe o escopo de dados ao `empresaId` extraído do
token. Esta feature expande intencionalmente esse escopo para suportar grupos de
empresas (holding).

**Redação proposta para Princípio II v1.1.0**:

> **MUST**: toda operação de dados é escopada pelas empresas que o token autenticado
> tem direito de acessar: a empresa própria **e**, quando aplicável, as empresas filhas
> do grupo ao qual ela pertence. O conjunto de empresas elegíveis é resolvido
> server-side por um helper de escopo (`resolveScope(req.user)`), **nunca** por
> identificador enviado pelo cliente. O token do CNPJ pai inclui permissão de grupo;
> tokens de filhos enxergam apenas a própria empresa.

> *Why*: suporte a holdings (um CNPJ pai com vários CNPJs operacionais filhos) é
> requisito de negócio; a expansão preserva o invariante de segurança porque o escopo
> ainda é resolvido exclusivamente a partir do token — nunca do corpo da requisição.

**Sync Impact Report (MINOR)**:
- `docs/constitution.md`: bump de 1.0.0 → 1.1.0, substituir §II.
- `docs/specs/app-motorista-nfse/spec.md`: sem impacto (motorista usa escopo próprio).
- Middleware `authenticateToken`: adicionar `resolveScope`; NENHUMA mudança de
  interface para rotas existentes (filhos continuam vendo apenas a própria empresa).

---

## User Scenarios & Testing

### User Story 1 — Gestão do Grupo de CNPJs (Priority: P1)

Um administrador da holding (usuário do CNPJ pai) acessa o painel e vê,
em uma única visão consolidada, todos os CNPJs filhos do seu grupo. Ele pode
associar um CNPJ filho ao grupo e, a partir desse momento, as operações de
consulta do painel passam a incluir os dados de todos os filhos. A branding
configurada no pai é herdada automaticamente pelos filhos.

**Why this priority**: É o alicerce da feature — sem a entidade Grupo e o middleware
de escopo expandido, as partes B (white-label) e o comportamento de herança de branding
não têm como funcionar. Todas as outras stories dependem desta.

**Independent Test**: Com um usuário de CNPJ pai que possui filhos associados, as
listagens do painel retornam dados de toda a hierarquia; sem filhos, comportamento
idêntico ao atual.

**Acceptance Scenarios**:

1. **Given** um usuário do CNPJ pai autenticado, **When** acessa o painel, **Then**
   vê os dados consolidados de todos os CNPJs filhos associados ao grupo, além dos
   próprios dados.
2. **Given** um usuário de CNPJ filho autenticado, **When** acessa o painel, **Then**
   vê apenas os dados da própria empresa — sem vazamento de dados de outros membros do
   grupo.
3. **Given** um administrador do CNPJ pai, **When** associa um novo CNPJ filho ao
   grupo, **Then** os dados desse filho passam a aparecer na visão consolidada do pai.
4. **Given** um grupo com branding configurada no pai, **When** um filho é consultado
   (pelo pai ou por qualquer superfície do sistema), **Then** a branding exibida é a
   do pai, sem que o filho precise configurar nada separadamente.
5. **Given** a migração de dados existentes da D&G, **When** o administrador acessa
   o painel após a migração, **Then** todos os CNPJs da D&G estão consolidados sob
   um único grupo com o CNPJ principal como pai.

---

### User Story 2 — Configuração de White-label no Painel (Priority: P1)

O administrador de uma empresa (ou grupo) acessa a tela de configurações de
aparência e define a identidade visual do seu tenant: logo, cor primária, cor de
destaque/gradiente e nome de exibição. As mudanças são refletidas imediatamente no
painel EnvioMassa e, quando um motorista abre o AppMotorista para um movimento
associado a esse tenant, vê a mesma identidade visual.

**Why this priority**: Junto com a US1 (Grupo), é o núcleo do valor de negócio —
diferencia o produto para cada cliente. Entrega valor imediato de personalização sem
depender de deploys ou suporte técnico.

**Independent Test**: Após salvar nova branding (logo + cor + nome), recarregar o
painel mostra a identidade atualizada; outro tenant não é afetado.

**Acceptance Scenarios**:

1. **Given** um administrador autenticado, **When** acessa `/dashboard/configuracoes/aparencia`,
   **Then** vê um formulário com os campos: logo (upload), cor primária, cor de
   destaque, nome de exibição — preenchidos com os valores atuais (ou padrão Movee).
2. **Given** o formulário preenchido com novos valores, **When** o administrador salva,
   **Then** o painel exibe imediatamente o novo logo, as novas cores e o novo nome de
   exibição, sem necessidade de recarregar a página manualmente.
3. **Given** um administrador de grupo (CNPJ pai), **When** salva a branding,
   **Then** todos os CNPJs filhos herdam automaticamente a mesma identidade visual,
   sem precisar configurar individualmente.
4. **Given** dois tenants distintos com configurações diferentes, **When** cada um
   acessa o painel, **Then** cada um vê apenas a própria identidade visual, sem
   interferência entre tenants.
5. **Given** um tenant sem logo carregado, **When** acessa o painel, **Then** um
   logotipo padrão (Movee) é exibido como fallback.
6. **Given** upload de um arquivo que não é imagem válida, **When** o administrador
   tenta salvar, **Then** o sistema recusa com mensagem clara em português e não
   persiste a alteração.

---

### User Story 3 — Branding no AppMotorista por Movimento (Priority: P2)

Quando um motorista abre o AppMotorista e visualiza um movimento em aberto, o app
exibe a identidade visual do tomador daquele movimento específico (logo, cor, nome
de exibição). Cada movimento pode potencialmente ter uma marca diferente, refletindo
o tomador real da nota fiscal.

**Why this priority**: Dependente da US2 (branding configurada), mas é o encerramento
do ciclo white-label: a personalização precisa chegar ao ponto de contato com o
motorista para ter valor real de produto. É P2 porque o app atual funciona sem
branding dinâmica.

**Independent Test**: Um motorista com movimento associado ao tenant X vê a branding
de X; com movimento do tenant Y, vê a branding de Y; se o tenant não tem branding
configurada, vê o fallback Movee.

**Acceptance Scenarios**:

1. **Given** um motorista autenticado com movimento em aberto de um tomador com
   branding configurada, **When** abre o painel do movimento, **Then** vê o logo, as
   cores e o nome de exibição desse tomador.
2. **Given** um tomador cujo tenant não tem branding personalizada, **When** o
   motorista visualiza um movimento desse tomador, **Then** vê a identidade padrão
   (Movee) sem erro.
3. **Given** troca de movimento (motorista tem movimento de tenant diferente),
   **When** os dados carregam, **Then** a branding exibida corresponde ao novo tomador.
4. **Given** o backend resolve a branding por `id_empresa` do movimento, **When** a
   consulta de branding falha (tenant sem configuração ou erro de rede), **Then** o
   app degrada graciosamente exibindo a identidade padrão — nunca trava nem exibe
   branding errada.

---

### Edge Cases

- **Grupo sem branding configurada no pai**: todos os filhos exibem o fallback Movee;
  cada filho pode opcionalmente ter configuração própria? (MVP: não — branding é do
  grupo; filho isolado herda padrão Movee).
- **CNPJ filho sem grupo**: comportamento idêntico ao atual (escopo individual);
  não impacta funcionalidades existentes.
- **Mudança de pai do grupo**: branding anterior é substituída; filhos que já tinham
  branding do pai antigo passam a herdar do novo pai na próxima renderização.
- **Upload de logo com tamanho excessivo**: sistema recusa com mensagem de limite e
  não persiste parcialmente.
- **Cor inválida (não é hex válido)**: sistema recusa salvamento e destaca o campo
  em erro.
- **Migração D&G**: se o levantamento de CNPJs da D&G ainda não foi executado pelo
  usuário (docs/sql/dg-levantamento.sql), a migração de vínculo fica bloqueada até a
  resposta do levantamento. Isso é um bloqueio humano documentado.
- **Token de CNPJ filho tentando acessar dados de outro filho**: middleware rejeita;
  filhos só enxergam a própria empresa.

---

## Requirements

### Functional Requirements

**Parte B — Grupo de CNPJs (modelar antes da branding)**

- **FR-001**: O sistema DEVE suportar uma nova entidade Grupo que representa uma
  holding: um conjunto de empresas com um CNPJ pai e zero ou mais CNPJs filhos.
  Um CNPJ filho pertence a no máximo um grupo.
- **FR-002**: O sistema DEVE expor um helper de escopo server-side
  (`resolveScope`) que, dado o token autenticado, retorna o conjunto de
  `empresaId`s que esse usuário tem direito de acessar (própria empresa + filhos, se
  for pai de grupo; apenas própria empresa, caso contrário).
- **FR-003**: O sistema DEVE garantir que tokens de CNPJs filhos enxerguem apenas a
  própria empresa, mesmo que pertençam a um grupo; somente o token do CNPJ pai tem
  escopo expandido.
- **FR-004**: O sistema DEVE disponibilizar endpoints para o CNPJ pai associar e
  desassociar filhos do grupo, com validação de que ambos existem na base e que o
  filho não pertence a outro grupo.
- **FR-005**: O sistema DEVE prover, para fins de migração, um roteiro SQL auditável
  que cria a estrutura do Grupo e popula as associações dos CNPJs da D&G, aplicável
  pelo usuário sem downtime (DDL aditivo). A migração depende de levantamento prévio
  (docs/sql/dg-levantamento.sql).

**Parte A — White-label por tenant**

- **FR-006**: O sistema DEVE armazenar configurações de branding associadas ao Grupo
  (quando existe) ou à Empresa individual (quando não há grupo). Campos obrigatórios:
  logo (referência a arquivo), cor primária (hex), cor de destaque/gradiente (hex),
  nome de exibição.
- **FR-007**: O sistema DEVE servir as configurações de branding via endpoint
  autenticado acessível ao painel (`frontend_v2`) e via endpoint leve acessível ao
  AppMotorista (`frontend_motorista`), dado o `id_empresa` do movimento.
- **FR-008**: O `frontend_v2` DEVE renderizar a tela `/dashboard/configuracoes/aparencia`
  onde o administrador pode visualizar e editar as configurações de branding do seu
  tenant. A tela não existia antes desta feature.
- **FR-009**: O `frontend_v2` DEVE aplicar os tokens de branding (cor primária, cor de
  destaque, logo) ao tema visual do painel assim que as configurações são carregadas —
  sem reinicialização ou recarregamento de página.
- **FR-010**: O `frontend_motorista` DEVE buscar, em cada carregamento de movimento, a
  branding do tomador daquele movimento e aplicar ao tema visual do PWA. A busca deve
  ter timeout definido; em caso de falha ou ausência, aplicar fallback Movee.
- **FR-011**: O upload de logo DEVE ser validado: apenas formatos de imagem (PNG, SVG,
  JPEG), tamanho máximo definido (ex.: 512 KB), recusando arquivos inválidos com
  mensagem clara em português.
- **FR-012**: O sistema DEVE garantir que a branding de um tenant não vaze para outro —
  a resolução de branding respeita o mesmo escopo de isolamento que os dados de negócio.
- **FR-013**: O sistema DEVE aplicar a branding do grupo (pai) nos filhos por herança:
  quando um filho não tem branding própria, usa a do grupo; quando não há grupo, usa o
  padrão Movee.

**Segurança & Operação**

- **FR-014**: Toda mutação de branding (salvar logo, cores, nome) exige autenticação
  válida e pertencimento ao tenant alvo — nunca mutação cruzada entre tenants.
- **FR-015**: Migrações DDL são geradas como arquivos `.sql` para execução manual pelo
  operador, com passo de recarga de schema PostgREST após aplicação.
- **FR-016**: O deploy de cada componente (backend, frontend_v2, frontend_motorista)
  segue o protocolo Docker Swarm aditivo: `service update --image ... --force`. Nenhuma
  alteração pode afetar outros serviços em execução.

### Decisões de Infraestrutura

- **FR-INFRA-LOCK**: O endpoint de associação pai→filho usa transação atômica para
  evitar condição de corrida em ambientes multi-pod (dois filhos sendo associados ao
  mesmo pai simultaneamente).
- **FR-INFRA-IDEMP**: O endpoint de upload de logo é idempotente para o mesmo arquivo
  (baseado em hash do conteúdo): re-envio do mesmo arquivo não cria entrada duplicada.

> **Scheduling, key rotation, token refresh**: N/A — feature stateless em relação a
> schedulers (branding é lida sob demanda); sem criptografia de chaves próprias
> (arquivos de logo persistem em storage); sem refresh de tokens externos.

### Key Entities

- **Grupo**: representa uma holding. Atributos: identificador único, nome do grupo,
  referência ao CNPJ pai (Empresa), lista de CNPJs filhos (Empresa), data de criação.
  Um Grupo tem exatamente um pai e zero ou mais filhos. Um CNPJ filho pertence a no
  máximo um Grupo.

- **Branding**: configuração visual associada a um Grupo (ou, na ausência de grupo,
  a uma Empresa individual). Atributos: referência ao Grupo/Empresa, URL ou referência
  do logo, cor primária (string hex), cor de destaque/gradiente (string hex), nome de
  exibição. Versão única por Grupo/Empresa (upsert — não é histórico).

- **Empresa** (existente, expandida): passa a ter referência opcional ao Grupo ao qual
  pertence como filho, e indicação de se é pai de grupo.

---

## Success Criteria

### Measurable Outcomes

- **SC-001**: Um administrador da holding consegue visualizar e interagir com os dados
  consolidados de todos os CNPJs filhos do grupo em menos de 3 segundos após o login,
  sem precisar alternar entre contas ou fazer configurações manuais.
- **SC-002**: Um administrador consegue salvar uma nova configuração de branding
  (logo + cores + nome) e vê as mudanças refletidas no painel em menos de 5 segundos,
  sem recarregar a página.
- **SC-003**: Um motorista vê a identidade visual correta do tomador do seu movimento
  em menos de 2 segundos adicionais ao tempo normal de carregamento do movimento (a
  busca de branding não pode ser o gargalo perceptível).
- **SC-004**: 100% das operações de leitura de dados de CNPJs filhos por um token de
  filho são bloqueadas — zero vazamentos de dados entre membros de grupos.
- **SC-005**: A migração dos dados da D&G (todos os CNPJs sob um único grupo) é
  concluída sem perda de dados e sem downtime nos serviços existentes, validável por
  consulta de contagem antes/depois.
- **SC-006**: Upload de logo com arquivo inválido (não-imagem ou acima do tamanho
  limite) é recusado em 100% dos casos com mensagem de erro em português.
- **SC-007**: A identidade visual padrão (Movee) é exibida como fallback em 100% dos
  casos onde a branding do tenant está ausente ou a busca falha — nunca erro visual
  ou tela em branco.

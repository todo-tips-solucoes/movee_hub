# Feature Specification: App Motorista (PWA) — Consulta de NF & Validação de XML

**Feature**: `app-motorista-nfse`
**Created**: 2026-06-04
**Status**: Clarified

## Clarifications

### Sessão 2026-06-04

- **Stack**: reaproveitar a stack do `movee_hub` — frontend Next.js + TypeScript +
  Tailwind + PWA (Serwist); backend Express lendo PostgREST; auth JWT em cookie
  httpOnly via proxy `/api/*`; validação intermediada server-side; deploy em Docker +
  Traefik na mesma VPS.
- **Identidade do motorista (FR-002)**: entidade **Motorista** própria, login por
  **CNPJ prestador + senha** (hash bcrypt). Dados escopados por
  `EnvioMassa.cnpj_prestador = <cnpj do token>`.
- **Provisionamento (R-2)**: **auto-cadastro no app** — o motorista cria a própria
  conta (CNPJ prestador + senha + nome). Guard de segurança do MVP: só é permitido
  cadastrar um `cnpj_prestador` que **já exista** na `EnvioMassa` e que ainda não
  tenha conta (evita que um CNPJ desconhecido se registre e veja dados). Sujeito à
  revisão OWASP.
- **Persistência do resultado (FR-010)**: colunas na própria `EnvioMassa` —
  `nota_ok` (boolean) e `erro_validacao` (campos reprovados). O bloqueio de reenvio
  lê desse estado.
- **Portal de emissão (FR-013)**: **NFS-e Nacional** — `https://www.nfse.gov.br`.
- **Seleção de período**: exibir **apenas o movimento aberto atual**
  (`mov_fechado = false`); sem histórico de períodos fechados no MVP.
- **Shape do `xml_input` para `validade_nfse`**: o motorista envia o XML; o backend
  monta `xml_input = JSON.stringify([{ filename, data }])`, onde `data` é o conteúdo
  do XML em texto UTF-8 e `filename` é o nome do arquivo enviado. Demais parâmetros:
  `validar_descricao_servico = false`, `nexus = false`.

## User Scenarios & Testing

### User Story 1 - Login do motorista (Priority: P1)

Um motorista abre o app no celular e faz login com suas credenciais para acessar
os dados do seu pagamento. Sem autenticação, nenhum dado de nota fiscal é visível.

**Why this priority**: É o portão de entrada. Sem autenticação não há como escopar
os dados ao motorista correto nem cumprir o isolamento exigido pela constituição.
É também a base sobre a qual as outras duas stories operam.

**Independent Test**: Com uma credencial válida, o motorista entra e vê a tela
inicial autenticada; com credencial inválida, recebe erro claro e permanece fora.

**Acceptance Scenarios**:

1. **Given** um motorista com credencial válida, **When** informa usuário e senha e
   confirma, **Then** o sistema o autentica e abre o painel de valores.
2. **Given** uma credencial inválida, **When** tenta entrar, **Then** o sistema
   recusa o acesso com mensagem clara em português e não revela qual campo falhou.
3. **Given** um motorista autenticado, **When** fecha e reabre o app dentro da
   validade da sessão, **Then** continua autenticado sem reinformar credenciais.
4. **Given** uma sessão expirada, **When** o motorista tenta uma ação protegida,
   **Then** o sistema o redireciona ao login.
5. **Given** um CNPJ prestador que existe na base e ainda não tem conta, **When** o
   motorista se cadastra (CNPJ + senha + nome), **Then** a conta é criada e ele pode
   logar. **Given** um CNPJ desconhecido ou já cadastrado, **When** tenta cadastrar,
   **Then** o sistema recusa com mensagem clara.

---

### User Story 2 - Consulta do valor da NF do movimento aberto (Priority: P1)

Após autenticar, o motorista vê na tela os dados do **movimento em aberto** (o
período de pagamento corrente, ainda não fechado): o valor a receber, o período de
apuração e os dados fiscais relacionados, para conferir antes de emitir sua NFS-e.

**Why this priority**: É o coração do valor entregue — o motorista precisa saber
quanto e referente a qual período antes de emitir a nota. Entregue sozinha (com o
login), já constitui um MVP útil de consulta.

**Independent Test**: Para um motorista com um movimento aberto, a tela exibe valor,
datas e dados fiscais corretos; para um sem movimento aberto, exibe estado vazio
claro ("nenhum movimento em aberto").

**Acceptance Scenarios**:

1. **Given** um motorista autenticado com um movimento em aberto, **When** abre o
   painel, **Then** vê `valor`, `dt_inicial`, `dt_final`, `nome`, `cnpj_tomador`,
   `cnpj_prestador` e `tribnac` referentes a esse movimento.
2. **Given** um motorista sem nenhum movimento em aberto, **When** abre o painel,
   **Then** vê uma mensagem de estado vazio, sem erro.
3. **Given** falha de rede ao buscar os dados, **When** o painel tenta carregar,
   **Then** o sistema mostra erro amigável e permite tentar novamente, sem travar.

---

### User Story 3 - Upload e validação da NFS-e em XML (Priority: P1)

O motorista, após emitir sua NFS-e, sobe o arquivo XML pelo app e aciona a
validação. O sistema valida a nota e responde: se válida, confirma sucesso e
**bloqueia** novos envios; se inválida, mostra exatamente quais campos estão
errados e orienta o motorista a cancelar a nota e emitir uma nova correta.

**Why this priority**: É o diferencial operacional da feature — fecha o ciclo entre
consultar o valor e comprovar a emissão correta. Depende do login (P1) e ganha
contexto da consulta (P2), mas entrega valor próprio: a validação assistida.

**Independent Test**: Subir um XML reconhecido como válido leva a estado de sucesso
e bloqueio de reenvio; subir um XML com campos inválidos exibe a lista de campos
incorretos com orientação de correção.

**Acceptance Scenarios**:

1. **Given** um motorista autenticado com movimento aberto e sem nota válida ainda,
   **When** sobe um XML e aciona "validar", **Then** o sistema processa a validação
   e retorna o resultado.
2. **Given** um XML cuja validação retorna válido, **When** a validação conclui,
   **Then** o sistema mostra sucesso ("nota ok") e **impede** o envio de outro XML
   para o mesmo movimento.
3. **Given** um XML cuja validação retorna inválido, **When** a validação conclui,
   **Then** o sistema lista em português **quais campos** estão errados e orienta a
   cancelar a nota e emitir uma nova corrigida.
4. **Given** um movimento que já teve uma nota validada como ok, **When** o motorista
   reabre a tela de upload, **Then** o envio aparece bloqueado com indicação de que a
   nota já foi aprovada.
5. **Given** um arquivo que não é um XML válido, **When** o motorista tenta subir,
   **Then** o sistema rejeita com mensagem clara, sem chamar a validação.
6. **Given** indisponibilidade do serviço de validação, **When** o motorista aciona
   "validar", **Then** o sistema informa falha temporária e permite repetir, sem
   marcar a nota como inválida.

---

### User Story 4 - Atalho para o portal oficial de emissão de NF (Priority: P2)

O motorista acessa, com um toque, o site oficial de emissão de nota fiscal para
emitir ou cancelar sua NFS-e, sem precisar procurar a URL manualmente.

**Why this priority**: Conveniência que reduz fricção no fluxo de emissão/correção,
mas não bloqueia o MVP de consulta e validação.

**Independent Test**: Acionar o botão abre o portal oficial correto em nova aba/app
do navegador.

**Acceptance Scenarios**:

1. **Given** o motorista em qualquer tela autenticada, **When** toca no atalho do
   portal de emissão, **Then** o portal oficial abre externamente.

---

### User Story 5 - Instalação como PWA no celular (Priority: P2)

O motorista instala o app na tela inicial do celular e o abre como um aplicativo,
sem barra de navegador, com acesso rápido recorrente.

**Why this priority**: Foi pedido explicitamente ("instalar como PWA") e melhora a
recorrência de uso, mas as funções centrais já operam pelo navegador sem a
instalação.

**Independent Test**: Em um dispositivo compatível, o app oferece a instalação; após
instalar, abre em modo standalone a partir do ícone na tela inicial.

**Acceptance Scenarios**:

1. **Given** o app aberto no navegador de um celular compatível, **When** o motorista
   escolhe instalar, **Then** o app é adicionado à tela inicial e abre em modo
   aplicativo (standalone).

---

### Edge Cases

- Motorista autenticado sem nenhum registro associado (sem vínculo de dados): painel
  mostra estado vazio, não erro.
- Movimento aberto existe mas com campos fiscais ausentes/nulos: exibir o que houver
  e sinalizar claramente o que falta, sem quebrar a tela.
- XML válido em formato mas referente a outro período/valor: a validação externa é a
  autoridade; o app apenas reporta o resultado retornado.
- Dois envios em sequência rápida (duplo toque): o sistema não deve registrar duas
  validações nem permitir reenvio após um "nota ok".
- Resposta da validação em formato inesperado (não-array, vazio, sem `details`): o
  app trata como falha temporária e não corrompe o estado da nota.
- Perda de conexão durante o upload: o envio não é dado como concluído; o motorista
  pode repetir.

## Requirements

### Functional Requirements

- **FR-001**: O sistema MUST exigir autenticação do motorista antes de exibir
  qualquer dado de nota fiscal ou permitir upload.
- **FR-002**: O sistema MUST escopar todos os dados exibidos ao motorista
  autenticado por `cnpj_prestador` extraído do token autenticado, nunca por um
  identificador fornecido pelo cliente. A identidade é uma entidade **Motorista**
  própria (login por CNPJ prestador + senha com hash bcrypt).
- **FR-003**: Os usuários MUST conseguir visualizar, do movimento em aberto
  (`mov_fechado = false`), os campos: `valor`, `dt_inicial`, `dt_final`, `nome`,
  `cnpj_tomador`, `cnpj_prestador` e `tribnac`.
- **FR-004**: O sistema MUST apresentar estado vazio claro quando não houver
  movimento em aberto para o motorista.
- **FR-005**: Os usuários MUST conseguir subir um arquivo XML de NFS-e pelo app.
- **FR-006**: O sistema MUST validar o XML enviado consultando o serviço de
  validação de NFS-e e interpretar a resposta retornada.
- **FR-007**: O sistema MUST, quando a validação indicar nota válida, exibir
  confirmação de sucesso ("nota ok") ao motorista.
- **FR-008**: O sistema MUST, após uma nota ser validada como ok para um movimento,
  **bloquear** o envio de outro XML para o mesmo movimento.
- **FR-009**: O sistema MUST, quando a validação indicar nota inválida, exibir em
  português quais campos estão incorretos e orientar o motorista a cancelar a nota e
  emitir uma nova corrigida.
- **FR-010**: O sistema MUST persistir o resultado da validação (aprovada/reprovada e
  os campos reprovados) de forma que a regra de bloqueio de reenvio sobreviva a
  recarregamentos e novos acessos.
- **FR-011**: O sistema MUST rejeitar arquivos que não sejam XML válido com mensagem
  clara, sem acionar o serviço de validação.
- **FR-012**: O sistema MUST tratar indisponibilidade ou resposta inesperada do
  serviço de validação como falha temporária — permitindo nova tentativa e sem marcar
  a nota como reprovada.
- **FR-013**: O sistema MUST oferecer um atalho que abra o portal oficial de emissão
  de NF (**NFS-e Nacional — `https://www.nfse.gov.br`**) externamente.
- **FR-014**: O sistema MUST ser instalável como PWA no celular (ícone na tela
  inicial, abertura em modo standalone).
- **FR-015**: O sistema MUST nunca expor a integração de validação diretamente ao
  navegador; a chamada ao serviço externo é intermediada pelo lado servidor.
- **FR-016**: O sistema MUST apresentar todas as mensagens de erro ao motorista em
  português, claras e acionáveis, sem vazar detalhes técnicos ou segredos.
- **FR-017**: Os usuários MUST conseguir **criar a própria conta** no app (CNPJ
  prestador + senha + nome). O sistema MUST permitir o cadastro **apenas** para um
  `cnpj_prestador` que já exista na base de movimentos e que ainda não possua conta;
  caso contrário, recusa com mensagem clara. A senha é armazenada com hash bcrypt.

> Decisões de infraestrutura: a feature é majoritariamente stateless no runtime
> (sessão via token, sem scheduler nem rotação de chave própria). Persistência do
> resultado de validação (FR-010) reaproveita a camada de dados existente. Sem jobs
> periódicos, sem key rotation própria, sem locks multi-pod específicos desta feature.

### Key Entities

- **Motorista**: ator que se autentica e cujos dados de pagamento e nota são
  consultados/validados. Vínculo com os registros de movimento a definir (FR-002).
- **Movimento (em aberto)**: período de apuração de pagamento não fechado
  (`mov_fechado = false`), portador do valor a receber, datas e dados fiscais
  (`valor`, `dt_inicial`, `dt_final`, `nome`, `cnpj_tomador`, `cnpj_prestador`,
  `tribnac`).
- **NFS-e (XML do motorista)**: a nota fiscal de serviço emitida pelo motorista,
  submetida como XML para validação.
- **Resultado de Validação**: veredito da validação (aprovada/reprovada) e o conjunto
  de campos reprovados; estado que governa o bloqueio de reenvio (FR-008, FR-010).

## Success Criteria

### Measurable Outcomes

- **SC-001**: Um motorista autenticado consegue ver o valor e o período do seu
  movimento aberto em menos de 5 segundos após abrir o painel, em rede móvel típica.
- **SC-002**: Um motorista consegue subir o XML e obter o veredito de validação
  (ok ou lista de campos errados) em menos de 15 segundos no caminho feliz.
- **SC-003**: 100% das notas validadas como ok ficam efetivamente bloqueadas para
  reenvio — nenhum segundo XML é aceito para o mesmo movimento após aprovação.
- **SC-004**: Para uma nota reprovada, o motorista identifica corretamente, sem ajuda
  externa, quais campos precisa corrigir, em pelo menos 90% dos casos.
- **SC-005**: O app é instalável como aplicativo na tela inicial em dispositivos
  móveis compatíveis (Android/Chrome e iOS/Safari).
- **SC-006**: Nenhum dado de nota de um motorista é acessível por outro motorista ou
  por usuário não autenticado (zero vazamento cross-tenant verificado).

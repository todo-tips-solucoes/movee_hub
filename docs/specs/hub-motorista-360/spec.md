# Feature Specification: Hub Motorista 360

**Feature**: `hub-motorista-360`
**Created**: 2026-09-03
**Status**: Draft

## Clarifications

### Session 2026-09-03

- Q: Qual atributo é usado para vincular automaticamente a credencial criada
  no aplicativo do motorista ao motorista já existente no hub (FR-009)? → A:
  **[CORRIGIDO — ver "Correção 2026-09-04" abaixo]** resposta original:
  CNPJ (`cnpj_prestador`) seria a chave de vínculo `ContaMotorista`↔
  `Entregador` — premissa refutada pelo schema real (`Entregador` não tem
  coluna de CNPJ). O CNPJ segue sendo a chave de `ContaMotorista` (isso
  estava certo); o que mudou é como `ContaMotorista` se liga ao
  `Entregador`.
- Q: De onde vem o identificador (UUID) da EntreGô que cada motorista do hub
  precisa ter associado para a busca funcionar (FR-006)? → A: Já existe hoje
  em `Entregador.id_externo`, populado pelo pipeline de importação
  automática (robô EntreGô) a partir da coluna `id_da_pessoa_entregadora` do
  CSV — a feature reusa esse campo já existente, sem novo mecanismo de
  captura ou cadastro manual.
- Q: A busca de dados na EntreGô (FR-005) fica mesmo restrita a sob demanda,
  um motorista por vez, sem execução em lote ou agendada nesta entrega? → A:
  Confirmado — mantém FR-005 como já assumido, sem novo scheduler.
- Q: O vínculo automático de credencial (US1) e o enriquecimento via EntreGô
  (US2) devem ser aplicados retroativamente a motoristas/credenciais já
  cadastrados hoje, ou só aos cadastros feitos a partir desta entrega? → A:
  Retroativo parcial — (a) o vínculo de credencial (US1) é retroativo: um
  backfill único por `cnpj_prestador` (consulta local, sem chamada externa)
  alcança todos os motoristas/credenciais já cadastrados, incluindo o caso
  relatado (motorista com credencial ativa sem vínculo); (b) o enriquecimento
  via EntreGô (US2) permanece exclusivamente sob demanda por motorista
  (FR-005), sem varredura de massa sobre o passivo retroativo; (c) fica
  adicionado requisito novo, fora do escopo original do briefing — rotina
  semestral de atualização da base já enriquecida, com throttle entre
  motoristas (FR-016).
- Q: Quais perfis de usuário do hub podem visualizar os dados pessoais
  sensíveis trazidos por esta feature (CPF, RG, nome dos pais, contato de
  emergência, e-mail)? → A: Permissão nova e dedicada, concedida somente aos
  perfis `admin_entidade` e `admin_plataforma` — seguindo o padrão granular
  já existente no hub para `motoristas.credencial` (migration 0044); o
  perfil `leitura` continua vendo o motorista, mas não os dados pessoais
  sensíveis.

### Correção 2026-09-04 (pós block-004 / dec-031, dec-032)

A resposta original da primeira pergunta acima estava errada sobre um fato do
sistema: `Entregador` (migration 0010) **não tem coluna de CNPJ** — os campos
são `id, id_empresa, id_externo, nome, motorista_id, ativo, criado_em,
atualizado_em` (confirmado em 0010 e em todos os `ALTER TABLE` da série até
0021). O casamento automático de FR-009/FR-012 é, na verdade, em **dois
passos distintos**:

1. A `ContaMotorista` continua sendo localizada/criada por **CNPJ**
   (`cnpj_prestador`) — isso é verdade hoje e não muda (`POST
   /motorista/register`, `routes/hub-motoristas.js:988`;
   `ContaMotorista.cnpj_prestador NOT NULL UNIQUE`, migration 0021).
2. Qual `Entregador` recebe `motorista_id` = essa conta **não se resolve por
   CNPJ** (a coluna não existe) — é resolvido por **similaridade de nome**,
   reusando o mesmo mecanismo já em produção da RPC
   `hub_motoristas_candidatos` (migration 0023, piso 0.3 para sugestão
   humana), com um limiar mais estrito para o caminho automático: vincula
   somente quando há **exatamente 1** candidato com similaridade **>= 0.9**;
   0 ou 2+ candidatos acima do piso não vinculam automaticamente e caem no
   fluxo manual já existente (`Vincular`, sugestões a 0.3).

Fontes descartadas antes de chegar nessa decisão (operador confirmou, ver
`block-004`): o CSV do robô EntreGô traz `id_da_pessoa_entregadora` (uuid),
sem CNPJ; `FaturamentoLancamento`/`PerformanceTurno` não têm CNPJ; a ponte
`EnvioMassa.entregador_uuid` (migration 0046) existe **somente** no ambiente
isolado de teste (a própria migration declara "nunca chatmasterveloz/
produção") e por isso não é viável em produção; a plataforma EntreGô expõe
CPF do prestador, não CNPJ. Decisão do operador: similaridade de nome com
piso alto, nunca vínculo errado silencioso. Esta correção substitui, em
FR-009, FR-012 e SC-005 abaixo, toda afirmação anterior de casamento
`Entregador`↔`ContaMotorista` por CNPJ.

## User Scenarios & Testing

### User Story 1 - Vínculo automático da credencial de acesso ao motorista do hub (Priority: P1)

Quando um motorista se cadastra no aplicativo do motorista e cria sua credencial de
acesso, o gestor que abre o cadastro desse motorista no hub encontra a credencial já
vinculada — sem precisar clicar manualmente em "Vincular" ou "Criar credencial".

**Why this priority**: hoje o vínculo não acontece (evidência observada: um motorista
com credencial ativa no legado aparece no hub com os dois cards de acesso vazios).
Corrige um comportamento quebrado e é pré-requisito para o hub assumir o papel de
sistema principal quando o envio-massa legado sair do ar.

**Independent Test**: a partir de um motorista já cadastrado no hub e sem conta de
acesso vinculada, simular o cadastro dele no aplicativo do motorista e confirmar que
o card "Conta de acesso vinculada" passa a mostrar a credencial, sem nenhuma ação
manual do gestor.

**Acceptance Scenarios**:

1. **Given** um motorista já cadastrado no hub e sem conta de acesso vinculada,
   **When** ele completa o cadastro/criação de credencial no aplicativo do motorista,
   **Then** o card "Conta de acesso vinculada" do motorista no hub passa a exibir essa
   credencial automaticamente, sem ação do gestor.
2. **Given** um motorista que já tem credencial vinculada (manual ou automaticamente),
   **When** o mesmo fluxo de cadastro no aplicativo do motorista é repetido, **Then**
   o sistema não cria um segundo vínculo nem sobrescreve o vínculo existente.
3. **Given** um cadastro no aplicativo do motorista sem correspondência confiável com
   nenhum motorista do hub, **When** o vínculo automático é tentado, **Then** o
   sistema não vincula silenciosamente a um motorista errado — a credencial fica sem
   vínculo automático e disponível para vínculo manual pelas ações já existentes
   ("Vincular" / "Criar credencial").

---

### User Story 2 - Enriquecimento do cadastro com dados da plataforma EntreGô (Priority: P2)

Um gestor abre o detalhe de um motorista no hub e aciona a busca dos dados desse
motorista na plataforma EntreGô; a tela passa a exibir, além do que já existe hoje,
os dados pessoais, RG, CNH, contato de emergência e informações de entrega trazidos
de lá.

**Why this priority**: entrega o núcleo do pedido de "enriquecer o cadastro", mas
depende de o motorista já ter um identificador válido na EntreGô associado (User
Story 2, FR-006) e não bloqueia a correção do vínculo de credencial (User Story 1).

**Independent Test**: a partir de um motorista do hub com identificador EntreGô já
associado, acionar a busca e confirmar que cada campo das quatro seções aparece
preenchido (ou vazio quando a EntreGô não tiver o dado, como no exemplo observado de
CNH sem preenchimento).

**Acceptance Scenarios**:

1. **Given** um motorista do hub com identificador EntreGô associado, **When** o
   gestor aciona a busca de dados, **Then** a tela de detalhe passa a exibir nome
   completo, data de nascimento, e-mail, CPF, nome da mãe, nome do pai e telefone
   (Dados pessoais); RG e CNH (Documentos); grau de parentesco, nome e telefone do
   contato de emergência; e operador logístico e modal atual (Informações de
   entrega).
2. **Given** um campo que a EntreGô retorna vazio (ex.: CNH não preenchida), **When**
   a busca é concluída, **Then** a tela exibe esse campo como vazio/não informado,
   sem erro.
3. **Given** um motorista sem identificador EntreGô associado, **When** o gestor
   tenta acionar a busca, **Then** o sistema informa que falta associar o
   identificador antes de buscar.
4. **Given** a plataforma EntreGô indisponível ou a sessão de acesso expirada no
   momento da busca, **When** o gestor aciona a busca, **Then** o sistema informa a
   falha de forma clara e não descarta dados já enriquecidos em uma busca anterior.

---

### User Story 3 - CNPJ do legado visível no hub (Priority: P3)

Um gestor abre o detalhe de um motorista no hub e vê o CNPJ que hoje só existe no
cadastro do envio-massa legado.

**Why this priority**: é o menor dos três pedidos e não depende das outras duas
frentes — pode ser entregue e validado isoladamente.

**Independent Test**: a partir de um motorista que já tem CNPJ registrado no legado,
confirmar que o mesmo CNPJ aparece na tela de detalhe do motorista no hub.

**Acceptance Scenarios**:

1. **Given** um motorista com CNPJ já registrado no legado, **When** o gestor abre o
   detalhe desse motorista no hub, **Then** o CNPJ aparece na tela.
2. **Given** um motorista sem CNPJ registrado no legado, **When** o gestor abre o
   detalhe, **Then** o campo aparece como não informado, sem erro.

---

### Edge Cases

- O que acontece quando a plataforma EntreGô está indisponível ou a sessão de acesso
  expira durante uma busca? (FR-007)
- O que acontece quando um motorista não tem identificador EntreGô associado e o
  gestor tenta buscar seus dados? (User Story 2, cenário 3)
- O que acontece quando um campo específico vem vazio na resposta da EntreGô (ex.:
  CNH sem preenchimento)? (User Story 2, cenário 2)
- O que acontece quando o mesmo motorista completa o cadastro no aplicativo do
  motorista mais de uma vez? (FR-011)
- O que acontece quando o cadastro no aplicativo do motorista não encontra
  correspondência confiável com nenhum motorista do hub? (FR-010)
- Como o sistema trata motoristas e credenciais já existentes antes desta entrega?
  O vínculo de credencial alcança o passado via backfill único; o enriquecimento
  via EntreGô permanece só sob demanda, mantido em dia pela rotina semestral.
  (FR-012, FR-016)
- O que acontece quando a rotina semestral de atualização (FR-016) encontra falha
  antibot ou sessão expirada no meio do throttle entre motoristas?

## Requirements

### Functional Requirements

- **FR-001**: Sistema MUST exibir na tela de detalhe do motorista do hub os campos
  de Dados pessoais (nome completo, data de nascimento, e-mail, CPF, nome da mãe,
  nome do pai, telefone) obtidos da plataforma EntreGô.
- **FR-002**: Sistema MUST exibir, da seção Documentos da EntreGô, exclusivamente RG
  e CNH — fotos de documentos ficam fora de escopo desta entrega.
- **FR-003**: Sistema MUST exibir os dados de Contato de emergência (grau de
  parentesco, nome, telefone) obtidos da EntreGô.
- **FR-004**: Sistema MUST exibir as Informações de entrega (operador logístico,
  modal atual) obtidas da EntreGô.
- **FR-005**: Sistema MUST permitir que um usuário autorizado do hub acione, sob
  demanda e por motorista, a busca desses dados na plataforma EntreGô (assumption:
  a busca é por um motorista de cada vez — não há pedido de execução em lote ou
  agendada nesta entrega; ver nota de infraestrutura abaixo). O endpoint/mecanismo
  usado por essa busca sob demanda é o mesmo consumido pela rotina semestral
  (FR-016) e está sujeito à mesma restrição: MUST ser confirmado em
  `docs/plans/robo-entrego/ACHADOS-PORTAL.md` (ou levantado empiricamente e
  documentado lá) antes da implementação — nunca suposto (Constitution VI).
- **FR-006**: Sistema MUST associar a cada motorista do hub um identificador da
  plataforma EntreGô, usado para localizar seus dados nessa busca. Esse
  identificador já é capturado hoje pelo pipeline de importação automática
  (robô EntreGô) em `Entregador.id_externo` — a feature MUST reusar esse
  campo já existente, sem introduzir um novo mecanismo de captura ou
  cadastro manual (a coluna/fonte exata MUST ser confirmada na fase de
  plano contra o código real).
- **FR-007**: Sistema MUST reaproveitar o mecanismo de sessão/autenticação já
  existente com a plataforma EntreGô (o mesmo já usado hoje em produção pela
  importação automática) em vez de implementar um novo, e informar claramente o
  usuário quando a busca falhar por indisponibilidade da plataforma ou sessão
  expirada, sem descartar dados já enriquecidos em uma busca anterior.
- **FR-008**: Sistema MUST exibir na tela de detalhe do motorista o CNPJ hoje
  disponível apenas no cadastro do envio-massa legado, para os motoristas que o
  possuam (a coluna/fonte exata do legado a usar MUST ser confirmada na fase de
  plano contra o código real — nunca suposta).
- **FR-009**: Sistema MUST vincular automaticamente, sem ação manual do gestor, a
  conta de acesso do aplicativo do motorista ao motorista correspondente do hub no
  momento em que o cadastro/credencial é criado no aplicativo, em dois passos: (1)
  localizar/criar a `ContaMotorista` pelo **CNPJ** (`cnpj_prestador`) — mesmo
  atributo já usado hoje como chave dessa conta no fluxo manual existente, e o
  único identificador globalmente único disponível (o identificador EntreGô é
  único apenas por empresa); (2) encontrar o `Entregador` correspondente a essa
  `ContaMotorista` por **similaridade de nome** — `Entregador` não possui coluna
  de CNPJ, então esse casamento nunca é feito por CNPJ. O vínculo só é criado
  automaticamente quando há **exatamente 1 candidato com similaridade de nome
  >= 0.9** ("correspondência confiável"); nos demais casos (0 candidatos, ou 2+
  candidatos acima do limiar) o sistema MUST NOT vincular automaticamente (ver
  FR-010).
- **FR-010**: Sistema MUST manter disponíveis as ações manuais já existentes
  "Vincular" e "Criar credencial" como alternativa para os casos em que o vínculo
  automático (FR-009) não encontra correspondência confiável.
- **FR-011**: Sistema MUST NOT criar um segundo vínculo nem sobrescrever um vínculo
  de credencial já existente ao processar um novo cadastro no aplicativo do
  motorista para o mesmo motorista.
- **FR-012**: Sistema MUST alcançar retroativamente, via backfill único que reaplica
  a mesma lógica de FR-009 (localizar/criar `ContaMotorista` por `cnpj_prestador`,
  depois vincular ao `Entregador` por similaridade de nome com o mesmo critério de
  correspondência confiável), todos os motoristas e credenciais já cadastrados
  antes desta entrega para o vínculo automático de credencial (User Story 1) —
  incluindo o caso já observado de credencial ativa sem vínculo. Casos sem
  correspondência confiável ficam disponíveis para vínculo manual (FR-010), nunca
  vinculados incorretamente em massa. O enriquecimento de dados da EntreGô (User
  Story 2) permanece exclusivamente sob demanda por motorista (FR-005) e MUST
  NOT ser disparado em varredura de massa sobre os cadastros retroativos.
- **FR-013**: Sistema MUST restringir a visualização dos dados pessoais sensíveis
  desta feature (CPF, RG, nome da mãe, nome do pai, e-mail, contato de
  emergência) a uma permissão nova e dedicada, concedida somente aos perfis
  `admin_entidade` e `admin_plataforma` — seguindo o padrão granular já
  existente no hub para `motoristas.credencial` (migration 0044; o
  identificador exato da nova permissão MUST ser confirmado na fase de plano
  contra esse mesmo padrão, nunca suposto). O perfil `leitura` MUST continuar
  vendo o cadastro do motorista, porém sem esses campos sensíveis.
- **FR-014**: Sistema MUST tratar CPF, RG, nome dos pais, contato de emergência e
  e-mail como dados pessoais sensíveis, sujeitos ao controle de acesso resolvido em
  FR-013 e ao mesmo padrão de auditoria já aplicado hoje a ações sobre credencial de
  motorista no hub.
- **FR-015**: Sistema MUST exibir os valores de categorias vindas da EntreGô (ex.:
  grau de parentesco, modal, operador logístico) como recebidos da plataforma, sem
  exigir tradução/rotulagem amigável nesta entrega.
- **FR-016**: Sistema MUST manter uma rotina semestral que atualiza a base de dados
  já enriquecida via EntreGô (User Story 2) para os motoristas com identificador
  associado, com throttle entre motoristas para não disparar navegações
  consecutivas contra o portal. A rotina MUST reusar o mecanismo de agendamento e
  sessão já existente do robô EntreGô (timer systemd gerado por `gerar-timer.sh` a
  partir de `config.json`; sessão persistida em
  `/var/lib/hub_secrets/robo-entrego/entrego-session.json`, chmod 600), sem
  introduzir credencial nova, e MUST reaproveitar o backoff já usado pelo robô
  (1/5/15 min, até 3 tentativas) e a classificação de falha definitiva
  (`ErroAntibotSuspeito` → `ehFalhaDefinitiva`), parando em vez de insistir diante
  de bloqueio do antibot. O endpoint do BFF usado para obter o cadastro da pessoa
  entregadora MUST ser confirmado em `docs/plans/robo-entrego/ACHADOS-PORTAL.md`
  (ou levantado empiricamente e documentado lá) antes da implementação — nunca
  suposto (Constitution VI) — preferindo a via de API via `page.evaluate` sobre os
  XPaths do briefing, que ficam como plano B declarado no plano técnico.
- **FR-017**: Sistema MUST ter uma política de retenção definida e documentada
  para os dados pessoais sensíveis desta feature (FR-014) — CPF, RG, nome dos
  pais, contato de emergência e e-mail, todos de um titular que não é usuário do
  hub. O prazo exato e a base legal aplicável MUST ser confirmados com o
  operador/DPO na fase de plano/tarefas (`[PROPOSTA — confirmar antes de
  execute-task]`; Constitution VI — nenhum prazo é suposto nesta spec). Até essa
  política existir, o sistema MUST NOT expurgar automaticamente os dados
  enriquecidos, para não perder de forma irreversível um dado sem regra de
  descarte definida.
- **FR-018**: Sistema MUST registrar evento de auditoria, pelo mesmo mecanismo já
  usado para as ações de escrita (FR-014), toda vez que um usuário autorizado
  VISUALIZAR os campos pessoais sensíveis (`dadosPessoais`, `documentos.rg`,
  `contatoEmergencia`) de um motorista via `GET /motoristas/:id` — não somente as
  ações que os criam ou atualizam.

> Decisões de infraestrutura: sem credencial nova nem política de rotação de
> chaves nova — a busca de dados na EntreGô sob demanda (FR-005) e a rotina
> semestral de atualização (FR-016) reaproveitam a sessão persistida já
> existente da EntreGô (FR-007) e o mecanismo de agendamento/backoff já usado
> pelo robô EntreGô; a rotina semestral é a única refresh policy periódica
> desta entrega. Idempotência do vínculo automático de credencial está coberta
> por FR-011; o backfill retroativo (FR-012) é execução única, não recorrente.

### Key Entities

- **Motorista (hub)**: passa a carregar, além do que já existe hoje, um
  identificador da plataforma EntreGô, o CNPJ trazido do legado, e os dados
  pessoais/documentos (RG, CNH)/contato de emergência/informações de entrega
  enriquecidos a partir da EntreGô.
- **Conta de acesso do motorista (credencial)**: já existente no hub; passa a poder
  ser vinculada automaticamente a um motorista no momento em que é criada pelo
  cadastro no aplicativo do motorista, além do vínculo manual já suportado hoje.

## Success Criteria

### Measurable Outcomes

- **SC-001**: Um gestor consegue visualizar, na própria tela de detalhe do
  motorista no hub, todos os campos das três frentes (dados da EntreGô, CNPJ do
  legado, vínculo de credencial) sem precisar abrir o envio-massa legado ou a
  plataforma EntreGô separadamente.
- **SC-002**: Motoristas que criam credencial pelo aplicativo do motorista aparecem
  com a conta de acesso já vinculada no hub sem qualquer ação manual do gestor,
  para os casos em que a correspondência é confiável (FR-009/FR-010).
- **SC-003**: Motoristas com CNPJ já registrado no legado passam a exibi-lo na tela
  de detalhe do motorista no hub.
- **SC-004**: Nenhum vínculo de credencial é perdido ou duplicado ao longo de
  cadastros repetidos do mesmo motorista no aplicativo do motorista (zero
  duplicações observadas em teste).
- **SC-005**: Após o backfill único (FR-012), motoristas com credencial ativa e
  correspondência confiável (similaridade de nome >= 0.9, único candidato —
  FR-009) no hub passam a exibir o vínculo, incluindo cadastros já existentes
  antes desta entrega (ex.: o caso relatado).

## Delta Requirements

**Skip**: feature nova; não há corpus `docs/specs/current/` no repositório para
alterar via delta (verificado: diretório inexistente) — agente-00c-feature-orchestrator, 2026-09-03.

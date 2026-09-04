# Research: Hub Motorista 360

Documento produzido no Phase 0 do `/plan`. Toda decisão cita a fonte real
verificada nesta sessão (Constitution VI) — grep de código, migration ou
`docs/plans/robo-entrego/ACHADOS-PORTAL.md`. Onde a fonte não existe, a
decisão fica marcada `[PROPOSTA — a validar na implementação]`.

## Decision 1: Onde roda o vínculo automático de credencial (FR-009)

**Decision**: o vínculo automático roda **dentro do handler existente**
`POST /motorista/register` (`app_homologacao/backend/routes/motorista.js:372`),
imediatamente após o `PATCH` que ativa o pré-cadastro na tabela legada
`Motorista` (linhas 411-421: `senha`, `nome`, `ativo=true`). Ao final desse
PATCH ter sucesso, o handler chama, no mesmo processo, o helper
`hubPostgrestRequest()` (`lib/hub-postgrest.js`) para localizar/criar o
`ContaMotorista` por `cnpj_prestador` e vincular o `Entregador` correspondente
(mesma lógica hoje replicada manualmente em
`routes/hub-motoristas.js:943` `POST /:id/credencial`, mas disparada
automaticamente em vez de por ação do gestor).

**Rationale**: confirmado nesta sessão que o backend legado
(`server.js:203`, `POSTGREST_URL`) e o helper do hub
(`lib/hub-postgrest.js:54`, mesmo `process.env.POSTGREST_URL`) apontam para
**a mesma instância PostgREST** — é o mesmo processo Node servindo os dois
produtos (CLAUDE.md: "hub em produção vive dentro do `chatmasterveloz`").
Uma chamada in-process ao helper do hub não é "integração de rede nova",
é uma chamada de função dentro do mesmo request — sem lag, sem infra nova,
satisfaz SC-002 ("sem qualquer ação manual do gestor").

**Alternatives considered**:
- *Job cron de polling* (varrer `Motorista` periodicamente por `senha`
  recém-preenchida): adiciona lag (motorista vê "sem vínculo" por minutos)
  e um scheduler novo sem necessidade — rejeitado, o hook in-process é mais
  simples e mais correto.
- *Webhook/evento assíncrono*: exigiria um broker novo (o projeto não tem
  fila de mensagens); over-engineering para uma escrita adicional de ~3
  chamadas HTTP internas ao mesmo PostgREST.

## Decision 2: Chave de vínculo é CNPJ (`cnpj_prestador`) — já ratificado — escopo corrigido por Decision 12

**Decision**: reusar a decisão já registrada no `clarify` (dec-009,
spec FR-009): `cnpj_prestador` é a chave — global e única em
`ContaMotorista.cnpj_prestador` (migration 0021) e em `Motorista.cnpj_prestador`
(base legada). Nenhuma decisão nova aqui; apenas fixado como Phase 0 porque
todos os outros designs deste plano dependem dela.

**Rationale**: `Entregador.id_externo` (UUID EntreGô) só é único por empresa
(`UNIQUE (id_empresa, id_externo)`, migration 0010) — inadequado como chave
de vínculo automático cross-tenant.

**Alternatives considered**: nenhuma nova — ver dec-009.

**Escopo corrigido (2026-09-04, block-004/Decision 12)**: esta Decision cobre
apenas a chave de `ContaMotorista` — isso permanece verdadeiro. O que esta
Decision **não** cobre, e a redação original não deixava claro, é como
`ContaMotorista` se liga ao `Entregador`: `Entregador` não tem coluna de CNPJ,
então esse segundo passo é por similaridade de nome, não por CNPJ. Ver
Decision 12 para o mecanismo completo.

## Decision 3: FR-008 (CNPJ do legado) não exige coluna nova

**Decision**: o CNPJ a exibir na tela de detalhe é
`ContaMotorista.cnpj_prestador`, já populado no momento do vínculo (manual,
automático FR-009, ou backfill FR-012). `buscarDetalheMotorista()`
(`routes/hub-motoristas.js:460`) passa a incluir esse campo no DTO quando
`Entregador.motorista_id` está preenchido; quando não está, o campo retorna
vazio (Acceptance Scenario 2 da User Story 3 — "sem erro").

**Rationale**: `ContaMotorista.cnpj_prestador` já É o CNPJ do legado —
gravado ali no momento da criação da credencial (ver
`routes/hub-motoristas.js:1024`, `cnpj_prestador: cnpjPrestador`, copiado do
corpo da requisição, que por sua vez vem do CNPJ digitado/casado no legado).
Nenhuma nova migração, nenhum novo join com `chatmasterveloz.Motorista` fora
do já existente é necessário — evita reintroduzir uma dependência de rede
que a migration 0021 deliberadamente evitou ("nunca por sincronização ao
vivo com Motorista", ver Decision 4 abaixo para o escopo exato dessa nota).

**Alternatives considered**: buscar `Motorista.cnpj_prestador` diretamente
via nova chamada PostgREST à mesma instância a cada `GET /:id` — funciona,
mas é uma chamada extra por request sem necessidade, já que o dado já está
espelhado em `ContaMotorista` no momento do vínculo.

## Decision 4: Nota de arquitetura sobre migration 0021 e "sem sincronização ao vivo"

**Decision**: o comentário em `infra/hub/migrations/0021_conta_motorista.sql`
("ContaMotorista é populada por seed determinístico... nunca por
sincronização ao vivo com Motorista em chatmasterveloz — nenhuma integração
de rede com produção") descreve o design da feature anterior
(`hub-motorista-canonico`) para o ambiente **isolado** `hub-homolog`, que
não tem acesso de rede a `chatmasterveloz` por desenho (banco próprio
`hub_homolog_db`). Essa restrição **não se aplica** à produção, onde hub e
legado compartilham a mesma instância PostgREST/banco (comprovado nesta
sessão, Decision 1). Registrar aqui explicitamente para não ser lido, no
futuro, como uma proibição arquitetural universal — é um invariante do
ambiente de teste isolado, não da produção.

**Rationale**: Constitution VI (veracidade) — a citação existe no código, a
interpretação do escopo dela precisa ficar auditável em vez de assumida.

**Alternatives considered**: N/A (nota de esclarecimento, não uma escolha
de design).

## Decision 5: Backfill retroativo (FR-012, US1) é script único, não rotina agendada

**Decision**: o backfill é um **script one-off idempotente**
(`infra/hub/scripts/` ou `scripts/` do backend, TBD em `create-tasks`) que
varre `Motorista` (legado) `WHERE senha IS NOT NULL`, casa por
`cnpj_prestador` com `ContaMotorista` (cria se ausente) e vincula
`Entregador.motorista_id` (mesma lógica do Decision 1), reaproveitando a
mesma função extraída do hook automático — não um segundo mecanismo. Roda
**uma vez**, sob operação do operador (rito de produção, CLAUDE.md — esta
pipeline nunca escreve em produção).

**Rationale**: resposta do operador (block-001): "backfill único... alcança
TODOS os motoristas/credenciais já cadastrados". É execução única, distinta
da rotina semestral (FR-016, que é sobre o enriquecimento EntreGô, não sobre
vínculo de credencial).

**Alternatives considered**: reusar `POST /:id/credencial` em loop via HTTP
— rejeitado, exige resolver o `id` do `Entregador` previamente e reintroduz
overhead de rede desnecessário; a função compartilhada chamada diretamente é
mais simples (ladder rung 7 mínimo, mesma lógica, sem HTTP de loopback).

## Decision 6: Raspagem EntreGô (FR-001..FR-007, FR-016) roda em `infra/robo-entrego/`, não no backend Express

**Decision**: tanto a busca sob demanda (FR-005) quanto a rotina semestral
(FR-016) rodam como processo(s) Node **separados**, dentro de
`infra/robo-entrego/` — não como código novo em
`app_homologacao/backend/`.

**Rationale**: confirmado por grep que `playwright` é dependência de
`infra/robo-entrego/package.json` (não de
`app_homologacao/backend/package.json`) — o processo Express web não tem
Playwright instalado e não deve ganhá-lo (processo request/response não é o
lugar certo para automação de browser de segundos/minutos). `infra/robo-entrego/`
já resolve login+sessão+antibot+backoff (`entrego-portal.js`,
`taxonomia-erro.js`, `index.js:35`) e já se autentica no hub via
`hub-client.js` com um usuário de serviço dedicado
(`robo_entrego_servico`, `infra/robo-entrego/sql/001-usuario-servico-robo-entrego.sql`)
— reusar essa base é a via de menor esforço e maior consistência (ladder
rung 2: já existe no projeto).

**Alternatives considered**: subir Playwright no processo Express —
rejeitado (nova dependência pesada no processo web, quebra o modelo
request/response rápido, foge do padrão já estabelecido). Novo
microsserviço HTTP dedicado com Playwright residente — rejeitado por ora
(mais um serviço para operar 24/7 quando um processo sob demanda/timer já
resolve; ver Decision 7).

## Decision 7: "Sob demanda" (FR-005) via fila curta + timer frequente, não HTTP síncrono

**Decision**: o gestor aciona a busca clicando um botão no hub (endpoint novo
`POST /motoristas/:id/entrego-enriquecimento`, `[PROPOSTA]`), que apenas
GRAVA um pedido pendente (timestamp em `Entregador.dados_entrego_solicitado_em`
— ver `data-model.md`) e responde 202 imediatamente. Um novo par
timer+script em `infra/robo-entrego/` (`enriquecimento-entrego.timer`,
intervalo curto — ex.: a cada 5 min, `[PROPOSTA — ajustar em create-tasks]`)
consome os pedidos pendentes, um motorista por vez, com o mesmo
backoff/antibot já usado pelo robô de importação, e grava o resultado de
volta via `hub-client.js`.

**Rationale**: mesmo padrão de fila+poll já usado no projeto para o pipeline
de importações (`lib/hub-import-processor.js`, "fire-and-forget... se o
volume exigir fila, um worker chamaria a mesma função sem mudar nada
abaixo") — reuso de convenção existente em vez de inventar um mecanismo de
resposta síncrona. Latência de poucos minutos é aceitável: a spec não pede
tempo real, só "sob demanda... um motorista por vez" (FR-005, já
clarificado).

**Alternatives considered**: chamada HTTP síncrona do backend Express
diretamente ao portal EntreGô dentro da mesma request do gestor — rejeitado
por Decision 6 (sem Playwright no processo web) e por travar a request por
segundos/minutos sujeitos a antibot.

## Decision 8: Rotina semestral (FR-016) reusa o mesmo script/mecanismo do Decision 7

**Decision**: um segundo `OnCalendar` (`[PROPOSTA]`, ex.: `*-01,07-01
00:00:00 America/Sao_Paulo` — duas vezes ao ano) dispara o MESMO script de
enriquecimento em modo "semestral": em vez de consumir a fila de pedidos
sob demanda, seleciona todo `Entregador` com
`dados_entrego_enriquecidos_em IS NOT NULL AND < now() - interval '6
months'`, e os processa com o MESMO throttle/backoff/antibot (reaproveita
`BACKOFF_MS_SEQUENCIA` de `infra/robo-entrego/src/index.js:35` e
`ErroAntibotSuspeito → ehFalhaDefinitiva` de `taxonomia-erro.js:78`, que já
para em vez de insistir).

**Rationale**: resposta do operador (block-001) pede throttle entre
motoristas e reuso explícito do mecanismo já existente — nenhuma sessão ou
credencial nova, mesmo timer generator (`scripts/gerar-timer.sh` a partir de
`config.json`, hoje `{"horarios": ["11:00","13:00","14:00"]}`).

**Alternatives considered**: script totalmente separado sem reuso de
código — rejeitado, duplicaria a lógica de sessão/antibot/backoff que já
existe e já é testada.

## Decision 9: Endpoint do BFF para "dados da pessoa entregadora" — sem fonte, marcado `[PROPOSTA]`

**Decision**: `docs/plans/robo-entrego/ACHADOS-PORTAL.md` (fonte única de
endpoints do portal, citada em `entrego-portal.js:3-4`) documenta apenas 3
áreas: login (§7), geração de relatório (§3,
`GET .../operation/logistics-operator/reports/{TIPO}/urls`) e a ponta de
destino (§8). **Nenhum endpoint para dados de cadastro do motorista está
documentado.** Portanto o contrato de dados (`contracts/entrego-dados-pessoa.md`)
fica `[PROPOSTA — a validar na implementação]`, com os 6 XPaths do operador
(`docs/plans/hub-motorista-360/BRIEFING-INPUT.md` linhas 41-48) como
fallback de UI declarado. A tarefa de implementação MUST levantar o
endpoint real (inspecionar Network tab durante a navegação dos 6 passos,
dentro de `page.evaluate()` como já é o padrão) e documentá-lo em
`ACHADOS-PORTAL.md` **antes** de codificar a via de API — nunca supor
nome de rota/campo (Constitution VI).

**Rationale**: Princípio VI (Zero Fabricação) é INEGOCIÁVEL — inventar um
endpoint que não foi visto seria fabricar dado factual de sistema externo.

**Alternatives considered**: assumir que o endpoint segue o padrão REST dos
outros 2 documentados (ex.: `/operation/logistics-operator/drivers/{uuid}`)
— rejeitado explicitamente; é uma hipótese razoável para a implementação
testar primeiro, mas não pode ser afirmada como fato no plano.

## Decision 10: RBAC — nova permissão `motoristas.dados_sensiveis` (nome proposto)

**Decision**: nova permissão granular `motoristas.dados_sensiveis`
(`[PROPOSTA]` — nome segue a convenção `<módulo>.<capacidade>` já usada por
`motoristas.credencial`/`motoristas.editar`/`motoristas.consultar`),
concedida via seed SQL no mesmo padrão exato de
`infra/hub/migrations/0044_seed_permissao_motoristas_credencial.sql`
(`INSERT INTO "Permissao"(codigo, modulo_id) ... INSERT INTO
"PapelPermissao"` para os papéis `admin_plataforma`/`admin_entidade`
apenas). A rota `GET /motoristas/:id` continua exigindo só
`motoristas.consultar` (nível de rota, `requirePermission`,
`middleware/hub-require-permission.js`) — a nova permissão gate campos
DENTRO do DTO: `buscarDetalheMotorista()` chama
`obterPermissoesEfetivas(usuarioId)` (já cacheado por
`lib/hub-rbac-cache.js`, mesmo helper que o middleware usa) e omite CPF,
RG, nome da mãe, nome do pai, e-mail e contato de emergência quando a
permissão está ausente.

**Rationale**: FR-013 exige que `leitura` continue vendo o motorista (não
pode bloquear a rota inteira) mas sem os campos sensíveis — isso é máscara
de campo, não gate de rota. `obterPermissoesEfetivas` já existe e já é
cacheado; reusar em vez de introduzir mecanismo de RBAC novo.

**Alternatives considered**: dois endpoints (`GET /:id` básico +
`GET /:id/dados-sensiveis` separado) — mais RESTful, mas rejeitado: exigiria
2 requisições do frontend para montar uma única tela de detalhe, contra o
padrão já estabelecido de um único payload por tela.

## Decision 11: Grant do papel de serviço `robo_entrego_servico` para as novas rotas de fila

**Decision**: as novas rotas em `routes/hub-robo-entrego.js` (consumo/escrita
da fila de enriquecimento) exigem permissões novas
`[PROPOSTA]` (ex.: `motoristas.enriquecimento.consultar` /
`motoristas.enriquecimento.atualizar`), concedidas ao papel já existente
`robo_entrego_servico` via um script SQL avulso adicional (mesmo padrão de
`infra/robo-entrego/sql/001-usuario-servico-robo-entrego.sql` — **artefato
para o operador aplicar manualmente**, nunca executado por esta pipeline
contra o banco vivo, CLAUDE.md rito de produção).

**Rationale**: least privilege já é o padrão estabelecido (comentário do
001: "não o papel `operador` existente... escopo maior do que este robô
precisa"); a mesma disciplina se aplica às novas capacidades.

**Alternatives considered**: reusar `importacoes.criar` para as novas rotas
— rejeitado, mistura domínios (auditoria de importação vs. dados de
motorista), quebra o princípio de permissão granular já em uso no projeto.

## Decision 12: correção — `Entregador` não tem coluna de CNPJ; casamento automático é por similaridade de nome (RPC nova, simétrica à 0023)

**Decision**: `Entregador` (migration 0010) **não tem** coluna de CNPJ —
campos são `id_empresa, id_externo (uuid), nome, motorista_id`. O casamento
automático de FR-009/FR-012 (a partir de um `cnpj_prestador` recém-ativado
no legado) não pode ser um `SELECT ... WHERE cnpj = ...` direto em
`Entregador`. O mecanismo de casamento **já existente** no hub para este
par de identidades é por **similaridade de nome**: a RPC
`hub_motoristas_candidatos(p_entregador_id)`
(`infra/hub/migrations/0023_motoristas_rpc_candidatos.sql`) — parte de um
`Entregador` e retorna candidatos `ContaMotorista` por
`similarity(hub_normaliza_nome(...))` >= 0.3, escopado a
`EmpresaGrupoMovee`. Essa RPC vai na direção **oposta** à que o hook
automático precisa (ele parte de um `ContaMotorista`/CNPJ recém-ativado e
precisa achar `Entregador` candidatos). Proposta: nova função SQL simétrica
`hub_motoristas_candidatos_por_conta(p_conta_motorista_id int)`
`[PROPOSTA]`, mesmo padrão exato (SECURITY INVOKER, `hub_normaliza_nome`,
join `EmpresaGrupoMovee`, `pg_trgm`), retornando `Entregador` candidatos por
similaridade de nome com `ContaMotorista.nome`.

**Threshold do vínculo AUTOMÁTICO é mais estrito que o das "sugestões"
manuais**: 0.3 (usado hoje só para *sugerir* candidatos a um humano
escolher, `GET /:id/sugestoes`) é permissivo demais para vincular sem
revisão. Proposta `[PROPOSTA — confirmar em create-tasks]`: só vincula
automaticamente quando há **exatamente 1** candidato com
`similaridade >= 0.9` (quase-exato após normalização); qualquer outro caso
(0 candidatos, múltiplos acima do limiar, ou único candidato abaixo de 0.9)
**não vincula** — fica para `Vincular`/`Criar credencial` manuais, que já
usam a RPC de 0.3 para sugerir. Isso satisfaz literalmente o Acceptance
Scenario 3 da User Story 1 ("não vincula silenciosamente a um motorista
errado").

**Rationale**: reusa 100% do mecanismo de normalização/similaridade/RLS já
testado em produção (migration 0023) em vez de inventar um novo critério de
matching; threshold mais alto para o caminho SEM revisão humana é
justificado pelo próprio texto da spec (FR-010: ação manual continua
disponível como rede de segurança).

**Alternatives considered**: usar o `nome` como chave direta
(`WHERE nome = ...`) — descartado, nomes têm variação de grafia/acentuação
(por isso a RPC existente já usa `similarity`+`unaccent`+`lower`, não
igualdade). Rebaixar o limiar de 0.3 para o caso automático — descartado,
inverteria a lógica: 0.3 é o piso para SUGERIR a um humano decidir, não
para decidir sozinho.

**Correção retroativa**: `contracts/vinculo-automatico.md` foi escrito
citando "correspondência de nome/CNPJ" de forma imprecisa antes desta
Decision existir — o contrato foi atualizado no mesmo commit para refletir
apenas nome (via a RPC nova), nunca CNPJ, como o mecanismo de casamento.

## Technical Context — resolvido

Nenhum `NEEDS CLARIFICATION` restante no Technical Context (ver `plan.md`);
todos os campos foram inferidos do projeto real (`package.json`,
`Dockerfile.hub`, `CLAUDE.md`).

# Research: Envio em Massa como Módulo do Hub

Documento produzido no Phase 0 do `/plan`. Resolve os `NEEDS CLARIFICATION` do
Technical Context e registra as decisões de desenho necessárias para uma feature
de **re-hospedagem** (não reescrita) de um fluxo legado dentro do shell do hub.

Contexto de código lido nesta pesquisa: `app_homologacao/backend/server.js` (rotas
legadas + `authenticateToken` + `resolveEmpresaAlvo`/`mesmoGrupoQue` em
`routes/grupo.js`), `app_homologacao/backend/routes/hub-auth.js` +
`routes/hub-me.js` (auth/token do hub), `middleware/hub-require-permission.js`,
`lib/hub-rbac-cache.js`, `lib/hub-postgrest.js`, `infra/hub/migrations/0007` (seed
de módulos/permissões/papéis) e `0011` (schema `ImportacaoArquivo`),
`app_homologacao/frontend_v2/app/hub/layout.tsx` +
`components/hub/session-guard.tsx` + `app/selecionar-entidade/page.tsx` +
`lib/hub/module-nav.ts`.

## Decision 1: Convivência de dois formatos de JWT no MESMO cookie `accessToken`

**Decision**: o backend legado (`authenticateToken`, `server.js:224`) e o backend
do hub (`decodificarAccessToken`, `routes/hub-me.js`) já assinam/verificam com o
**mesmo segredo** (`process.env.JWT_SECRET`) e o **mesmo nome de cookie**
(`accessToken`, `httpOnly`). Isso é uma coincidência estrutural favorável: uma
sessão de navegador está OU no modo legado (payload `{empresaId, id_grupo,
is_grupo_pai, ...}`, emitido por `POST /login`) OU no modo hub (payload `{sub,
email, entidade_ativa}`, emitido por `POST /api/v1/hub/auth/login` e reemitido
por `POST /api/v1/me/entidade`) — nunca os dois ao mesmo tempo, porque é o mesmo
cookie. `authenticateToken` já faz `jwt.verify` sem checar o *shape* do payload —
portanto **continua funcionando sem alteração** para AMBOS os formatos (o
`jwt.verify` apenas confirma a assinatura); o que falta é uma camada que, quando
o payload é do formato hub, o traduza para o formato que o código legado
downstream (`resolveEmpresaAlvo`, `postgrestRequest(...id_empresa=eq.<n>)`)
espera.

**Rationale**: satisfaz FR-002 (sem segundo login) e FR-018 (zero alteração para
quem ainda usa o painel legado) com o menor diff possível — nenhuma mudança em
`authenticateToken` nem no formato do token legado; a tradução acontece em UM
middleware novo, inserido na cadeia de cada rota tocada.

**Alternatives considered**: (a) unificar os dois formatos de token num único
schema — rejeitado, viola FR-018 (obrigaria reemitir token de todo usuário
legado ativo) e o próprio escopo da feature ("não inclui... mudar o roteamento");
(b) cookie de nome diferente para o hub — mais seguro em teoria, mas contradiz a
premissa do briefing ("zero mudança na validação legada") e criaria uma
bifurcação de infraestrutura de cookies não pedida por nenhum FR.

## Decision 2: Adaptador de claims (`hubEnvioMassaClaimsBridge`) — contrato exato

**Decision**: novo middleware `middleware/hub-envio-massa-claims.js`, inserido
**depois** de `authenticateToken` e **antes** do handler de cada uma das 11
rotas legadas afetadas (`GET /envio-massa`, `PATCH /update-envio-massa/:id`,
`DELETE /envio-massa/:id`, `POST /start-process`, `GET /process-status`, `POST
/stop-process`, `POST /upload`, `GET /export-envio-massa`, `GET
/download-xml-movimento`, `POST /validate-xml-batch`, `POST /close-movimento`).
Lógica — **discriminador checado na ordem abaixo, `sub` SEMPRE primeiro**
(gate `owasp-security` desta onda, achado F1 — ver rodapé desta Decision):

1. `req.user.sub` presente (payload hub) → caminho novo:
   - `entidade_ativa` ausente/null → responde **403** imediatamente
     `{ "error": { "code": "SEM_ENTIDADE_ATIVA", "message": "Selecione uma
     entidade para continuar." } }` e **não chama `next()`** (FR-004: nega sem
     jamais assumir uma entidade). O frontend do módulo intercepta esse código
     específico e redireciona para `/selecionar-entidade` (Decision 7).
   - `entidade_ativa` presente → resolve `id_grupo`/`is_grupo_pai` da
     `Empresa=entidade_ativa` via `hubPostgrestRequest` (mesma consulta que
     `POST /login` já faz em `server.js:278-291`, duplicada aqui de forma
     enxuta — extrair uma função compartilhada tocaria `server.js` além do
     estritamente necessário; duplicar ~12 linhas de leitura mantém o diff do
     arquivo legado a ZERO). Reescreve `req.user` para o formato legado:
     `req.user = { empresaId: entidade_ativa, id_grupo, is_grupo_pai }` e
     anota `req.hubContext = { usuarioId: sub, viaHub: true }` (não removido —
     usado pelo gate de permissão e pelo log de importação).
2. `req.user.sub` ausente e `req.user.empresaId` presente (payload legado) →
   `next()` sem tocar em nada — **caminho 100% preservado, zero custo para
   sessão legada**.
3. Nenhum dos dois formatos reconhecível (token malformado/expirado que passou
   por `jwt.verify` mas sem `sub` nem `empresaId`) → **401** `{ "error": {
   "code": "TOKEN_INVALIDO" } }` (defesa em profundidade; teoricamente
   inalcançável dado que `authenticateToken` já valida assinatura).

**Rationale**: FR-003 (identidade só da sessão), FR-004 (negar sem inferir).
Fail-closed: qualquer exceção na consulta de `id_grupo`/`is_grupo_pai` responde
502 “indisponível” (falha de infraestrutura, não de negócio) e não chama
`next()` — nunca deixa `req.user.empresaId` órfão seguir para o handler.

**Alternatives considered**: reescrever `authenticateToken` para já emitir o
formato traduzido — rejeitado, tocaria o middleware mais central do arquivo
legado (violaria FR-015, risco de regressão em TODAS as rotas, não só as 11 do
módulo).

**Achado F1 do gate `owasp-security` (onda-003, MEDIUM — corrigido nesta
mesma onda, sem necessidade de bloqueio humano)**: a versão original desta
Decision discriminava o ramo checando `req.user.empresaId` PRIMEIRO ("se
presente, é legado"). Isso é seguro **hoje** porque `gerarAccessToken` do hub
(`routes/hub-auth.js`/`routes/hub-me.js`) nunca inclui `empresaId` no payload
e `generateAccessToken` legado nunca inclui `sub` — os dois formatos são
mutuamente exclusivos por construção nos pontos de emissão atuais. Mas é um
**contrato implícito**: se um código futuro (fora desta feature) algum dia
adicionar `empresaId` a um token emitido pelo hub por qualquer motivo, o ramo
antigo trataria esse token como "legado" e faria bypass TOTAL do RBAC (Decision
5) para uma sessão que na verdade é do hub — escalonamento de privilégio
silencioso. A correção (aplicada acima): checar `sub` **primeiro** — como só o
hub emite `sub`, e o adaptador HOJE nunca vê um token com ambos os campos, a
troca de ordem é comportamentalmente idêntica no estado atual do sistema, mas
faz o código falhar para o lado mais seguro (tratar como sessão hub, sujeita a
RBAC) numa eventual drift futura de payload, em vez de para o lado mais
permissivo. Custo zero (mesma complexidade), benefício de defesa em
profundidade — corrigido diretamente no design em vez de registrado como
débito técnico.

## Decision 3: Mapeamento endpoint → permissão (papel FR-005/FR-008)

**Decision**: tabela fixa endpoint→código de permissão, verificada pelo novo
middleware `requirePermissionEnvioMassa(codigo)` (Decision 4):

| Endpoint | Permissão | Nível (FR-005) |
|---|---|---|
| `GET /envio-massa` | `envio_massa.consultar` | visualizar |
| `GET /process-status` | `envio_massa.consultar` | visualizar |
| `GET /export-envio-massa` | `envio_massa.consultar` | visualizar |
| `GET /download-xml-movimento` | `envio_massa.consultar` | visualizar |
| `POST /upload` | `envio_massa.criar` | criar/enviar |
| `PATCH /update-envio-massa/:id` | `envio_massa.criar` | criar/enviar |
| `POST /start-process` | `envio_massa.enviar` | criar/enviar |
| `POST /stop-process` | `envio_massa.enviar` | criar/enviar |
| `POST /validate-xml-batch` | `envio_massa.enviar` | criar/enviar |
| `POST /close-movimento` | `envio_massa.aprovar` | aprovar |
| `DELETE /envio-massa/:id` | `envio_massa.aprovar` | aprovar |

**Rationale**: `envio_massa.consultar/criar/enviar/aprovar` **já existem**,
seedados desde `infra/hub/migrations/0007_seed_papeis_permissoes_modulos.sql`
(S2/fundações) — nenhuma migration nova é necessária para estes 4 códigos. A
divisão consultar=leitura / criar=operações que produzem/alteram um movimento /
enviar=disparo de processamento em lote / aprovar=ações terminais e
irreversíveis (fechar, excluir) reflete exatamente os 3 perfis testados em US3
(leitura só vê `consultar`; operador tem `consultar+criar+enviar`; admin_entidade
tem tudo). Compatível com a matriz já seedada em `0007`: `operador` recebe
`envio_massa.consultar, .criar, .enviar` (linha 105); `leitura` recebe só
`envio_massa.consultar` (linha 120); `admin_entidade` recebe tudo (CROSS JOIN
menos `admin.gerenciar`) — **os 3 perfis do FR-016/E2E já estão corretos no
banco sem nenhuma migration**, só falta o middleware que os aplica.

**Alternatives considered**: mapear `PATCH`/`DELETE` para `envio_massa.aprovar`
uniformemente (tratar toda escrita como "aprovação") — rejeitado, US3 descreve
"operador" como capaz de operar o fluxo diário completo (que inclui editar
gorjeta, US1 AS4) sem ser "aprovador"; um mapeamento que exigisse `aprovar` para
editar um campo quebraria o Acceptance Scenario 2 de US3 (operador consegue
criar/enviar sem estar bloqueado).

## Decision 4: Nível "administrar" (FR-005) — nova permissão `envio_massa.gerenciar`, sem gate de endpoint no S8

**Decision**: adicionar migration nova (próximo número livre da série —
`0032_seed_permissao_envio_massa_gerenciar.sql`) criando `envio_massa.gerenciar`
e concedendo-a a `admin_plataforma`+`admin_entidade` (mesmo padrão de
`0026_seed_permissao_faturamento_listar.sql`: `admin_plataforma`/`admin_entidade`
já teriam a permissão via CROSS JOIN do `0007`, mas como este é um código NOVO
inserido depois, precisa de backfill explícito — `PapelPermissao` não é uma view
derivada). **Nenhum endpoint legado é gateado por `envio_massa.gerenciar`** —
o catálogo de permissões passa a ter os 4 níveis exigidos por FR-005/FR-008, mas
o fluxo legado hoje não tem nenhuma ação de "administração do módulo"
(configurar allowlist, editar flags) — introduzir uma teria sido um "novo caso
de uso que o fluxo atual não tem hoje", explicitamente fora do escopo (spec,
linha 19). FR-016 (E2E dos 3 papéis) cobre o fluxo de US1, que não inclui
nenhuma ação de administração — portanto o E2E não precisa (e não deve) testar
`envio_massa.gerenciar` contra um endpoint que não existe.

**Rationale**: FR-005 exige que o NÍVEL exista ("pelo menos os níveis:
visualizar, criar/enviar, aprovar, e administrar"), não que exista uma ação de
negócio que o consuma — a leitura mais estrita (adicionar a permissão sem uso)
é a que respeita simultaneamente FR-005 (nível existe, testável via
`obterPermissoesEfetivasPorEntidade`) e a cláusula de escopo "não inclui...
qualquer novo caso de uso que o fluxo atual não tenha hoje".

**Alternatives considered**: reaproveitar `envio_massa.aprovar` como
"administrar" (não criar `.gerenciar`) — rejeitado, FR-005 lista 4 níveis
distintos e FR-008 testa "administração da entidade consegue tudo, incluindo
aprovar **e gerenciar**" como conceitos citados separadamente na User Story 3;
colapsar os dois perderia a granularidade exigida pelo requisito, mesmo sem uso
imediato.

## Decision 5: Escopo do RBAC — só sessões hub; sessões legadas sempre em modo compatibilidade

**Decision**: `requirePermissionEnvioMassa(codigo)` só avalia RBAC quando
`req.hubContext.viaHub === true` (setado pela Decision 2). Se a requisição veio
de uma sessão legada (`req.user.empresaId` já presente desde o `authenticateToken`,
sem passar pelo ramo hub do adaptador), o middleware chama `next()`
incondicionalmente — **sempre**, independente da flag `HUB_RBAC_ENVIO`.

**Rationale**: as tabelas `Papel`/`Permissao`/`UsuarioEntidade` (RBAC do hub) só
têm vínculo com `Usuario` (tabela nova do hub) — uma sessão legada (tabela
`Empresa`) não tem `usuario_id` para consultar contra elas; não há como aplicar
RBAC granular a uma identidade que o sistema de RBAC não conhece. Isso não é uma
lacuna: é exatamente o comportamento que FR-006/AS4 descreve como "modo de
compatibilidade" — pessoas na sessão legada sempre operam como se o RBAC
estivesse desligado, porque estruturalmente elas nunca estiveram dentro dele.
Zero-risco para FR-018 (o painel legado continua se comportando 100% como hoje).

**Alternatives considered**: negar (403) toda requisição legada quando
`HUB_RBAC_ENVIO` está ligado — rejeitado, quebraria diretamente FR-018 (o painel
legado deixaria de funcionar para o cliente antes do cutover, o pior resultado
possível para a fase de maior risco de regressão do projeto).

## Decision 6: Flag `HUB_RBAC_ENVIO` — semântica e leitura

**Decision**: `process.env.HUB_RBAC_ENVIO !== 'off'` → RBAC ativo (default:
ativo, fail-safe na direção mais segura). Lido uma vez por request dentro do
middleware (sem cache de processo — troca de env exige apenas reiniciar o
serviço, consistente com o padrão de env vars do projeto; SC-005 exige reversão
"sem exigir mudança de código", não "sem restart").

**Rationale**: espelha a semântica textual do briefing (`HUB_RBAC_ENVIO=off`) e
o padrão de fail-safe já usado em `grupoLoginUnicoAtivo` (fail-*open* só quando
o *lado seguro* é permitir uma leitura simples — aqui o lado seguro é o oposto:
RBAC LIGADO por padrão, "off" exige opt-out explícito).

**Alternatives considered**: `HUB_RBAC_ENVIO=on/off` exigindo valor explícito (
sem default) — rejeitado, um ambiente sem a env var definida ficaria sem
proteção nenhuma (fail-open no pior sentido) — contraria "sem jamais assumir".

**Achado F2 do gate `owasp-security` (onda-003, INFORMATIVO — risco aceito e
já existente no desenho do hub, não introduzido por esta feature)**: o token
hub carrega `entidade_ativa` fixado no momento da emissão (`POST
/api/v1/hub/auth/login` ou `POST /api/v1/me/entidade`), validado contra
`UsuarioEntidade.ativo=true` **naquele instante** — não é revalidado a cada
requisição pelo adaptador de claims (Decision 2) nem pelo gate de permissão
(Decision 3), que consultam `obterPermissoesEfetivasPorEntidade` ao vivo mas
não revalidam o vínculo `UsuarioEntidade` em si. Se um administrador revogar o
vínculo de alguém com a entidade ativa NO MEIO de uma sessão, a janela residual
até a expiração do access token (15 min, `ACCESS_TOKEN_TTL`) é a mesma que já
existe hoje para `GET /me`/demais módulos do hub — este não é um gap novo desta
feature, é uma propriedade do modelo de sessão do hub como um todo (fora de
escopo alterar aqui). Com `HUB_RBAC_ENVIO` ligado, permissões efetivas ainda
são reavaliadas ao vivo a cada requisição (só o vínculo bruto que tem essa
janela de 15 min) — reduz, mas não zera, o risco residual durante o RBAC
ligado; com a flag **desligada**, esse é o único freio restante (a checagem de
`empresaId` continua vindo do token, nunca do request, preservando o Princípio
II da constitution — só a granularidade de PAPEL é que fica temporariamente
suspensa, por design de FR-006). Reforça por que o próprio critério de aceite
do briefing S8 (#4) exige que `HUB_RBAC_ENVIO=off` **não sobreviva
indefinidamente em produção** — é uma janela de compatibilidade, não um estado
permanente aceitável; a aposentadoria da flag entra no runbook da S10 (dono:
operador), conforme já registrado no briefing.

## Decision 7: Rota do frontend — reaproveita a convenção `/hub/dashboard/<codigo>` já existente

**Decision**: nenhuma rota nova hardcoded é necessária. O módulo `envio_massa`
já está seedado em `Modulo` (`0007`, `codigo='envio_massa'`) e
`lib/hub/module-nav.ts#moduloParaRota` já resolve qualquer módulo devolvido por
`GET /me` para `/hub/dashboard/<codigo>` — ou seja, assim que existir uma linha
`ModuloEntidade(modulo_id=envio_massa, empresa_id=<entidade>, ativo=true)`, o
módulo aparece sozinho no `ModuleNav` do shell apontando para
`/hub/dashboard/envio_massa`, sem tocar `module-nav.ts`. O trabalho real desta
feature é criar o **diretório de página** `app/hub/dashboard/envio_massa/`
(seguindo o padrão de `app/hub/dashboard/{faturamento,performance,motoristas}/`)
que renderiza os componentes JÁ EXISTENTES do painel legado
(`components/import-button.tsx`, `components/process-controls.tsx`,
`components/xml-validation-card.tsx`, `components/stats-cards.tsx`,
`components/action-bar.tsx`, `components/filters.tsx`,
`components/data-table.tsx`, `components/pagination-controls.tsx` e os hooks
`hooks/use-envio-massa.ts`/`hooks/use-process-status.ts`) — **reaproveitados,
não duplicados** (import direto dos mesmos arquivos; `app/dashboard/page.tsx`
legado continua existindo e funcionando, inalterado, para quem acessa por
`/dashboard`).

**Ajuste necessário nos hooks/componentes reaproveitados**: hoje eles chamam o
backend via o proxy genérico do frontend_v2 (`/api/*` → backend), que já repassa
cookies (Princípio III da constitution) — nenhuma mudança de rede é necessária,
só a MONTAGEM all dentro de `app/hub/dashboard/envio_massa/page.tsx` no lugar de
`app/dashboard/page.tsx`.

**Rationale**: satisfaz §13.4 ponto 1 (grupo de rotas do shell), ponto 3 (só
rotas do frontend mudam) e ponto 6 (isolamento por entidade já existe via
`resolveScope`/`EntitySwitcher`) com o menor código novo possível — reaproveita
100% da lógica de dados já testada, só reempacota a apresentação.

**Alternatives considered**: usar path literal `/hub/dashboard/envio-massa`
(hífen, como o texto informal da spec/briefing sugere) — rejeitado, quebraria a
convenção pura `moduloParaRota(codigo)` (que usa o `codigo` do banco
verbatim, `envio_massa` com underscore); um path customizado exigiria uma
exceção no `module-nav.ts` (tocar um arquivo do shell fora do escopo desta
feature) só por estética de URL. O `codigo='envio_massa'` já está gravado desde
S2 — mudá-lo agora quebraria os demais consumidores do módulo.

## Decision 8: `EmpresaSelector`/`resolveEmpresaAlvo`/`mesmoGrupoQue` preservados sem alteração

**Decision**: o seletor de filial dentro do grupo Movee
(`components/empresa-selector.tsx`, hook `useGrupoEscopo`, que lê/escreve
`?empresa_id=` na URL) é reaproveitado tal como está. A validação de que o
`empresa_id` solicitado pertence ao MESMO grupo da sessão já acontece
server-side em `resolveEmpresaAlvo(req.user, req.query.empresa_id, endpoint)`
(`routes/grupo.js:831`), que lança 403 se o alvo estiver fora do escopo — e essa
função lê exclusivamente de `req.user` (nunca confia sozinha no query param).
Como o adaptador da Decision 2 preenche `req.user.empresaId/id_grupo/is_grupo_pai`
a partir da **sessão do hub** (nunca do request), a cadeia de confiança de
FR-003 permanece intacta mesmo com o seletor de filial na tela.

**Rationale**: FR-012 exige preservar exatamente a regra de grupo empresarial
existente; a spec já observa isso no Edge Case final ("regras de roteamento e
cadastro que hoje dependem do grupo Movee continuam se aplicando sem
alteração"). Nenhuma mudança de código é necessária aqui — é uma decisão de
**não fazer nada**, registrada para deixar explícito que a composição
FR-003×seletor-de-filial foi analisada e não é um conflito.

## Decision 9: Histórico leve de importação (FR-009/010/011) — grava em status terminal, nunca em `validating`/`processing`

**Decision**: novo helper `lib/hub-envio-massa-import-log.js#registrarImportacaoEnvioMassa(...)`,
chamado de dentro do handler `POST /upload` (server.js) **depois** que o parse
da planilha termina (sucesso ou falha) — nunca antes. Grava **uma única linha**
em `ImportacaoArquivo` já no status FINAL (`completed`,
`completed_with_errors`, ou `failed`), nunca passando pelos estados
`pending`/`validating`/`processing`. Campos: `id_empresa` (=`req.user.empresaId`
pós-adaptador), `tipo='envio_massa'` (já permitido pelo `CHECK` de `0011`, sem
migration), `nome_arquivo`, `hash_sha256` (sha256 do arquivo recebido),
`tamanho_bytes`, `status`, `total_linhas`/`linhas_validas`/`linhas_invalidas`
(dos contadores que o parser já produz hoje), `criado_por=req.hubContext.usuarioId`.
Só executa quando `req.hubContext.viaHub === true` (sessão legada nunca grava —
não tem `criado_por` válido nem faz sentido aparecer no histórico do hub que ela
não acessa) e quando `HUB_IMPORT_LOG_ENVIO !== 'off'` (default: ligado).
Best-effort: envolvido em `try/catch` que só loga (`console.error`) — nunca
propaga exceção para o handler de `/upload` (FR-011).

**Rationale — o motivo do "status terminal direto" é um gotcha real do
schema**: `infra/hub/migrations/0011_importacao_arquivo.sql` define um índice
único parcial, `importacaoarquivo_uma_ativa_por_tipo`, que **rejeita** uma
segunda linha `(id_empresa, tipo)` enquanto uma primeira estiver em
`validating`/`processing` — mecanismo de mutex do pipeline de importação em
lote (S4). Se o log do envio-massa reproduzisse esse ciclo de vida (like
`hub-importacoes.js` faz para faturamento/performance), o SEGUNDO upload da
MESMA empresa enquanto o primeiro "log" ainda estivesse em `validating` seria
**bloqueado pelo índice único** — uma regressão grave e sutil: o **fluxo de
negócio de verdade** (parser XLSX legado) não tem esse mutex nem deveria
ganhar um (FR-011: log nunca pode "impedir, atrasar de forma perceptível, ou
reverter" o processamento). Gravar sempre em estado terminal, numa única
transação de INSERT, elimina completamente essa classe de bug — nunca há uma
linha "em andamento" para o índice rejeitar.

**Alternatives considered**: reusar `lib/hub-import-processor.js` (pipeline
completo de S4/importações) — rejeitado, ele foi desenhado para o fluxo de
CSV/ZIP assíncrono com processamento em background (exatamente o ciclo de vida
`pending→validating→processing` que o parágrafo acima mostra ser perigoso
aqui); o upload de envio-massa é síncrono (parse+resposta na mesma requisição
HTTP) — não há "processamento em background" para rastrear.

## Decision 10: Erros negócio vs infraestrutura (FR-013) — já implementado, preservar tal como está

**Decision**: nenhuma mudança de código. O roteamento FastAPI
(`fastapihomologacao` vs `fastapihomologacaonexus`, conforme
`mesmoGrupoQue(idEmpresa, 6)`) e a distinção 4xx-com-detail (negócio) vs
5xx/timeout→502 genérico (infra) já existem em `POST /validate-xml-batch`
(server.js) e são cobertos pela regra do CLAUDE.md do projeto. Como o
adaptador da Decision 2 só popula `req.user.empresaId/id_grupo/is_grupo_pai` —
os MESMOS campos que essa lógica já lê — nenhuma linha dela precisa mudar.

**Rationale**: escopo explícito da spec ("não inclui... mudar o roteamento
FastAPI ou a regra mesmoGrupoQue"); confirma que a Decision 2 é
suficiente — o resto do comportamento decorre automaticamente de `req.user`
estar correto.

## Decision 11: Testes — suítes novas, sem tocar as existentes

**Decision**: duas suítes novas em `app_homologacao/backend/tests/`:
`hub-envio-massa-claims-unit.test.js` (unit do adaptador de claims — Decision
2: os 3 ramos + resolução de `id_grupo`/`is_grupo_pai` mockada) e
`hub-envio-massa-permission-unit.test.js` (unit do mapeamento endpoint→permissão
— Decision 3/5: sessão legada sempre passa, sessão hub respeita
`obterPermissoesEfetivasPorEntidade`, flag `off` sempre passa). Registradas nos
scripts `test`/`test:hub:unit` do `package.json` (mesmo padrão das suítes hub
existentes) — SEM remover nem modificar nenhuma das suítes listadas hoje
(`tests/motorista-*`, `tests/hub-*` pré-existentes — FR-017). E2E em bash,
seguindo a convenção de `docs/specs/validacao-xml-lote/e2e-validacao-xml-lote.sh`
e `docs/specs/grupo-unificado-filiais/e2e-corte-modulo-c.sh`, rodando contra o
ambiente isolado `hub-homolog` (nunca produção) — cobre os 3 perfis (US3) no
fluxo completo (US1), conforme FR-016.

**Rationale**: FR-017 (suíte legada intocada) e SC-002 exigem separação física
de arquivos de teste; FR-016 exige E2E de ponta a ponta com os 3 papéis — bash
é o padrão já estabelecido em 2 features anteriores do mesmo projeto.

**Achado F3 do gate `owasp-security` (onda-003, MEDIUM — incorporado como
requisito de teste explícito, não como bloqueio)**: a garantia de segurança
inteira desta feature depende de os 2 middlewares novos (Decisions 2/3)
estarem presentes, na ordem certa, em **todas as 11** rotas — um diff futuro
que adicione uma 12ª rota, ou que uma revisão de código deixe passar UMA rota
sem o middleware, reabriria RBAC bypass silencioso só para aquele endpoint,
sem quebrar nenhum teste "funcional" (a rota continuaria respondendo
normalmente para sessões legadas E hub, só sem gate). Por isso
`hub-envio-massa-permission-unit.test.js` MUST incluir um teste dedicado de
**cobertura de middleware**, não só de comportamento: uma lista fixa das 11
rotas (mesma lista de `contracts/legacy-endpoints.md`) verificada
programaticamente contra o roteador Express (`app._router.stack` ou
equivalente) confirmando que cada uma tem `hubEnvioMassaClaimsBridge` +
`hubEnvioMassaRequirePermission` na cadeia — falha o teste (não silenciosamente
o comportamento) se uma rota da lista estiver sem os middlewares, ou se uma
rota fora da lista os tiver por engano.

## Decision 12: Migration nova é a única migration desta feature

**Decision**: uma única migration, `0032_seed_permissao_envio_massa_gerenciar.sql`
(próximo número livre — a última migration aplicada é `0031`), cobrindo
exclusivamente a Decision 4. Nenhuma outra migration é necessária: `Modulo`,
as 4 permissões operacionais, os 4 papéis-seed e o `CHECK` de `tipo` em
`ImportacaoArquivo` já existem desde S2/S4.

**Rationale**: minimiza a superfície de mudança em schema — alinhado ao
objetivo central da fase ("re-hospedar... sem tocar a lógica de negócio
legada"), que se estende ao princípio de não introduzir schema novo além do
estritamente necessário para o requisito faltante (nível "administrar").

## Technical Context (resolvido)

**Language/Version**: Node.js 14 (`app_homologacao/backend`, Express — runtime
do container `envio-massa-homologacao_backend_homologacao`); Node.js 20 (libs
`hub-*` já rodam no MESMO processo/imagem — ver `Dockerfile.hub` da S2).
**Primary Dependencies**: Express 4, `jsonwebtoken`, `multer` (upload), PostgREST
(via `fetch`/`node-fetch`), Next.js (App Router) no `frontend_v2`.
**Storage**: PostgreSQL via PostgREST (mesma instância/URL para tabelas legadas
e tabelas do hub — `POSTGREST_URL` compartilhada).
**Testing**: `node --test` (backend, `npm test`/`test:hub:unit`); scripts bash
E2E (`docs/specs/*/e2e-*.sh`) contra o ambiente isolado `hub-homolog`.
**Target Platform**: mesmo host VPSTodo, porém em recursos isolados `hub-*`
(compose/rede/banco próprios) — nada é deployado no ambiente vivo do cliente
nesta fase.
**Project Type**: web-service (backend Express) + web-app (frontend Next.js) —
monorepo único (`app_homologacao/`).
**Performance Goals**: N/A — sem SLA numérico nesta fase; o requisito é
comportamento observável idêntico ao legado (SC-001/SC-002), não performance
nova.
**Constraints**: diff mínimo nos endpoints legados (FR-015); zero alteração de
schema além da Decision 4; zero envio real fora do ambiente isolado (SC-006,
já garantido pela infra S1 — `ENVIO_DRY_RUN`/allowlist/mocks).
**Scale/Scope**: 11 endpoints legados ganham middleware; 1 migration; 1 rota de
página nova no frontend; reaproveita todos os componentes/hooks existentes.

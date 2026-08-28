# Quickstart: Robô de Importação EntreGô

Cenários de teste do fluxo end-to-end. O portal EntreGô é de um terceiro
(franqueado real) — os cenários que dependem dele usam sessão/fixtures gravadas
(`storageState` de teste + mocks de resposta do BFF), nunca o portal de PRODUÇÃO do
franqueado a partir de CI/execução automatizada desta pipeline. O hub tem ambiente
`hub-homolog` isolado (`docs/plans/hub-frota/`) — usar lá para os cenários que
envolvem `POST /api/v1/importacoes`.

## Scenario 1: Happy path — sessão do hub nova, sessão do EntreGô reutilizada

1. `storageState` do EntreGô já existe em disco e é válido (mock: sonda
   `GET .../authentication/me` responde 200).
2. Robô loga no hub (`POST /api/v1/auth/login` com credencial de serviço) — recebe
   cookie `hub_accessToken`, depois `POST /api/v1/me/entidade` (o token do login
   isolado NUNCA carrega `entidade_ativa` — achado de 6.2, contracts/hub-api.md)
   para selecionar `HUB_ID_EMPRESA` e obter o cookie definitivo.
3. Robô confere `entidade_ativa` do token (pós `/me/entidade`) contra
   `HUB_ID_EMPRESA` configurado — bate.
4. Robô chama `GET .../reports/PERFORMANCE/urls` e `GET .../reports/FINANCE/urls`
   dentro do contexto Playwright (sessão herdada, sem novo login).
5. Robô baixa os 2 CSVs via HTTP puro (URLs pré-assinadas do S3).
6. Robô envia cada um via `POST /api/v1/importacoes` (`tipo=performance`/`faturamento`).
7. Robô recebe `201` para os dois, faz polling até `completed`.
8. **Expected**: log de execução registra `resultado: sucesso`, 2 entradas em
   `relatorios[]` com `status_hub: completed`; nenhum e-mail de alerta enviado;
   nenhum login completo no EntreGô ocorreu (sessão só validada, não recriada).

## Scenario 2: Sessão do EntreGô expirada — login completo acionado

1. `storageState` existe mas a sonda `GET .../authentication/me` responde `401`.
2. Robô executa o fluxo de 4 passos (ACHADOS-PORTAL.md §7): preenche e-mail, senha,
   aguarda o modal, lê o código via IMAP (mensagem com assunto "Código de Acesso"
   recebida APÓS o timestamp do `POST authentication/validate` desta tentativa),
   preenche e confirma.
3. **Expected**: novo `storageState` salvo em disco; execução segue normalmente
   (mesmo fluxo do Scenario 1 a partir do passo 4); esse relogin NÃO é contado como
   "falha" nem como "tentativa" no sentido de FR-012 — é o comportamento esperado de
   FR-016.

## Scenario 3: Desafio anti-bot detectado — parada imediata, sem retry

1. Durante o fluxo de login (ou durante uma chamada ao BFF), a resposta observada é
   estruturalmente diferente do documentado em `contracts/entrego-portal.md` (ex.:
   corpo HTML no lugar do JSON esperado, elemento de formulário não aparece dentro
   do timeout).
2. **Expected**: robô interrompe a execução IMEDIATAMENTE (não tenta de novo, não
   tenta interpretar o conteúdo do desafio); as 3 reações de FR-013 disparam
   (log + e-mail + `POST /api/v1/robo-entrego/eventos` com `acao:
   "robo_entrego.suspeita_antibot"`); `resultado: falha_total` no log de execução.
   Zero tentativa de resolver/repetir a chamada em loop (SC-003).

## Scenario 4: Falha transitória — retry com backoff, depois sucesso

1. Chamada ao BFF do EntreGô (ou ao hub) falha por timeout de rede.
2. Robô aguarda 1 minuto, tenta de novo — falha de novo.
3. Robô aguarda 5 minutos, tenta de novo — sucesso desta vez.
4. **Expected**: log registra `tentativas: 3` para este relatório; `resultado:
   sucesso` na execução; nenhum alerta de falha definitiva (só teria disparado se as
   3 tentativas + o backoff de 15 min também esgotassem, FR-012).

## Scenario 5: Arquivo já importado — sucesso idempotente

1. Robô envia um CSV cujo `sha256` já existe para `(id_empresa=6, tipo=performance)`
   no hub (ex.: reexecução do mesmo dia).
2. `POST /api/v1/importacoes` responde `409 CONFLITO`.
3. **Expected**: `status_hub: duplicado` registrado, tratado como sucesso (FR-008);
   nenhum retry, nenhum alerta, nenhuma segunda linha em `ImportacaoArquivo`
   (SC-004).

## Scenario 6: Roundtrip real contra `hub-homolog` — Auditoria proposta

Cenário obrigatório (borda backend↔robô) para validar o endpoint PROPOSTO
`POST /api/v1/robo-entrego/eventos` (contracts/hub-api.md) contra o backend REAL do
hub — não um mock.

**Executado de fato em 2026-08-28 (tasks.md 6.2)** — 2 drifts reais encontrados e
documentados em contracts/hub-api.md (login não carrega `entidade_ativa` sem
`POST /me/entidade` — CORRIGIDO em `hub-client.js`; filtros `acao`/`recurso` de
`GET /auditoria` incompatíveis com os valores reais gravados — pré-existente,
fora de escopo). O SQL de provisionamento (FASE 2.2) também tinha um bug real de
interpolação `psql` dentro de `DO $$...$$` — corrigido no próprio artefato.

1. Subir `hub-homolog` (`infra/hub/RUNBOOK.md`).
2. Provisionar o usuário de serviço do robô nesse ambiente
   (`infra/robo-entrego/sql/001-usuario-servico-robo-entrego.sql`, adaptando
   `empresa_id` para a empresa de teste do ambiente — `6` só existe em
   produção) com `importacoes.criar` na entidade de teste.
3. `curl` real: `POST /api/v1/auth/login` → capturar `Set-Cookie` — **o token
   ainda NÃO tem `entidade_ativa`** (drift vs. a nota de design anterior do
   contrato).
4. `curl` real, com o cookie do passo 3: `POST /api/v1/me/entidade` com
   `{"empresa_id": <id da entidade de teste>}` → capturar o `Set-Cookie` NOVO
   (esse sim carrega `entidade_ativa`).
5. `curl` real, reusando o cookie do passo 4: `POST /api/v1/robo-entrego/eventos`
   com `{"acao": "robo_entrego.sucesso", "detalhes": {"origem": "quickstart"}}`.
6. `GET /api/v1/auditoria` (endpoint de LEITURA já existente, **sem** filtro
   `acao`/`recurso` — ver drift acima) e confirmar no array `eventos` que a
   linha aparece com `recurso: "RoboEntrego"`, `acao` batendo, `entidadeId`
   correto.
7. **Expected**: zero divergência de NOME DE CAMPO entre o contrato proposto e o
   comportamento real do endpoint `/robo-entrego/eventos` implementado — o que
   de fato aconteceu (`acao`/`detalhes`/`ok` batem 1:1). As divergências reais
   encontradas foram de FLUXO (login precisa do passo extra) e de um endpoint
   auxiliar pré-existente (`/auditoria`), não do endpoint novo em si — ambas
   documentadas em contracts/hub-api.md.

## Scenario 7: Duas execuções sobrepostas — lock

1. Disparar a rotina duas vezes quase simultaneamente (dois horários configurados
   colidindo, User Story 4 cenário 2).
2. **Expected**: a segunda chamada a `flock -n` no arquivo de lock falha
   imediatamente; log registra `resultado: pulado_lock` para a segunda; a primeira
   roda normalmente até o fim, sem interferência.

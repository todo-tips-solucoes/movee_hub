# Quickstart: Envio em Massa como Módulo do Hub

Cenários de teste que validam a implementação end-to-end no ambiente isolado
`hub-homolog`. Todos rodam contra os mocks de n8n/FastAPI (S1) — nenhum envio
real acontece (SC-006).

## Scenario 1: Fluxo completo pela pessoa admin_entidade (Happy Path — US1+US2+US3)

1. Login no hub (`POST /api/v1/hub/auth/login`) com uma conta vinculada como
   `admin_entidade` à entidade de teste.
2. `GET /me` confirma `entidade_ativa` já setada (ou `POST /me/entidade` se a
   conta tiver mais de um vínculo) e `modulos[]` contém `envio_massa`.
3. Navegar para `/hub/dashboard/envio_massa` — tela carrega sem erro, sem novo
   login.
4. Enviar planilha `.xlsx` válida (upload) — aceito, movimentos aparecem na
   listagem.
5. Iniciar o processo pela tela — progresso via polling reflete o mock do n8n;
   ao concluir, status dos movimentos atualizado.
6. Enviar lote de XMLs de nota fiscal — cada movimento recebe o resultado
   correto (mock FastAPI: casos válida/inválida/erro-negócio/timeout).
7. Editar um campo permitido (ex.: gorjeta) de um movimento validado.
8. Fechar o movimento — não aceita mais edição.
9. Exportar o período — arquivo com os mesmos dados/formato do painel legado.
10. **Expected**: todas as 9 etapas concluem sem exigir credencial adicional
    (SC-003) e sem nenhum código de erro novo (`SEM_ENTIDADE_ATIVA`/
    `PERMISSAO_INSUFICIENTE`) aparecer.

## Scenario 2: Sessão hub sem entidade ativa (Error Case — FR-004)

1. Login no hub com uma conta vinculada a **2+ entidades**, sem completar a
   seleção (interceptar antes do redirecionamento automático de
   `/selecionar-entidade`, ou chamar a API diretamente).
2. Chamar `GET /envio-massa` (ou qualquer dos 11 endpoints) diretamente, com o
   cookie `accessToken` da sessão hub SEM `entidade_ativa`.
3. **Expected**: `403 {"error":{"code":"SEM_ENTIDADE_ATIVA"}}`. Ao acessar
   `/hub/dashboard/envio_massa` pela UI nessa mesma condição, o navegador é
   redirecionado para `/selecionar-entidade` (sem nenhuma tela do módulo
   renderizada, sem inferir entidade).

## Scenario 3: Papel de leitura — bloqueios de escrita (US3, FR-007/FR-008)

1. Login no hub com conta vinculada como `leitura` à entidade de teste.
2. `GET /envio-massa` — 200, lista visível.
3. `POST /upload` — **Expected**: `403 {"error":{"code":"PERMISSAO_INSUFICIENTE"}}`.
4. `POST /start-process`, `POST /validate-xml-batch`, `POST /close-movimento`,
   `DELETE /envio-massa/:id` — todos **Expected**: `403 PERMISSAO_INSUFICIENTE`.

## Scenario 4: Papel de operador — pode operar, não pode aprovar (US3)

1. Login com conta `operador`.
2. `POST /upload`, `PATCH /update-envio-massa/:id`, `POST /start-process`,
   `POST /validate-xml-batch` — todos 200/201 (permitidos).
3. `POST /close-movimento` e `DELETE /envio-massa/:id` — **Expected**: `403
   PERMISSAO_INSUFICIENTE`.

## Scenario 5: Flag `HUB_RBAC_ENVIO=off` — modo de compatibilidade instantâneo (FR-006/SC-005)

1. Com `HUB_RBAC_ENVIO=off` no ambiente, repetir o Scenario 3 (conta
   `leitura`) chamando `POST /upload`.
2. **Expected**: 200/201 — a mesma ação antes bloqueada agora é permitida,
   sem nenhuma mudança de código, só reinício do serviço com a env var nova.

## Scenario 6: Sessão legada — comportamento 100% preservado (FR-018/FR-002)

1. Login pela rota legada (`POST /login`, painel `/dashboard`, fora do `/hub/`).
2. Repetir os passos do Scenario 1 (upload → processo → validação → edição →
   fechamento → export) inteiramente pelo painel legado.
3. **Expected**: comportamento idêntico ao de antes desta feature — nenhum dos
   novos códigos de erro (`SEM_ENTIDADE_ATIVA`/`PERMISSAO_INSUFICIENTE`)
   aparece nunca para esta sessão, independentemente do papel/flag.

## Scenario 7: Histórico leve de importação (US4, FR-009/010/011)

1. Com `HUB_IMPORT_LOG_ENVIO` no default (ligado), repetir o upload do
   Scenario 1 via sessão hub.
2. `GET /importacoes?tipo=envio_massa` (tela de histórico do hub) — **Expected**:
   uma entrada nova, `tipo=envio_massa`, com `status` terminal
   (`completed`/`completed_with_errors`), contagens coerentes com o upload.
3. Repetir com `HUB_IMPORT_LOG_ENVIO=off` — **Expected**: upload processa
   normalmente (200), nenhuma entrada nova aparece no histórico.
4. Simular falha na gravação do log (ex.: indisponibilidade momentânea do
   PostgREST só para o INSERT de `ImportacaoArquivo`) — **Expected**: o
   upload de negócio ainda responde 200/201 normalmente; a falha do log é
   só logada no servidor, nunca propagada à resposta HTTP.

## Scenario 8: Roundtrip End-to-End — payload real dos códigos de erro novos

Cenário obrigatório (borda backend↔frontend) — valida que os códigos de erro
introduzidos por esta feature (`contracts/claims-adapter.md`) batem
byte-a-byte entre o que o backend realmente responde e o que o frontend do
módulo trata.

1. Subir o backend do `hub-homolog` (ambiente isolado, nunca produção).
2. `curl -s -b "accessToken=<token-hub-sem-entidade>" https://hub-homolog.../api/../envio-massa` (ou rota equivalente por trás do proxy).
3. Capturar o JSON de resposta e comparar contra `contracts/claims-adapter.md`:
   nome exato do campo (`error.code`, `error.message`), valor literal do code
   (`SEM_ENTIDADE_ATIVA`), status HTTP (403).
4. Confirmar que o handler de erro do frontend do módulo
   (`app/hub/dashboard/envio_massa/`) reconhece exatamente essa string e
   dispara o redirecionamento para `/selecionar-entidade` — não um
   `error.code` diferente ou um `errorCode` (camelCase) inventado sem
   verificação empírica.
5. **Expected**: zero divergência entre o payload real de erro e o contrato
   declarado — mesma lição do drift snake_case/camelCase de execuções
   anteriores (ver skill `/plan`, nota sobre a execução-fonte onda-040).

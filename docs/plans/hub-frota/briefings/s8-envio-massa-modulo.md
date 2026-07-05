# Briefing S8 — Envio em massa como módulo do hub

**Fase:** S8 · **Branch:** `feat/hub-envio-massa` · **Pré-requisito:** S3 mergeada
(shell). **Fase de maior risco de regressão do projeto** — o fluxo migrado é o que o
cliente usa todos os dias.

## Contexto mínimo (autossuficiente)

- Fluxo atual (produção, intocável até o cutover): telas do `frontend_v2`
  (`/dashboard` + componentes `import-button`, `process-controls`,
  `xml-validation-card`, dialogs) → backend legado:
  `POST /upload` (XLSX → `EnvioMassa`; se grupo Movee, cura base `Motorista`),
  `POST /start-process`/`GET /process-status`/`POST /stop-process` (n8n),
  `GET /envio-massa`, `PATCH /update-envio-massa/:id`, `DELETE /envio-massa/:id`,
  `GET /export-envio-massa`, `GET /download-xml-movimento`,
  `POST /validate-xml-batch` (FastAPI não-nexus p/ grupo Movee via `mesmoGrupoQue`,
  nexus p/ demais), `POST /close-movimento`.
- No ambiente isolado, n8n e FastAPI são **mocks** (S1) e valem as proteções:
  `ENVIO_DRY_RUN` default, allowlist, limite por lote, registro de bloqueios.
- ⚠️ Ambiente do VPSTodo É PRODUÇÃO. Nada é deployado lá nesta fase.
- Referências: plano técnico §13.4 (8 pontos), §14 (tabela, linha "legado"), §15 (S8);
  E2E existentes como base: `docs/specs/validacao-xml-lote/e2e-validacao-xml-lote.sh`,
  `docs/specs/grupo-unificado-filiais/e2e-corte-modulo-c.sh`.

## Objetivo

Re-hospedar o envio em massa dentro do shell do hub **sem alterar seu comportamento**,
aplicando autenticação/permissões novas na frente dos endpoints legados.

## Escopo

**Inclui**
1. **Frontend:** mover as telas atuais para o grupo de rotas `/envio-massa/*` do shell
   (navegação via ModuleNav; visual EntreGô 2.0 já é o mesmo). Mesmos componentes;
   ajustes só de layout/navegação/breadcrumb.
2. **Auth ponte:** o hub emite token de `Usuario`; endpoints legados esperam claims
   `{empresaId, id_grupo, is_grupo_pai}` — adaptador que garante essas claims no token do
   hub (a entidade ativa vira `empresaId`). Zero mudança na validação legada.
3. **Permissões:** `requirePermission('envio_massa.view|create|send|approve|manage')`
   como middleware **na frente** dos endpoints legados (mudança mínima e reversível por
   flag `HUB_RBAC_ENVIO=off`).
4. **Histórico de importações (leve):** registrar cada `/upload` em `ImportacaoArquivo`
   tipo `envio_massa` (só o cabeçalho: hash, contagens, status) **sem** mudar o parser
   nem o fluxo — flag `HUB_IMPORT_LOG_ENVIO=on/off`.
5. **E2E completo do fluxo** no ambiente isolado (mocks): upload XLSX → movimentos →
   start-process (mock n8n) → validação XML em lote (mock FastAPI: casos válida/inválida/
   erro negócio/timeout) → edição/gorjeta → fechamento → export.

**Não inclui:** refatorar o parser XLSX; alterar `EnvioMassa`/`ProcessControl` (schema);
mudar o roteamento FastAPI ou as regras do grupo Movee (`mesmoGrupoQue` intocado);
desligar as telas antigas (produção continua com elas até o cutover).

## Ordem

adaptador de claims → telas re-hospedadas → RBAC na frente (com flag) → log de importação
(com flag) → E2E completo → diff dos endpoints legados (deve ser mínimo e revisado linha
a linha) → evidências.

## Testes exigidos

- Unit: adaptador de claims; mapeamento permissão→endpoint.
- **E2E fluxo completo** (acima) com os 3 perfis: admin_entidade (tudo), operador
  (sem approve/manage), leitura (só view) — cada bloqueio conferido no backend (403).
- Regressão dos testes unitários legados existentes (8 arquivos) — todos verdes, sem
  modificação neles.
- Teste das proteções: envio com allowlist vazia → bloqueado + registrado em Auditoria.

## Evidências

E2E completo verde (saída); diff dos arquivos legados tocados (esperado: só middleware/
flags); log do mock n8n comprovando que nada real sairia; testes legados verdes.

## Critérios de aceite

1. E2E do fluxo completo 100% verde no hub; 2. testes legados intocados e verdes;
3. diff mínimo nos endpoints legados (middleware + flags apenas); 4. flags permitem
desligar RBAC/log instantaneamente (rollback funcional); 5. proteções de envio ativas e
auditadas; 6. PR + DIARIO.md.

## Gotchas

- `mesmoGrupoQue(id, 6)` é a regra canônica do grupo Movee — qualquer novo caminho de
  código que toque `Motorista`/FastAPI usa ela, nunca `=== 6`.
- Erros FastAPI: negócio (4xx com `detail`) propaga a mensagem real; infra (timeout/5xx)
  vira 502 "indisponível" — não mascarar um pelo outro (regra do CLAUDE.md).
- Datas do XLSX: usar as funções existentes (`excelSerialToUTCDate`,
  `toTimestamptzMidnightSP`) — não reimplementar.
- Comentário `{/* */}` após `return (` quebra build turbopack.

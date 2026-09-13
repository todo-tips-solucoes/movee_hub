# Quickstart: Notificações push no app do motorista

Cenários que validam a implementação ponta a ponta. Todos rodam primeiro no ambiente isolado.
O hub-test é efêmero e sobe pelos drivers `infra/hub/testes/*.sh`; o hub-homolog é
persistente (`infra/hub/RUNBOOK.md`). **Nada roda em produção** sem os 5 gates do rito
(`CLAUDE.md`).

Pré-condições comuns:
- `df -h /` com pelo menos ~20 GB livres e swap ativa antes de qualquer build;
  `docker build --memory=2g` (`CLAUDE.md` §Comandos);
- backend do hub-homolog **rebuildado** a partir do código novo — ele roda imagem buildada
  (briefing `:116-118`);
- arquivo de chave VAPID de teste gerado por `infra/hub/scripts/gen-vapid.sh` num diretório
  temporário (hub-test) ou em `/var/lib/hub_secrets/` (hub-homolog);
- `push-mock` HTTPS no ar no compose de teste, com status programável por endpoint.

## Scenario 1: Ativação com gesto (US1, SC-001)

1. Motorista entra no app com um navegador stubado (Playwright, init script conta chamadas a
   `Notification.requestPermission`).
2. O app carrega `/movimento`.
3. **Expected**: 0 chamadas a `requestPermission`; o passo de contexto aparece com "Ativar".
4. Tocar em "Ativar" e conceder.
5. **Expected**: 1 chamada a `requestPermission`; `PUT /api/motorista/push/inscricao` → 204;
   estado exibido "ativas".
6. No banco, `PushInscricao` com `cnpj_prestador` do motorista logado e `PushEstadoAtivacao` =
   `ativas`.

## Scenario 2: iOS sem instalação (US1-4, SC-002)

1. Emular UA de iPhone com `display-mode: standalone` = false.
2. Abrir o app autenticado.
3. **Expected**: orientação "instale o app na tela de início"; nenhum botão de ativar; 0 chamadas
   a `requestPermission`; `PUT /api/motorista/push/estado` com `ios_sem_instalacao`/`ios`.

## Scenario 3: Permissão bloqueada e sem suporte (US1-5, US1-6)

1. Stub `Notification.permission = 'denied'`, depois um navegador sem `PushManager`.
2. **Expected**: estado "bloqueadas" com orientação de reativação e 0 pedidos; depois "sem
   suporte" sem botão de ativar.

## Scenario 4: Identidade pelo token (US1-3, FR-003)

1. `PUT /motorista/push/inscricao` autenticado como motorista A, com corpo contendo
   `cnpjPrestador` do motorista B.
2. **Expected**: 204 e a inscrição fica vinculada a **A**. Nenhuma linha para B.

## Scenario 5: Criar e disparar aviso (US2, SC-004)

1. Usuário do hub com `avisos.enviar`, entidade 6, e 3 inscrições de teste ativas.
2. Abrir "Novo aviso", preencher título e mensagem, modo "toda a base".
3. **Expected**: prévia `GET /api/v1/avisos/alcance` = `{ motoristas: N, inscricoes: 3 }`.
4. Disparar.
5. **Expected**: `201 { status: 'na_fila', visados: 3 }` em ≤ 3 s; a tela de resultado mostra
   "Na fila" → "Em andamento" → "Concluído" por polling.
6. **Expected**: `aceitos + falhas + mortas = 3`; o log do `push-mock` tem 3 POSTs cifrados
   com cabeçalho VAPID.

## Scenario 6: Recusas de permissão e escopo (US2-2, US2-3, SC-008)

1. `POST /api/v1/avisos` com usuário sem `avisos.enviar`.
2. **Expected**: `403 PERMISSAO_NEGADA`; 0 linhas novas em `Aviso`.
3. Com a permissão, mas entidade ativa fora do grupo Movee.
4. **Expected**: `403 FORA_DO_GRUPO_MOVEE`.
5. Com uma filial do grupo (fixture `Grupo`/`Empresa` com `id_grupo` da empresa 6).
6. **Expected**: aceito — prova que o critério é `mesmoGrupoQue`, não `=== 6`.

## Scenario 7: Zero inscrições e limites (US2-4, US2-9, US2-10)

1. Prévia e disparo com modo `individual` para um motorista sem inscrição.
2. **Expected**: prévia `inscricoes: 0`, botão desabilitado; `POST` direto → `422 SEM_INSCRICOES_ATIVAS`.
3. Título com 61 caracteres.
4. **Expected**: `400 CONTEUDO_EXCEDE_LIMITE`, mensagem em português.
5. 11 disparos em 15 min pelo mesmo usuário.
6. **Expected**: o 11º → `429 LIMITE_EXCEDIDO`, sem aviso criado.

## Scenario 8: Inscrição morta (US3-3, SC-006)

1. `push-mock` programado: endpoint E1 → 201, E2 → 410, E3 → 404.
2. Disparar aviso para toda a base.
3. **Expected**: `aceitos: 1, mortas: 2`; `PushInscricao` de E2 e E3 apagadas.
4. Disparar um segundo aviso.
5. **Expected**: `visados: 1`; E2 e E3 sem POST no log do `push-mock`.

## Scenario 9: Falha transitória (US3-4)

1. `push-mock`: E1 → 500, 500, 201; E2 → 429 sempre.
2. Disparar.
3. **Expected**: E1 `aceito` com `tentativas = 3`; E2 `falha`/`transitoria_esgotada` com
   `tentativas = 3`; aviso `concluido`.

## Scenario 10: Duplo disparo e reinício no meio (US2-8, SC-010)

1. Enviar o mesmo `POST /api/v1/avisos` duas vezes em paralelo, com a mesma `chaveIdempotencia`.
2. **Expected**: um 201 e um 200 com o **mesmo** `id`; um só conjunto de `AvisoEntrega`.
3. `push-mock` com atraso de 5 s por POST e 100 inscrições; `docker restart` do backend no meio
   do processamento.
4. **Expected**: após o boot, o aviso retoma; as entregas em voo viram `falha`/`interrompida`;
   o log do `push-mock` tem **no máximo 1** POST por endpoint.
5. Dois reivindicadores simultâneos na função `hub_push_reivindicar` (duas sessões psql com o
   claim do worker).
6. **Expected**: conjuntos de entregas disjuntos.

## Scenario 11: Payload sem PII (US2-6, SC-007)

1. Após os cenários 5 a 10, inspecionar o corpo **decifrado** que o `push-mock` registra. O mock
   de teste recebe a chave privada da inscrição de teste que ele mesmo gerou.
2. **Expected**: cada payload tem exatamente as chaves `avisoId`, `titulo`, `corpo`; nenhum CNPJ
   (regex de 14 dígitos), nome de motorista ou valor.

## Scenario 12: Logout e aparelho compartilhado (US1-9, edge case, SC-008)

1. Motorista A com notificações ativas faz logout.
2. **Expected**: `unsubscribe()` no aparelho + `POST /api/motorista/push/inscricao/revogar` → 204;
   `PushInscricao` e `PushEstadoAtivacao` do aparelho apagadas.
3. Novo aviso para toda a base.
4. **Expected**: o endpoint antigo de A não é visado.
5. Motorista B entra no mesmo aparelho e ativa. A tocar num aviso antigo de A:
   `GET /motorista/avisos/:id` como B.
6. **Expected**: `404 AVISO_NAO_DISPONIVEL`; a tela mostra "Aviso não disponível".

## Scenario 13: Toque na notificação e sessão expirada (US2-7, FR-013)

1. Com o SW real (`next build && next start`), disparar `notificationclick` com
   `data.url = /avisos/42` e sessão expirada.
2. **Expected**: abre `/login?next=%2Favisos%2F42`; após o login, cai em `/avisos/42`.
3. `next=//evil.example`.
4. **Expected**: ignorado, vai para `/movimento`.

## Scenario 14: Rotação de chave (edge case, FR-026, FR-029)

1. Com inscrições ativas na chave K1, gerar K2 (`gen-vapid.sh --gerado-por <operador>`),
   trocar o arquivo e reiniciar o backend.
2. **Expected**: `PushChaveVapid` ganha K2; `Auditoria` com `acao = 'push_chave_substituida'`,
   `detalhes.geradoPor` = operador.
3. A prévia de alcance cai para 0 (inscrições em K1 não são visadas).
4. Abrir o app autenticado.
5. **Expected**: `keyId` local ≠ servido → re-assina sem pedido de permissão → `PUT` com K2 → 204;
   a prévia volta a contar.

## Scenario 15: Chave ausente (edge case, FR-025)

1. Subir o backend com `VAPID_KEYS_FILE` apontando para um arquivo inexistente.
2. **Expected**: boot não quebra; log `push indisponível` **sem** conteúdo de chave;
   `GET /motorista/push/chave-publica` e `POST /api/v1/avisos` → `503 PUSH_INDISPONIVEL`;
   0 avisos em `em_andamento`.

## Scenario 16: Expurgo de 90 dias (FR-030)

1. Inserir aviso e entregas com `criado_em = now() - interval '91 days'` e outro com 89 dias.
2. Chamar `hub_push_expurgo()` com o claim do worker (ou esperar o boot).
3. **Expected**: o de 91 dias some com as entregas; o de 89 permanece; `Auditoria` intacta.
4. Chamar sem o claim do worker.
5. **Expected**: exceção, nada apagado.

## Scenario 17: Cobertura por plataforma (US4, SC-011)

1. Estados reportados: A (android `ativas`), B (ios `ativas`), C (ios `ios_sem_instalacao`),
   D (android `bloqueadas`), E (desktop `sem_suporte`).
2. **Expected**: `GET /api/v1/avisos/cobertura` →
   `ativos {android:1, ios:1, desktopOutros:0}`, `impedidos {iosSemInstalacao:1, bloqueadas:1, semSuporte:1}`.
3. C instala o app e reporta `ativas` no mesmo `dispositivoId`.
4. **Expected**: C conta só como ativo iOS.

## Scenario 18: RLS (FR-028)

1. `GET` direto no PostgREST de `PushInscricao`/`AvisoEntrega`/`PushEstadoAtivacao` com JWT de
   usuário do hub e com JWT de motorista.
2. **Expected**: 0 linhas; só as funções devolvem dado, e cada uma respeita o próprio claim.
3. `hub_push_inscricao_revogar` com o claim do motorista B para a inscrição de A.
4. **Expected**: nada apagado.

## Scenario 19: Varredura da chave privada (SC-009)

1. Conferir por **contagem**, sem imprimir a chave, que o valor de `privateKey` do arquivo de
   teste não aparece em:
   - `git grep` do repo;
   - `docker run --rm <imagem backend> sh -c 'grep -rF …'`;
   - logs dos containers do hub-test;
   - bundle servido dos dois frontends.
2. **Expected**: 0 ocorrências em todos. O arquivo vive só no diretório de segredos e no mount
   read-only.

## Scenario 20: Roundtrip End-to-End (obrigatório)

Valida que o payload **real** do backend casa com `contracts/*.md` e com os tipos dos
frontends. Sem mock ou fixture no lado do backend.

1. Subir o hub-test com o backend buildado do código novo, `push-mock` e seeds (usuário
   `avisos.enviar` na entidade 6, motorista com conta ativa e `Entregador` vinculado).
2. Capturar com `curl` e cookies reais:
   - `POST /api/v1/avisos`
   - `GET /api/v1/avisos/:id`
   - `GET /api/v1/avisos/alcance`
   - `GET /api/v1/avisos/cobertura`
   - `GET /motorista/push/chave-publica`
   - `PUT /motorista/push/inscricao`
   - `GET /motorista/avisos/:id`

   Salvar os corpos em arquivos.
3. Comparar o shape contra os contratos:
   - nomes em camelCase;
   - `id` e contagens como `number` (não string);
   - `status`/`modoDestinatarios`/`estado` com os literais do contrato;
   - erros das rotas novas sob a chave `erro` (o `401` herdado do `authenticateMotorista` usa `error`).
4. Um teste vitest em `frontend_v2` passa os corpos capturados pelos parsers de
   `lib/hub/avisos-dto.ts` sem erro. O `frontend_motorista`, que não tem runner, recebe a mesma
   verificação no E2E Playwright do cenário 1.
5. **Expected**: zero divergência entre payload real, contrato e tipos TS.

## Scenario 21: Aparelho real (SC-003) — manual, operador

1. Numa origem HTTPS confiável alcançável pelo celular (a definir com o operador: túnel
   autenticado ou janela em produção sob o rito), instalar o PWA no Android e no iPhone (iOS
   16.4+), ativar e fechar o app.
2. Disparar 20 avisos de teste.
3. **Expected**: notificação em ≤ 1 min em ≥ 95% das entregas `aceito`; tocar abre `/avisos/:id`.
   Registrar os hosts de endpoint observados para validar a allowlist (research Decision 10).

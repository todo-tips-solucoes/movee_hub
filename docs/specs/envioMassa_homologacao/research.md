# Research: Notificações push no app do motorista

Phase 0 do `/plan` (2026-09-11). Resolve as incógnitas técnicas antes do design. Toda
afirmação sobre código existente cita `arquivo:linha` lido nesta sessão; o que ainda
depende de medição real está marcado **[A VALIDAR]** e vira tarefa, nunca suposição.

Convenção de caminhos: `BE` = `app_homologacao/backend`, `FM` = `app_homologacao/frontend_motorista`,
`FV2` = `app_homologacao/frontend_v2`, `MIG` = `infra/hub/migrations`.

Nenhum eixo estrutural novo é fixado aqui (dec-030): runtime, frameworks, arquitetura de
processo único, persistência PostgREST/Postgres, ambiente Swarm e tier `cloud-public` já
estão decididos pelo repositório; Web Push/VAPID é decisão do operador
(`docs/plans/push-motorista/BRIEFING-PUSH-MOTORISTA.md:60-73`).

## Decision 1: Biblioteca de Web Push no backend

**Decision**: `web-push` **3.6.7** como dependência do backend (dec-024).
**Rationale**:
- Versão apurada no registry nesta sessão: `npm view web-push version engines.node` →
  `3.6.7`, `engines.node ">= 16"`. O backend roda `node:20-alpine` (`BE/Dockerfile.hub:23`).
- API usada (lida numa cópia local do mesmo pacote 3.6.7, só para leitura, em
  `/var/lib/sara-hub/node_modules/web-push`): `setVapidDetails`, `sendNotification`,
  `generateVAPIDKeys`, `WebPushError` (`src/index.js:11-21`); o erro carrega `statusCode`
  (`src/web-push-error.js:3-8`); opções `TTL`, `urgency`, `topic`, `timeout`
  (`src/web-push-lib.js:109-129,222-223`); o envio usa `https.request`
  (`src/web-push-lib.js:369`); o `subject` VAPID precisa ser `mailto:` ou `https:`
  (`src/vapid-helper.js:68-88`).
- Licença MPL-2.0 (`package.json` do pacote): uso como dependência sem modificação.
- A instalação será feita, na implementação, dentro de container `node:20-alpine` para manter
  o `package-lock.json` coerente (hoje `web-push` não está em `BE/package.json`; o lock é
  reescrito pelo container do Playwright — conferir antes de commitar).

**Alternatives considered**: criptografia RFC 8291 + JWT VAPID à mão com `node:crypto`
(código de segurança sem ganho); FCM (vetado pelo operador).

## Decision 2: Armazenamento e carga da chave VAPID

**Decision**: arquivo JSON em `/var/lib/hub_secrets/` (`chmod 600`), montado **read-only**
no container do backend; o backend lê o caminho de `VAPID_KEYS_FILE` (dec-025).
Formato: `{ publicKey, privateKey, subject, geradoPor, geradoEm }` (base64url; só
`privateKey` é segredo).
**Rationale**:
- FR-025 exige a chave **somente** em `/var/lib/hub_secrets/`. Os segredos atuais entram
  por variável de ambiente — em produção via `docker service update --env-add`
  (`docs/plans/hub-frota/RUNBOOK-CUTOVER.md:151-158`) —, o que copia o valor para a spec
  do serviço e para `docker inspect`. Um arquivo montado não copia.
- `--mount-add` já é usado no mesmo serviço (`RUNBOOK-CUTOVER.md:151-158`); a variação é o
  tipo `bind` apontando para um arquivo de `/var/lib/hub_secrets/`.
- Validação no boot: `publicKey` com 65 bytes e `privateKey` com 32 bytes (as mesmas
  checagens da lib, `vapid-helper.js:110-111,131-132`), `subject` válido. Arquivo ausente ou inválido → push
  **indisponível** (fail-closed): chave pública e disparo respondem `503 PUSH_INDISPONIVEL`
  (edge case "chave ausente ou inválida"). O valor da chave privada nunca é logado.
- O `subject` (contato do operador) é fornecido pelo operador no arquivo — não é inventado
  aqui. **Valor definido pelo operador (2026-09-11, dec-095): `https://app.moveelog.com.br`**
  (URL pública do painel; sem e-mail, para não expor endereço a serviços de push de
  terceiros). Gerado nos 3 arquivos via `gen-vapid.sh --force --subject
  https://app.moveelog.com.br` (dev/test/homolog).

**Alternatives considered**: variável de ambiente (viola FR-025); Docker Swarm secret
(mecanismo novo em produção sem precedente no runbook).

## Decision 3: Rotação de chave e `keyId`

**Decision**: `keyId` = 16 primeiros hex de `sha256(publicKey)`, calculado no boot. Toda
inscrição grava o `keyId` com que foi feita. Só inscrições com o `keyId` ativo são visadas.
No boot, o backend registra o `keyId` em `"PushChaveVapid"`; se já havia outra chave, grava
auditoria `push_chave_substituida` com autor = `geradoPor` do arquivo. O script
`infra/hub/scripts/gen-vapid.sh` gera o arquivo novo (par EC P-256 via `node:crypto`,
`chmod 600`).
**Rationale**: FR-026 (inscrições da chave antiga deixam de ser usadas) e FR-029 (rotação
auditada com autor). O app guarda localmente o `keyId` com que assinou e re-assina quando
o `keyId` servido muda, sem novo pedido de permissão (FR-008). A rotação em produção é
troca de arquivo + restart do serviço, sob o rito.
**Alternatives considered**: rota HTTP de rotação (expõe operação de segredo na API);
rotação sem registro (viola FR-029).

## Decision 4: Processamento em segundo plano e idempotência entre instâncias

**Decision**: fila em tabela (`"AvisoEntrega"`, uma linha por inscrição visada, criada no
mesmo `INSERT` do aviso). Um worker **dentro do backend** reivindica lotes com
`FOR UPDATE SKIP LOCKED` + lease (`lease_ate`, `lease_token`) e grava o resultado só se o
lease ainda for dele. Disparo = promessa fire-and-forget após responder `201`; no boot, o
backend retoma avisos `na_fila`/`em_andamento`. **At-most-once**: entrega em voo quando o
processo caiu (lease vencido) vira `falha` com motivo `interrompida` e **não** é reenviada
(dec-026).
**Rationale**:
- Precedentes do repo: `processarImportacao(...).catch(...)` antes do `201`
  (`BE/routes/hub-importacoes.js:380-389`) e recuperação de órfãos no boot que marca como
  falha em vez de reprocessar (`BE/server.js:2893-2901`; `BE/lib/hub-import-processor.js:974-986`).
- O claim atual (PATCH condicional + índice único, `hub-import-processor.js:199-212`;
  `MIG/0011:48-50`) garante **um job ativo**, não N entregas concorrentes; `SKIP LOCKED`
  + lease cobre FR-018 com mais de uma instância.
- `app_homologacao/docker-compose.yml:22,39,58` declara 1 réplica por serviço em produção, mas o
  arquivo está desatualizado (`:43,62` ainda roteiam domínios aposentados) — **[A VALIDAR]**
  com `docker service ls` pelo operador. O desenho não depende disso: SKIP LOCKED + lease já
  cobre N instâncias, e um worker separado seria mudança de arquitetura sem necessidade medida.
- Limites (constantes no código, com comentário `ponytail:` do teto): lote 50, concorrência
  10 envios simultâneos por aviso, um aviso por vez por processo, lease 120 s.

**Alternatives considered**: laço síncrono no request (proibido por FR-017); serviço/worker
separado (4º processo sem necessidade); advisory lock (não cobre lease por entrega).

## Decision 5: Classificação de respostas e re-tentativa

**Decision**:

| Resposta do serviço de push | Resultado |
|---|---|
| 2xx | `aceito` |
| 404 ou 410 | `morta` + a inscrição é apagada na mesma transação (FR-020) |
| 429, 5xx, timeout, erro de rede (sem `statusCode`) | transitória → até 3 tentativas, espera 1 s e 4 s; esgotou → `falha`/`transitoria_esgotada` |
| demais 4xx (400, 401, 403, 413…) | `falha`/`rejeitada`, sem re-tentativa |

Timeout por requisição: 10 s (opção `timeout`, `web-push-lib.js:222-223`). O lease de 120 s
cobre o pior caso de uma entrega (3 × 10 s + 5 s de espera).
**Rationale**: FR-019 (limitado, espera crescente) e FR-020. `Retry-After` do 429 não é
honrado (`ponytail:` — adicionar se o serviço de push limitar de forma medida).
**Alternatives considered**: backoff exponencial configurável (config para valor que não
muda); re-enfileirar a entrega para outra rodada (complica o at-most-once).

## Decision 6: Identidade do motorista e resolução de destinatários

**Decision**: a inscrição é chaveada pelo `cnpjPrestador` do token (dec-027). Modos:

- `toda_base`: todas as inscrições com o `keyId` ativo de contas ativas.
- `individual`: `Entregador.id` escolhidos → `Entregador.motorista_id` → `ContaMotorista.cnpj_prestador` → inscrições.
- `empresa`: `Entregador.id_empresa` escolhidas → mesmo caminho.

"Conta ativa" usa a mesma fonte do login: com `HUB_MOTORISTA_LOGIN_CONTA_ATIVA=true` →
`ContaMotorista.ativo`; senão → `Motorista.ativo` (legado).
**Rationale**:
- O token do motorista carrega só `cnpjPrestador`, `nome`, `aud` (e `entregadorUuid`, perdido
  no refresh): `BE/routes/motorista.js:135-149,350,490`. Não há id de conta nem empresa no
  token — `cnpjPrestador` é a única identidade estável server-side.
- Empresa do motorista no hub: `Entregador.id_empresa` (`MIG/0010_entregador.sql:16`)
  ligado à conta por `Entregador.motorista_id → ContaMotorista(id)`
  (`MIG/0021_conta_motorista.sql:50-58`). Empresa informada pelo app violaria a
  constitution §II.
- Login verifica `ContaMotorista.ativo` (`motorista.js:273`) ou `Motorista.ativo`
  (`motorista.js:346`) conforme a flag (`BE/lib/hub-motorista-app-login.js:19-22`): quem
  pode entrar é quem pode receber.
- Em produção, as tabelas do hub vivem dentro do `chatmasterveloz`
  (`infra/producao/backup-producao.sh:7-8`) junto do `Motorista` legado; no hub-homolog a
  cópia do schema legado existe (`MIG/0033_schema_legado_envio_massa.sql:176`). A função
  SQL alcança as duas fontes nos dois ambientes.

**Risco registrado**: motorista sem vínculo `Entregador ↔ ContaMotorista` só é alcançado no
modo `toda_base`. A tela explica isso, e a prévia de alcance mostra o número real.
[A VALIDAR] a quantidade de inscrições sem vínculo, medida em homolog antes do merge.
**Alternatives considered**: `id_empresa` informado pelo app (viola §II); movimentos do
legado `EnvioMassa` como fonte de empresa (vínculo por movimento, não por conta).

## Decision 7: Gate do grupo Movee e escopo no hub

**Decision**: nas rotas do hub, na ordem: `requireModuloAtivo('avisos')`
(`BE/middleware/hub-require-modulo.js:23-40`) → `requirePermission(...)`
(`BE/middleware/hub-require-permission.js:40-62`) → contexto por entidade (padrão de
`resolverContextoEntidade`, `BE/routes/hub-motoristas.js:149-168`) →
`await mesmoGrupoQue(entidadeAtiva, 6, cache)` com `const cache = {}` por requisição
(`BE/routes/grupo.js:895-935`). Fora do grupo → `403 FORA_DO_GRUPO_MOVEE`. Os claims do
PostgREST levam `escopo` = ids do grupo, obtidos por um helper `idsDoGrupo(6, cache)`
extraído de `mesmoGrupoQue`, que passa a usá-lo.
**Rationale**: FR-015/FR-016 e `CLAUDE.md` §Regras de domínio (nunca `id_empresa === 6`
estrito). `mesmoGrupoQue` é assíncrona e falha fechada, retornando `false`
(`grupo.js:933-935`). Nas funções SQL, `6 = ANY(hub_jwt_escopo_ids())` fica como defesa
em profundidade.
**Alternatives considered**: tabela `EmpresaGrupoMovee` (`MIG/0022`) como gate — é o
critério usado hoje por `hub-motoristas.js:220-222`, mas a regra de domínio manda
`mesmoGrupoQue`.

## Decision 8: Acesso a dados — RLS, funções e claims novos

**Decision**: as 5 tabelas novas nascem com RLS ligada. Hub **lê** `"Aviso"` direto por
escopo (padrão `id_empresa = ANY(hub_jwt_escopo_ids())`, `MIG/0048_performance_meta.sql:64-86`).
Toda **escrita** e todo acesso a dado de motorista passam por funções
`SECURITY DEFINER` com `SET search_path = public, pg_temp`, que derivam identidade dos claims
do JWT e nunca de parâmetro (precedentes de RPC definer que aplica o claim explicitamente:
`MIG/0050_performance_tempo_disponivel_periodo.sql:192`, `MIG/0051_performance_turnos_rpc.sql:151-155`).
Dois claims novos em
`generateHubPostgrestJWT` (`BE/lib/hub-postgrest-jwt.js:62-91`):
`motoristaCnpj → motorista_cnpj` (rotas do app) e `hubPushWorker → hub_push_worker`
(worker/boot), com helpers `hub_jwt_motorista_cnpj()` e `hub_jwt_push_worker()` no molde
de `hub_jwt_boot_recovery()` (`MIG/0018:52-61,99-107`).
**Rationale**: não existe papel de serviço; todo acesso é `authenticated` com claims
(`hub-postgrest-jwt.js:63`). A transferência de inscrição entre motoristas (FR-003) não
passa por uma política `UPDATE USING (cnpj = claim)`, por isso precisa de função definer.
FR-028.
**Alternatives considered**: políticas diretas por tabela para o motorista (bloqueiam a
transferência); chave de API de serviço (não existe e ampliaria privilégio).

## Decision 9: Criação e disparo em uma requisição idempotente

**Decision**: `POST /api/v1/avisos` cria o aviso e congela os destinatários
(`"AvisoEntrega"`) numa única função SQL. O cliente envia `chaveIdempotencia` (UUID gerado
por formulário aberto); `UNIQUE (criado_por, chave_idempotencia)` faz a repetição devolver
o mesmo aviso. A prévia de alcance é `GET /api/v1/avisos/alcance`. Zero inscrições no
momento do POST → `422 SEM_INSCRICOES_ATIVAS`, sem criar aviso (dec-029).
**Rationale**: FR-016 (prévia e bloqueio no zero), FR-017 (confirmação sem aguardar a
entrega) e FR-018 (duplo clique/repetição). O instantâneo em `"AvisoEntrega"` faz as
contagens baterem por construção (FR-022).
**Alternatives considered**: rascunho + disparo condicional (estado a mais, sem requisito).

## Decision 10: Validação do endpoint da inscrição (anti-SSRF) e gate de saída

**Decision**: o backend faz POST ao `endpoint` enviado pelo navegador
(`web-push-lib.js:369`); sem validação isso é SSRF a partir da rede interna, onde estão o
PostgREST e o banco. Regras, na inscrição **e** de novo antes de cada envio:
- URL parseável, `https:`, sem userinfo, sem porta explícita, até 2.000 caracteres;
- hostname (parseado, nunca regex na string) numa allowlist;
- `p256dh`/`auth` em base64url com tamanho limitado.

Allowlist inicial **[PROPOSTA — A VALIDAR com endpoints reais observados em Chrome/Android,
Firefox e Safari/iOS]**: `fcm.googleapis.com`, `updates.push.services.mozilla.com`,
`*.push.apple.com`, `*.notify.windows.com`. `PUSH_HOSTS_PERMITIDOS` substitui a lista (só em
teste/homolog, para o `push-mock`). Além disso, todo envio passa pelo gate de saída
existente `BE/lib/envio-gate.js` (`ENVIO_DRY_RUN`/`ENVIO_ALLOWLIST`, `:1-25`); bloqueado →
`falha`/`envio_bloqueado`.
**Rationale**: tier `cloud-public` + OWASP A10. O `envio-gate` já isola hub-test/homolog de
saída real.
**Alternatives considered**: aceitar qualquer `https:` (SSRF para hosts internos com TLS);
resolver DNS e bloquear IP privado (TOCTOU/DNS rebinding, mais código).

## Decision 11: Conteúdo, payload e opções de envio

**Decision**:
- título de 1 a 60 caracteres e mensagem de 1 a 180, texto puro, sem caracteres de controle;
- payload `{"avisoId":<int>,"titulo":"…","corpo":"…"}` com no máximo 1.024 bytes UTF-8,
  conferido antes de persistir;
- `TTL` 72 h, `urgency: 'normal'`, `timeout` 10 s.

**Rationale**:
- FR-012: só referência e texto curto, sem dado de motorista.
- FR-021: recusa antes do disparo.
- O `http_ece` cifra num registro de 4.096 bytes por padrão (`http_ece/ece.js:243`, cópia
  local), então o teto de aplicação fica bem abaixo.
- O TTL padrão da lib é 4 semanas (`web-push-lib.js:12-13`), o que entregaria aviso vencido
  semanas depois; 72 h cobre aparelho desligado num fim de semana (política de produto
  ajustável).
- Os limites 60/180 são política de "mensagem curta", não afirmação sobre a UI do sistema
  operacional.

**Alternatives considered**: limite só pelo tamanho do registro cifrado (mensagem longa
demais para notificação); `urgency: high` (gasto de bateria sem requisito).

## Decision 12: Service worker do app motorista

**Decision**: em `FM/app/sw.ts`, que hoje só instancia o Serwist e chama
`serwist.addEventListeners()` (`sw.ts:15-44`), adicionar:
- `push`: sempre `showNotification(titulo, { body: corpo, tag: 'aviso-<id>', icon: '/icons/icon-192x192.png', data: { url: '/avisos/<id>' } })`.
  O ícone vem de `FM/public/manifest.json`.
- `notificationclick`: fecha a notificação, foca uma janela existente e navega para
  `data.url`; sem janela, `clients.openWindow(data.url)`.
- Regra `NetworkOnly` para `/api/motorista/(avisos|push)/` antes da regra `NetworkFirst` de
  `/api/motorista/.*` (`sw.ts:33-40`). Conteúdo autenticado de aviso não pode ser servido
  do cache a outro motorista no mesmo aparelho.

**Rationale**:
- FR-011/FR-013.
- Push sempre visível: não há push silencioso.
- O SW não roda em `next dev` (`FM/next.config.mjs:11-14`), então a validação usa
  `next build && next start`.
- `pushsubscriptionchange` fica de fora (`ponytail:` — FR-008 reconfere a cada abertura
  autenticada; adicionar se houver inscrições perdidas entre aberturas, medido).

**Alternatives considered**: SW separado só para push (dois SW no mesmo escopo conflitam).

## Decision 13: Estado de ativação e plataforma no app

**Decision**: um módulo puro `FM/lib/push.ts` calcula o estado, **nesta ordem**:
1. iOS sem modo standalone → `ios_sem_instalacao` (FR-004);
2. sem `serviceWorker`/`PushManager`/`Notification` → `sem_suporte` (FR-006);
3. `Notification.permission === 'denied'` → `bloqueadas` (FR-005);
4. `granted` com inscrição → `ativas`;
5. demais casos → `nao_ativadas`.

Plataforma: `android` | `ios` | `desktop_outros`, derivada do user agent (iPadOS com UA de
desktop e toque conta como iOS). `Notification.requestPermission()` só dentro do handler de
clique do passo de contexto (FR-002).
**Rationale**: a ordem garante que um iPhone sem instalação veja a orientação de instalação
(FR-004), e não "sem suporte", independentemente de quais APIs de push o navegador expõe
nessa situação. Não existe código de detecção de iOS/standalone no app hoje: as únicas
ocorrências de `standalone` são `output: 'standalone'` (`FM/next.config.mjs:6`) e
`"display": "standalone"` (`FM/public/manifest.json:6`), nenhuma delas detecção. O iOS só
entrega push para PWA instalado (briefing `:31-35`).
**Alternatives considered**: biblioteca de detecção de UA (dependência para meia dúzia de
linhas).

## Decision 14: Login com retorno ao destino

**Decision**: `FM/app/(app)/layout.tsx` redireciona para `/login?next=<caminho atual>`, e o
login usa `next` após sucesso — só se começar com `/` e não com `//` ou `/\`.
**Rationale**: hoje o layout manda para `/login` sem destino (`layout.tsx:17-21`) e o login
vai fixo para `/movimento` em dois pontos: usuário já autenticado
(`FM/app/(auth)/login/page.tsx:34`) e sucesso do submit (`:66`) — a mudança toca os dois.
FR-013 exige voltar ao aviso depois do login. A checagem fecha open redirect.
**Alternatives considered**: guardar destino em `sessionStorage` (mais estado, mesma
validação).

## Decision 15: Revogação no logout

**Decision**: no `logout()` de `FM/contexts/auth-context.tsx` (`:118-127`), **antes** de
`/motorista/logout`:
1. `pushManager.getSubscription()` → `unsubscribe()` no aparelho — é a garantia principal;
2. `POST /motorista/push/inscricao/revogar` com o endpoint — garantia do servidor,
   best-effort.

**Rationale**:
- FR-009 e SC-008.
- `/motorista/logout` exige `authenticateMotorista` (`motorista.js:511-514`): com access
  vencido responde 401. A revogação no aparelho não depende disso.
- Revogar por endpoint preserva os outros aparelhos do motorista (FR-010).

**Alternatives considered**: revogar todas as inscrições do CNPJ no logout (derruba os
outros aparelhos).

## Decision 16: Estado reportado e cobertura

**Decision**: o app gera um `dispositivoId` aleatório (UUID em `localStorage`, sem dado
pessoal, não é token) e reporta `{ dispositivoId, estado, plataforma }` a cada abertura
autenticada. `"PushEstadoAtivacao"` guarda o último estado por aparelho. Se o mesmo
`dispositivoId` for reportado por outro motorista, o aparelho passa para ele (espelha
FR-003). Na cobertura, cada motorista é ativo em cada plataforma onde tem aparelho
`ativas`; sem aparelho ativo, conta como impedido pelo estado do aparelho mais recente.
**Rationale**: FR-007/FR-023/US4. Estados sem inscrição (bloqueadas, iOS sem instalação)
não têm endpoint, então é preciso um identificador de aparelho que não seja PII.
Constitution §I proíbe **tokens** em `localStorage`, não identificadores aleatórios.
**Alternatives considered**: `fingerprint` do aparelho (PII/rastreamento); contar por
inscrição (não cobre quem não se inscreveu).

## Decision 17: RBAC — módulo `avisos`

**Decision**: migration de seed no molde de `MIG/0047_modulo_validacao_xml.sql:16-51`:
- `"Modulo"` `avisos`;
- `"Permissao"` `avisos.consultar` (ver lista, resultado e cobertura) e `avisos.enviar`
  (prévia, busca de destinatários e disparo);
- `"PapelPermissao"` para `admin_plataforma` e `admin_entidade`;
- `"ModuloEntidade"` ativo para a empresa 6.

**Rationale**: FR-014.
- O menu já é data-driven: `/me` lista um módulo quando o usuário tem permissão com o
  prefixo do código (`BE/routes/hub-me.js:133-145`), e a rota vira `/hub/dashboard/avisos`
  (`FV2/lib/hub/module-nav.ts:156-159`).
- `ModuloEntidade` nega por padrão: filial futura do grupo precisa ter o módulo habilitado
  pelo admin.
- O cache de RBAC dura 60 s por processo (`BE/lib/hub-rbac-cache.js:28`).

**Alternatives considered**: permissão única (misturaria ver e disparar); `operador` com a
permissão por padrão (a spec pede permissão dedicada).

## Decision 18: Auditoria

**Decision**: `registrarAuditoria` (`BE/lib/hub-auditoria.js:148-158`), tabela
`"Auditoria"` (`MIG/0004_auditoria.sql:4-14`):
- `aviso_disparado`: `recurso: 'aviso'`, `recursoId`, e `detalhes` com
  `{ modo, empresas: [ids], qtdMotoristasIndividuais, visados }` — sem CNPJ e sem texto do
  aviso. O autor é o `usuarioId` e o momento é `criado_em`.
- `push_chave_substituida` e `push_chave_ativada`: `detalhes` com
  `{ keyIdAnterior, keyIdNovo, geradoPor }`, `idEmpresa: 6` e claims `escopo:[6]`
  (exigidos com `idEmpresa`, `hub-auditoria.js:105-111`).

Criação e disparo são **uma** ação atômica (Decision 9), então um evento registra ambos.
**Rationale**: FR-029. A trilha existente segue a própria política de 12 meses (FR-030,
`MIG/0041`).
**Alternatives considered**: tabela de auditoria própria (duplicaria a trilha); dois eventos
no mesmo instante (ruído sem informação nova).

## Decision 19: Expurgo de 90 dias

**Decision**: a função `hub_push_expurgo()` apaga `"AvisoEntrega"` e `"Aviso"` com
`criado_em < now() - interval '90 days'`, só com o claim `hub_push_worker`. O próprio
backend a chama no boot e a cada 24 h (timer `unref`), logando as contagens. É idempotente
com mais de uma instância (dec-028).
**Rationale**: FR-030. Existe precedente de job de host (`infra/hub/scripts/backup-daemon.sh:35-40`,
`infra/producao/backup-producao.sh:140-179`), mas o expurgo mensal de Auditoria em produção
só está documentado como cron do operador (`MIG/0041:18-20`) e não aparece em
`backup-producao.sh` — o host já derivou uma vez. No backend, o prazo vale onde o serviço
roda. Prazo fixo em 90 dias (sem parâmetro): o teste recua `criado_em` das linhas.
**Alternatives considered**: linha em `backup-producao.sh`/`backup-daemon.sh` (mudança de
host, sujeita ao mesmo drift); `pg_cron` (não existe no repo).

## Decision 20: Limite de taxa

**Decision**: `express-rate-limit` no molde dos limitadores do hub (chave pelo `sub`,
corpo `{ erro }`, `BE/routes/hub-robo-entrego.js:75-87`):
- escritas de push do motorista (inscrição, revogação, estado): 30 por 15 min por `cnpjPrestador`;
- disparo de aviso: 10 por 15 min por usuário do hub.

Excedido → `429 LIMITE_EXCEDIDO`, sem efeito colateral.
**Rationale**: FR-027. Os contadores ficam em memória por processo, como todos os
limitadores atuais (nenhum define `store`); com a réplica única declarada (a confirmar,
Decision 4) isso basta (`ponytail:` — store compartilhado se houver mais réplicas).
`trust proxy` já está configurado (`BE/server.js:157`).

## Decision 21: Estratégia de validação e testes

**Decision**:
- **Unit** (`node --test`, arquivos novos listados explicitamente em `test` e
  `test:hub:unit`, `BE/package.json:8,11`; conferir com `node scripts/checar-testes-orfaos.js`):
  DTO/limites/payload sem PII, allowlist, classificação/retry/pool/lease do worker, carga da
  chave e rotas (identidade pelo token, 403 fora do grupo com filial aceita, 422 zero).
- **Integração** (`test:hub:integration`, wrapper `tests/hub-avisos.test.js` →
  `infra/hub/testes/hub-avisos-integration.sh`, no molde de `tests/hub-papeis.test.js:20-48`
  e `hub-papeis-integration.sh:27-67`): compose hub-test efêmero com um **`push-mock` HTTPS**
  novo, no padrão dos mocks `node:20-alpine` (`infra/hub/compose.hub.test.yml:60-75`,
  `infra/hub/mocks/n8n-mock/server.js`). Status por endpoint programável e log JSONL do
  corpo recebido. HTTPS porque o `web-push` usa `https.request`; o certificado autoassinado
  é gerado pelo driver com `openssl` e confiado só no backend de teste via
  `NODE_EXTRA_CA_CERTS`.
- **E2E hub**: `playwright.config.hub-avisos.ts` + driver `infra/hub/testes/hub-avisos-e2e-browser.sh`
  (molde `hub-shell-e2e-browser.sh`, Playwright em container).
- **E2E motorista**: o app não tem runner de teste (`FM/package.json` sem `test`) e o
  hub-homolog não tem instância dele (`infra/hub/compose.hub.homolog.yml` sem
  `frontend_motorista`). Adicionar o serviço `frontend-motorista` aos compose do hub
  (recurso `hub-*`) e um `playwright.config.motorista-push.ts` em `FV2` (onde o Playwright
  já está). As APIs `Notification`/`PushManager`/`serviceWorker` são stubadas por init
  script, o que conta `requestPermission` (SC-001) e emula UA iOS + `display-mode` (SC-002).
- **Aparelho real (SC-003)**: teste manual controlado. O hub-homolog escuta só em loopback
  com certificado autoassinado (`compose.hub.homolog.yml:219-233`), e SW + push num celular
  exigem origem HTTPS confiável alcançável — **[A VALIDAR com o operador na fase de
  validação]**: túnel autenticado ou janela em produção sob o rito.
- **Imagem**: o backend do hub-homolog roda de imagem buildada — rebuildar antes de testar
  rota nova (briefing `:116-118`).

## Decision 22: Backup e restauração

**Decision**: sem mecanismo novo. As tabelas novas entram no dump diário do `chatmasterveloz`,
que já inclui as tabelas do hub (`infra/producao/backup-producao.sh:7-8`, timer 03:30 UTC,
retenção de 14 dias em `:49`).
**Rationale**: confirma a assumption da spec. Consequência declarada: dado expurgado aos 90
dias pode sobreviver até 14 dias nos dumps de backup.

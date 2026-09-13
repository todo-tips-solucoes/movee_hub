# Data Model: Notificações push no app do motorista

Tabelas novas no banco do hub, criadas pela série `infra/hub/migrations/NNNN_*.sql`
(aplicada por `infra/hub/scripts/migrate.sh`). Os números propostos são `0061_push_avisos.sql`
(schema, RLS e funções) e `0062_modulo_avisos.sql` (seed de RBAC). O número definitivo é
conferido na hora de criar o arquivo: a série é única e há outra sessão ativa no repo.

Convenções herdadas (tabela + RLS: `infra/hub/migrations/0048_performance_meta.sql:35-86`;
RPC definer com escopo explícito: `0051_performance_turnos_rpc.sql:151-155`):
- tabelas em `"PascalCase"` com aspas, colunas em `snake_case`;
- `CREATE TABLE IF NOT EXISTS`, `DROP POLICY IF EXISTS` + `CREATE POLICY`,
  `CREATE OR REPLACE FUNCTION … SECURITY DEFINER` com `SET search_path = public, pg_temp`
  (forma de `0051:152`);
- `GRANT` a `authenticated`, incluindo sequences;
- timestamps `timestamptz NOT NULL DEFAULT now()`;
- PK `serial`/`bigserial`;
- nenhuma coluna guarda segredo — a chave privada VAPID fica fora do banco.

## Entity: Aviso

| Field | Type | Constraints | Notes |
|-------|------|-------------|-------|
| id | serial | PK | referência que viaja no push (`avisoId`) |
| id_empresa | int | NOT NULL | entidade ativa do autor (membro do grupo Movee); coluna de escopo da RLS |
| titulo | text | NOT NULL, CHECK `char_length BETWEEN 1 AND 60` | texto da equipe (FR-021) |
| corpo | text | NOT NULL, CHECK `char_length BETWEEN 1 AND 180` | texto da equipe (FR-021) |
| modo_destinatarios | text | NOT NULL, CHECK IN (`toda_base`,`individual`,`empresa`) | FR-016 |
| destinatarios_ids | int[] | NOT NULL DEFAULT `'{}'`, CHECK (vazio ⇔ `toda_base`) | `Entregador.id` (individual) ou `Empresa.id` (empresa) |
| status | text | NOT NULL DEFAULT `na_fila`, CHECK IN (`na_fila`,`em_andamento`,`concluido`) | FR-022 |
| chave_idempotencia | uuid | NOT NULL | gerada pelo cliente por formulário |
| criado_por | int | NOT NULL, FK `"Usuario"(id)` | autor |
| criado_em | timestamptz | NOT NULL DEFAULT now() | momento da criação **e** do disparo (ação única) |
| iniciado_em | timestamptz | NULL | primeira reivindicação do worker |
| concluido_em | timestamptz | NULL | |

Índices: `UNIQUE (criado_por, chave_idempotencia)`; `idx_aviso_empresa_criado (id_empresa, criado_em DESC)`;
`idx_aviso_pendente (status) WHERE status <> 'concluido'`; `idx_aviso_criado_em (criado_em)` (expurgo).

### State Transitions

```
na_fila ──(worker reivindica o 1º lote)──> em_andamento ──(sem pendente/processando)──> concluido
```

`concluido` é terminal. Nada volta a `na_fila`. Reinício do backend retoma `na_fila` e
`em_andamento` (FR-018).

## Entity: AvisoEntrega

Fila e registro de entrega: uma linha por inscrição visada, congelada no disparo.

| Field | Type | Constraints | Notes |
|-------|------|-------------|-------|
| id | bigserial | PK | |
| aviso_id | int | NOT NULL, FK `"Aviso"(id)` ON DELETE CASCADE | |
| inscricao_id | int | NULL, FK `"PushInscricao"(id)` ON DELETE SET NULL | fica NULL se a inscrição for apagada |
| cnpj_prestador | text | NOT NULL | destinatário no instante do disparo (dígitos); PII sujeita ao expurgo |
| status | text | NOT NULL DEFAULT `pendente`, CHECK IN (`pendente`,`processando`,`aceito`,`falha`,`morta`) | |
| motivo | text | NULL, CHECK IN (`transitoria_esgotada`,`rejeitada`,`interrompida`,`inscricao_indisponivel`,`chave_substituida`,`envio_bloqueado`) | só com `falha` |
| tentativas | smallint | NOT NULL DEFAULT 0 | |
| lease_ate | timestamptz | NULL | vence ⇒ entrega em voo vira `falha`/`interrompida` |
| lease_token | uuid | NULL | gerado pelo worker por reivindicação |
| criado_em | timestamptz | NOT NULL DEFAULT now() | |
| atualizado_em | timestamptz | NOT NULL DEFAULT now() | momento do resultado |

Índices: `UNIQUE (aviso_id, inscricao_id)`; `idx_avisoentrega_aviso_status (aviso_id, status)`;
`idx_avisoentrega_cnpj_aviso (cnpj_prestador, aviso_id)`.

### State Transitions

```
pendente ──reivindicar──> processando ──2xx──────────────> aceito
    │                          ├──404/410─────────────────> morta   (+ apaga PushInscricao)
    │                          ├──transitória ×3 / 4xx────> falha   (transitoria_esgotada | rejeitada | envio_bloqueado)
    │                          └──lease vencido───────────> falha   (interrompida — nunca reenvia)
    └──inscrição apagada/transferida/chave antiga──────────> falha   (inscricao_indisponivel | chave_substituida)
```

**Invariante (FR-022/SC-006)**: `visados = count(*)` por aviso. Com o aviso `concluido`,
`count(pendente) = count(processando) = 0` e portanto `aceitos + falhas + mortas = visados`.
As contagens são sempre calculadas das linhas, nunca guardadas em contador.

## Entity: PushInscricao

| Field | Type | Constraints | Notes |
|-------|------|-------------|-------|
| id | serial | PK | |
| cnpj_prestador | text | NOT NULL | dono atual, sempre do claim `motorista_cnpj` (FR-003) |
| endpoint | text | NOT NULL, CHECK `char_length <= 2000` | URL de capacidade — nunca em log (FR-031) |
| endpoint_hash | text | NOT NULL, UNIQUE | sha256 hex calculado no backend; chave de upsert e de log |
| p256dh | text | NOT NULL | base64url |
| auth | text | NOT NULL | base64url |
| key_id | text | NOT NULL | `keyId` VAPID com que a inscrição foi feita (FR-026) |
| plataforma | text | NOT NULL, CHECK IN (`android`,`ios`,`desktop_outros`) | |
| dispositivo_id | uuid | NOT NULL | liga ao estado do aparelho |
| criado_em / atualizado_em | timestamptz | NOT NULL DEFAULT now() | |

Índices: `idx_pushinscricao_cnpj (cnpj_prestador)`; `idx_pushinscricao_key (key_id)`.

Ciclo de vida:
- **upsert** por `endpoint_hash`: registrar sob outro CNPJ transfere o vínculo;
- **delete** no logout (revogar), em 404/410 (morta) ou quando o app detecta uma troca de
  inscrição.

Sem soft delete: inscrição apagada não pode ser visada (SC-006).

## Entity: PushEstadoAtivacao

| Field | Type | Constraints | Notes |
|-------|------|-------------|-------|
| dispositivo_id | uuid | PK | aleatório, gerado no app |
| cnpj_prestador | text | NOT NULL | dono atual; outro motorista no mesmo aparelho transfere |
| estado | text | NOT NULL, CHECK IN (`ativas`,`bloqueadas`,`ios_sem_instalacao`,`sem_suporte`,`nao_ativadas`) | FR-007 |
| plataforma | text | NOT NULL, CHECK IN (`android`,`ios`,`desktop_outros`) | |
| atualizado_em | timestamptz | NOT NULL DEFAULT now() | |

Índice: `idx_pushestado_cnpj (cnpj_prestador)`. A revogação no logout apaga a linha do
aparelho.

## Entity: PushChaveVapid

Histórico público das chaves ativadas. Não guarda segredo.

| Field | Type | Constraints | Notes |
|-------|------|-------------|-------|
| key_id | text | PK | 16 hex de sha256(publicKey) |
| chave_publica | text | NOT NULL | base64url, pública |
| gerado_por | text | NULL | metadado do arquivo de chave |
| ativada_em | timestamptz | NOT NULL DEFAULT now() | |

### Relationships

- `"Aviso"` 1:N `"AvisoEntrega"` via `aviso_id`
- `"PushInscricao"` 1:N `"AvisoEntrega"` via `inscricao_id` (SET NULL ao apagar)
- `"PushEstadoAtivacao"` 1:0..1 `"PushInscricao"` via `dispositivo_id`, lógico e sem FK
- `"Usuario"` 1:N `"Aviso"` via `criado_por`
- Resolução de destinatários, só leitura e sem FK nova:
  `"Entregador".motorista_id → "ContaMotorista".id` (`0021_conta_motorista.sql:50-58`),
  `"ContaMotorista".cnpj_prestador = "PushInscricao".cnpj_prestador`,
  `"Entregador".id_empresa` (`0010_entregador.sql:16`)
- Conta ativa: `"ContaMotorista".ativo` (`0021:22`) ou `"Motorista".ativo`
  (legado, `0033_schema_legado_envio_massa.sql:176`), conforme a fonte do login

## Claims e helpers (JWT do PostgREST)

| Claim no JWT | Origem no backend (`generateHubPostgrestJWT`) | Helper SQL | Quem usa |
|---|---|---|---|
| `sub`, `empresa_ativa`, `escopo` | já existem (`lib/hub-postgrest-jwt.js:64-73`) | `hub_jwt_claims()`, `hub_jwt_escopo_ids()` (`0006:35-61`) | rotas do hub; `escopo` = ids do grupo Movee |
| `motorista_cnpj` | **novo**: `claims.motoristaCnpj` ← `req.motorista.cnpjPrestador` | `hub_jwt_motorista_cnpj()` **novo** | rotas `/motorista/push/*` e `/motorista/avisos/*` |
| `hub_push_worker` | **novo**: `claims.hubPushWorker === true` | `hub_jwt_push_worker()` **novo** | worker, boot e expurgo |

## RLS (FR-028)

`ENABLE ROW LEVEL SECURITY` nas 5 tabelas. Nenhuma política permissiva de escrita para
usuários: toda escrita passa pelas funções abaixo.

| Tabela | Política | Regra |
|---|---|---|
| Aviso | `aviso_select_por_escopo` | `SELECT USING (id_empresa = ANY(hub_jwt_escopo_ids()))` |
| Aviso | `aviso_select_worker` | `SELECT USING (hub_jwt_push_worker())` (retomada no boot) |
| PushChaveVapid | `pushchave_select_worker` / `pushchave_insert_worker` | `USING/WITH CHECK (hub_jwt_push_worker())` |
| AvisoEntrega, PushInscricao, PushEstadoAtivacao | — | sem política ⇒ só as funções definer acessam |

## Funções (`SECURITY DEFINER`, `search_path = public, pg_temp`, `EXECUTE` a `authenticated`)

Cada função valida primeiro o claim exigido e levanta exceção se ele faltar. Nenhuma recebe
identidade ou escopo por parâmetro.

| Função | Claim exigido | Efeito |
|---|---|---|
| `hub_push_inscricao_registrar(p_endpoint, p_endpoint_hash, p_p256dh, p_auth, p_key_id, p_plataforma, p_dispositivo_id)` | `motorista_cnpj` | upsert por `endpoint_hash` com `cnpj_prestador = claim`; upsert do estado `ativas` do aparelho |
| `hub_push_inscricao_revogar(p_endpoint_hash, p_dispositivo_id)` | `motorista_cnpj` | apaga a inscrição **e** o estado daquele aparelho, se forem do claim; idempotente |
| `hub_push_estado_reportar(p_dispositivo_id, p_estado, p_plataforma)` | `motorista_cnpj` | upsert por `dispositivo_id` com `cnpj_prestador = claim` |
| `hub_aviso_para_motorista(p_aviso_id)` | `motorista_cnpj` | devolve `id, titulo, corpo, criado_em` só se existir `AvisoEntrega` do aviso com `cnpj_prestador = claim`; senão 0 linhas |
| `hub_aviso_alcance(p_modo, p_ids, p_key_id, p_fonte_conta)` | `sub` + `6 = ANY(escopo)` | `motoristas, inscricoes` que o disparo alcançaria agora |
| `hub_aviso_criar(p_titulo, p_corpo, p_modo, p_ids, p_chave_idempotencia, p_key_id, p_fonte_conta)` | `sub` + `6 = ANY(escopo)` | idempotente por `(sub, chave)`; `INSERT "Aviso"` (`id_empresa = empresa_ativa`, `criado_por = sub`) + `INSERT "AvisoEntrega" SELECT …`; 0 visados ⇒ exceção `SEM_INSCRICOES_ATIVAS` (nada gravado); retorna `aviso_id, visados, reutilizado` |
| `hub_aviso_resumo(p_aviso_ids int[])` | `6 = ANY(escopo)` + aviso no escopo | contagens por aviso: `visados, pendentes, processando, aceitos, falhas, mortas` |
| `hub_push_cobertura()` | `6 = ANY(escopo)` | `ativos` por plataforma, `impedidos` por estado, `nao_ativadas` (regra da research Decision 16) |
| `hub_push_reivindicar(p_aviso_id, p_limite, p_lease_segundos, p_lease_token, p_key_id)` | `hub_push_worker` | ver sequência abaixo |
| `hub_push_registrar_resultado(p_entrega_id, p_lease_token, p_status, p_motivo, p_tentativas)` | `hub_push_worker` | atualiza só se `status = 'processando' AND lease_token = p_lease_token`; se `morta`, apaga a inscrição; retorna se aplicou |
| `hub_push_expurgo()` | `hub_push_worker` | apaga `AvisoEntrega` e `Aviso` com `criado_em < now() - interval '90 days'`; retorna contagens (FR-030) |

Sequência de `hub_push_reivindicar`, numa transação:
1. `Aviso`: `na_fila → em_andamento`, `iniciado_em = coalesce(iniciado_em, now())`.
2. Entregas `processando` com `lease_ate < now()` → `falha`/`interrompida`.
3. Entregas `pendente` inelegíveis:
   - `inscricao_id` NULL, ou `PushInscricao.cnpj_prestador <> AvisoEntrega.cnpj_prestador`
     (transferida) → `falha`/`inscricao_indisponivel`;
   - `key_id <> p_key_id` → `falha`/`chave_substituida`.
4. Até `p_limite` entregas `pendente` `ORDER BY id FOR UPDATE SKIP LOCKED` →
   `processando`, com `lease_ate = now() + p_lease_segundos` e `lease_token = p_lease_token`.
   Retorna `entrega_id, endpoint, p256dh, auth`.
5. Sem `pendente` nem `processando` restante → `Aviso.status = 'concluido'`,
   `concluido_em = now()`.

Filtro de destinatários, em `hub_aviso_alcance` e `hub_aviso_criar`:
- **Sempre**: `PushInscricao.key_id = p_key_id` e conta ativa. Com `p_fonte_conta = 'conta_motorista'`
  vale `EXISTS ContaMotorista(cnpj, ativo)`; com `'legado'`, `EXISTS Motorista(cnpj, ativo)`.
  O backend passa a fonte por `hubMotoristaLoginHabilitado(env)`.
- `toda_base`: sem filtro adicional. O app é exclusivo do grupo Movee
  (`CLAUDE.md` §Regras de domínio).
- `individual`: `Entregador.id = ANY(p_ids)` e `Entregador.id_empresa = ANY(hub_jwt_escopo_ids())`,
  ligado por `ContaMotorista`.
- `empresa`: `Entregador.id_empresa = ANY(p_ids)`, com `p_ids ⊆ hub_jwt_escopo_ids()`
  validado; se não, exceção `DESTINATARIOS_FORA_DO_ESCOPO`.

## Retenção (FR-030)

| Dado | Prazo | Mecanismo |
|---|---|---|
| `Aviso`, `AvisoEntrega` (quem recebeu o quê e quando) | 90 dias após `criado_em` | `hub_push_expurgo()` chamado pelo backend no boot + a cada 24 h |
| `PushInscricao`, `PushEstadoAtivacao` | enquanto ativos (estado corrente, não histórico) | apagados no logout, em 404/410 ou na transferência |
| Eventos `aviso_disparado` / `push_chave_*` em `"Auditoria"` | 12 meses (política existente) | `hub_auditoria_expurgo` (`0041`) — não alterado |
| Dumps de backup | até 14 dias além do expurgo | `infra/producao/backup-producao.sh:49` — declarado, sem mudança |

## Seed de RBAC (`0062_modulo_avisos.sql`)

No molde de `0047_modulo_validacao_xml.sql:16-51`, tudo com `ON CONFLICT DO NOTHING`:
1. `"Modulo"` (`codigo='avisos'`, `nome='Avisos'`, `ordem` = maior ordem + 1)
2. `"Permissao"` `avisos.consultar` e `avisos.enviar`
3. `"PapelPermissao"`: `admin_plataforma` e `admin_entidade` × as 2 permissões
4. `"ModuloEntidade"` (`avisos`, `empresa_id = 6`, `ativo = true`)

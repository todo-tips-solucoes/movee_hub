# Implementation Plan: Notificações push no app do motorista

**Feature**: `envioMassa_homologacao` | **Date**: 2026-09-11 | **Spec**: [spec.md](./spec.md)
**Tier de entrega**: `cloud-public` (escopo pleno) | **Fonte**: [BRIEFING-PUSH-MOTORISTA.md](../../plans/push-motorista/BRIEFING-PUSH-MOTORISTA.md)

## Summary

A equipe Moveelog cria no hub um aviso (título + mensagem curta), escolhe os destinatários e
dispara. O motorista do grupo Movee recebe uma notificação do sistema, mesmo com o app
fechado, e ao tocar abre o detalhe do aviso, buscado já autenticado.

Abordagem técnica (detalhe e evidências em [research.md](./research.md)):

- **Canal**: Web Push nativo com VAPID (decisão do operador), pela biblioteca `web-push`
  3.6.7 no backend Express existente. A chave privada fica num arquivo em
  `/var/lib/hub_secrets/`, montado read-only.
- **App do motorista (PWA Next.js + Serwist)**:
  - handlers `push` e `notificationclick` no `sw.ts` existente;
  - máquina de estados de ativação que trata iOS sem instalação, permissão bloqueada e sem
    suporte;
  - passo de contexto antes da permissão, re-assinatura a cada abertura autenticada e
    revogação no logout;
  - rota `/avisos/[id]` e retorno ao destino após o login.
- **Hub (Next.js + Base UI)**: módulo `avisos`, data-driven pelo `/me`, com lista, cobertura
  por plataforma, diálogo de criação com prévia de alcance e tela de resultado com polling.
- **Backend**:
  - rotas novas `/motorista/push/*`, `/motorista/avisos/:id` e `/api/v1/avisos/*`;
  - gate de grupo por `mesmoGrupoQue`;
  - worker **dentro do processo** que consome uma fila em tabela com
    `FOR UPDATE SKIP LOCKED` + lease: at-most-once por inscrição, lotes com concorrência
    limitada, re-tentativa limitada e limpeza de inscrição 404/410;
  - expurgo de 90 dias chamado pelo próprio backend.
- **Dados**: 5 tabelas novas no banco do hub, com RLS e funções `SECURITY DEFINER` que tiram
  a identidade dos claims do JWT; seed de RBAC (`avisos.consultar`, `avisos.enviar`);
  auditoria na trilha existente.

## Technical Context

**Language/Version**:
- **Backend**: JavaScript em Node.js 20 (`node:20-alpine`, `app_homologacao/backend/Dockerfile.hub:23`).
- **Frontends**: TypeScript (`strict`); o `frontend_motorista` usa Next.js 16.2.3 e React 19.2.4
  (`frontend_motorista/package.json:15`, `tsconfig.json:7`); o `frontend_v2` usa Next.js App
  Router (versão no próprio `package.json`).

**Primary Dependencies**:
- **Backend**: express ^4.17.1, express-rate-limit ^6.11.2, jsonwebtoken ^8.5.1
  (`backend/package.json`), mais **web-push 3.6.7 (nova)**.
- **Motorista**: serwist + @serwist/next ^9.0.0.
- **Hub**: @base-ui/react ^1.3.0 + shadcn, sonner.
- Nenhuma dependência nova de frontend.

**Storage**:
- PostgreSQL via PostgREST, banco do hub, migrations `infra/hub/migrations/NNNN_*.sql`.
- hub-homolog: postgres:13 + postgrest v14.1 (`infra/hub/compose.hub.homolog.yml:42,63`).
- Produção: tabelas do hub dentro do `chatmasterveloz` (`infra/producao/backup-producao.sh:7-8`).
- Sem ORM.

**Testing**:
- **Backend**: `node --test` com arquivos listados explicitamente (`backend/package.json:8,11,12`)
  + `scripts/checar-testes-orfaos.js`; integração em compose hub-test efêmero
  (`infra/hub/testes/*-integration.sh`).
- **Frontends**: vitest no `frontend_v2` (`vitest.config.ts:7-19`); Playwright em container
  pelos drivers `infra/hub/testes/*-e2e-browser.sh`. O `frontend_motorista` não tem runner:
  é coberto por Playwright stubado + `tsc` + `next build`.

**Target Platform**: Docker Swarm no host VPSTodo (produção, `CLAUDE.md`; constitution §V) + navegadores com Web Push (briefing). Detalhe:
- **Produção**: Docker Swarm no VPSTodo, **1 réplica por serviço confirmada** (`docker
  service ls`, medido pelo operador em 2026-09-11: `envio-massa-homologacao_backend_homologacao`,
  `_frontend_v2_homologacao`, `_frontend_motorista_homologacao` e `_frontend_homologacao`,
  todos `replicated 1/1` — dec-044/block-005). `app_homologacao/docker-compose.yml:22,39,58`
  segue desatualizado quanto a domínios (`:43,62`), mas a contagem de réplicas está validada.
- **Validação**: hub-test (efêmero) e hub-homolog (loopback, `compose.hub.homolog.yml:219-233`).
- **Clientes**: Chrome/Edge/Firefox/Samsung e Safari iOS 16.4+ com PWA instalado (briefing).

**Project Type**: web-service (API Express) + 2 web apps (PWA motorista; hub em `frontend_v2`).

**Performance Goals**:
- confirmação do disparo em ≤ 3 s (SC-004);
- notificação em ≤ 1 min em ≥ 95% das aceitas (SC-003);
- demais telas responsivas durante o envio (SC-005).

**Constraints**:
- sem PII no payload, que tem no máximo 1.024 bytes;
- chave privada VAPID só em `/var/lib/hub_secrets/`;
- at-most-once por inscrição, com várias instâncias;
- concorrência limitada: lote 50, 10 simultâneos por aviso, 1 aviso por vez por processo;
- iOS só com PWA instalado;
- SW e push exigem HTTPS;
- rate limit em inscrição e disparo;
- toda escrita no ambiente vivo sob os 5 gates.

**Scale/Scope**:
- base do app = motoristas do grupo Movee (ordem de centenas a poucos milhares de inscrições —
  **[A VALIDAR]** com contagem de `ContaMotorista`/inscrições no hub-homolog antes do merge;
  nenhum número afirmado sem medição);
- 5 tabelas, 11 funções SQL, 2 claims novos;
- 12 endpoints novos (5 do app, 7 do hub), 3 telas no hub, 1 rota + 1 componente no app.

## Constitution Check

*GATE: executado antes do Phase 0 e re-checado após o Phase 1 (resultado final abaixo).*
Governança: `docs/constitution.md` v1.1.0.

| Princípio | Status | Notas |
|-----------|--------|-------|
| I. Segurança de Autenticação & Segredos (NON-NEGOTIABLE) | PASS | Auth inalterada: cookies httpOnly do motorista (`routes/motorista.js:181-195`) e do hub. Chave privada VAPID fora do git, da imagem, do env e dos logs, só em arquivo montado read-only de `/var/lib/hub_secrets/` (research D2). O `localStorage` do app guarda só UUID aleatório e flags de UI — **nenhum token**. Logs sem endpoint completo nem chaves (FR-031). |
| II. Isolamento Multi-Tenant por Empresa (NON-NEGOTIABLE) | PASS | Motorista identificado só pelo token (`req.motorista.cnpjPrestador`); corpo ignorado (FR-003). Hub: escopo pela entidade ativa do token + `mesmoGrupoQue(_, 6, cache)`. `destinatariosIds` é **seleção** validada contra o escopo no servidor e na função SQL, nunca define o tenant. RLS nas 5 tabelas, funções que tiram identidade do claim (D7, D8). |
| III. Contratos de API & Proxy de Cookies | PASS | Os dois apps falam só pelos proxies `/api/*` existentes (`frontend_motorista/app/api/[...path]/route.ts:9-37`; `frontend_v2/app/api/[...path]/route.ts`). O SW busca conteúdo pelo mesmo proxy. SHOULD: documentar os endpoints novos em `app_homologacao/backend/README.md` na mesma entrega (tarefa explícita). |
| IV. Qualidade e Revisão de Mudanças | PASS | Branch dedicada, Conventional Commits, `git add` por caminho explícito (rito do ciclo git do `CLAUDE.md`). SHOULD de revisão OWASP: a feature toca autenticação/sessão → gate `owasp-security` após este plan. Uploads/XML: N/A. |
| V. Deploy Conteinerizado e Convivência de Serviços (NON-NEGOTIABLE) | PASS | **Nenhum serviço novo em produção**: worker e expurgo rodam dentro do backend existente. Serviços novos (`push-mock`, `frontend-motorista` de validação) só nos compose `hub-*` isolados. Mudança em produção = imagens novas + `--mount-add` do arquivo de chave + `--env-add VAPID_KEYS_FILE`, via `docker service update` sob o rito, sem disputar portas. |
| Padrões de Qualidade | PASS | Mensagens em português por código de erro. Timeouts: `web-push` `timeout: 10000`; app via `fetchWithTimeout` com AbortController (`frontend_motorista/lib/api-client.ts:8-27`); hub via wrapper existente. |

**Re-check pós-design (Phase 1)**: PASS. O design não adicionou serviço, camada ou
dependência de frontend. A única dependência nova é `web-push` (D1). As 11 funções SQL
seguem o padrão existente de RPC `SECURITY DEFINER` que aplica o claim explicitamente
(`0050_performance_tempo_disponivel_periodo.sql:192`, `0051_performance_turnos_rpc.sql:151-155`)
e de helper de claim (`0018:52-61`), exigido pela transferência de inscrição (FR-003) e pelo
at-most-once (FR-018). Nenhuma violação a justificar.

## Project Structure

### Documentation (this feature)

```
docs/specs/envioMassa_homologacao/
├── spec.md
├── plan.md              # este arquivo
├── research.md          # Phase 0 — 22 decisões
├── data-model.md        # Phase 1 — tabelas, RLS, funções, retenção
├── quickstart.md        # Phase 1 — 21 cenários (inclui roundtrip E2E)
└── contracts/
    ├── motorista-push.md  # /motorista/push/*, /motorista/avisos/:id, payload, SW
    └── hub-avisos.md      # /api/v1/avisos/* + telas
```

### Source Code (repository root)

Diretórios existentes conferidos nesta sessão; `(novo)` marca arquivo a criar e
`(alterar)` marca arquivo existente.

```
app_homologacao/backend/
├── server.js                           (alterar) montar /api/v1/avisos e sub-router push em /motorista; boot: chave VAPID → retomar avisos → timer de expurgo
├── routes/
│   ├── motorista.js                    (sem mudança de contrato) authenticateMotorista reutilizado
│   ├── motorista-push.js               (novo) chave-publica, inscricao, revogar, estado, avisos/:id
│   ├── hub-avisos.js                   (novo) lista, detalhe, alcance, criar, destinatarios, cobertura
│   └── grupo.js                        (alterar) extrair idsDoGrupo(idRef, cache), usado por mesmoGrupoQue
├── lib/
│   ├── hub-postgrest-jwt.js            (alterar) claims motoristaCnpj → motorista_cnpj; hubPushWorker → hub_push_worker
│   ├── hub-avisos-dto.js               (novo) validação título/corpo/modo/ids, payload ≤1024 bytes, mappers camelCase
│   ├── hub-push-endpoint.js            (novo) validação de endpoint/chaves + allowlist de hosts
│   ├── hub-push-vapid.js               (novo) carga/validação do arquivo, keyId, registro no boot + auditoria
│   ├── hub-push-worker.js              (novo) reivindicar → enviar (pool 10) → registrar; retry; retomada; expurgo 24h
│   ├── envio-gate.js                   (reusar) gate de saída ENVIO_DRY_RUN/ENVIO_ALLOWLIST
│   └── hub-auditoria.js                (reusar) registrarAuditoria
├── middleware/hub-require-{modulo,permission}.js  (reusar)
├── tests/
│   ├── hub-avisos-dto-unit.test.js     (novo)
│   ├── hub-push-endpoint-unit.test.js  (novo)
│   ├── hub-push-vapid-unit.test.js     (novo)
│   ├── hub-push-worker-unit.test.js    (novo)
│   ├── hub-avisos-rotas-unit.test.js   (novo)
│   ├── motorista-push-rotas-unit.test.js (novo)
│   └── hub-avisos.test.js              (novo) wrapper de integração → infra/hub/testes/hub-avisos-integration.sh
├── scripts/checar-testes-orfaos.js     (alterar) EXIGEM_AMBIENTE += hub-avisos.test.js
├── package.json                        (alterar) dep web-push 3.6.7; testes novos listados em test / test:hub:unit / test:hub:integration
└── README.md                           (alterar) endpoints novos (constitution III)

app_homologacao/frontend_motorista/
├── app/sw.ts                           (alterar) push + notificationclick + NetworkOnly para avisos/push
├── app/(app)/layout.tsx                (alterar) redirect com ?next=
├── app/(app)/avisos/[id]/page.tsx      (novo) detalhe do aviso / "Aviso não disponível"
├── app/(app)/movimento/page.tsx        (alterar) ponto de entrada "Notificações" + card de contexto
├── app/(auth)/login/page.tsx           (alterar) respeitar next seguro
├── components/notificacoes.tsx         (novo) contexto, estado, ativar, orientação iOS/bloqueadas
├── contexts/auth-context.tsx           (alterar) sincronizar inscrição/estado na abertura; revogar antes do logout
└── lib/push.ts                         (novo) detecção de estado/plataforma, subscribe/sync/revogar, base64url

app_homologacao/frontend_v2/
├── app/hub/dashboard/avisos/page.tsx       (novo) cobertura + lista + "Novo aviso"
├── app/hub/dashboard/avisos/[id]/page.tsx  (novo) resultado com polling
├── components/hub/novo-aviso-dialog.tsx    (novo) formulário, modos, multi-seleção, prévia
├── lib/hub/avisos-api.ts                   (novo) cliente via criarRequest + mensagens por código
├── lib/hub/avisos-dto.ts                   (novo) parsers (+ teste vitest com payload real capturado)
├── lib/hub/module-nav.ts                   (alterar, opcional) ícone/descrição do módulo avisos
├── playwright.config.hub-avisos.ts         (novo) + tests/e2e-hub-avisos/
└── playwright.config.motorista-push.ts     (novo) + tests/e2e-motorista-push/ (stubs de Notification/PushManager)

infra/hub/
├── migrations/0061_push_avisos.sql         (novo; número conferido na criação) tabelas, RLS, helpers, funções
├── migrations/0062_modulo_avisos.sql       (novo) seed Modulo/Permissao/PapelPermissao/ModuloEntidade
├── mocks/push-mock/server.js               (novo) HTTPS, status programável por endpoint, log JSONL
├── compose.hub.test.yml                    (alterar) push-mock, frontend-motorista, VAPID mount, ENVIO_ALLOWLIST/PUSH_HOSTS_PERMITIDOS, NODE_EXTRA_CA_CERTS
├── compose.hub.homolog.yml                 (alterar) VAPID mount + VAPID_KEYS_FILE, frontend-motorista para validação
├── .env.hub.{dev,test,homolog}.example     (alterar) nomes VAPID_KEYS_FILE / PUSH_HOSTS_PERMITIDOS
├── scripts/gen-vapid.sh                    (novo) gera par EC P-256 em /var/lib/hub_secrets (chmod 600) com geradoPor/geradoEm
└── testes/
    ├── hub-avisos-integration.sh           (novo) hub-test efêmero: RLS, SKIP LOCKED, reinício, 404/410, retry, expurgo, auditoria
    ├── hub-avisos-e2e-browser.sh           (novo) Playwright do módulo no hub
    └── hub-motorista-push-e2e-browser.sh   (novo) Playwright do app motorista (stubado)
```

**Structure Decision**: tudo cabe na estrutura existente: dois apps Next.js, backend Express
com `routes/` + `lib/` e série única de migrations do hub. Nenhum pacote, serviço de produção
ou camada nova. A lógica testável fica em `lib/` (padrão do hub), com rotas finas. O worker é
um módulo do backend, não um processo.

## Convenções de Borda

| Camada | Case style | Validação | Fonte da verdade |
|--------|------------|-----------|------------------|
| DB (Postgres do hub) | tabelas `"PascalCase"`, colunas `snake_case` | `CHECK` + funções `SECURITY DEFINER` + RLS | `infra/hub/migrations/0061_push_avisos.sql` |
| Backend → PostgREST | `snake_case` (colunas/params `p_*`) | JWT por requisição com claims | `lib/hub-postgrest.js:53`, `lib/hub-postgrest-jwt.js` |
| Backend DTO (JS) | camelCase | validação manual (sem zod — padrão do repo) | `lib/hub-avisos-dto.js` |
| API payload (request/response) | camelCase | backend valida request; frontends parseiam response | `contracts/*.md` |
| Erro da API | `{ "erro": "CODIGO_MAIUSCULO", "motivo"? }` nas rotas novas | chave `erro` nas rotas novas; exceção herdada: o `401` do `authenticateMotorista` reutilizado vem como `{ "error": "<texto>" }` (`routes/motorista.js:158,163,168`), então o app motorista decide pelo status HTTP | `contracts/*.md`; precedente `routes/hub-papeis.js:48-196` |
| Frontend hub DTO (TS) | camelCase | `parse*` manual em `lib/hub/avisos-dto.ts` | espelha `contracts/hub-avisos.md` |
| Frontend motorista (TS) | camelCase | tipos em `lib/push.ts` | espelha `contracts/motorista-push.md` |
| Payload do push | camelCase JSON `{avisoId,titulo,corpo}` | tamanho e campos no backend; SW descarta inválido | `contracts/motorista-push.md` |
| URL path | lowercase com `/` (`/api/v1/avisos/destinatarios/empresas`) | router Express | `routes/hub-avisos.js`, `routes/motorista-push.js` |
| Query params | camelCase (`page`, `pageSize`, `modo`, `ids`, `busca`) | parse manual; `ids` CSV de inteiros | `contracts/hub-avisos.md` |
| Enums literais | `snake_case` (`na_fila`, `toda_base`, `ios_sem_instalacao`) iguais no DB, na API e nos TS | `CHECK` no DB + validação no backend | `data-model.md` |

**Mapper layer (DB ↔ DTO)**: `lib/hub-avisos-dto.js` (snake_case → camelCase), no molde de
`lib/hub-motoristas-dto.js:117,209`. Não há ORM: PostgREST + mapeamento manual.

**Validação de schema**: sem zod no repo (`frontend_v2/package.json` sem zod/react-hook-form).
Request validado no backend; response parseado nos DTOs do `frontend_v2`. O roundtrip E2E
(quickstart 20) compara payload real × contrato × parser.

## NFRs (cloud-public)

| NFR | Medida no design | Requisito |
|---|---|---|
| Segredo VAPID | arquivo read-only, fail-closed se ausente, nunca em log/env/imagem; varredura antes da entrega | FR-025, SC-009 |
| SSRF | endpoint `https:` sem porta nem userinfo, host em allowlist, revalidado antes de cada envio; gate de saída existente | D10 |
| Autorização | módulo + permissão dedicada + entidade ativa + `mesmoGrupoQue`; RLS + funções por claim | FR-014, FR-015, FR-028 |
| Abuso | rate limit 30/15 min (motorista) e 10/15 min (disparo) | FR-027 |
| Privacidade | payload só `{avisoId,titulo,corpo}`; alerta de terceiro na tela; expurgo de 90 dias; auditoria sem CNPJ nem texto | FR-012, FR-021, FR-030 |
| Confiabilidade | at-most-once com SKIP LOCKED + lease; retomada no boot; retry limitado; limpeza 404/410; conclusão sempre com resultado real | FR-018, FR-019, FR-020 |
| Desempenho | disparo = 1 função SQL; envio fora do request, concorrência limitada | FR-017, SC-004, SC-005 |
| Observabilidade | logs com `endpoint_hash` curto, contagens por aviso, `AUDITORIA_PERDIDA` existente; tela de resultado | FR-022, FR-031 |
| Acessibilidade | foco visível, rótulo/nome acessível e navegação completa por teclado no passo de contexto e no formulário "Novo aviso" | FR-032, SC-012 |

## Riscos e mitigação

| # | Risco | Mitigação |
|---|---|---|
| R1 | Base iOS sem instalar o PWA não recebe nada (briefing) | orientação de instalação no app + cobertura por plataforma no hub (US4) |
| R2 | Motorista sem vínculo `Entregador↔ContaMotorista` não aparece nos modos individual/empresa | a tela explica; `toda_base` alcança; medir no hub-homolog antes do merge |
| R3 | Validação em aparelho real exige origem HTTPS confiável; hub-homolog é loopback autoassinado | decidir com o operador na fase de validação (túnel autenticado ou janela em produção sob o rito) |
| R4 | Allowlist de hosts de push incompleta bloqueia um navegador real | lista marcada como PROPOSTA; validar com endpoints reais (quickstart 21) antes do merge |
| R5 | Colisão de número de migration com outra sessão | conferir `ls infra/hub/migrations` na criação; nunca editar migration aplicada |
| R6 | Rate limit e cache de RBAC em memória por processo | 1 réplica por serviço confirmada em produção (`docker service ls`, 2026-09-11, dec-044/block-005) — premissa válida; `ponytail:` store compartilhado só se escalar para múltiplas réplicas |
| R7 | `POST /motorista/logout` responde 401 com access vencido (`motorista.js:511-514`) | `unsubscribe()` no aparelho é a garantia; revogação no servidor é best-effort |
| R8 | `package-lock.json` reescrito pelo container do Playwright | conferir e reverter antes de commitar (`CLAUDE.md`) |
| R9 | Dados expurgados sobrevivem até 14 dias nos dumps | declarado em data-model (retenção) |
| R10 | SW não roda em `next dev` | validar com `next build && next start` |

## Gates de qualidade da implementação (com números medidos)

- **Backend**: suíte unit completa (baseline **932** testes) + unit do hub + integração
  `hub-avisos`; `node scripts/checar-testes-orfaos.js` sem órfãos nem fantasmas.
- **Frontends**: `tsc --noEmit` nos dois; `next build` nos dois; `npm test` (vitest) no
  `frontend_v2`; lint comparado com a baseline.
- **E2E**: `hub-avisos-e2e-browser.sh` e `hub-motorista-push-e2e-browser.sh`; UI → detector
  impeccable com 0 achados.
- **Segurança**: gate `owasp-security` sobre este plan; varredura da chave privada (quickstart 19).
- **Acessibilidade**: verificação manual de foco visível, rótulos acessíveis e navegação
  por teclado nas duas telas novas (passo de contexto, formulário "Novo aviso") — escopo
  básico decidido pelo operador (dec-046/block-007, FR-032/SC-012), não substitui uma
  rodada `impeccable` completa.

## Entrega em produção (referência — cada passo exige autorização explícita do operador)

Rito do ciclo git (`CLAUDE.md`): branch → gates → `git add` explícito → commit → PR →
**merge** → build da main com tag `avisos-push-<sha7>` → deploy pelos 5 gates → prova do
bundle. Commit, PR e deploy são três autorizações distintas.

Ordem proposta para a janela:

1. **Migrations no `chatmasterveloz`** (`0061`, `0062`): aditivas, sem dado a alterar.
   Depois, SIGUSR1 no PostgREST e prova das funções pela API.
2. **Chave VAPID de produção**: gerada pelo operador em `/var/lib/hub_secrets/`, com
   `subject` informado por ele.
3. **Imagens**: backend (`Dockerfile.hub`, conferir `node --version`), `frontend_v2` e
   `frontend_motorista` (`BACKEND_URL` conferido).
4. **Backend**: `docker service update --with-registry-auth --mount-add type=bind,source=<arquivo>,target=/run/secrets/vapid.json,readonly --env-add VAPID_KEYS_FILE=/run/secrets/vapid.json --image … envio-massa-homologacao_backend_homologacao`.
   A imagem anterior é anotada como rollback.
5. **Frontends**: `frontend_v2` e depois `frontend_motorista_homologacao`, cada um com o
   rollback anotado.
6. **Verificação**: smoke HTTP + prova de bundle (string exclusiva da entrega nos dois
   frontends) + aviso de teste para o aparelho do operador.

## Complexity Tracking

> Sem violações de constitution a justificar.

| Violação | Por Que Necessário | Alternativa Simples Rejeitada Porque |
|----------|-------------------|--------------------------------------|
| — | — | — |

## Achados do gate owasp-security (onda-006)

Modo `completo` (tier `cloud-public`), revisão do desenho. Resultado: **0 critical, 0 high,
4 medium, 6 low**. As mitigações são requisitos de desenho: entram no backlog do
`create-tasks`, cada uma com um teste que falha sem ela.

| ID | Sev. | Onde | Achado | Mitigação |
|---|---|---|---|---|
| S1 | medium | data-model §Funções | Funções novas nascem com `EXECUTE` para `PUBLIC` (padrão do Postgres). O PostgREST tem papel anônimo `hub_web_anon` (`infra/hub/compose.hub.homolog.yml:70`) e o de produção passa pelo Traefik (`postgrest.todo-tips.com`, `docs/plans/infra-certificados/RUNBOOK-CORRECAO.md:121`): a checagem de claim seria a única barreira. | `REVOKE ALL ON FUNCTION … FROM PUBLIC` antes do `GRANT EXECUTE … TO authenticated` nas 11 funções (precedente `0041_auditoria_expurgo_d5.sql:69`); teste de integração chamando cada `/rpc/` sem JWT → recusado. |
| S2 | medium | contracts/motorista-push.md (inscrição); research D5 | Sem teto de inscrições por CNPJ; `p256dh`/`auth` validados só como base64url ≤ 256; erro local do `web-push` (sem `statusCode`) cai em transitória com 3 tentativas; `400` vira `rejeitada` sem apagar a inscrição. Um motorista autenticado acumula inscrições inválidas que o worker re-tenta a cada aviso. | Na inscrição: `p256dh` com 65 bytes e prefixo `0x04`, `auth` com 16 bytes. Erro lançado antes da requisição HTTP → `rejeitada`, sem re-tentativa. Teto de inscrições por CNPJ: **10**, removendo a de `atualizado_em` mais antigo (aceito pelo operador, dec-043/block-004). Apagar a inscrição em `rejeitada` só depois de validar respostas reais (quickstart 21). |
| S3 | medium | contracts/motorista-push.md:163; research D14 | A checagem de `next` (começa com `/`, não com `//` nem `/\`) aceita `"/<TAB>/evil.example"`: o parser de URL descarta TAB e quebra de linha e o destino vira outro domínio. Sondado na onda-006: `new URL("/\t/evil.example", "https://app.example").href` → `https://evil.example/`, com a checagem aprovando. | Resolver `new URL(next, location.origin)`; aceitar só com `origin` igual à do app e navegar para `pathname + search + hash`; senão `/movimento`. Testes: `//x`, `/\x`, `/<TAB>/x`, `/<LF>/x`, `javascript:`. |
| S4 | medium | data-model §Filtro de destinatários (`toda_base`) | `toda_base` não filtra por grupo: o isolamento depende da regra de domínio (app exclusivo do grupo Movee) e da trava na criação da credencial (research D7). `"ContaMotorista"` não tem coluna de empresa (`0021_conta_motorista.sql:18-22`). | Em `toda_base`, excluir contas cujos vínculos `Entregador` estejam **todos** fora de `hub_jwt_escopo_ids()`; contas sem vínculo continuam alcançadas (R2). Teste de integração: conta ligada só a `Entregador` de empresa fora do grupo não é visada. |
| S5 | low | contracts/hub-avisos.md:20 | O claim `escopo` com os ids do grupo diverge do padrão atual `escopo: [entidadeAtiva]` (`routes/hub-motoristas.js:166`). É exigido por FR-015/FR-016, mas não pode vazar para outras rotas. | Montar o escopo de grupo só em `routes/hub-avisos.js`; teste de unidade garantindo que as demais rotas mantêm `[entidadeAtiva]`. |
| S6 | low | research D10 | Allowlist com curinga (`*.push.apple.com`) e override `PUSH_HOSTS_PERMITIDOS`. Em produção o `envio-gate` não bloqueia nada (`lib/envio-gate.js:13`), então a allowlist é a única barreira de SSRF. | Casamento exato ou por sufixo com fronteira de ponto sobre `URL.hostname` em minúsculas; override só vale com `ENVIO_ALLOWLIST` definida (ambiente isolado); allowlist efetiva logada no boot. |
| S7 | low | contracts/hub-avisos.md (POST) | "Sem caracteres de controle" não cobre formatação Unicode (bidi U+202A–U+202E, U+2066–U+2069), que falsifica o texto da notificação. | Recusar as categorias Unicode `Cc` e `Cf`; título e mensagem renderizados sempre como texto, nunca como HTML. |
| S8 | low | contracts/hub-avisos.md (alcance, destinatários) | `GET /api/v1/avisos/alcance` (até 500 ids) e a busca de motoristas não têm limite de taxa. | Limitador por usuário nas duas rotas; busca pela RPC parametrizada existente (`0042_hub_entregadores_busca_rpc.sql`). |
| S9 | low | research D3, D18 | Transferência de inscrição entre CNPJs e recusas `FORA_DO_GRUPO_MOVEE`/`DESTINATARIOS_FORA_DO_ESCOPO` não geram log; o autor da rotação (`geradoPor`) é texto declarado no arquivo. | Log com o prefixo do `endpoint_hash` e o código da recusa (FR-031); a auditoria rotula o autor como declarado no arquivo de chave. |
| S10 | low | data-model §Claims | `hub_push_worker` dá acesso a endpoint e chaves de todas as inscrições; `motorista_cnpj` é texto livre no JWT. | Token de worker emitido só em `lib/hub-push-worker.js`, nunca a partir de dado da requisição; `hub_jwt_push_worker()` com `COALESCE(…, false)` como `hub_jwt_boot_recovery()` (`0018_dedupe_erro_recuperacao_orfa.sql:60`); `hub_jwt_motorista_cnpj()` recusa nulo, vazio e valor fora de 14 dígitos. |

Sem achado em CSRF: cookies do motorista com `sameSite: 'Strict'` (`routes/motorista.js:186,192`)
e corpo lido só por `express.json()` (`server.js:184`).

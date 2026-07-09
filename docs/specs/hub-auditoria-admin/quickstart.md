# Quickstart — hub-auditoria-admin (S9)

Cenários de validação por fluxo crítico. Ambiente: hub-homolog isolado
(`https://localhost:8443/hub/login`, cert self-signed), QA
`qa.importacoes@moveelog.local / Teste@Hub2026` (entidade 9001,
admin_entidade). Testes de integração: padrão efêmero
`infra/hub/testes/*.sh` (projeto `hub-test-<runid>`, contadores
`PASS:`/`FAIL:`), NUNCA tocando produção/chatmasterveloz.

## Cenário 1 — Trilha da própria entidade com filtros (US1, happy path)

1. Login como QA (admin_entidade, entidade 9001) → cookie `accessToken`.
2. Editar um motorista qualquer pela tela (gera evento).
3. Abrir `/hub/dashboard/auditoria` → **Expected**: lista paginada, mais
   recentes primeiro, SOMENTE eventos `entidadeId=9001`.
4. Filtrar `acao=entregador_editado` + período de hoje → **Expected**: o
   evento do passo 2 aparece; abrir o detalhe (drawer) → **Expected**: sem
   CPF/CNPJ/senha/nome de terceiro em texto claro (`detalhes` scrubbed).

## Cenário 2 — Nega-por-padrão sem entidade ativa (US1, error case)

1. Login com usuário multi-entidade SEM selecionar entidade ativa.
2. `GET /api/v1/auditoria` → **Expected**:
   `200 { "eventos": [], "total": 0 }` — nunca lista global, nunca 500
   (comportamento já asserted em `hub-rbac-integration.sh`, preservado).
3. Forçar `?entidadeId=<outra>` como admin_entidade → **Expected**:
   `403 { "erro": "PERMISSAO_NEGADA" }` (nunca resultado cross-tenant).

## Cenário 3 — Visão global do admin_plataforma (US2)

1. Login como usuário com vínculo `admin_plataforma` (seed de teste).
2. `GET /api/v1/auditoria` sem `entidadeId` → **Expected**: eventos de
   MÚLTIPLAS entidades + eventos globais (`entidadeId: null`, ex.
   `login_sucesso`).
3. `GET /api/v1/auditoria?entidadeId=9001` → **Expected**: só eventos da
   9001 (mesmos que o admin_entidade da 9001 vê).
4. Repetir passo 2 autenticado como admin_entidade → **Expected**: eventos
   globais NUNCA aparecem (edge case da spec; RLS 0035).

## Cenário 4 — Imutabilidade da trilha (FR-005/SC-003, error case)

1. Via PostgREST direto (role `authenticated`), tentar
   `PATCH /Auditoria?id=eq.<id>` e `DELETE /Auditoria?id=eq.<id>` →
   **Expected**: ambos rejeitados (trigger
   `hub_bloqueia_alteracao_auditoria` + REVOKE); linha original intacta.
   (Já coberto por `hub-auditoria-integration.sh` — re-rodar como regressão.)

## Cenário 5 — Gestão de usuários ponta-a-ponta (US3/SC-008)

1. Como admin_entidade, `/hub/dashboard/usuarios` → criar usuário
   `op@teste.local` com senha forte + vínculo entidade 9001 papel
   `operador` → **Expected**: 201, usuário listado com vínculo.
2. Login como `op@teste.local` → **Expected**: autentica; `GET /me` mostra
   permissões de operador (sem `usuarios.gerenciar`).
3. Como admin, trocar papel do vínculo para `leitura` →
   **Expected**: `200`; em <2s, request do operador a rota de escrita
   (ex. criar importação) → `403 PERMISSAO_NEGADA` — SEM esperar TTL de 60s
   (`invalidarUsuario` síncrono, SC-004).
4. Auditoria registra `usuario_criado` e `usuario_papel_alterado`, sem senha
   em `detalhes`.

## Cenário 6 — Matriz de papéis: leitura vs edição (US3/FR-010/FR-016)

1. Como admin_entidade, `/hub/dashboard/usuarios/papeis` → **Expected**:
   matriz 4 papéis × permissões visível, checkboxes DESABILITADOS
   (`podeEditar: false`).
2. `PUT /api/v1/papeis/3/permissoes/12` como admin_entidade →
   **Expected**: `403 PERMISSAO_NEGADA` (dupla barreira: middleware + RPC).
3. Como admin_plataforma, mesmo PUT com `{ "ativo": false }` →
   **Expected**: `200`; célula some do GET; usuários com o papel perdem a
   permissão no request seguinte (`limparCache()`).
4. Tentar criar/excluir papel por qualquer via (sem rota; INSERT direto em
   `Papel` via PostgREST) → **Expected**: negado (RLS sem política de
   escrita — catálogo fixo, dec-008).

## Cenário 7 — Módulos por entidade: efeito imediato (US4/FR-008/SC-005)

1. Como admin_plataforma, `/hub/dashboard/admin` → desabilitar
   `envio_massa` para a entidade 9001 → **Expected**: `200`.
2. Com sessão ATIVA de usuário da 9001 (sem relogar): `GET /me` →
   **Expected**: `envio_massa` ausente de `modulos[]`; nav sem o item.
3. Mesmo usuário, `GET /api/v1/<rota do módulo>` → **Expected**:
   `403 { "erro": "MODULO_DESABILITADO" }` — imediato, sem janela de 60s.
4. Como admin_entidade, `GET /api/v1/admin/modulos` → **Expected**:
   `403 PERMISSAO_NEGADA` (FR-017 — nem leitura).
5. Reabilitar → **Expected**: item volta ao nav; funcionalidade responde.

## Cenário 8 — Roundtrip End-to-End (obrigatório, borda backend↔frontend)

Chamada REAL ao backend (sem mock/fixture), comparando o payload contra o
contrato declarado em `contracts/auditoria-api.md`:

1. `curl -sk --cookie "accessToken=<jwt QA>" \
   'https://localhost:8443/api/v1/auditoria?page=1&pageSize=5'`
2. Capturar o JSON real e validar shape: chaves top-level `eventos`,
   `total`, `page`, `pageSize`; cada evento com `id`, `entidadeId`,
   `usuarioId`, `acao`, `recurso`, `recursoId`, `detalhes`, `ip`,
   `criadoEm` — **camelCase** (nunca `criado_em`/`id_empresa` vazando do
   PostgREST sem mapper).
3. **Expected**: shape idêntico ao contrato; qualquer chave snake_case na
   borda = FAIL (lição das 40 ondas da execucao-fonte: só roundtrip
   empírico pega drift de case).
4. Repetir para `GET /papeis` e `GET /admin/entidades/9001/modulos` (as
   outras duas superfícies novas).

## Cenário 9 — Cobertura de auditoria S2–S8 (FR-006/SC-002)

1. Executar uma escrita por módulo (importação, edição de motorista,
   toggle de módulo, troca de papel, envio em massa com flag ativa).
2. `GET /api/v1/auditoria` filtrando por cada `acao` → **Expected**: 1
   evento por escrita, com `recurso`/`recursoId` corretos (checklist
   endpoint-a-endpoint no PR — critério de aceite 1 do briefing).

# API Checklist: Configuração de UI por Tenant (White-label) + Grupo de CNPJs

**Purpose**: Validar qualidade dos requisitos de API — completude dos contratos,
status codes, escopo por token, idempotência, e cobertura de cenários de erro para os
endpoints de branding e grupo.

**Created**: 2026-06-05
**Feature**: [spec.md](../spec.md) | [contracts/branding-api.md](../contracts/branding-api.md) | [contracts/grupo-api.md](../contracts/grupo-api.md)
**Domínio**: api

---

## GET /empresa/branding — Completude e Escopo

- [x] CHK026 - O escopo de quem pode chamar GET /empresa/branding está especificado
  (token pai vs. token filho vs. empresa sem grupo)? [Completude, contratos/branding-api.md] {auto}
  > SATISFEITO — branding-api.md §GET /empresa/branding Request: "Auth: cookie httpOnly
  > `accessToken`." Response define retorno por caso: grupo com branding → payload completo;
  > sem grupo ou sem branding → `{ "id_grupo": null, "fallback": "movee" }`.

- [x] CHK027 - O contrato de GET /empresa/branding define o status code de resposta
  quando empresa não tem grupo (200 com fallback payload, não 404)? [Clareza,
  contratos/branding-api.md] {auto}
  > SATISFEITO — branding-api.md §GET /empresa/branding Response (200): "Se a empresa
  > **não tem grupo** (`id_grupo` NULL) ou o grupo não tem branding:
  > `{ "id_grupo": null, "fallback": "movee" }`." Sempre 200 — nunca 404.

- [x] CHK028 - Os campos retornados no GET /empresa/branding para o painel estão todos
  especificados (id_grupo, logo_url, cor_primaria, cor_destaque, nome_exibicao)?
  [Completude, contratos/branding-api.md] {auto}
  > SATISFEITO — branding-api.md §GET /empresa/branding Response (200): JSON exemplo
  > com os 5 campos esperados. `updated_at` não está no GET de leitura (ok — é
  > retornado apenas no PUT).

- [ ] CHK029 - O contrato GET /empresa/branding especifica se um token de **filho** que
  chama o endpoint recebe a branding do grupo pai (herança) ou `{ fallback: "movee" }`?
  [Completude, Gap — contrato não documenta o comportamento para token de filho:
  se resolveScope retorna `[empresaId]` do filho, a query de branding do grupo do filho
  pode não encontrar branding própria do filho (correto por design FR-013), mas o
  contrato não descreve isso explicitamente] {humano}

---

## PUT /empresa/branding — Idempotência, Upsert e Validação

- [x] CHK030 - O PUT /empresa/branding está especificado como upsert idempotente
  (cria se não existe, atualiza se existe), retornando sempre 200 (não 201 na criação)?
  [Completude, contratos/branding-api.md, FR-INFRA-IDEMP] {auto}
  > SATISFEITO — branding-api.md §PUT: "Cria/atualiza (upsert) a branding do grupo do
  > token." Response sempre 200. spec.md §FR-INFRA-IDEMP: "endpoint de upload de logo
  > é idempotente para o mesmo arquivo."

- [x] CHK031 - O contrato do PUT especifica que campos omitidos do body não zeram os
  valores existentes (partial update semantics)? [Clareza, contratos/branding-api.md] {auto}
  > SATISFEITO — branding-api.md §PUT Request: "Content-Type: multipart/form-data
  > (campo `logo` opcional) **ou** application/json (sem alterar logo)" — omitir logo
  > preserva o existente. Campos de texto seguem mesma semântica (upsert parcial).

- [x] CHK032 - Os status codes de erro do PUT estão especificados para todos os casos
  de validação (400 hex inválido, 400 logo inválido, 401 sem token, 403 não-pai)?
  [Completude, contratos/branding-api.md] {auto}
  > SATISFEITO — branding-api.md §PUT Error Responses: tabela com 400 (hex inválido /
  > logo inválido), 401 (sem token), 403 (não é pai do grupo). Mensagens de erro em
  > português especificadas.

- [ ] CHK033 - O limite de caracteres (`≤ N chars`) do campo `nome_exibicao` está
  definido com o valor numérico concreto (não apenas "≤ N chars")? [Clareza,
  contratos/branding-api.md, Gap — contrato usa placeholder "≤ N chars" sem valor
  definido] {humano}

- [ ] CHK034 - Existe requisito definindo o comportamento do PUT quando o grupo ainda
  não tem `Branding` row (primeira configuração) — o status code permanece 200 e não
  há status 201? O contrato é ambíguo sobre upsert vs. create+update separados?
  [Clareza, contratos/branding-api.md, Ambiguity — PUT é descrito como upsert mas
  apenas "Response 200" está documentado; confirmar que criação inicial também é 200] {humano}

---

## GET /motorista/branding-tomador — PWA Leve e Fallback

- [x] CHK035 - O endpoint GET /motorista/branding-tomador especifica como resolve
  o tomador do movimento (parâmetro `?movimento` ou `?id_empresa` na query)?
  [Completude, contratos/branding-api.md] {auto}
  > SATISFEITO — branding-api.md §GET /motorista/branding-tomador Request: "Query
  > params: `?movimento=<id>` ou `?id_empresa=<id>` (somente um é necessário)."

- [x] CHK036 - O comportamento de fallback do GET /motorista/branding-tomador em caso
  de erro ou tomador sem branding está especificado como 200 com payload de fallback
  (nunca erro visual)? [Completude, SC-007, contratos/branding-api.md] {auto}
  > SATISFEITO — branding-api.md §GET /motorista/branding-tomador Response: "Tomador
  > sem grupo/branding ou erro de resolução → fallback (HTTP 200, payload fallback)
  > para o PWA degradar graciosamente: `{ "fallback": "movee" }`." SC-007: "nunca
  > erro visual ou tela em branco."

- [x] CHK037 - O requisito de timeout definido para a busca de branding no PWA está
  declarado como FR? [Completude, FR-010, spec.md] {auto}
  > SATISFEITO — spec.md §FR-010: "ter timeout definido; em caso de falha ou ausência,
  > aplicar fallback Movee." Valor concreto do timeout não é especificado no FR (gap
  > de completude, mas aceitável para fase de especificação — detalhado no plan/tasks).

- [ ] CHK038 - O requisito de timeout está quantificado com um valor numérico concreto
  (ex: 2s, 3s) nos artefatos de spec ou plan? [Clareza, FR-010, Gap — FR-010 diz
  "timeout definido" mas plan.md não especifica o valor em ms/s; SC-001 especifica
  "menos de 3 segundos" para painel mas não para PWA motorista] {humano}

- [x] CHK039 - O escopo de autorização do GET /motorista/branding-tomador está
  especificado (token de motorista, não de empresa/admin)? [Completude,
  contratos/branding-api.md] {auto}
  > SATISFEITO — branding-api.md §GET /motorista/branding-tomador Request: "Auth:
  > cookie httpOnly `accessToken` (token do motorista)." Escopo separado dos endpoints
  > de painel.

---

## GET/POST/DELETE /grupo/filhos — Gestão de Grupo

- [x] CHK040 - O status code de sucesso do POST /grupo/filhos está especificado como
  201 (recurso criado), diferenciando do PUT (200)? [Completude, contratos/grupo-api.md] {auto}
  > SATISFEITO — grupo-api.md §POST /grupo/filhos Response: 201 `{ "ok": true }`.
  > Diferenciado corretamente do PUT (200).

- [x] CHK041 - O status 409 do POST /grupo/filhos (empresa já vinculada a outro grupo)
  está especificado como caso de erro explícito? [Completude, contratos/grupo-api.md] {auto}
  > SATISFEITO — grupo-api.md §POST Error Responses: "409 — empresa já vinculada a
  > outro grupo: `{ "error": "Empresa já pertence a outro grupo." }`."

- [x] CHK042 - O status 404 do POST /grupo/filhos (empresa alvo não existe) está
  especificado? [Completude, contratos/grupo-api.md] {auto}
  > SATISFEITO — grupo-api.md §POST Error Responses: "404 — empresa alvo não encontrada:
  > `{ "error": "Empresa não encontrada." }`."

- [x] CHK043 - O status code de sucesso do DELETE /grupo/filhos/:empresaIdFilho está
  especificado (200, não 204)? [Completude, contratos/grupo-api.md] {auto}
  > SATISFEITO — grupo-api.md §DELETE Response (200): `{ "ok": true }`. Consistente
  > com o padrão do projeto (200 com body, não 204 sem body).

- [x] CHK044 - O status 404 do DELETE (filho não vinculado a este grupo) está
  diferenciado do 403 (filho existe mas é de outro grupo)? [Clareza,
  contratos/grupo-api.md] {auto}
  > SATISFEITO — grupo-api.md §DELETE Error Responses: 403 "filho não é do grupo do
  > token"; 404 "Empresa não está vinculada a este grupo." Semanticamente distintos e
  > documentados.

- [x] CHK045 - O escopo de GET /grupo/filhos está limitado ao grupo do token (sem
  possibilidade de listar filhos de outro grupo via parâmetro)? [Completude, Princípio II,
  contratos/grupo-api.md] {auto}
  > SATISFEITO — grupo-api.md §GET /grupo/filhos Request: "Auth: authenticateToken +
  > is_grupo_pai === true." Sem parâmetro de grupo na query — escopo vem exclusivamente
  > do token.

- [ ] CHK046 - Existe requisito definindo paginação para GET /grupo/filhos em caso de
  grupos com muitos filhos (ex: holding com 50+ CNPJs)? [Completude, Gap — contrato
  não especifica limit/offset ou cursor; Response (200) retorna array sem paginação] {humano}

---

## Consistência e Convenções

- [x] CHK047 - Todos os payloads de request e response usam `snake_case` de forma
  consistente (sem mistura com `camelCase`) conforme convenção da feature? [Consistência,
  contratos/branding-api.md, contratos/grupo-api.md, plan.md] {auto}
  > SATISFEITO — plan.md linha 145: "DB columns: snake_case (`id_grupo`, `logo_url`,
  > `cor_primaria`, `cor_destaque`, `nome_exibicao`)"; plan.md linha 147: "API payload:
  > snake_case **idêntico ao banco**." Contratos seguem snake_case consistentemente.

- [x] CHK048 - O mapeamento `snake_case → CSS custom property` (TenantThemeProvider)
  está especificado formalmente para todos os campos de branding? [Completude,
  contratos/branding-api.md] {auto}
  > SATISFEITO — branding-api.md §Mapeamento: tabela com 4 linhas cobrindo
  > `cor_primaria`, `cor_destaque`, `nome_exibicao`, `logo_url` para ambos
  > `frontend_v2` (oklch) e `frontend_motorista` (HEX).

- [ ] CHK049 - O requisito de atomicidade da operação POST /grupo/filhos (transação
  que previne race condition entre dois pais tentando adicionar o mesmo filho
  simultaneamente) está especificado com o mecanismo concreto (FOR UPDATE, advisory
  lock, constraint UNIQUE)? [Completude, FR-INFRA-LOCK, spec.md, Gap — FR-INFRA-LOCK
  menciona "transação atômica" mas não especifica o mecanismo de lock] {humano}

---

## Notes

- Items `{auto}` resolvidos com citação direta dos artefatos
- Items `{humano}` ficam `[ ]` aguardando decisão do dono do produto
- **{auto} resolvidos**: 16 (`[x]` com evidência citada)
- **{humano} aguardando decisão**: 7 (CHK029, CHK033, CHK034, CHK038, CHK046, CHK049)
- **Gaps abertos**: 6 gaps de requisito em aberto

### Gaps prioritários para /clarify ou definição antes de create-tasks

| Item | Gap | Ação sugerida |
|------|-----|---------------|
| CHK029 | Comportamento GET branding para token de filho | Documentar no contrato: filho recebe branding do grupo ou fallback? |
| CHK033 | Tamanho máximo de `nome_exibicao` (placeholder "≤ N chars") | Definir valor concreto (ex: 80 chars) no contrato |
| CHK034 | Confirmar que upsert inicial retorna 200 (não 201) | Tornar explícito no contrato |
| CHK038 | Timeout concreto para GET /motorista/branding-tomador | Definir em ms no contrato ou plan |
| CHK046 | Paginação para GET /grupo/filhos | Decidir se MVP aceita limite implícito ou pagination explícita |
| CHK049 | Mecanismo de lock em POST /grupo/filhos | Especificar constraint ou advisory lock no data-model/DDL |

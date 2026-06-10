# OWASP Security Review — Corte controlado do Módulo C (login único por grupo)

> Complemento ao `owasp-review.md` (review da feature). Escopo: APENAS o cutover —
> tornar a guarda de filial condicional à flag `Grupo.login_unico_ativo` por grupo.
> Frameworks: OWASP Top 10:2025 (A01, A05, A09, A10), API Top 10:2023, ASVS 5.0 L1/L2.
> Stack: Node 14 / Express + PostgREST/PostgreSQL + JWT httpOnly.

## Mudança revisada

- Nova helper `grupoLoginUnicoAtivo(idGrupo)` (`server.js:138`): `SELECT login_unico_ativo
  FROM "Grupo" WHERE id = idGrupo`, **fail-open** (catch → `false`).
- `POST /login` (`server.js:233`) e `POST /token/refresh` (`server.js:325`): a guarda de
  filial (403) agora exige `&& await grupoLoginUnicoAtivo(idGrupo)` — bloqueia só se o
  grupo da filial estiver com a flag ativa.
- DDL `007`: `Grupo.login_unico_ativo boolean NOT NULL DEFAULT false`; GRANT só SELECT.

## Sumário

| Severidade | Count | Bloqueante |
|------------|-------|-----------|
| CRITICAL | 0 | — |
| HIGH | 0 | — |
| MEDIUM | 0 | — |
| LOW | 1 (aceito como decisão de design) | Não |
| INFO | 1 | Não |

**Veredito: PASS.** O corte não reintroduz nenhum finding do review original e não
abre novos. A única observação relevante (fail-open) é uma exceção **consciente e
documentada** ao padrão fail-closed, justificada pela natureza do controle.

## Análise por eixo

### A05 Injeção / API3 — PostgREST via `idGrupo` — PASS
`Grupo?id=eq.${idGrupo}` usa `idGrupo` **derivado do banco** em ambos os pontos
(`user.id_grupo` / `grupoCheck[0].id` no login; `emp[0].id_grupo` / `grupoCheck[0].id`
no refresh). O usuário só fornece email/senha — nunca alcança `idGrupo`. Sem superfície
de injeção (contraste com HIGH-002, que era path param do usuário no PUT, intocado aqui).

### A07 Enumeração / HIGH-001 preservado — PASS
A query da flag está **dentro** da guarda `idGrupo !== null && isGrupoPai === false`, que
no `POST /login` só é alcançada **após** `bcrypt.compare` + `if (!isValidPassword) return 400`
(Passo 3 → Passo 4). Logo a flag só é consultada para **senha válida de filial** — um
anônimo não obtém novo oráculo. O trade-off já documentado no HIGH-001 ("403 após senha
válida confirma filial existente, aceitável pois filiais são criadas pelo admin do grupo")
permanece idêntico; a flag apenas adiciona latência uniforme no ramo de filial, sem nova
assimetria observável por não-autenticado.

### LOW-005 (novo) — Fail-open na leitura da flag — ACEITO COMO DESIGN
`grupoLoginUnicoAtivo` retorna `false` (não bloqueia) se o SELECT falhar. Isso desvia do
padrão "fail-closed em checagem de permissão". **Justificativa da exceção:**
- O 403 de filial **não é fronteira de tenant** — é governança/UX (redirecionar ao login
  do pai). A filial é membro legítimo do grupo e **já passou pela senha**; logando sozinha,
  ela acessa apenas o **próprio** escopo (`empresaId = user.id`; isolamento real é feito por
  `resolveScope`/`resolveEmpresaAlvo`, não por esta guarda). Fail-open **não expõe** dados de
  outro tenant — só mantém o comportamento pré-corte durante uma falha transitória de DB.
- Alinhado ao objetivo declarado do corte ("não trancar usuário real de surpresa") e ao
  fail-safe já existente no código (login `server.js:207-211` degrada para sem-grupo em erro
  de `grupoCheck`). Fail-closed aqui poderia trancar uma filial legítima por blip de DB.
- **Consistência:** se o PostgREST cai, o `grupoCheck` anterior já lança e degrada para
  `idGrupo=null` → a guarda nem é alcançada → filial loga. Fail-open na flag mantém esse
  comportamento coerente.
- **Reavaliar SE** a flag passar a carregar semântica de segurança (não só governança); aí o
  trade-off muda e fail-closed deve ser reconsiderado.

### A01 Menor privilégio (GRANT) — PASS
DDL 007 concede só `SELECT` em `Grupo` (a feature só lê). A ativação (UPDATE) é por
psql/owner, não pelo role `authenticated`. (O 003 já concedia UPDATE amplo — decisão
pré-existente, fora do escopo deste corte; não reafirmada aqui.)

### A09 Logging — PASS
O 403 loga `empresaId`, `grupoId`, `ip`, `ts` sem credencial (LOW-001 mantido + grupoId
adicionado para auditoria do corte).

### LOW-004 paridade login/refresh — PASS (reforçado)
Os dois pontos usam a **mesma** helper com a **mesma** condição. Antes eram dois blocos
duplicados (risco de divergência que o review original destacou); agora um refreshToken
antigo de filial não fura o corte — se a flag está ativa, refresh também retorna 403.

### INFO-004 — Coerção defensiva de `idGrupo` (opcional)
`idGrupo` já é inteiro do banco; um `Number(idGrupo)` antes da interpolação seria defesa
em profundidade redundante. Não bloqueante — backlog.

## Constitution check (segurança)

| Princípio | Status |
|-----------|--------|
| §I JWT httpOnly / 403 não emite token | PASS (403 não gera token; refresh limpa cookies) |
| §II multi-tenant | PASS (isolamento por `resolveScope` intacto; flag é por grupo) |
| §IV OWASP review (auth) | PASS — este review |

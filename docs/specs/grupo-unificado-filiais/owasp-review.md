# OWASP Security Review — grupo-unificado-filiais

> Gate obrigatório (constitution §IV) rodado na fase `plan`. Frameworks: OWASP Top 10:2025,
> API Security Top 10:2023, ASVS 5.0 L1/L2, CWE Top 25:2025.
> Escopo: A (comportamento por grupo), B (editar filiais), C (login único do grupo).
> Stack: Node.js/Express + PostgREST/PostgreSQL + Next.js 14 + JWT httpOnly cookies.

## Sumário

| Severidade | Count | Bloqueante p/ deploy módulo C |
|------------|-------|-------------------------------|
| CRITICAL | 0 | — |
| HIGH | 2 | **SIM** |
| MEDIUM | 3 | Corrigir antes do merge |
| LOW | 4 | Recomendado |
| INFO | 3 | Tech debt / backlog |

**Veredito**: arquitetura sólida (reusa `requireGrupoPai`, `resolveScope`, JWT httpOnly).
HIGH-001 e HIGH-002 + LOW-004 + MEDIUM-001 devem ser corrigidos ANTES do deploy do módulo C.
Cada finding abaixo já tem a ação mapeada para a task de execução correspondente.

---

## Ações obrigatórias (folddar nas tasks de execução)

| # | Finding | Severidade | Ação | Task alvo |
|---|---------|-----------|------|-----------|
| 1 | HIGH-001 | HIGH | Reordenar `POST /login`: `bcrypt.compare` SEMPRE primeiro (com dummy hash p/ email inexistente), guarda de filial (403) SÓ após senha válida. Equaliza timing + evita enumeração de usuário. | C (login) |
| 2 | HIGH-002 | HIGH | `parseInt(req.params.id,10)` + `Number.isInteger` + `>0` no `PUT /grupo/empresas/:id`; usar só o inteiro sanitizado nas queries PostgREST. | B (editar) |
| 3 | LOW-004 | LOW (impacto alto) | Replicar a guarda de filial no `/token/refresh` (`server.js:~240`): refreshToken antigo de filial não pode renovar accessToken e bypassar o 403. | C (login) |
| 4 | MEDIUM-001 | MEDIUM | Rate limiting em `POST /login` (`express-rate-limit`, ex. 10 tentativas/15min/IP). Empresa-pai vira ponto único de entrada do grupo. | C (login) |
| 5 | MEDIUM-002 | MEDIUM | Remover default `cache = {}` de `mesmoGrupoQue(id, ref, cache)` — default object é compartilhado entre chamadas em Node (CWE-362, false positive cross-empresa). Caller declara `const _grupoCache = {}` antes do loop. | A (comportamento) |
| 6 | MEDIUM-003 | MEDIUM | BOLA no PUT: comparar `id_grupo` da filial (via select) com `id_grupo` do token; cross-group retorna **403 genérico** ("Empresa não encontrada"); proibir editar a própria empresa-pai por esta rota. | B (editar) |
| 7 | LOW-001 | LOW | Log de segurança (sem credencial) no 403 de bloqueio de login de filial. | C (login) |
| 8 | LOW-002 | LOW | Usar o MESMO regex de email do `POST /grupo/empresas` no PUT (consistência). | B (editar) |
| 9 | LOW-003 | LOW | `autoComplete="off"`/`"username"` no form de cadastro/edição de filial (campo senha removido → evitar autofill de gerenciador). | B (tela) |
| 10 | INFO-001/002/003 | INFO | Tech debt: bcrypt cost ≥12 (hoje 10); comentar `idReferencia=6 = Movee`; CSP no frontend. Backlog. | — |

---

## Detalhe dos findings HIGH

### HIGH-001 — Timing oracle / enumeração de usuário no `POST /login` (CWE-208, API2:2023, ASVS V2.2.3)
Guarda de filial inserida ANTES do `bcrypt.compare` cria timing observável (filial = 2 queries; email inexistente = 1 query + 400) e mensagens distintas (400 "Email ou senha incorretos" p/ inexistente vs 403 "Acesse o painel..." p/ filial) → enumeração.
**Correção**: `bcrypt.compare` sempre (dummy hash quando email não existe) → 400 genérico p/ senha errada → SÓ depois checar `id_grupo`/filial → 403. Trade-off documentado: 403 após senha válida confirma "filial com senha correta", aceitável pois filiais são criadas pelo admin do grupo (não anônimos). Registrar como exceção no PR.

### HIGH-002 — Injeção PostgREST via path param `:id` no `PUT /grupo/empresas/:id` (CWE-89, API3:2023)
`:id` não validado pode virar `id=eq.1 OR 1=1` (URL-encoded) e atualizar múltiplas linhas.
**Correção**: `const empresaIdFilha = parseInt(req.params.id,10); if(!Number.isInteger(empresaIdFilha)||empresaIdFilha<=0) return 400;` e usar só `empresaIdFilha` nas queries.

---

## Nota pós-execução: mudança de escopo — matriz editável (dec-030)

A restrição original do `PUT /grupo/empresas/:id` bloqueava edição da própria empresa-pai
(`if (id === req.empresa.id) return 400`). Por decisão do operador (dec-030), essa restrição foi
removida para permitir edição da matriz na aba grupo.

**Análise OWASP — esta remoção NÃO reabre vulnerabilidade de BOLA (MEDIUM-003)**:
- A checagem de autorização cross-grupo permanece intacta: `empresa.id_grupo === tokenIdGrupo`;
  qualquer empresa de outro grupo ainda recebe 403 genérico.
- A proteção de campos sensíveis permanece: `PUT` não toca `pass`/hash em hipótese alguma
  (FR-B — campo `pass` ausente do payload PATCH para PostgREST).
- O `parseInt + Number.isInteger + >0` (HIGH-002) permanece: path injection impossível.
- O login único não é afetado: guarda de filial no `POST /login` checa `id_grupo != null &&
  is_grupo_pai === false` — a empresa-pai (is_grupo_pai=true) continua autenticando normalmente.
- **Superfície de ataque**: token da empresa-pai já podia editar filiais; agora também edita a si
  mesma — não é ampliação de superfície cruzada, apenas remoção de restrição intra-grupo.

**Veredito**: remoção segura. Constitution Princípio II (multi-tenant) preservado.

---

## Constitution check (segurança)

| Princípio | Status |
|-----------|--------|
| §I JWT httpOnly / 403 não emite token | PASS |
| §I bcrypt | PASS (INFO-001 upgrade futuro) |
| §I segredos em .env | PASS (nenhum novo) |
| §II multi-tenant | PASS **condicionado** a HIGH-002 + MEDIUM-003 corrigidos |
| §III proxy cookies | PASS |
| §IV OWASP review | PASS (este review); HIGH-001/002 corrigir antes do deploy C |

# Plano de Implementação — migrar-cnpj-motorista

**Feature**: Migrar Cadastro do Motorista ao Alterar CNPJ do Prestador
**Branch sugerida**: `feature/migrar-cnpj-motorista`
**Spec**: `docs/specs/migrar-cnpj-motorista/spec.md`
**Briefing técnico**: `docs/specs/migrar-cnpj-motorista/feature-briefing.md`

## Summary

Hoje a rota `PATCH /update-envio-massa/:id` ignora `cnpj_prestador` no body
(bug FR-001), então corrigir o CNPJ de um prestador na UI não persiste e não
atualiza o login do app motorista (tabela `Motorista`, exclusiva do grupo
Movee). A feature: (1) faz a rota persistir o novo `cnpj_prestador`,
trocando-o em **lote** em todos os movimentos da mesma empresa com o CNPJ
antigo (incl. `enviado=true`); (2) para empresas do grupo Movee, migra o
registro de `Motorista` (preservando senha/nome/ativo), recusando colisão com
409 e criando pré-cadastro se o antigo não existir; (3) adiciona máscara +
validação de 14 dígitos + aviso fixo no diálogo de edição. Sem DDL.

Abordagem: estender a rota e helpers **existentes** (reuso de `onlyDigits`,
`isCNPJ14`, `postgrestRequest`, `mesmoGrupoQue`, `resolveEmpresaAlvo`), nova
função `migrarCnpjMotorista`. Detalhes em `research.md` (decisões 1–6).

## Technical Context

| Campo | Valor |
|-------|-------|
| Linguagem (backend) | Node.js (node:14), Express, PostgREST como camada de dados |
| Linguagem (frontend) | TypeScript, Next.js (node:20-alpine standalone), React 19 |
| Data layer | PostgREST sobre PostgreSQL (`chatmasterveloz`) — **sem transação cross-request** |
| Auth | JWT em cookie httpOnly (`accessToken`); `authenticateToken` middleware |
| Multi-tenant | escopo server-side via `resolveEmpresaAlvo` / `id_empresa`; grupo via `mesmoGrupoQue(id,6,cache)` |
| Storage changes | **Nenhum (sem DDL)** — colunas já existem |
| Testing | unit do backend mockando `postgrestRequest`; roundtrip E2E real (C10) |
| Arquivos backend | `app_homologacao/backend/server.js` (rota `~:875`, helpers `:1222+`) |
| Arquivos frontend | `app_homologacao/frontend_v2/components/edit-dialog.tsx` |
| NEEDS CLARIFICATION | **0** (resolvidos no clarify: dec-007..dec-010 / FR-011..FR-014) |

## Constitution Check

*GATE: passou antes do Phase 0. Re-checado após Phase 1 (§Re-check).*

| Princípio | Status | Notas |
|-----------|--------|-------|
| I. Segurança Auth & Segredos (NON-NEGOTIABLE) | PASS | Não toca senha (preservada na migração); log sem segredos (FR-011); senha=null só em pré-cadastro (padrão existente). 409 evita sobrescrever credenciais |
| II. Isolamento Multi-Tenant (NON-NEGOTIABLE) | PASS | PATCH em lote filtra `id_empresa=eq.${idEmp}` (anti-IDOR); `Motorista` só tocada via `mesmoGrupoQue(id,6,cache)` (FR-013). Escopo resolvido server-side, nunca do body cru |
| III. Contratos de API & Proxy de Cookies | PASS | Contrato explícito em `contracts/patch-update-envio-massa.md`; rota reusa `authenticateToken`; sem novo compartilhamento implícito de dados |
| IV. Qualidade e Revisão | PASS | Branch dedicada; Conventional Commits; toca auth/multi-tenant → revisão OWASP (gate owasp-security desta onda). Spec clarificada antes do plano |
| V. Deploy Conteinerizado & Convivência | PASS | Sem novo serviço; sem mudança de imagem além do código; sem acoplamento. Deploy só sob rito de produção (fora do escopo do agente) |

Nenhum FAIL em princípio MUST. Prosseguir.

## Convenções de Borda

Feature atravessa DB ↔ backend ↔ frontend.

| Camada | Case style | Validação | Fonte da verdade |
|--------|------------|-----------|------------------|
| DB columns (PostgreSQL/PostgREST) | snake_case (`cnpj_prestador`, `id_empresa`) | UNIQUE/NOT NULL no schema | `backend/db/001_create_motorista.sql` |
| Backend (server.js) | lê/escreve os nomes de coluna snake_case direto (sem ORM mapper) | `onlyDigits` + `isCNPJ14`; escopo via `resolveEmpresaAlvo`/`mesmoGrupoQue` | `app_homologacao/backend/server.js` |
| API payload (request/response) | body usa nomes de coluna snake_case (`cnpj_prestador`, `empresa_id`) — alinhado ao handler atual | validação no backend (400/409/500) | `contracts/patch-update-envio-massa.md` |
| Frontend DTO (TS) | objeto `form` do `edit-dialog.tsx` usa as chaves do registro (`cnpj_prestador`) | máscara + 14 dígitos no client; backend re-valida | `app_homologacao/frontend_v2/components/edit-dialog.tsx` |
| URL path param | `:id` (numérico) | router Express | rota `/update-envio-massa/:id` |

**Mapper layer (DB ↔ DTO)**: **N/A — sem ORM.** O código fala PostgREST direto
com nomes de coluna snake_case; o front carrega o registro como veio do GET e
o reenvia. **Convenção da feature: snake_case fim-a-fim no payload do PATCH**
(consistente com o handler atual). Não introduzir camelCase no body para evitar
o drift histórico das 40 ondas.

**Validação**: backend é a fonte da verdade (400 CNPJ inválido; 409 conflito;
404 ownership). Front valida apenas para UX (desabilitar Salvar). Sem Zod no
projeto — validação imperativa com os helpers existentes.

## Project Structure

```
docs/specs/migrar-cnpj-motorista/
├── spec.md                      (existente)
├── feature-briefing.md          (existente — fonte técnica autoritativa)
├── plan.md                      (este)
├── research.md                  (Phase 0)
├── data-model.md                (Phase 1)
├── quickstart.md                (Phase 1 — C1..C10)
└── contracts/
    └── patch-update-envio-massa.md   (Phase 1)

app_homologacao/
├── backend/
│   └── server.js                (ESTENDER: rota ~:875 + nova fn migrarCnpjMotorista; reuso helpers :1222+)
│   └── db/001_create_motorista.sql   (referência — NÃO alterar)
└── frontend_v2/
    └── components/
        └── edit-dialog.tsx       (ESTENDER: campo CNPJ máscara/validação + aviso fixo)
```

## Arquitetura da mudança

### Backend (`server.js`)

1. **Rota `PATCH /update-envio-massa/:id`**: passar a ler `cnpj_prestador` do
   body. Ordem das operações [A]..[H] conforme `contracts/...md`:
   `resolveEmpresaAlvo` → validar (400) → buscar movimento/cnpjAntigo (404) →
   idempotência (no-op se igual) → pré-check 409 (só Movee) → PATCH em lote
   movimentos (`id_empresa` + `cnpj_prestador=eq.antigo`) → `migrarCnpjMotorista`
   (só após movimentos OK, FR-010) → demais campos → 200. Falha parcial → 500
   sem reverter (FR-011).
2. **Nova função `migrarCnpjMotorista(cnpjAntigo, cnpjNovo, idEmpresa, cache)`**:
   gate `mesmoGrupoQue(idEmpresa,6,cache)`; 409 se existe novo; PATCH se existe
   antigo (preserva campos); POST pré-cadastro senão. Idempotente. Log sem
   segredos. Lança erro tipado para o handler mapear 409/500.
3. **Reuso (não reinventar)**: `onlyDigits`, `isCNPJ14`, `postgrestRequest`,
   `mesmoGrupoQue`, `resolveEmpresaAlvo`. Mesmo padrão de
   `upsertMotoristasFromLote` para o pré-cadastro.
4. **Não regredir**: semântica de `enviado/men1/men2/tipo` inalterada.

### Frontend (`edit-dialog.tsx`)

1. Campo `cnpj_prestador`: aplicar máscara visual; normalizar para 14 dígitos
   no `onChange` (`onlyDigits` equivalente no front).
2. Desabilitar Salvar enquanto o CNPJ foi alterado e `length !== 14` (FR-008).
3. Aviso fixo no diálogo (texto para todos, FR-014): "Isto também atualizará o
   login do motorista no app."
4. Tratar respostas: toast de erro em 400/409 (mensagem do backend); manter o
   diálogo aberto com valores anteriores no 409 (P2 cenário 2).
5. Enviar sempre os 14 dígitos crus no body (`cnpj_prestador`).

## Cenários de teste

Detalhados em `quickstart.md` (C1..C10). Unit do backend (mock
`postgrestRequest`): C1 feliz, C2 fora-do-grupo, C3 conflito 409, C4
antigo-inexistente→pré-cadastro, C5 idempotência, C6 CNPJ inválido, C7 falha
parcial→500, C8 IDOR escopo empresa. Frontend: C9 validação do diálogo.
E2E real: C10 roundtrip (sem mock).

## Riscos & Mitigações

| Risco | Severidade | Mitigação |
|-------|-----------|-----------|
| IDOR — troca em lote vazar para outra empresa | Alta | Filtro `id_empresa=eq.${idEmp}` (server-side) em todo PATCH de `EnvioMassa`; teste C8 |
| Multi-tenant — poluir base de login do grupo Movee | Alta | Gate `mesmoGrupoQue(id,6,cache)` antes de qualquer toque em `Motorista`; teste C2 |
| Falha parcial sem transação (movimentos OK, Motorista falha) | Média | 500 + log claro, sem reverter (FR-011); idempotência permite re-tentar; teste C7 |
| Fusão acidental de contas (409) | Média | Pré-check 409 antes de escrever; nunca merge automático; teste C3 |
| Drift snake_case/camelCase no payload | Baixa | Convenção de Borda: snake_case fim-a-fim; roundtrip real C10 |
| Premissa "sem DDL" falsa (coluna ausente) | Baixa | Confirmação read-only (data-model.md §Confirmação) antes de codar |

## Complexity Tracking

Nenhuma violação de constitution. Sem complexidade adicional não justificada
(reuso de rota e helpers existentes; sem novo serviço/camada). N/A.

## Re-check (pós-Phase 1)

Design não introduziu serviço, camada ou dependência nova. Os 5 princípios
permanecem PASS — em particular II (IDOR + gate de grupo são parte explícita do
contrato) e I (senha preservada, log sem segredos). Gate final: **PASS**.

### Gate OWASP (owasp-security, 2026-06-21) — findings remediados no contrato

A revisão OWASP do plano (Top 10:2025 A01, API1/BOLA, API3/BOPLA, CWE-862) não
achou nenhum `critical`. Findings tratados (Edit em `contracts/patch-update-envio-massa.md`):

- **SEC-03 [high]** — gate `mesmoGrupoQue` agora é guard-clause EXPLÍCITA `[E]`
  antes do pré-check 409 `[E1]`, não só dentro de `migrarCnpjMotorista`. Empresa
  fora do grupo nunca emite o SELECT de pré-check em `Motorista` (evita BOLA/info
  disclosure cross-tenant). `create-tasks`/`execute-task` devem materializar o
  gate como primeira instrução do bloco de Motorista.
- **SEC-04 [medium]** — violação do `UNIQUE` de `cnpj_prestador` no POST de
  pré-cadastro (race TOCTOU entre `[E1]` e o POST) mapeia para **409**, não 500.
  O `UNIQUE NOT NULL` do banco é a barreira atômica que fecha a janela.
- **SEC-05 [low]** — nota reforçada: nunca logar objeto `Motorista` completo no
  catch do 500 (carrega hash de senha).

PASS (info): SEC-01 (IDOR em lote mitigado), SEC-02 (tenant isolation),
SEC-06 (sem mass-assignment), SEC-07 (fail-closed, sem fusão de contas).

## Próximos passos

1. `/checklist` — quality gate dos requisitos antes de implementar.
2. `/create-tasks` — decompor em backlog executável.
3. `/analyze` — consistência cross-artifact após tasks.

# Plano de Implementação — Validação de XML em Lote Idempotente

**Feature**: `validacao-xml-lote`
**Spec**: [`spec.md`](./spec.md)
**Fonte de verdade técnica**: [`docs/plans/validacao-xml-lote-sem-substituir-validada.md`](../../plans/validacao-xml-lote-sem-substituir-validada.md)
**Data**: 2026-06-14

---

## Summary

Hoje o endpoint `POST /validate-xml-batch` (`app_homologacao/backend/server.js:1903`) é
**efêmero**: valida cada XML na FastAPI e retorna `{ stats, results }` sem **nenhuma escrita no
banco**. Esta feature o torna **idempotente e persistente**: cada XML é casado com o movimento
aberto correspondente em `EnvioMassa` e o resultado (`nota_ok` / `erro_validacao`) é gravado via
`PATCH` no PostgREST por `id` — **MAS uma nota já APROVADA nunca é sobrescrita** (gate central).

**Abordagem técnica** (do plano mestre §5 + clarify §12):
1. **Backend** — evoluir `extractNfseFields` (server.js:1868) para extrair chave de acesso (50
   dígitos, do `Id` de `<infNFSe>` sem prefixo `NFS`) + `numnota` (`<nNFSe>`); novo helper
   `findMovimentoParaXml` casando por chave (primário, via `getNFeKeyFromNotaOk`, server.js:1705)
   com fallback `cnpj_prestador + numnota + data_emissao`; reescrever o handler para carregar
   movimentos abertos UMA vez, aplicar a árvore de decisão §4 e `PATCH` idempotente por `id`.
2. **Frontend** — refletir o novo enum de status por linha (`use-xml-validation.ts` +
   `xml-validation-card.tsx`) com badge (cor + ícone + texto, a11y color-not-only) + resumo.

**SEM DDL** (clarify P2): chave derivada em runtime das colunas existentes. **SEM build/deploy**
(rito de produção é do operador — `docs/RITO-PRODUCAO.md`).

---

## Constitution Check

*GATE: passou antes do Phase 0; re-checado após Phase 1 (§ Re-check ao final).*

| Princípio | Status | Notas |
|-----------|--------|-------|
| I. Segurança de Autenticação & Segredos (NON-NEGOTIABLE) | PASS | Não toca auth/segredos. Handler preserva `authenticateToken`. `FASTAPI_VALIDATION_TOKEN` consumido de env como hoje; nenhum segredo logado/exposto. |
| II. Isolamento Multi-Tenant por Empresa (NON-NEGOTIABLE) | PASS | Casamento e PATCH escopados por `id_empresa` via `resolveEmpresaAlvo` (lança 403/503). É o cerne da US4. Nunca expande para o grupo (Q3); `mesmoGrupoQue(_,6)` afeta SÓ roteamento FastAPI. |
| III. Contratos de API & Proxy de Cookies | PASS | Frontend continua falando via proxy `/api/*`. A resposta de `/validate-xml-batch` é **estendida** (campos aditivos por linha + novos contadores em `stats`); request inalterada. Contrato documentado em `contracts/`. |
| IV. Qualidade e Revisão de Mudanças | PASS | Branch `feat/validacao-xml-lote`; Conventional Commits. Toca manipulação de XML/NFSe → SHOULD review aplicável (gates owasp/doc-quality desta onda). Validação de entrada de XML mantida/reforçada (parsing defensivo, FR-016). |
| V. Deploy Conteinerizado e Convivência de Serviços (NON-NEGOTIABLE) | PASS | Sem novos serviços. Deploy = `docker build/push/service update` pelo operador sob rito; não afeta containers existentes. |

Nenhum FAIL em princípio MUST → prosseguir.

---

## Technical Context

| Campo | Valor |
|-------|-------|
| **Linguagem (backend)** | Node.js 14 + Express (`app_homologacao/backend/server.js`) |
| **Linguagem (frontend)** | TypeScript / Next.js 16 / React 19 (`app_homologacao/frontend_v2`) |
| **Persistência** | PostgreSQL `chatmasterveloz` via **PostgREST** (HTTP), container `pgadmin_db` |
| **Parsing XML** | `xml2js` (`parseStringPromise`) — já em uso |
| **Upload** | `multer` (`upload.array('xmlFiles', 100)`) — já em uso |
| **Serviço externo** | FastAPI de validação: `fastapihomologacao/validade_nfse` (grupo Movee, não-nexus) e `fastapihomologacaonexus` (demais, `nexus=true`) |
| **Design system (FE)** | EntreGô 2.0 (Tailwind v4 + shadcn/ui + framer-motion + sonner) — **não** re-skin |
| **Auth** | JWT em cookie httpOnly; middleware `authenticateToken`; escopo via `resolveEmpresaAlvo` |
| **Testes** | Sem suíte automatizada formal no repo; validação por cenários manuais/roundtrip com fixtures reais (3 XMLs em `docs/nota_entrego/`) |
| **DDL** | **Nenhuma** (clarify P2 — chave derivada em runtime) |
| **Decisões de infraestrutura** | **N/A** — feature stateless: sem scheduling, sem novas keys/segredos, sem refresh token novo, sem cache, sem fila. Apenas evolução de handler HTTP existente. |
| NEEDS CLARIFICATION restantes | 0 (Q1–Q4 + P1–P5 resolvidos no clarify) |

---

## Phase 0 — Research

Detalhe completo em [`research.md`](./research.md). Decisões-chave:

- **D1 — Extração da chave NFS-e nacional**: `Id` de `<infNFSe>` sem prefixo `NFS` (50 dígitos);
  fallback = basename do `filename` (já é a chave pura). Defensivo para layouts ABRASF futuros.
- **D2 — Casamento e índices**: chave primária (via `getNFeKeyFromNotaOk` do `nota_ok` existente)
  + fallback `cnpj+numnota+data_emissao` (por dia). Movimentos carregados UMA vez por lote.
- **D3 — Persistência idempotente**: `PATCH EnvioMassa?id=eq.<id>` gravando apenas
  `nota_ok`/`erro_validacao`; valor financeiro nunca alterado (P5). Gate de não-sobrescrita de
  aprovada.
- **D4 — Enum de status SUBSTITUI flags booleanas** (Q4): `ValidationRow` perde
  `valid`/`valid_cnpj_prestador`/`valid_valor` em favor de `status` + `match_criterio` +
  `movimento_id`.
- **D5 — Rate-limit condicional**: 2 s entre arquivos APENAS quando há chamada à FastAPI; skip/
  duplicada não esperam.
- **D6 — Negócio × infra**: 4xx com `detail` → propaga mensagem; timeout/5xx/sem resposta →
  "serviço de validação indisponível".

---

## Phase 1 — Design

- **Modelo de dados / entidades**: [`data-model.md`](./data-model.md) — `EnvioMassa` (existente,
  sem DDL), `XmlExtractedFields` (in-memory), `ValidationRow` (resposta), `BatchStats`.
- **Contratos**: [`contracts/validate-xml-batch.md`](./contracts/validate-xml-batch.md) (API
  HTTP) — request/response do handler reescrito + árvore de decisão.
- **Cenários de teste / roundtrip**: [`quickstart.md`](./quickstart.md) — inclui roundtrip E2E
  real com os 3 XMLs de `docs/nota_entrego/`.

---

## Convenções de Borda

Feature atravessa **2 camadas** (backend Express ↔ frontend Next). Fonte da verdade de cada
convenção:

| Camada | Case style | Validação | Fonte da verdade |
|--------|------------|-----------|------------------|
| DB columns (PostgreSQL/PostgREST) | snake_case (`nota_ok`, `erro_validacao`, `id_empresa`, `mov_fechado`, `cnpj_prestador`, `numnota`, `data_emissao`) | sem migration (colunas já existem) | schema existente (server.js:1649 select) |
| Backend handler (JS) | resposta em **snake_case** (mantém o padrão atual de `/validate-xml-batch`: `stats`, `results`, e os campos por linha já são snake/lower) | montagem manual do objeto `row` no handler | `app_homologacao/backend/server.js` (handler `/validate-xml-batch`) |
| API payload (response) | **snake_case** nos novos campos: `status`, `match_criterio`, `movimento_id` | sem Zod no projeto — tipagem TS espelha o JSON literal | `contracts/validate-xml-batch.md` |
| Frontend DTO (TS) | espelha o JSON do backend **literalmente** (snake_case nos campos novos) | tipo `ValidationRow` em `use-xml-validation.ts` | `app_homologacao/frontend_v2/hooks/use-xml-validation.ts` |
| URL/multipart | `xmlFiles` (multipart field), `empresa_id` (query/body) | `multer` + `resolveEmpresaAlvo` | server.js handler |

**Mapper layer (DB ↔ DTO)**: PostgREST devolve as colunas em snake_case; o handler lê direto
(sem ORM/auto-mapping). ORM auto-mapping: **NÃO**.

**Validação Zod**: o projeto **não usa Zod**. A tipagem do frontend (`ValidationRow`) é a
fonte de verdade do shape no FE e DEVE espelhar exatamente o JSON do backend (snake_case nos
campos novos `status`/`match_criterio`/`movimento_id`). **Regra dura anti-drift**: não introduzir
camelCase nos campos novos — manter snake_case ponta-a-ponta para evitar a divergência
snake_case×camelCase. O cenário "Roundtrip E2E" do quickstart valida o shape real.

---

## Project Structure

### Documentação (feature dir)

```
docs/specs/validacao-xml-lote/
├── spec.md            (existente — specify + clarify)
├── plan.md            (este arquivo)
├── research.md        (Phase 0)
├── data-model.md      (Phase 1)
├── quickstart.md      (Phase 1 — cenários + roundtrip E2E)
└── contracts/
    └── validate-xml-batch.md   (contrato HTTP do handler)
```

### Código-fonte (árvore real — pontos de mudança)

```
app_homologacao/
├── backend/
│   └── server.js
│       ├── getNFeKeyFromNotaOk()         (server.js:1705 — REUSAR, não mudar)
│       ├── resolveEmpresaAlvo/mesmoGrupoQue (server.js:24 — REUSAR)
│       ├── extractNfseFields()           (server.js:1868 — EVOLUIR: + chave + numnota)
│       ├── findMovimentoParaXml()        (NOVO helper — casamento chave/fallback)
│       └── POST /validate-xml-batch       (server.js:1903 — REESCREVER: carregar movimentos,
│                                            árvore §4, PATCH idempotente, resposta enriquecida)
└── frontend_v2/
    ├── hooks/use-xml-validation.ts        (EVOLUIR: tipo ValidationRow + novos stats)
    ├── components/xml-validation-card.tsx (EVOLUIR: badge por status + resumo a11y)
    └── app/dashboard/validacao-xml/page.tsx (AJUSTE leve se necessário p/ novos campos)
```

**NÃO TOCAR** (restrições §6): `/upload` (XLSX), `contexts/auth-context.tsx`, white-label
(`tenant-theme-context.tsx`), regra da base `Motorista`. Sem novas dependências no frontend.

---

## Complexity Tracking

Nenhuma violação de constitution → tabela vazia (sem complexidade não justificada). A feature é
evolução de um handler existente + tipos de UI; não adiciona serviço, camada, fila ou store.

---

## Re-check de Constitution (pós-Phase 1)

| Verificação | Resultado |
|-------------|-----------|
| Design introduziu serviço/camada extra? | NÃO — apenas helper interno + evolução de handler |
| Multi-tenant (Princ. II) preservado no design? | SIM — todo casamento/PATCH dentro de `id_empresa` resolvido por `resolveEmpresaAlvo`; índices construídos só sobre movimentos da empresa-alvo |
| Contrato de API (Princ. III) quebrou? | NÃO — mudança aditiva na resposta; request inalterada; documentada em `contracts/` |
| Segredos/auth (Princ. I) tocados? | NÃO |
| Deploy (Princ. V) afeta serviços existentes? | NÃO — sem novos containers; deploy sob rito pelo operador |

**Constitution: PASS** (pré e pós design).

---

## Próximos Passos

1. `/checklist` — quality gate de requisitos antes de implementar.
2. `/create-tasks` — decompor em backlog (Fase 1 backend, Fase 2 frontend, Fase 3 testes).
3. `/analyze` — consistência cross-artifact após tasks.
4. **Deploy**: NÃO automático. Entregar PR + pedir deploy ao operador (rito `docs/RITO-PRODUCAO.md`).

# Tasks: Movimento por Empresa/Filial

**Feature**: `movimento-por-filial`
**Branch**: `feat/movimento-por-filial`
**Gerado em**: 2026-06-10
**Spec**: [spec.md](./spec.md) | **Plano**: [plan.md](./plan.md) | **Research**: [research.md](./research.md)
**Contratos**: [contracts/grupo-escopo-api.md](./contracts/grupo-escopo-api.md) · [contracts/movimento-api.md](./contracts/movimento-api.md)
**Checklists**: [security.md](./checklists/security.md) · [api.md](./checklists/api.md) · [ux.md](./checklists/ux.md)

---

## Legenda de Criticidade

- `[crit]` — Crítico: bloqueia a feature ou viola invariante de segurança/multi-tenant
- `[high]` — Alta: necessário para completar user story
- `[med]` — Média: quality gate ou melhoria significativa de UX
- `[low]` — Baixa: polish, observabilidade opcional

---

## Matriz de Dependências

```
1.1 (helper resolveEmpresaAlvo)
 └─▶ 1.2 (GET /grupo/escopo)
 └─▶ 1.3 (threading GET endpoints)
 └─▶ 1.4 (threading POST/DELETE/PATCH)
       └─▶ 1.5 (correção IDOR PATCH)
 └─▶ 1.6 (testes backend)
       depende de: 1.2, 1.3, 1.4, 1.5

2.1 (instalar shadcn command+popover)
 └─▶ 2.2 (componente EmpresaSelector)
       └─▶ 2.3 (integração dashboard — URL + refetch)
             └─▶ 2.4 (threading use-envio-massa + api-client)
                   └─▶ 2.5 (ocultar escopo=1)

3.1 (ui-ux-pro-max acabamento)
  depende de: 2.1, 2.2, 2.3

4.1 (validação E2E em homologação)
  depende de: 1.x todos, 2.x todos, 3.1
```

---

## Resumo do Backlog

| ID | Fase | Título | Criticidade | Deps |
|----|------|--------|-------------|------|
| 1.1 | FASE 1 | Helper `resolveEmpresaAlvo` | [crit] | — |
| 1.2 | FASE 1 | Endpoint `GET /grupo/escopo` | [crit] | 1.1 |
| 1.3 | FASE 1 | Threading empresa_id em GET endpoints (3x) | [crit] | 1.1 |
| 1.4 | FASE 1 | Threading empresa_id em POST/DELETE endpoints (3x) | [crit] | 1.1 |
| 1.5 | FASE 1 | Correção IDOR no PATCH /update-envio-massa/:id | [crit] | 1.1 |
| 1.6 | FASE 1 | Testes backend (TS-BE-1..13) | [high] | 1.1–1.5 |
| 2.1 | FASE 2 | Instalar shadcn command + popover | [crit] | — |
| 2.2 | FASE 2 | Componente EmpresaSelector (combobox pesquisável) | [crit] | 2.1 |
| 2.3 | FASE 2 | Integração dashboard: URL param + refetch | [crit] | 2.2 |
| 2.4 | FASE 2 | Threading empresa_id em use-envio-massa + api-client | [crit] | 2.3 |
| 2.5 | FASE 2 | Ocultar combobox quando escopo=1 | [high] | 2.3 |
| 3.1 | FASE 3 | Acabamento UX via /ui-ux-pro-max | [med] | 2.1–2.5 |
| 4.1 | FASE 4 | Validação E2E em homologação | [high] | 1.x, 2.x, 3.1 |

**Total**: 13 tarefas · 6 críticas no backend, 4 críticas no frontend.

---

## Escopo Coberto

- Helper `resolveEmpresaAlvo` com fail-closed (CHK014 — 503 em erro de banco) e log de 403 (CHK019)
- Endpoint `GET /grupo/escopo` (autenticado, sem `requireGrupoPai`)
- Threading de `empresa_id` nos 7 endpoints de movimento (GET/POST/DELETE/PATCH)
- Correção do IDOR pré-existente em `PATCH /update-envio-massa/:id` (FR-013)
- Testes backend: default / em-escopo / fora→403 / não-numérico (TS-BE-1..13)
- Componente combobox pesquisável com ARIA completo (CHK007–CHK012), toque ≥44px (CHK014-UX), contraste WCAG AA
- Estado de filial via query param `?empresa_id=N` persistente na URL
- Threading frontend em `use-envio-massa.ts` + `api-client.ts`
- Ocultamento do combobox para empresa com escopo único
- Acabamento UX via skill `/ui-ux-pro-max`
- Validação E2E em homologação (sem deploy automático — D9)

## Escopo Excluído (FR-EX-001)

- Loop de envio / `ProcessControl` / `validate-xml-batch` / `processBatchMessages` — continuam operando sobre `req.user.empresaId` sem threading
- Deploy automático — apenas com autorização explícita do operador (D9)
- Rate limiting no `resolveEmpresaAlvo` (CHK011 — decisão de negócio, fora do MVP)
- Política de retenção de logs (CHK020 — decisão regulatória, fora do MVP)

---

## FASE 1 — Backend: resolveEmpresaAlvo + Endpoints

### 1.1 Helper `resolveEmpresaAlvo` [crit]

**Dependências**: —
**Arquivos afetados**: `routes/grupo.js` (ou novo helper em `lib/empresa-scope.js`)
**FRs**: FR-014, FR-015 | **Contrato**: [contracts/grupo-escopo-api.md §Helper](./contracts/grupo-escopo-api.md)
**Checklist**: CHK014-SEC (fail-closed), CHK019-SEC (log de 403), CHK016-SEC (tipo inteiro)

- [x] Implementar `resolveEmpresaAlvo(user, requestedId)` reutilizando `resolveScope(user)` de `routes/grupo.js`
- [x] Comportamento quando `requestedId` é `null`/`''`/`undefined`: retornar `user.empresaId` (backward-compatible; sem 403)
- [x] Comportamento quando `requestedId` é não-numérico (`parseInt` retorna `NaN`): retornar erro `{ status: 403, error: "empresa_id inválido" }`
- [x] Comportamento quando `requestedId` é inteiro mas fora do escopo: retornar erro `{ status: 403, error: "empresa fora do escopo" }`
- [x] **CHK014 — fail-closed**: se `resolveScope(user)` lançar exceção (ex: erro de banco ao consultar filiais), retornar **503** `{ error: "escopo indisponível" }` — NUNCA deixar passar sem validação (invariante: fail-closed, não fail-open)
- [x] **CHK019 — log de 403**: ao retornar 403 (qualquer motivo), registrar no log: `user_id`, `empresa_id` tentada, endpoint (passado como parâmetro ou detectado via contexto do handler)
- [x] Exportar `resolveEmpresaAlvo` para ser reutilizado nos 7 handlers

**Critérios de aceite testáveis**:
- `resolveEmpresaAlvo(user, null)` → retorna `user.empresaId` (sem lançar)
- `resolveEmpresaAlvo(user, "abc")` → retorna `{ status: 403, error: "empresa_id inválido" }`
- `resolveEmpresaAlvo(user, 999_fora_do_escopo)` → retorna `{ status: 403, error: "empresa fora do escopo" }`
- `resolveEmpresaAlvo(user, id_no_escopo)` → retorna o inteiro do `id`
- `resolveScope` lança erro → retorna `{ status: 503, error: "escopo indisponível" }` (nenhum dado exposto)
- Log contém `user_id + empresa_id + endpoint` para cada 403 emitido

> **Revisão OWASP obrigatória** — este helper é o único ponto de controle de acesso cross-empresa. Qualquer bypass aqui viola o Princípio II (Multi-Tenant) da constitution.

---

### 1.2 Endpoint `GET /grupo/escopo` [crit]

**Dependências**: 1.1
**Arquivos afetados**: `routes/grupo.js` (novo handler) ou `server.js`
**FRs**: FR-016 | **Contrato**: [contracts/grupo-escopo-api.md §Endpoint](./contracts/grupo-escopo-api.md)
**Checklist**: CHK001-API (contrato documentado), CHK006-API (401 sem token)

- [ ] Registrar rota `GET /api/grupo/escopo` com middleware `authenticateToken` (SEM `requireGrupoPai` — filhos também consultam)
- [ ] Montar lista `empresas` no handler:
  - Se `is_grupo_pai = true`: buscar filiais via `Empresa?id_grupo=eq.${id_grupo}&order=nome_empresa.asc`, prepend da empresa-pai com `default: true`
  - Se `is_grupo_pai = false` (filho): retornar array com apenas a própria empresa (`[{ id: empresaId, nome_empresa, default: true }]`)
- [ ] Shape da resposta 200 conforme contrato: `{ empresas: [{ id, nome_empresa, default? }] }`
- [ ] Retornar 401 quando token ausente/inválido

**Critérios de aceite testáveis** (TS-BE-11, TS-BE-12, TS-BE-13):
- Admin pai com 2 filiais: resposta 200 com array de 3 itens (pai + 2 filiais), pai tem `default: true`
- Admin filho (sem filiais): resposta 200 com array de 1 item
- Sem token: resposta 401
- `nome_empresa` em todos os itens (nunca apenas `id`)

---

### 1.3 Threading `empresa_id` nos endpoints GET (3 endpoints) [crit]

**Dependências**: 1.1
**Arquivos afetados**: `server.js` (linhas aprox. 276, 1410, 1498)
**FRs**: FR-009, FR-010, FR-011 | **Contrato**: [contracts/movimento-api.md §1–3](./contracts/movimento-api.md)
**Checklist**: CHK001-SEC (escopo em GET), CHK003-API (fonte correta por endpoint)

Endpoints cobertos nesta tarefa:
1. `GET /envio-massa` — `empresa_id` via query string (`req.query.empresa_id`)
2. `GET /export-envio-massa` — `empresa_id` via query string
3. `GET /download-xml-movimento` — `empresa_id` via query string

Para cada endpoint:
- [ ] Extrair `empresa_id` da query (`req.query.empresa_id`)
- [ ] Chamar `resolveEmpresaAlvo(req.user, req.query.empresa_id)` e capturar resultado
- [ ] Se resultado contiver `status: 403` ou `status: 503`, retornar imediatamente com o status/body do helper
- [ ] Substituir o `req.user.empresaId` hard-coded na query PostgREST pelo `idEmp` resolvido
- [ ] Manter comportamento idêntico ao atual quando `empresa_id` não é enviado (default = empresa do token)

**Critérios de aceite testáveis**:
- `GET /api/envio-massa` sem `empresa_id` → retorna dados da empresa do token (sem regressão — TS-BE-1)
- `GET /api/envio-massa?empresa_id=<filial_no_escopo>` → retorna dados da filial (TS-BE-2)
- `GET /api/envio-massa?empresa_id=<fora_do_escopo>` → 403 `{ "error": "empresa fora do escopo" }` (TS-BE-3)
- Idem para `/export-envio-massa` e `/download-xml-movimento`
- Export gerado contém apenas registros da filial selecionada (US3-AC1)
- Download de XML retorna arquivo da nota pertencente à filial alvo (US3-AC2)

---

### 1.4 Threading `empresa_id` nos endpoints POST/DELETE (3 endpoints) [crit]

**Dependências**: 1.1
**Arquivos afetados**: `server.js` (linhas aprox. 1165, 1770, 776)
**FRs**: FR-007, FR-008, FR-012 | **Contrato**: [contracts/movimento-api.md §4–6](./contracts/movimento-api.md)
**Checklist**: CHK001-SEC, CHK018-SEC (upload via multipart — mesma validação)

> **Revisão OWASP obrigatória** — POST /upload e POST /close-movimento tocam escrita de dados e fechamento de período fiscal. Bypass de escopo aqui causa corrupção de dados entre empresas.

Endpoints cobertos nesta tarefa:
1. `POST /upload` — `empresa_id` via campo FormData (`req.body.empresa_id` após multer)
2. `POST /close-movimento` — `empresa_id` via body JSON (`req.body.empresa_id`)
3. `DELETE /envio-massa/:id` — `empresa_id` via body ou query (`req.body.empresa_id`)

Para cada endpoint:
- [ ] Extrair `empresa_id` da fonte correta (vide contratos §4, §5, §6)
- [ ] Chamar `resolveEmpresaAlvo(req.user, empresa_id_extraido)` — mesmo padrão da tarefa 1.3
- [ ] Retornar 403/503 imediatamente se helper retornar erro
- [ ] Para `POST /upload`: gravar `id_empresa = idEmp` na tabela `EnvioMassa` (não mais `req.user.empresaId`)
- [ ] Para `POST /close-movimento`: filtrar `EnvioMassa?id_empresa=eq.${idEmp}&mov_fechado=eq.false` (apenas registros da filial alvo — US3-AC3)
- [ ] Para `DELETE /envio-massa/:id`: filtrar por `id_empresa` antes de deletar (não deletar registro de outra empresa)

**Critérios de aceite testáveis**:
- Upload com `empresa_id` válido → nota gravada com `id_empresa` correto (TS-BE-6)
- Upload com `empresa_id` fora do escopo → 403, 0 registros criados (TS-BE-7)
- Fechar movimento da filial Z → apenas registros da filial Z fechados; registros de outras filiais inalterados (TS-BE-8, US3-AC3)
- Delete de registro pertencente a outra empresa → 404 ou 403 (TS-BE-9)

---

### 1.5 Correção IDOR — `PATCH /update-envio-massa/:id` [crit]

**Dependências**: 1.1
**Arquivos afetados**: `server.js` linha ~762; possível refatoração de `updateEnvioMassa()`
**FRs**: FR-013 | **Contrato**: [contracts/movimento-api.md §7](./contracts/movimento-api.md)
**Checklist**: CHK003-SEC (gap pré-existente documentado)

> **Revisão OWASP obrigatória** — gap pré-existente de IDOR (Insecure Direct Object Reference): qualquer autenticado pode editar qualquer `id` sem verificar ownership. OWASP API4:2023 (Broken Object Level Authorization).

- [ ] Extrair `empresa_id` de `req.body.empresa_id` e resolver via `resolveEmpresaAlvo`
- [ ] Retornar 403/503 imediatamente se helper retornar erro
- [ ] Implementar verificação de ownership **atômica**: usar filtro composto na query PostgREST `EnvioMassa?id=eq.${id}&id_empresa=eq.${idEmp}` (se `updateEnvioMassa` aceitar filtro extra), OU pré-checar com `SELECT id WHERE id=eq.${id} AND id_empresa=eq.${idEmp}` e retornar 404 se vazio antes de atualizar
- [ ] Nunca retornar dados da linha (nem `id`) quando o registro não pertence ao escopo

**Critérios de aceite testáveis** (TS-BE-10):
- `PATCH /api/update-envio-massa/42` com `empresa_id` correto (registro pertence à empresa) → 200, atualiza
- `PATCH /api/update-envio-massa/42` com `empresa_id` de outra empresa do escopo mas registro não pertence → 404 (filtro não casa, linha não atualizada)
- `PATCH /api/update-envio-massa/42` com `empresa_id` fora do escopo → 403 antes mesmo de tocar o banco
- Tentar PATCH sem `empresa_id` → usa empresa do token; só atualiza se o registro pertencer ao token user

---

### 1.6 Testes backend — `resolveEmpresaAlvo` + endpoints [high]

**Dependências**: 1.1, 1.2, 1.3, 1.4, 1.5
**Arquivos afetados**: `tests/` (novo arquivo `test-movimento-escopo.js` ou similar)
**FRs**: FR-014, FR-015 | **Quickstart**: [quickstart.md TS-BE-1..13](./quickstart.md)
**Checklist**: CHK002-API (pares erro documentados), CHK009-API (close sem registros)

Cobrir os seguintes cenários (mapeados em quickstart.md):

- [x] **TS-BE-1** — Default sem `empresa_id`: resposta idêntica ao comportamento atual (sem regressão)
- [x] **TS-BE-2** — `empresa_id` de filial dentro do escopo: retorna dados da filial
- [x] **TS-BE-3** — `empresa_id` fora do escopo: 403 `{ "error": "empresa fora do escopo" }`, sem dados expostos
- [x] **TS-BE-4** — `empresa_id` não-numérico (`"abc"`, `"1; DROP"`): 403 `{ "error": "empresa_id inválido" }`
- [x] **TS-BE-5** — Filho não expande escopo: empresa filho não consegue acessar outras empresas do grupo
- [x] **TS-BE-6** — Upload grava na filial-alvo: `id_empresa` gravado corretamente
- [x] **TS-BE-7** — Upload fora do escopo: 403, 0 registros criados
- [x] **TS-BE-8** — Close-movimento por filial: apenas registros da filial são fechados
- [x] **TS-BE-9** — Delete: registro de outra empresa não é deletado
- [x] **TS-BE-10** — PATCH fecha o IDOR pré-existente (TS-BE-10)
- [x] **TS-BE-11** — `GET /grupo/escopo` (pai): array com pai + filiais
- [x] **TS-BE-12** — `GET /grupo/escopo` (filho/single): array com 1 item
- [x] **TS-BE-13** — `GET /grupo/escopo` sem auth: 401
- [x] **CHK009-API** — `POST /close-movimento` com filial sem registros abertos: 200 com `{ fechados: 0 }` (não 500)

**Critérios de aceite testáveis**:
- Todos os 13 TS-BE passam sem erro
- CHK009 `close-movimento` com 0 registros → 200 `{ fechados: 0 }`
- Nenhum teste de regressão falha (comportamento sem `empresa_id` idêntico ao atual)

---

## FASE 2 — Frontend: EmpresaSelector + Threading

### 2.1 Instalar shadcn command + popover [crit]

**Dependências**: —
**Arquivos afetados**: `frontend_v2/components/ui/` (gerado pelo shadcn CLI), `package.json`
**FRs**: FR-006 (busca textual) | **Research**: [research.md §D0.1](./research.md)

- [x] Criar `components/ui/command.tsx` manualmente (Base UI combobox — projeto usa `@base-ui/react`, não `@radix-ui`; `npx shadcn add` não aplicável)
- [x] Criar `components/ui/popover.tsx` manualmente (Base UI popover — mesma razão; sem dep nova necessária)
- [x] Sem novas deps em `package.json` (`@base-ui/react ^1.3.0` já cobria popover + combobox)
- [x] `tsc --noEmit` passa limpo (TS-REG-2 via typecheck)

**Critérios de aceite testáveis**:
- `import { Command, CommandInput, CommandList, CommandItem } from "@/components/ui/command"` compila sem erro
- `import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover"` compila sem erro
- `npm run build` passa limpo

---

### 2.2 Componente `EmpresaSelector` (combobox pesquisável) [crit]

**Dependências**: 2.1
**Arquivos afetados**: `frontend_v2/components/empresa-selector.tsx` (novo)
**FRs**: FR-001, FR-006 | **Contrato**: [contracts/grupo-escopo-api.md §Response](./contracts/grupo-escopo-api.md)
**Checklist**: CHK007–CHK012 UX/ARIA, CHK013 (contraste), CHK014-UX (toque ≥44px), CHK015 (responsivo)

> **Tarefa irmã**: 3.1 fará acabamento visual via `/ui-ux-pro-max`; esta tarefa foca em funcionalidade e acessibilidade base.

- [x] Criar `components/empresa-selector.tsx` aceitando props: `empresas: { id: number; nome_empresa: string; default?: boolean }[]`, `value: number | null`, `onChange: (id: number) => void`
- [x] Usar `Popover` + `Command` do shadcn para montar o combobox pesquisável
- [x] Campo de busca `CommandInput` com `aria-label="Buscar filial"` (CHK008)
- [x] Cada `CommandItem` exibe `nome_empresa` como texto visível (nunca apenas ID — CHK009)
- [x] Trigger (`PopoverTrigger`) com `role="combobox"`, `aria-expanded={open}`, `aria-haspopup="listbox"` (CHK007)
- [x] Navegação por teclado: `↓/↑` navegam a lista, `Enter` seleciona, `Escape` fecha o popover (CHK011–CHK012); comportamento nativo do Base UI — não suprimido
- [x] Área de toque do trigger: `min-h-[44px] min-w-[44px]` via Tailwind (CHK014-UX, WCAG 2.5.5)
- [x] Contraste WCAG 2.1 AA (4.5:1): usar cores do design system EntreGô 2.0 ou tokens CSS equivalentes para texto sobre fundo (CHK013)
- [x] Em telas ≤375px: `PopoverContent` com `w-[calc(100vw-2rem)]` e `max-h-[60vh] overflow-y-auto` (CHK015)
- [x] Estado de loading enquanto `GET /grupo/escopo` carrega: skeleton ou texto "Carregando..." no trigger (CHK005-UX)
- [x] Estado de erro (API indisponível): mensagem de erro acessível, combobox desabilitado (CHK006-UX)
- [x] `aria-live="polite"` em elemento adjacente anunciando "Filial [nome] selecionada. Dados recarregados." após troca (CHK010)
- [x] Componente exportado como default e named export

**Critérios de aceite testáveis**:
- Componente renderiza com lista de empresas do mock
- Campo de busca filtra por `nome_empresa` (substrings, case-insensitive)
- Selecionar item chama `onChange(id)` com o `id` numérico correto
- `aria-expanded` muda de `false` para `true` ao abrir
- Área de toque ≥44px verificável via computed styles
- `npm run build` limpo após adicionar o componente

---

### 2.3 Integração no dashboard: URL param + refetch [crit]

**Dependências**: 2.2
**Arquivos afetados**: `frontend_v2/app/dashboard/page.tsx` (ou equivalente — verificar path real), `contexts/auth-context.tsx` (leitura de `is_grupo_pai`)
**FRs**: FR-001, FR-004, FR-005 | **Research**: [research.md §D0.3, D0.4](./research.md)
**Checklist**: CHK005-UX (loading ao trocar), CHK019-UX (aria-live)

- [x] Chamar `GET /api/grupo/escopo` no mount do dashboard para obter a lista de empresas e determinar visibilidade
- [x] Ler `?empresa_id=N` da URL via `useSearchParams` ao inicializar; se ausente, usar a empresa marcada `default: true`
- [x] Renderizar `<EmpresaSelector>` SOMENTE se `empresas.length > 1` (FR-002 — sem regressão para single-empresa — D4, US1-AS4)
- [x] Ao trocar a seleção no `EmpresaSelector`, atualizar o query param `?empresa_id=N` via `router.push`/`router.replace` sem reload completo (FR-004, US1-AS3)
- [x] Ao trocar a seleção, disparar refetch dos dados de movimento (FR-005, US1-AS2) — sem confirmação prévia do usuário
- [x] `empresa_id` inválido na URL (não-numérico ou fora do escopo retornado por `/grupo/escopo`): silenciosamente usar a empresa-pai como padrão (edge case spec)
- [x] Ao fechar o popover e o usuário copiar a URL, a nova aba deve carregar com a filial já selecionada (US1-AS3)

**Critérios de aceite testáveis** (TS-FE-1..6):
- TS-FE-1: combobox visível para admin de grupo com ≥2 empresas
- TS-FE-2: combobox oculto para empresa single
- TS-FE-3: trocar filial atualiza URL + recarrega dados
- TS-FE-4: busca dentro do combobox funciona
- TS-FE-5: link compartilhado com `?empresa_id=N` carrega dados da filial correta
- TS-FE-6: `?empresa_id=texto_invalido` → usa empresa-pai, sem erro visível ao usuário

---

### 2.4 Threading `empresa_id` em `use-envio-massa.ts` + `api-client.ts` [crit]

**Dependências**: 2.3
**Arquivos afetados**: `frontend_v2/hooks/use-envio-massa.ts`, `frontend_v2/lib/api-client.ts`
**FRs**: FR-003, FR-005 | **Contrato**: [contracts/movimento-api.md §1–7](./contracts/movimento-api.md)

- [x] Em `api-client.ts`: adicionar parâmetro opcional `empresaId?: number` a todas as funções que chamam os 7 endpoints de movimento; quando presente, append `empresa_id=${empresaId}` ao query string ou body
- [x] Em `use-envio-massa.ts`: receber `empresaId` como parâmetro (ou via `useSearchParams` interno) e passá-lo para as chamadas do `api-client.ts`
- [x] O hook deve invalidar/refetch quando `empresaId` muda (dep array do `useEffect`/`useQuery`)
- [x] Upload (`POST /upload`): incluir `empresa_id` como campo FormData adicional
- [x] Close-movimento, delete, PATCH: incluir `empresa_id` no body JSON
- [x] Sem `empresaId`: omitir o parâmetro (backend usa default = empresa do token — backward-compatible)

**Critérios de aceite testáveis**:
- Roundtrip TS-RT-1: `GET /grupo/escopo` → selecionar filial → `GET /envio-massa?empresa_id=N` retorna dados da filial
- `api-client.ts` compila sem erros TS
- `npm run build` limpo
- Mudar `empresaId` no hook dispara nova requisição (verificável via DevTools Network)

---

### 2.5 Ocultar combobox quando escopo = 1 empresa [high]

**Dependências**: 2.3
**Arquivos afetados**: `frontend_v2/app/dashboard/page.tsx`
**FRs**: FR-002 | **Clarificações**: D4 (D4 pré-confirmado pelo operador)

- [x] Verificar que a condição `empresas.length > 1` em 2.3 já satisfaz este requisito (caso trivial — validar)
- [x] Garantir que quando `empresas.length === 1`, o DOM não renderiza o `<EmpresaSelector>` (sem `display: none` — elemento deve estar ausente)
- [x] Verificar que o layout da página não quebra com o combobox ausente (sem gap vazio no header)
- [x] Testar com empresa filho (não é grupo-pai): combobox ausente, UI idêntica ao atual

**Critérios de aceite testáveis**:
- Admin de empresa filho ou empresa sem filiais: `<EmpresaSelector>` não presente no DOM
- Layout da página sem combobox idêntico ao layout atual (sem regressão visual — US1-AS4)

---

## FASE 3 — Acabamento UX

### 3.1 Acabamento visual do EmpresaSelector via `/ui-ux-pro-max` [med]

**Dependências**: 2.1, 2.2, 2.3, 2.4, 2.5
**Arquivos afetados**: `frontend_v2/components/empresa-selector.tsx`, possíveis tokens CSS globais
**FRs**: FR-001, FR-006 | **Clarificações**: D8 (acabamento UX via skill dedicada)
**Checklist**: CHK013 (contraste), CHK014-UX (toque), CHK015 (responsivo), CHK018-UX (microcopy placeholder)

> Esta tarefa invoca explicitamente a skill `/ui-ux-pro-max` para revisar e refinar o `EmpresaSelector`. O executor deve usar o comando `/ui-ux-pro-max` (skill) passando o caminho do componente.

- [ ] Invocar `/ui-ux-pro-max` com escopo: componente `EmpresaSelector`, design system EntreGô 2.0 (paleta azul/menta/creme, Plus Jakarta Sans, Material Symbols Rounded)
- [ ] Aplicar refinamentos de contraste indicados pela skill (se alguma cor não atingir 4.5:1 WCAG AA — CHK013)
- [ ] Refinar microcopy do placeholder do combobox: usar texto descritivo como "Selecionar filial..." (CHK018-UX)
- [ ] Ajustar responsividade para mobile ≤375px conforme saída da skill (CHK015)
- [ ] Verificar e ajustar estados: hover, focus-visible, selected, disabled — com ring/outline visível para navegação por teclado
- [ ] Garantir que `npm run build` continua limpo após os ajustes

**Critérios de aceite testáveis**:
- Contraste de texto no trigger e lista ≥4.5:1 (verificável via ferramenta de contraste)
- Placeholder é "Selecionar filial..." ou equivalente descritivo
- Em mobile 375px: popover não ultrapassa a viewport, lista scrollável
- Estados hover/focus visualmente distintos
- `npm run build` limpo

---

## FASE 4 — Validação E2E em Homologação

### 4.1 Validação E2E em homologação (sem deploy automático) [high]

**Dependências**: 1.1–1.6, 2.1–2.5, 3.1
**Ambientes**: homologação (`envmassv2.todo-tips.com` + API `fastapihomologacao` ou equivalente backend)
**FRs**: todos os FRs | **Quickstart**: [quickstart.md — Roundtrip TS-RT-1](./quickstart.md)
**Clarificações**: D9 (deploy só com autorização explícita do operador)

> **IMPORTANTE**: Esta tarefa NÃO inclui deploy. A validação usa um ambiente já em execução ou branch subida manualmente pelo operador. Nenhuma automação de push/deploy deve ser executada por esta tarefa.

- [ ] Confirmar com o operador que o branch `feat/movimento-por-filial` está disponível em homologação antes de executar os testes (D9)
- [ ] **Roundtrip TS-RT-1**: autenticar como admin de grupo → `GET /grupo/escopo` retorna ≥2 empresas → dashboard exibe combobox → selecionar filial → URL atualiza para `?empresa_id=N` → listagem de movimento recarrega com dados da filial selecionada
- [ ] **TS-FE-1**: combobox visível para admin de grupo
- [ ] **TS-FE-2**: combobox oculto para empresa single (login com conta filho)
- [ ] **TS-FE-3**: trocar filial recarrega dados + persiste URL
- [ ] **TS-FE-5**: URL copiada com `?empresa_id=N` mantém seleção ao abrir em nova aba
- [ ] **TS-FE-6**: `?empresa_id=texto` na URL → fallback para empresa-pai sem erro
- [ ] **Segurança**: tentar forjar `empresa_id` de outro grupo via DevTools (fetch manual) → 403
- [ ] **Regressão TS-REG-1**: fluxo de envio (ProcessControl / loop de envio) continua funcionando com `req.user.empresaId` sem threading — nenhuma regressão
- [ ] **Regressão TS-REG-2**: build frontend limpo, sem warnings de TypeScript

**Critérios de aceite testáveis**:
- Todos os TS-FE-1..6 e TS-RT-1 passam em homologação
- Tentativa de acesso cross-empresa retorna 403 (sem vazar dados)
- Upload de XML para filial grava com `id_empresa` correto (verificar na tabela)
- Fechar movimento para filial X não fecha movimento de filial Y
- Nenhuma regressão nos fluxos fora do MVP

---

## Observações de Governança

- **Commits/push/merge/deploy**: apenas com autorização explícita do operador (D9).
- **Deploy**: `feat/movimento-por-filial` → abrir PR → aguardar review → merge apenas com aprovação.
- **Tarefas com revisão OWASP obrigatória**: 1.1, 1.4, 1.5. O executor deve invocar `/owasp-security` ao concluir cada uma delas antes de marcar como `[x]`.
- **Tarefas que tocam upload/XML** (1.4 — `POST /upload`): revisão OWASP inclui verificação de tamanho de arquivo, tipo MIME e ausência de path traversal no filename.

# Plano Técnico — import-range-datas

**Feature:** Seletor de Range de Datas no Import de Movimento  
**Short name:** `import-range-datas`  
**Gerado em:** 2026-06-13  
**Status:** Draft  

---

## Summary

**Requisito primário:** Substituir a leitura per-row de `dt_inicial`/`dt_final` da planilha por um range único informado pelo operador na UI, aplicado a todas as linhas do lote. Elimina o `400` tudo-ou-nada causado por linhas com data ausente.

**Abordagem técnica:** Modificação em 3 camadas verticais (UI → API client → Backend), sem DDL:
1. `import-button.tsx`: fluxo de 2 passos com Dialog nativo shadcn/ui + `<input type="date">`
2. `use-envio-massa.ts` + `action-bar.tsx`: propagação da assinatura estendida `uploadFile(file, extraFields?)`
3. `server.js` rota `/upload`: validação do range antes do loop; aplicação uniforme a todas as linhas

**Deploy coordenado:** frontend_v2 + backend no mesmo ciclo. Sem DDL.

---

## Technical Context

| Campo | Valor |
|-------|-------|
| Linguagem backend | Node.js 14 (Express) |
| Linguagem frontend | TypeScript / Next.js 16.2.3 + React 19 |
| UI components | shadcn/ui (Dialog, Input, Button já existentes) |
| Upload multipart | multer `upload.single('file')` — campos texto em `req.body` |
| Autenticação | JWT cookie httpOnly (`authenticateToken` middleware) |
| Proxy | `app/api/[...path]/route.ts` — sem mudança (streaming transparente) |
| Banco | PostgreSQL via PostgREST — sem DDL |
| Deploy | Docker Swarm (`registry.todo-tips.com`) — swap 4G + `--memory=2g` no build |
| Branch base | `main` |

---

## Constitution Check

*GATE: Deve passar antes do Phase 0. Re-checado após Phase 1.*

| Princípio | Status | Notas |
|-----------|--------|-------|
| I. Segurança / Secrets | PASS | Nenhum segredo novo; auth via JWT cookie preservado; `dt_inicial`/`dt_final` são dados de negócio, não credenciais |
| II. Multi-tenant | PASS | `empresaId` extraído do token (`resolveEmpresaAlvo`); range de datas é escopo do lote, não de identidade; nenhum id vindo do cliente determina escopo de empresa |
| III. Contratos / Proxy | PASS | Proxy sem mudança; `extraFields` via FormData já é padrão validado em produção (`empresa_id`); campos passam transparentemente |
| IV. Qualidade / Revisão | PASS | Branch dedicada; rota `/upload` toca autenticação → revisão OWASP contemplada nos gates da pipeline |
| V. Deploy conteinerizado | PASS | Deploy coordenado frontend+backend; sem nova porta, sem novo container, sem DDL; rito do operador aplicado |

---

## Convenções de Borda

| Camada | Case style | Validação | Fonte da verdade |
|--------|------------|-----------|------------------|
| FormData fields (wire) | `snake_case` | presença + comparação string na UI | `import-button.tsx` |
| Backend `req.body` fields | `snake_case` | presença + `toTimestamptzMidnightSP` + comparação timestamp | `server.js` handler `/upload` |
| DB columns (`EnvioMassa`) | `snake_case` | PostgreSQL `timestamptz` | schema existente (sem DDL) |
| TypeScript tipos frontend | camelCase (`dtInicial`, `dtFinal`) | comparação `dtInicial <= dtFinal` em JSX | `import-button.tsx` state |

**Formato de data:**
- `<input type="date">` retorna `YYYY-MM-DD` (padrão HTML5)
- Transmissão ao backend: `DD/MM/YYYY` (conversão na UI antes do `formData.append`) para reusar `toTimestamptzMidnightSP` sem alteração
- Banco: `timestamptz` meia-noite SP (semântica preservada)

**Conversão na UI (decisão tomada em research.md D2):**
```ts
// YYYY-MM-DD → DD/MM/YYYY
const toDDMMYYYY = (iso: string) => iso.split('-').reverse().join('/');
```

**Sem Zod nesta feature** — validação é de presença e comparação de strings/datas; padrão existente no projeto usa validação imperativa nos handlers Express.

---

## Project Structure

### Documentação da feature
```
docs/specs/import-range-datas/
  spec.md          ← spec (gerada)
  plan.md          ← este arquivo
  research.md      ← decisões técnicas Phase 0
  data-model.md    ← modelo de transmissão e state transitions
  quickstart.md    ← cenários de teste manual + E2E
```

### Arquivos modificados (source code)
```
app_homologacao/
  frontend_v2/
    components/
      import-button.tsx        ← MODIFICAR: fluxo 2 passos + Dialog + state dtInicial/dtFinal
      action-bar.tsx           ← MODIFICAR: onUpload(file, extraFields?)
    hooks/
      use-envio-massa.ts       ← MODIFICAR: uploadFile(file, extraFields?)
    app/
      dashboard/
        page.tsx               ← VERIFICAR: wiring ActionBar.onUpload (pode ser noop se já compatível)
    lib/
      api-client.ts            ← SEM MUDANÇA (extraFields já implementado)
    app/
      api/[...path]/
        route.ts               ← SEM MUDANÇA (streaming transparente)
  backend/
    server.js                  ← MODIFICAR: handler POST /upload (validação range + loop)
```

---

## Phase 0 — Research (Resumo)

Ver `research.md` para detalhes completos. Decisões-chave:

| # | Decisão | Resultado |
|---|---------|-----------|
| D1 | campos texto via multer+proxy | `req.body` populado — padrão idêntico ao `empresa_id` |
| D2 | formato de transmissão de datas | Converter na UI (`YYYY-MM-DD` → `DD/MM/YYYY`); sem mudança no helper |
| D3 | onde fica validação `dt_ini ≤ dt_fim` | Em ambos (UI desabilita botão + backend valida antes do loop) |
| D4 | proxy precisa mudar? | NÃO — streaming transparente |
| D5 | propagação de assinatura | `uploadFile(file, extraFields?)` em hook + action-bar + import-button |

---

## Phase 1 — Design Detalhado

### 1.1 Camada UI — `import-button.tsx`

**Estado local novo:**
```ts
const [dtInicial, setDtInicial] = useState('');
const [dtFinal, setDtFinal] = useState('');
const [dialogOpen, setDialogOpen] = useState(false);
const [pendingFile, setPendingFile] = useState<File | null>(null);
```

**Fluxo revisado:**
1. Usuário escolhe arquivo (input `onChange` ou drag-and-drop)
2. `handleChange`/`handleDrop`: validar extensão → salvar em `pendingFile` → `setDialogOpen(true)` (NÃO chama `onUpload` ainda)
3. Dialog exibe dois `<Input type="date">` para `dtInicial` e `dtFinal`
4. Botão Enviar habilitado apenas quando `dtInicial && dtFinal && dtInicial <= dtFinal`
5. Ao confirmar: converter ambas para `DD/MM/YYYY` → `onUpload(pendingFile, { dt_inicial, dt_final })` → fechar dialog → reset state

**Interface do componente modificada:**
```ts
interface ImportButtonProps {
  onUpload: (file: File, extraFields?: Record<string, string>) => Promise<unknown>;
}
```

**Componentes usados:** `Dialog`, `DialogContent`, `DialogHeader`, `DialogTitle`, `DialogFooter` de `@/components/ui/dialog`; `Input` de `@/components/ui/input`; `Button`, `Label` (já existentes). Sem nova lib.

### 1.2 Propagação da assinatura

**`action-bar.tsx`:**
```ts
interface ActionBarProps {
  // ...demais campos...
  onUpload: (file: File, extraFields?: Record<string, string>) => Promise<unknown>;
}
```
A prop `onUpload` é repassada diretamente para `<ImportButton onUpload={onUpload} />` — sem lógica adicional.

**`use-envio-massa.ts`:**
```ts
const uploadFile = useCallback(async (file: File, extraFields?: Record<string, string>) => {
  const extra: Record<string, string> = {};
  if (empresaId != null) extra.empresa_id = String(empresaId);
  if (extraFields) Object.assign(extra, extraFields);
  const result = await api.uploadFile('/upload', file, Object.keys(extra).length ? extra : undefined);
  await fetchData();
  return result;
}, [fetchData, empresaId]);
```

**`dashboard/page.tsx`:** verificar se `uploadFile` é passado diretamente como `onUpload={uploadFile}` para `ActionBar` — se sim, a propagação é automática pela compatibilidade de tipo (parâmetros extras opcionais são compatíveis com assinatura original sem extras). Nenhuma mudança esperada no `page.tsx`, mas confirmar durante implementação.

### 1.3 Backend — `server.js` rota `POST /upload`

**Após** a validação do arquivo (`if (!req.file)`) e **antes** do loop de linhas, inserir bloco de validação do range:

```js
// ---- Validação do range de datas (lida uma vez, aplicada a todas as linhas) ----
const dtInicialRaw = (req.body.dt_inicial ?? '').trim();
const dtFinalRaw   = (req.body.dt_final   ?? '').trim();

if (!dtInicialRaw) {
  return res.status(400).json({ success: false, message: 'dt_inicial é obrigatório para o import.' });
}
if (!dtFinalRaw) {
  return res.status(400).json({ success: false, message: 'dt_final é obrigatório para o import.' });
}

const dtIniTS = toTimestamptzMidnightSP(dtInicialRaw);
const dtFimTS = toTimestamptzMidnightSP(dtFinalRaw);

if (!dtIniTS) {
  return res.status(400).json({ success: false, message: 'dt_inicial inválido (formato esperado: DD/MM/YYYY).' });
}
if (!dtFimTS) {
  return res.status(400).json({ success: false, message: 'dt_final inválido (formato esperado: DD/MM/YYYY).' });
}
if (dtIniTS > dtFimTS) {
  return res.status(400).json({ success: false, message: 'dt_inicial deve ser menor ou igual a dt_final.' });
}
// dtIniTS e dtFimTS são os valores a usar em TODAS as linhas
```

**No loop `rows.forEach`:** remover o bloco condicional `if (!_isGrupoMovee) { ... }` que lia `row.dt_inicial`/`row.dt_final` e validava per-row. Substituir por uso direto de `dtIniTS`/`dtFimTS` (já computados acima, em escopo do handler):

```js
// REMOVER:
let dt_inicial_raw = '01/01/1982';
let dt_final_raw = '01/01/1982';
let dtIniTS = toTimestamptzMidnightSP(dt_inicial_raw);
let dtFimTS = toTimestamptzMidnightSP(dt_final_raw);

if (!_isGrupoMovee) {
  dt_inicial_raw = (row.dt_inicial ?? '').toString().trim();
  // ... validação per-row ...
}

// MANTER no dataToInsert (usar dtIniTS/dtFimTS do escopo externo):
dataToInsert.push({
  // ...
  dt_inicial: dtIniTS,
  dt_final: dtFimTS,
  // ...
});
```

**Nota:** `_isGrupoMovee` ainda pode ser necessário para outros fins no handler (verificar). Se usado apenas para o bloco de datas, remover também o `await mesmoGrupoQue(empresaId, 6, _grupoCache)`.

---

## Complexity Tracking

| Item | Justificativa |
|------|---------------|
| Nenhuma violação de constitution identificada | — |

---

## Constitution Re-check (pós design)

| Princípio | Status pós-design | Notas |
|-----------|-------------------|-------|
| I. Segurança | PASS | `dtInicialRaw` e `dtFinalRaw` são strings de data validadas e convertidas via helper existente; sem injeção possível via `toTimestamptzMidnightSP` (produz `null` em input inválido) |
| II. Multi-tenant | PASS | Range não afeta escopo de empresa; `resolveEmpresaAlvo` inalterado |
| III. Contratos / Proxy | PASS | Sem mudança no proxy |
| IV. Qualidade | PASS | Validação defense-in-depth (UI + backend); mensagens de erro em português; sem lógica de grupo condicional |
| V. Deploy | PASS | Deploy coordenado; sem DDL; sem novo container |

---

## Ordem de Implementação (referência para create-tasks)

1. **Backend:** bloco de validação do range + remoção do bloco per-row + uso de `dtIniTS`/`dtFimTS` no loop
2. **Hook + tipos:** `useEnvioMassa.uploadFile` com `extraFields?`; `ActionBar.onUpload` com assinatura estendida
3. **UI:** `import-button.tsx` — fluxo 2 passos com Dialog + validação + conversão de formato
4. **Verificar `dashboard/page.tsx`:** confirmar que a propagação automática é suficiente (noop ou ajuste mínimo)
5. **Testes manuais:** cenários do `quickstart.md` (happy path, erros, regressão gorjeta/valor/CNPJ)
6. **Deploy coordenado:** build frontend + backend com swap temporário 4G + `--memory=2g`; `service update --image` via registry

---

## Artefatos

| Arquivo | Status |
|---------|--------|
| `docs/specs/import-range-datas/spec.md` | Criado |
| `docs/specs/import-range-datas/plan.md` | Criado (este arquivo) |
| `docs/specs/import-range-datas/research.md` | Criado |
| `docs/specs/import-range-datas/data-model.md` | Criado |
| `docs/specs/import-range-datas/quickstart.md` | Criado |

## Próximos Passos

1. `/checklist` — Quality gate dos requisitos antes de implementar
2. `/create-tasks` — Decompor plano em tarefas executáveis
3. `/execute-task` — Implementar seguindo a ordem acima

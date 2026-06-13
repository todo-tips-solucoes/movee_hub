# Research — import-range-datas

> Fase: Phase 0 — Unknowns resolvidos antes do design

## Decision 1 — Como os campos de texto chegam ao backend via multer + proxy streaming

**Contexto:** O proxy `app/api/[...path]/route.ts` faz streaming do `multipart/form-data`. A questão era: os campos de texto (`dt_inicial`, `dt_final`) chegam em `req.body` quando o body vem via stream?

**Decision:** SIM — `multer` com `upload.single('file')` popula `req.body` com os campos de texto do FormData, mesmo quando o request chega via streaming proxy. O multer processa o stream multipart e separa partes: a parte `file` vai para `req.file`, as demais (text fields) vão para `req.body`. Esse comportamento é o padrão do multer e independe de o proxy usar streaming.

**Evidência:** O campo `empresa_id` já é enviado como campo de texto no FormData (`formData.append('empresa_id', String(empresaId))` em `use-envio-massa.ts:65`) e é lido em `req.body.empresa_id` no handler (`server.js:1366`). Os campos `dt_inicial` e `dt_final` seguem o mesmo padrão exato.

**Rationale:** Reusar o padrão já validado em produção (`empresa_id` via FormData → `req.body`). Zero risco técnico nessa borda.

**Alternatives considered:** Enviar datas como query params na URL — descartado porque quebraria a interface do proxy e exigiria mudança no route handler.

---

## Decision 2 — Formato de transmissão das datas (UI → backend)

**Contexto:** O `<input type="date">` nativo retorna `YYYY-MM-DD`. O backend usa `toTimestamptzMidnightSP` que aceita o formato `DD/MM/YYYY` (via `parseToDate`).

**Decision:** Enviar no formato `YYYY-MM-DD` do input nativo e adaptar `toTimestamptzMidnightSP` para aceitar ambos os formatos, OU converter na UI para `DD/MM/YYYY` antes de enviar.

**Rationale:** A função `toTimestamptzMidnightSP` chama `parseToDate` — verificar que `parseToDate` já aceita `YYYY-MM-DD`. Se não aceitar, a conversão mais segura é na UI (`dtInicial.split('-').reverse().join('/')`) para manter zero mudança no helper já em produção.

**Alternatives considered:** Enviar como `YYYY-MM-DD` e adaptar o backend — possível, mas requer mudança em helper compartilhado com outros fluxos (risco). Converter na UI — mais seguro, zero impacto em helpers.

**Decisão final:** Converter na UI (`YYYY-MM-DD` → `DD/MM/YYYY`) antes de enviar para o backend. Sem mudança no helper de conversão.

---

## Decision 3 — Onde fica a validação `dt_inicial ≤ dt_final`

**Contexto:** A validação pode ficar apenas na UI (botão desabilitado), apenas no backend, ou em ambos.

**Decision:** Em ambos — defense in depth (Constitution §IV).
- UI: botão Enviar desabilitado enquanto range inválido (UX imediata).
- Backend: validação de presença + `dt_inicial ≤ dt_final` em uma única verificação no início do handler, antes do loop de linhas.

**Rationale:** A validação no backend é obrigatória pois o endpoint pode ser chamado diretamente (fora da UI). A validação na UI é obrigatória para UX responsiva.

---

## Decision 4 — Confirmação: proxy não precisa de mudança

**Contexto:** O proxy `app/api/[...path]/route.ts` faz stream direto do body. A dúvida era se adicionar campos extras ao FormData quebraria o streaming.

**Decision:** Sem mudança no proxy. O proxy usa `req.body` passthrough para métodos não-GET — o body (incluindo todos os campos FormData) é repassado como stream opaco para o backend. Campos extras (`dt_inicial`, `dt_final`) passam transparentemente junto com `file` e `empresa_id`.

**Evidência:** O padrão já funciona para `empresa_id` em produção (feature `movimento-por-filial`).

---

## Decision 5 — Propagação da assinatura de `uploadFile`

**Contexto:** `api.uploadFile` já tem `extraFields?: Record<string, string>` (já implementado no `api-client.ts` atual). O hook `useEnvioMassa.uploadFile` tem assinatura `(file: File)` — precisa ser estendido.

**Decision:** Estender `useEnvioMassa.uploadFile` para `(file: File, extraFields?: Record<string, string>)` e propagar `extraFields` para `api.uploadFile`. O `ActionBar.onUpload` e `ImportButton.onUpload` também precisam da assinatura estendida.

**Chain de propagação:**
```
ImportButton.onUpload(file, { dt_inicial, dt_final })
  → ActionBar.onUpload(file, extraFields?)
    → dashboard/page.tsx → useEnvioMassa.uploadFile(file, extraFields?)
      → api.uploadFile('/upload', file, { empresa_id, dt_inicial, dt_final })
```

**Nota:** `api-client.ts` já tem `extraFields` implementado — merge é noop nessa camada.

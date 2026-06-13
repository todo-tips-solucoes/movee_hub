# Implementation Plan: Gorjeta do Motorista

**Feature**: `gorjeta-motorista`
**Branch**: `feat/gorjeta-motorista` (worktree isolado, base `main`)
**Spec**: [spec.md](./spec.md) — 2 user stories, FR-001..FR-008, SC-001..SC-005
**Created**: 2026-06-12
**Constitution**: v1.1.0 (multi-tenant amendment ratificado)

> Briefing técnico complementar (fonte de arquitetura, pontos de código já mapeados):
> `docs/plans/gorjeta-tela-motorista.md`.

---

## 1. Resumo Técnico

A coluna `gorjeta` chega na planilha de upload (formato BRL: `"R$ 22,00"`, `"R$ -"`)
mas é descartada em todas as camadas: não existe coluna no banco, não é mapeada no
insert, não é lida pelo backend, não é renderizada. Esta feature é uma **fatia
vertical** que fecha a lacuna: DDL aditivo → reload PostgREST → mapeamento no upload
→ mapeamento na leitura → render condicional na tela do motorista.

**Princípio arquitetural reusado** (read-back loop, K=4 achados de execuções passadas):
o caminho `EnvioMassa` via PostgREST + parse BRL (`toNumberBR`) + `.toFixed(2)` já é o
padrão consolidado do `valor`. A gorjeta **espelha o `valor`** em tipo, formato de
gravação e leitura — divergindo em UM ponto: a gorjeta é **opcional** (nunca gera
`rowError`), enquanto `valor` é obrigatório (CL-004).

---

## 2. Decisões do Clarify a Honrar (CL-001..CL-004)

| ID | Decisão | Implicação técnica |
|----|---------|--------------------|
| CL-001 | `gorjeta` espelha `valor` — string `valorNum.toFixed(2)` (ex. `"22.00"`) | DDL usa o mesmo tipo da coluna `valor` (TEXT). Parse via `toNumberBR`. |
| CL-002 | Planilha `"R$ -"` → grava `NULL` (nunca erro de linha) | `Number.isFinite(toNumberBR("R$ -"))` é `false` → grava `null`. SEM `rowErrors.push`. |
| CL-003 | gorjeta `NULL`/zero → linha oculta na tela (não exibir "R$ 0,00") | Render condicional: só renderiza se `gorjetaNum` finito e `> 0`. |
| CL-004 | coluna 100% opcional — planilhas legadas sem a coluna seguem funcionando | `row.gorjeta` ausente → `undefined` → `toNumberBR` retorna `NaN` → `null`. Nenhum gate de obrigatoriedade. |

---

## 3. Modelo de Dados

### 3.1 Entidade `Movimento` (tabela `EnvioMassa`, banco `chatmasterveloz` via PostgREST)

Ganha 1 atributo aditivo:

| Atributo | Tipo | Nullable | Default | Formato gravado |
|----------|------|----------|---------|------------------|
| `gorjeta` | TEXT (espelha `valor`) | sim | NULL | string 2 casas decimais, ex. `"22.00"`; ou `NULL` |

- **Cardinalidade**: 1 movimento → 0 ou 1 gorjeta (NULL = ausência semântica, distinta de `"0.00"`).
- **Idempotência (FR-007)**: `ADD COLUMN IF NOT EXISTS` — reaplicar não gera erro (SC-005).
- **Rollback**: a coluna aditiva **FICA** (inócua); não dropar. Rollback de comportamento = reverter imagens.

### 3.2 Confirmação do tipo de `valor`

CL-001 fixa "espelhar `valor`". O upload grava `valor` como **string** (`valorNum.toFixed(2)`,
`server.js:1455`), o que é consistente com coluna **TEXT** no PostgREST. O DDL usa `text` para
`gorjeta`. **Verificação no rito** (operador, antes do ALTER): confirmar o tipo real de `valor`
via `\d "EnvioMassa"` no pgAdmin; se divergir de `text`, alinhar o tipo do `gorjeta` ao do `valor`
real antes de aplicar.

---

## 4. Arquitetura por Camada (o HOW)

### 4.1 DDL — `app_homologacao/backend/db/009_envio_massa_gorjeta.sql`

Próximo número livre na sequência (`001`, `002`, `003`, `008`, `008b` → **`009`**).
Aditivo + idempotente, espelhando o tipo de `valor`:

```sql
-- 009_envio_massa_gorjeta.sql
-- Feature gorjeta-motorista — coluna aditiva opcional na EnvioMassa.
-- Espelha o tipo da coluna `valor` (TEXT). Gravada pelo upload como string
-- `valorNum.toFixed(2)` (ex. "22.00") ou NULL quando ausente/"R$ -".
-- Idempotente (FR-007 / SC-005): reaplicar não gera erro.

ALTER TABLE "EnvioMassa"
  ADD COLUMN IF NOT EXISTS gorjeta text;

-- Reload do schema do PostgREST para expor a coluna nova via API (FR-008).
NOTIFY pgrst, 'reload schema';
```

> **Nota de rito**: o `NOTIFY pgrst, 'reload schema'` cobre o reload (FR-008). Se o serviço
> PostgREST não escutar o canal, o fallback do rito é forçar reload do serviço
> (`docker service update --force pgadmin_postgrest` ou equivalente do rito de produção).
> A verificação do reload faz parte do rito (Edge Case da spec).

### 4.2 Upload — `app_homologacao/backend/server.js` (~1451-1500, objeto `dataToInsert`)

Logo após o parse de `valor` (`const valor = ...`, linha ~1455) e **antes** do gate
`if (rowErrors.length) { ... return; }`, adicionar o parse da gorjeta **sem** push em
`rowErrors` (CL-002/CL-004):

```js
// gorjeta — OPCIONAL (gorjeta-motorista CL-002/CL-004). Espelha o parse do
// `valor` mas NUNCA gera rowError: ausência da coluna ou "R$ -" → null.
const gorjetaNum = toNumberBR(row.gorjeta);
const gorjeta = Number.isFinite(gorjetaNum) ? gorjetaNum.toFixed(2) : null; // "22.00" | null
```

E incluir `gorjeta` no objeto enviado ao PostgREST:

```js
dataToInsert.push({
  number,
  // ...campos existentes inalterados...
  valor,
  gorjeta,   // <-- novo campo (gorjeta-motorista FR-001/FR-002)
  // ...id_empresa etc...
});
```

**Pontos críticos**:
- `toNumberBR` é reusado (já trata `"R$ 22,00"` → `22`, `"R$ -"`/vazio → `NaN`). Confirmar que
  texto livre não-monetário também cai em `NaN` (Edge Case spec → grava `null`, nunca 500).
- A linha do parse fica **antes** do `return` do gate de erro mas **fora** de qualquer push em
  `rowErrors` — garante que linha sem gorjeta válida ainda entra no `dataToInsert` se os demais
  campos obrigatórios estiverem OK (FR-003).
- `row.gorjeta` ausente (planilha legada) → `undefined` → `toNumberBR(undefined)` → `NaN` → `null`.
  Nenhuma mudança nas demais validações (FR-003/SC-002).

### 4.3 Leitura — `app_homologacao/backend/routes/motorista.js` (~395, mapper do `/movimento-aberto`)

A query usa `select *` (sem `select=`), então a coluna nova já vem em `m`. Adicionar ao objeto
`movimento` mapeado (FR-004):

```js
const m = movimentos[0];
const movimento = {
  id: m.id,
  valor: m.valor,
  gorjeta: m.gorjeta ?? null,   // <-- novo (gorjeta-motorista FR-004); null se ausente
  dtInicial: m.dt_inicial,
  // ...demais campos inalterados...
};
```

**Isolamento por motorista preservado**: a query continua escopada por
`cnpjEnvioMassaFilter(cnpj)` + token (`authenticateMotorista`) — gorjeta não introduz parâmetro
externo (Constituição II). Estado "sem movimento" (`{ movimento: null }`) intacto.

### 4.4 Render — `app_homologacao/frontend_motorista/app/(app)/movimento/page.tsx`

1. **Tipo** — adicionar `gorjeta` à `interface Movimento`:

```ts
interface Movimento {
  id: number;
  valor: string | number | null;
  gorjeta: string | number | null;   // <-- novo (FR-005/FR-006)
  // ...demais campos...
}
```

2. **Derivar valor numérico** (espelha o padrão de `valorNum`):

```ts
const gorjetaNum =
  movimento?.gorjeta != null && movimento.gorjeta !== ''
    ? typeof movimento.gorjeta === 'string'
      ? parseFloat(movimento.gorjeta)
      : movimento.gorjeta
    : NaN;
const temGorjeta = !isNaN(gorjetaNum) && gorjetaNum > 0;   // CL-003: oculta null/zero
```

3. **Render condicional** — exibir a gorjeta perto do hero do valor, em BRL via `formatCurrency`,
   **somente** quando `temGorjeta` (FR-006/CL-003 — nunca "R$ 0,00"):

```tsx
{temGorjeta && (
  <div className="...glass/card consistente com design system Movee...">
    <p className="...rótulo uppercase muted...">Gorjeta</p>
    <p className="tabular ...">{formatCurrency(gorjetaNum)}</p>
  </div>
)}
```

> **Design system**: reusar os tokens/classes já presentes na tela (glass, gradient, `tabular`,
> `formatCurrency`) — sem introduzir novo componente. A gorjeta é informativa, posicionada junto
> ao bloco "Valor da nota fiscal" (hero) ou na grid de Dados Fiscais.

---

## 5. Ordem Crítica de Runtime (rito de produção — operador)

> ⚠️ **CLÁUSULA PÉTREA**: o agente NÃO aplica DDL nem builda neste host (risco de starvation do
> Swarm). Entrega artefatos (SQL idempotente, código, instruções). O **operador** executa sob rito,
> com os comandos mostrados antes.

Sequência inviolável (quebrá-la rejeita o insert e derruba TODO o upload):

1. **`pg_dump -t '"EnvioMassa"'`** (backup antes de qualquer escrita).
2. **`ALTER TABLE "EnvioMassa" ADD COLUMN IF NOT EXISTS gorjeta text;`** (DDL aditivo).
3. **`NOTIFY pgrst, 'reload schema';`** (reload PostgREST — FR-008; verificar exposição da coluna).
4. **Deploy backend** (`docker service update --image envio-massa-backend:<tag>`) — só DEPOIS da coluna existir.
5. **Deploy frontend_motorista** (`docker service update --image app-motorista-frontend:<tag>`).
6. **Smoke** (`app.motorista.moveelog.com.br`): upload com gorjeta → motorista vê o valor.

**Razão da ordem**: se o backend novo (que envia `gorjeta` no insert) subir antes da coluna
existir, o PostgREST rejeita o POST inteiro (coluna inexistente) e quebra o upload — não só a
gorjeta. Por isso DDL+reload SEMPRE precedem o backend.

**Build seguro** (lição starvation): `DOCKER_BUILDKIT=0 docker build --memory=2g --memory-swap=2g
--cpu-quota=200000 --cpu-period=100000`, em background + monitor do Swarm. NUNCA `pkill -f` amplo
nem prune `-a`/`--volumes`.

---

## 6. Cenários de Teste

### 6.1 Backend — upload (server.js)

| Cenário | Entrada `row.gorjeta` | Esperado | FR/CL |
|---------|------------------------|----------|-------|
| Gorjeta preenchida | `"R$ 22,00"` | `dataToInsert` recebe `gorjeta: "22.00"`; sem rowError | FR-001/CL-001 |
| Gorjeta vazia | `"R$ -"` | `gorjeta: null`; sem rowError | FR-002/CL-002 |
| Coluna ausente (legado) | `undefined` | `gorjeta: null`; upload OK | FR-003/CL-004/SC-002 |
| Texto não-monetário | `"abc"` | `gorjeta: null`; sem 500 | Edge Case |
| Mista | linhas variadas | cada linha independente, gorjeta só nas válidas | US2 cenário 4 |
| Regressão `valor` | qualquer | `valor` e demais campos idênticos ao comportamento atual | SC-001 |

### 6.2 Backend — leitura (`routes/motorista.js`) — `motorista-integration.test.js`

Estender o describe `3.1.5 GET /motorista/movimento-aberto` (já valida shape do movimento):
- movimento com `gorjeta: "22.00"` no fixture → `r.body.movimento.gorjeta === "22.00"`.
- movimento sem gorjeta (`gorjeta: null`) → `r.body.movimento.gorjeta === null`.
- isolamento por CNPJ preservado (motorista A não vê gorjeta de B) — assert já existente reforçado.

### 6.3 DDL — idempotência (SC-005)

- Aplicar `009` duas vezes seguidas → segundo `ALTER` é no-op (IF NOT EXISTS), sem erro.

### 6.4 Frontend — render (page.tsx)

| Cenário | `movimento.gorjeta` | Tela | FR/CL |
|---------|---------------------|------|-------|
| Gorjeta presente | `"22.00"` | exibe "Gorjeta R$ 22,00" (BRL) | FR-005 |
| Gorjeta nula | `null` | linha oculta (sem "R$ 0,00") | FR-006/CL-003/SC-004 |
| Gorjeta zero | `"0.00"` | linha oculta | FR-006/CL-003 |
| Sem movimento | — | estado vazio preservado, sem regressão | US1 cenário 3 |

### 6.5 Verificação local (sem deploy)

- `tsc --noEmit` no `frontend_motorista` (tipo `Movimento` com `gorjeta`) → limpo.
- Lint backend/frontend → limpo.
- `node --test` em `backend/tests/motorista-integration.test.js` → verde.
- **Não** buildar imagem neste host (rito de produção, operador).

---

## 7. Escopo

**Muda (4 camadas + testes):**
- `app_homologacao/backend/db/009_envio_massa_gorjeta.sql` (novo — DDL aditivo + NOTIFY reload).
- `app_homologacao/backend/server.js` (~1455 — parse `gorjeta` + push no `dataToInsert`).
- `app_homologacao/backend/routes/motorista.js` (~395 — `gorjeta` no mapper do `/movimento-aberto`).
- `app_homologacao/frontend_motorista/app/(app)/movimento/page.tsx` (tipo + derivação + render condicional).
- `app_homologacao/backend/tests/motorista-integration.test.js` (shape + gorjeta).

**NÃO muda**: demais colunas/validações do upload, painel além do upload, validação NFS-e, proxy,
autenticação, `frontend_v2` (painel), `frontend` legado.

---

## 8. Riscos e Mitigações

| Risco | Mitigação |
|-------|-----------|
| Backend sobe antes da coluna existir → quebra todo o upload | Ordem crítica §5 (DDL+reload ANTES do backend); documentada no rito |
| PostgREST não recarrega schema → coluna invisível | `NOTIFY pgrst` no DDL + verificação no rito (force-reload como fallback) |
| Tipo de `valor` divergir de TEXT | Verificação `\d "EnvioMassa"` no rito antes do ALTER (§3.2) |
| Planilha legada sem coluna quebrar | `row.gorjeta` undefined → null; nenhum gate de obrigatoriedade (CL-004/SC-002) |
| Build derrubar Swarm (starvation) | Build com cap de recurso + monitor; nunca pkill amplo (§5) |

---

## 9. Conformidade com a Constitution (v1.1.0)

- **Não tocar produção**: agente entrega SQL/código/instruções; operador aplica DDL/deploy sob rito.
- **Isolamento por tenant/motorista**: leitura escopada por token (`authenticateMotorista` +
  `cnpjEnvioMassaFilter`); gorjeta não adiciona parâmetro externo.
- **Aditividade/idempotência**: DDL `IF NOT EXISTS`, coluna nullable opcional, retrocompatível.
- **Sem credenciais versionadas**: nenhum `.env`/dump no PR.

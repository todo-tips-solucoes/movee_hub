# Tasks: Gorjeta do Motorista

**Feature**: `gorjeta-motorista`
**Branch**: `feat/gorjeta-motorista` (worktree isolado, base `main`)
**Spec**: [spec.md](./spec.md) — FR-001..FR-008, CL-001..CL-004
**Plan**: [plan.md](./plan.md) — 4 camadas + ordem crítica de runtime
**Criado**: 2026-06-12

> **CLÁUSULA PÉTREA**: tarefas marcadas como `[RITO DO OPERADOR]` NÃO são
> executáveis pelo agente. O agente entrega apenas artefatos (SQL, código,
> testes). Operador aplica DDL, reload e deploys no host de produção.
>
> **Ordem crítica de runtime** (NUNCA inverter):
> DDL → reload PostgREST → backend deploy → frontend deploy → smoke

---

## Legenda de Criticidade

- `[C]` — Crítico: bloqueia stories P1/P2; falha quebra a feature inteira
- `[A]` — Alto: cobre FR/SC relevante; falha degrada parcialmente
- `[M]` — Médio: melhoria de qualidade, teste auxiliar, documentação

## Legenda de Status

- `[ ]` — pendente
- `[x]` — concluída
- `[~]` — em andamento

## Legenda de Dependências

Formato: `DEP: <id-da-tarefa-predecessor>`

---

## Escopo Coberto

- FASE 1 — DDL: arquivo SQL idempotente `009_envio_massa_gorjeta.sql`
- FASE 2 — Backend upload: parse de gorjeta em `server.js` (L1228 `dataToInsert.push`)
- FASE 3 — Backend leitura: mapeamento de gorjeta em `motorista.js` (L429 mapper `/movimento-aberto`)
- FASE 4 — Frontend render: interface TypeScript + exibição condicional em `page.tsx`
- FASE 5 — Testes: `motorista-integration.test.js` (novo arquivo) cobrindo upload + leitura
- FASE 6 — Ritos do operador: DDL, reload PostgREST, deploys, smoke

## Escopo Excluído

- Painel `frontend_v2` (nenhuma mudança)
- Frontend legado
- Validação NFS-e
- Autenticação / proxy / CORS
- Relatório de gorjetas (gap CHK308 — feature futura)
- Rótulo exato do campo na UI (gap CHK204 — decisão de produto, usa "Gorjeta" como padrão)

---

## Matriz de Dependências

```
1.1 (DDL)
  └─> 6.1 (rito: backup + DDL + reload) [OPERADOR]
        └─> 2.1 (server.js parse)
              └─> 2.2 (server.js teste upload)
        └─> 3.1 (motorista.js mapper)
              └─> 3.2 (motorista.js teste leitura)
        └─> 4.1 (page.tsx interface)
              └─> 4.2 (page.tsx render condicional)
                    └─> 4.3 (page.tsx teste E2E local)
5.1 (criar diretório tests)
  └─> 2.2, 3.2
6.2 (deploy backend) [OPERADOR] — DEP: 2.1 + 3.1 + DDL aplicado
6.3 (deploy frontend) [OPERADOR] — DEP: 4.2 + backend deploy
6.4 (smoke) [OPERADOR] — DEP: 6.2 + 6.3
```

---

## Resumo Quantitativo

| Criticidade | Tarefas |
|-------------|---------|
| [C] Crítico | 8 (1.1, 2.1, 3.1, 4.1, 4.2, 6.1, 6.2, 6.3, 6.4) |
| [A] Alto | 3 (2.2, 3.2, 5.1) |
| [M] Médio | 1 (4.3) |
| **Total** | **13** |

| Tipo | Tarefas |
|------|---------|
| Agente executa | 9 (1.1, 2.1, 2.2, 3.1, 3.2, 4.1, 4.2, 4.3, 5.1) |
| RITO DO OPERADOR | 4 (6.1, 6.2, 6.3, 6.4) |

## Resumo de Tasks

| ID | Título | Fase | Crit | Dep |
|----|--------|------|------|-----|
| 1.1 | Criar DDL idempotente 009 | FASE 1 | [C] | — |
| 2.1 | Mapear gorjeta no dataToInsert (server.js) | FASE 2 | [C] | 6.1 |
| 2.2 | Teste upload com gorjeta (server.js) | FASE 2 | [A] | 5.1, 2.1 |
| 3.1 | Adicionar gorjeta ao mapper /movimento-aberto (motorista.js) | FASE 3 | [C] | 6.1 |
| 3.2 | Teste de integração leitura gorjeta (motorista.js) | FASE 3 | [A] | 5.1, 3.1 |
| 4.1 | Adicionar gorjeta à interface Movimento (page.tsx) | FASE 4 | [C] | — |
| 4.2 | Render condicional de gorjeta (page.tsx) | FASE 4 | [C] | 4.1 |
| 4.3 | Verificação local do render (page.tsx) | FASE 4 | [M] | 4.2 |
| 5.1 | Criar diretório tests e arquivo base | FASE 5 | [A] | — |
| 6.1 | [RITO] Backup + DDL + reload PostgREST | FASE 6 | [C] | 1.1 |
| 6.2 | [RITO] Deploy backend | FASE 6 | [C] | 2.1, 3.1, 6.1 |
| 6.3 | [RITO] Deploy frontend_motorista | FASE 6 | [C] | 4.2, 6.2 |
| 6.4 | [RITO] Smoke test ponta-a-ponta | FASE 6 | [C] | 6.2, 6.3 |

---

## FASE 1 — DDL

### 1.1 Criar DDL idempotente 009_envio_massa_gorjeta.sql `[C]`

**O quê**: criar o arquivo
`app_homologacao/backend/db/009_envio_massa_gorjeta.sql` com ALTER TABLE
idempotente (`ADD COLUMN IF NOT EXISTS`) e NOTIFY para reload do PostgREST.

**Por quê**: sem a coluna `gorjeta` na tabela `EnvioMassa`, o backend novo
que envia o campo no insert seria rejeitado pelo PostgREST (quebra todo
upload, não só gorjeta). FR-007 (idempotência) + FR-008 (reload).

**Arquivo alvo**: `app_homologacao/backend/db/009_envio_massa_gorjeta.sql`
(novo — migrations existentes chegam até `008_cadastro_motorista_base.sql`)

**Conteúdo esperado**:
```sql
-- 009_envio_massa_gorjeta.sql
-- Adiciona coluna gorjeta à tabela EnvioMassa (banco chatmasterveloz).
-- Idempotente: ADD COLUMN IF NOT EXISTS. Seguro reaplicar.
-- FR-001, FR-002, FR-007, FR-008

-- Verificação preventiva do tipo de `valor` (CL-003 / SC-005):
-- rodar \d "EnvioMassa" antes do ALTER para confirmar que tipo é TEXT.
-- Se for NUMERIC, adaptar o tipo de gorjeta para NUMERIC.

ALTER TABLE "EnvioMassa"
  ADD COLUMN IF NOT EXISTS gorjeta text;

-- Reload do schema PostgREST para expor a nova coluna imediatamente (FR-008).
-- ATENÇÃO: executar este NOTIFY apenas APÓS o ALTER ter sido aplicado.
NOTIFY pgrst, 'reload schema';
```

**Critérios de aceite**:
- [ ] Arquivo existe em `app_homologacao/backend/db/009_envio_massa_gorjeta.sql`
- [ ] Contém `ADD COLUMN IF NOT EXISTS gorjeta text`
- [ ] Contém `NOTIFY pgrst, 'reload schema'`
- [ ] Reaplicar o arquivo em banco que já possui a coluna NÃO gera erro (idempotência — FR-007)
- [ ] Comentário documenta a verificação preventiva do tipo de `valor` (CL-003)

**DEP**: nenhuma (artefato independente — o operador aplica após a tarefa estar pronta)

- [ ] **1.1** Criar `009_envio_massa_gorjeta.sql` com DDL idempotente e NOTIFY

---

## FASE 2 — Backend Upload (server.js)

> Estas tarefas dependem que o DDL tenha sido aplicado pelo operador (FASE 6 rito 6.1)
> **antes do deploy do backend**. O código pode ser escrito antes, mas o serviço
> só sobe depois do DDL estar no banco.

### 2.1 Mapear gorjeta no dataToInsert (server.js) `[C]`

**O quê**: adicionar parse de gorjeta da linha da planilha e inserção no
objeto `dataToInsert` em `server.js`.

**Arquivo alvo**: `app_homologacao/backend/server.js`

**Ponto de inserção**: linha ~1152 (declaração `const dataToInsert = []`)
e linha ~1228 (`dataToInsert.push({...})`).

**Lógica esperada** (baseada em CL-001 / FR-001 / FR-002):
```js
// Parse gorjeta da linha — coluna opcional (FR-003)
// Converte "R$ 22,00" → 22.00 | "R$ -" / vazio / undefined → null
function parseGorjeta(raw) {
  if (raw == null || raw === '' || raw === 'R$ -') return null;
  const s = String(raw).replace(/[R$\s.]/g, '').replace(',', '.');
  const n = parseFloat(s);
  return isNaN(n) || n <= 0 ? null : n;
}
// ... dentro do loop de linhas, antes do dataToInsert.push:
const gorjeta = parseGorjeta(row.gorjeta);
// ... dentro do dataToInsert.push({...}):
// adicionar: gorjeta,
```

**Critérios de aceite**:
- [ ] Função `parseGorjeta` (ou equivalente inline) criada e testável isoladamente
- [ ] `gorjeta` incluído no objeto passado para `dataToInsert.push()`
- [ ] Planilha sem coluna `gorjeta`: `row.gorjeta` é `undefined` → `null` persistido (FR-002, FR-003)
- [ ] Planilha com `gorjeta = "R$ -"`: persiste `null` (FR-002)
- [ ] Planilha com `gorjeta = "R$ 22,00"`: persiste `22.0` (FR-001)
- [ ] Nenhuma validação obrigatória adicionada — gorjeta não bloqueia upload (CL-004, FR-003)

**DEP**: 6.1 (DDL aplicado antes de subir o backend com essa mudança)

- [ ] **2.1** Adicionar parse de gorjeta e incluir campo no `dataToInsert.push` em `server.js`

### 2.2 Teste upload com gorjeta (server.js) `[A]`

**O quê**: adicionar casos de teste em
`app_homologacao/backend/tests/motorista-integration.test.js` cobrindo
o comportamento do parse de gorjeta no upload.

**Arquivo alvo**: `app_homologacao/backend/tests/motorista-integration.test.js`
(novo — diretório `tests/` ainda não existe; ver tarefa 5.1)

**Cenários** (plan §6.1):
- Upload com `gorjeta = "R$ 22,00"` → campo gorjeta no payload = `22.0`
- Upload sem coluna gorjeta → campo gorjeta no payload = `null`
- Upload com `gorjeta = "R$ -"` → campo gorjeta no payload = `null`
- Upload com `gorjeta = "0"` → campo gorjeta = `null` (CL-001: zero é ausência)

**Critérios de aceite**:
- [ ] Todos os 4 cenários cobertos com asserções explícitas
- [ ] Testes passam com `node --test` ou jest (sem necessidade de banco real — mockar PostgREST)
- [ ] Teste de regressão: upload sem gorjeta não altera outros campos do `dataToInsert`

**DEP**: 5.1 (diretório tests criado), 2.1 (lógica de parse implementada)

- [ ] **2.2** Criar testes de upload (parse gorjeta) em `motorista-integration.test.js`

---

## FASE 3 — Backend Leitura (motorista.js)

> Estas tarefas também dependem que o DDL tenha sido aplicado (FASE 6 rito 6.1)
> **antes do deploy**.

### 3.1 Adicionar gorjeta ao mapper /movimento-aberto (motorista.js) `[C]`

**O quê**: incluir o campo `gorjeta` no objeto de resposta do endpoint
`GET /motorista/movimento-aberto`.

**Arquivo alvo**: `app_homologacao/backend/routes/motorista.js`

**Ponto de inserção**: linha ~429 (objeto de resposta da rota, ao lado de
`valor: m.valor`).

**Mudança esperada**:
```js
// Antes (linha ~429):
valor: m.valor,

// Depois:
valor: m.valor,
gorjeta: m.gorjeta ?? null,   // FR-004: null quando ausente/zero (CL-002)
```

**Critérios de aceite**:
- [ ] Campo `gorjeta` presente no objeto de resposta da rota `/movimento-aberto`
- [ ] Quando `m.gorjeta` é `null` no banco: resposta contém `gorjeta: null` (FR-004)
- [ ] Quando `m.gorjeta` é `22.0`: resposta contém `gorjeta: 22.0`
- [ ] Nenhuma outra rota ou comportamento existente alterado (regressão zero)

**DEP**: 6.1 (DDL aplicado — a coluna precisa existir para o PostgREST retorná-la)

- [ ] **3.1** Adicionar `gorjeta: m.gorjeta ?? null` no mapper de `/movimento-aberto` em `motorista.js`

### 3.2 Teste de integração leitura gorjeta (motorista.js) `[A]`

**O quê**: adicionar casos de teste cobrindo o retorno de gorjeta pelo
endpoint `/movimento-aberto`.

**Arquivo alvo**: `app_homologacao/backend/tests/motorista-integration.test.js`

**Cenários** (plan §6.2):
- Mock PostgREST retorna `{ gorjeta: "22.0", valor: "100.00", ... }` → resposta da rota inclui `gorjeta: 22.0`
- Mock PostgREST retorna `{ gorjeta: null, valor: "100.00", ... }` → resposta inclui `gorjeta: null`
- Mock PostgREST retorna registro sem campo gorjeta (base antiga) → resposta inclui `gorjeta: null` (retrocompatibilidade — CL-002)

**Critérios de aceite**:
- [ ] Todos os 3 cenários cobertos com asserções explícitas
- [ ] Teste de shape: resposta da rota SEMPRE tem campo `gorjeta` (nunca `undefined`)
- [ ] Testes passam sem banco real (mock/stub do PostgREST)

**DEP**: 5.1 (diretório tests), 3.1 (mapper implementado)

- [ ] **3.2** Criar testes de leitura gorjeta em `motorista-integration.test.js`

---

## FASE 4 — Frontend (page.tsx)

### 4.1 Adicionar gorjeta à interface Movimento (page.tsx) `[C]`

**O quê**: estender a interface TypeScript `Movimento` em `page.tsx` com
o campo `gorjeta` opcional.

**Arquivo alvo**:
`app_homologacao/frontend_motorista/app/(app)/movimento/page.tsx`

**Ponto de inserção**: linha ~35 (`interface Movimento { valor: string | number | null; ... }`).

**Mudança esperada**:
```ts
// Dentro de interface Movimento (linha ~37, após valor):
gorjeta?: string | number | null;
```

**Critérios de aceite**:
- [ ] `gorjeta` adicionado à interface `Movimento` como campo opcional (`?`)
- [ ] Tipo aceita `string | number | null` (consistência com `valor` — CL-003)
- [ ] TypeScript compila sem erros (`tsc --noEmit`)

**DEP**: nenhuma (mudança de tipo pura, independente do backend estar deployado)

- [ ] **4.1** Adicionar `gorjeta?: string | number | null` à interface `Movimento` em `page.tsx`

### 4.2 Render condicional de gorjeta (page.tsx) `[C]`

**O quê**: adicionar exibição condicional do valor da gorjeta na tela de
movimento, formatado em BRL, visível apenas quando não-nulo e não-zero.

**Arquivo alvo**:
`app_homologacao/frontend_motorista/app/(app)/movimento/page.tsx`

**Lógica esperada** (FR-005, FR-006, CL-002):
```tsx
// Derivar gorjetaNum próximo de valorNum (linhas ~111-115):
const gorjetaNum =
  movimento?.gorjeta != null && movimento.gorjeta !== ''
    ? typeof movimento.gorjeta === 'string'
      ? parseFloat(movimento.gorjeta)
      : movimento.gorjeta
    : null;

// Render condicional — SOMENTE quando gorjetaNum > 0 (FR-006):
// Posicionar após o bloco "Hero — Valor" (linha ~177) dentro do card:
{gorjetaNum != null && !isNaN(gorjetaNum) && gorjetaNum > 0 && (
  <div className="flex items-baseline justify-between gap-2">
    <span className="text-sm text-muted-foreground">Gorjeta</span>
    <span className="font-semibold tabular">
      {formatCurrency(gorjetaNum)}
    </span>
  </div>
)}
```

**Critérios de aceite**:
- [ ] Gorjeta `22.0` exibida como "R$ 22,00" próxima ao valor do serviço (FR-005)
- [ ] Gorjeta `null` ou `0`: bloco NÃO renderizado — nenhum texto "Gorjeta" aparece (FR-006)
- [ ] Gorjeta `undefined` (campo ausente na resposta): NÃO renderizado (retrocompat — CL-002)
- [ ] Rótulo "Gorjeta" usado (padrão — gap CHK204 de baixo impacto, decisão de produto)
- [ ] Usa `formatCurrency` existente — nenhuma dependência nova (SC-003)
- [ ] TypeScript compila sem erros (`tsc --noEmit`)
- [ ] Comportamento existente (tela vazia, valor NF, datas, tomador) NÃO alterado (regressão zero)

**DEP**: 4.1 (interface atualizada)

- [ ] **4.2** Implementar derivação `gorjetaNum` e render condicional em `page.tsx`

### 4.3 Verificação local do render (page.tsx) `[M]`

**O quê**: verificar localmente (sem deploy no host de produção) que o
componente renderiza corretamente com dados mockados.

**Como** (plan §6.5 — verificação local segura):
```ts
// Arquivo temporário de verificação (não commitado):
// Alterar o mock do estado no storybook/dev local OU
// inspecionar via snapshot test que o JSX produzido pelo componente
// contém o bloco de gorjeta quando gorjeta=22.0
```

**Critérios de aceite**:
- [ ] Inspeção visual ou snapshot confirma que bloco gorjeta aparece com `gorjeta=22.0`
- [ ] Inspeção confirma que bloco NÃO aparece com `gorjeta=null`
- [ ] NUNCA rodar `next build` ou `next dev` no host de produção (lição starvation)

**DEP**: 4.2 (render implementado)

- [ ] **4.3** Verificar render localmente (snapshot ou inspeção manual com dados mock)

---

## FASE 5 — Testes

### 5.1 Criar diretório tests e arquivo base `[A]`

**O quê**: criar a estrutura de testes backend que ainda não existe.

**Diretório alvo**: `app_homologacao/backend/tests/`

**Arquivo a criar**: `app_homologacao/backend/tests/motorista-integration.test.js`
(esqueleto inicial — as tarefas 2.2 e 3.2 adicionam os casos)

**Conteúdo mínimo do esqueleto**:
```js
// motorista-integration.test.js
// Testes de integração: upload gorjeta (server.js) + leitura gorjeta (motorista.js)
// Executar: node --test tests/motorista-integration.test.js
// (ou jest, conforme setup do projeto)

const assert = require('node:assert');
const { describe, it } = require('node:test');

// Helpers de mock PostgREST serão adicionados pelas tasks 2.2 e 3.2
```

**Critérios de aceite**:
- [ ] Diretório `app_homologacao/backend/tests/` existe
- [ ] Arquivo `motorista-integration.test.js` criado com esqueleto inicial
- [ ] `node --test tests/motorista-integration.test.js` executa sem erro de sintaxe

**DEP**: nenhuma

- [ ] **5.1** Criar diretório `tests/` e esqueleto de `motorista-integration.test.js`

---

## FASE 6 — Ritos do Operador (NÃO executar pelo agente)

> **TODAS as tarefas desta fase são RITO DO OPERADOR.**
> O agente NÃO executa nenhuma delas. Entrega apenas os artefatos SQL e
> os comandos documentados. O operador executa na VPS de produção sob rito,
> com os comandos exatos abaixo.

### 6.1 [RITO DO OPERADOR] Backup + DDL + reload PostgREST `[C]`

**Pré-condição**: tarefa 1.1 concluída (arquivo SQL commitado na branch).

**Sequência obrigatória** (plan §5 — NUNCA inverter):

```sh
# 1. Backup preventivo (ANTES de qualquer escrita)
pg_dump -t '"EnvioMassa"' chatmasterveloz > backup_EnvioMassa_pre_gorjeta.sql

# 2. Verificar tipo da coluna valor (CL-003 / SC-005)
psql chatmasterveloz -c '\d "EnvioMassa"' | grep -E 'valor|gorjeta'

# 3. Aplicar DDL idempotente
psql chatmasterveloz < app_homologacao/backend/db/009_envio_massa_gorjeta.sql

# 4. Verificar que a coluna foi criada
psql chatmasterveloz -c '\d "EnvioMassa"' | grep gorjeta

# 5. Forçar reload do PostgREST (FR-008) — alternativa se NOTIFY não bastar:
#    docker service update --force envio-massa-homologacao_postgrest
```

**Critérios de aceite** (operador valida):
- [ ] Backup gerado antes do ALTER
- [ ] `\d "EnvioMassa"` mostra `gorjeta | text` após o ALTER
- [ ] PostgREST recarregado: `curl -s "http://postgrest/EnvioMassa?limit=0" -I` retorna `gorjeta` no schema

**DEP**: 1.1

- [ ] **6.1** [RITO] Aplicar `009_envio_massa_gorjeta.sql` + reload PostgREST

### 6.2 [RITO DO OPERADOR] Deploy backend `[C]`

**Pré-condição**: tarefas 2.1 + 3.1 commitadas; DDL aplicado (6.1 concluído).

**Razão da ordem** (plan §5): backend que envia `gorjeta` no INSERT SÓ pode
subir DEPOIS da coluna existir no banco. Inverter quebra TODOS os uploads.

```sh
# Build com cap de recurso (lição starvation — NUNCA sem --memory)
DOCKER_BUILDKIT=0 docker build \
  --memory=2g --memory-swap=2g \
  --cpu-quota=200000 --cpu-period=100000 \
  -t envio-massa-backend:gorjeta-motorista \
  app_homologacao/backend/

# Deploy no Swarm
docker service update \
  --image envio-massa-backend:gorjeta-motorista \
  envio-massa-homologacao_backend

# Verificar que o serviço estabilizou
docker service ps envio-massa-homologacao_backend
```

**Critérios de aceite** (operador valida):
- [ ] Serviço backend estabilizado (sem restart loops)
- [ ] `POST /upload` com planilha de teste retorna 200

**DEP**: 2.1, 3.1, 6.1

- [ ] **6.2** [RITO] Build + deploy do backend com gorjeta

### 6.3 [RITO DO OPERADOR] Deploy frontend_motorista `[C]`

**Pré-condição**: tarefa 4.2 commitada; backend deployado (6.2 concluído).

```sh
# Build com cap de recurso
DOCKER_BUILDKIT=0 docker build \
  --memory=2g --memory-swap=2g \
  --cpu-quota=200000 --cpu-period=100000 \
  -t app-motorista-frontend:gorjeta-motorista \
  app_homologacao/frontend_motorista/

# Deploy no Swarm
docker service update \
  --image app-motorista-frontend:gorjeta-motorista \
  envio-massa-homologacao_frontend-motorista

docker service ps envio-massa-homologacao_frontend-motorista
```

**Critérios de aceite** (operador valida):
- [ ] Serviço frontend estabilizado
- [ ] `https://app.motorista.moveelog.com.br` retorna 200 na raiz

**DEP**: 4.2, 6.2

- [ ] **6.3** [RITO] Build + deploy do frontend_motorista com gorjeta

### 6.4 [RITO DO OPERADOR] Smoke test ponta-a-ponta `[C]`

**Pré-condição**: 6.2 + 6.3 concluídos.

**Sequência de smoke** (plan §5 + spec SC-001..SC-005):

```sh
# 1. Upload de planilha com gorjeta preenchida (ex.: "R$ 22,00")
#    → verificar que o upload retorna 200 e inserted_count > 0

# 2. Login como motorista correspondente em https://app.motorista.moveelog.com.br
#    → tela de movimento deve exibir:
#      - Valor da nota fiscal: R$ <valor>
#      - Gorjeta: R$ 22,00   ← NOVO

# 3. Upload de planilha SEM coluna gorjeta (planilha legada)
#    → upload retorna 200 (sem erro — FR-003)
#    → tela do motorista NÃO exibe campo "Gorjeta" (FR-006)

# 4. Upload com gorjeta = "R$ -"
#    → tela NÃO exibe campo "Gorjeta" (FR-006)
```

**Critérios de aceite** (SC-001..SC-005):
- [ ] Upload com gorjeta `"R$ 22,00"` → motorista vê "Gorjeta: R$ 22,00" (SC-001)
- [ ] Upload sem gorjeta → campo não exibido (SC-002)
- [ ] Upload com planilha legada (sem coluna) → upload não quebra (SC-003)
- [ ] Reaplicar 009.sql com coluna já existente → sem erro (SC-005 / FR-007)
- [ ] Outros campos (valor, datas, tomador) não alterados — regressão zero (SC-004)

**DEP**: 6.2, 6.3

- [ ] **6.4** [RITO] Executar smoke test ponta-a-ponta e registrar resultado

---

## Notas

- **CHK111** `[Conflict]` (API checklist): spec diz "falhar apenas no campo gorjeta" mas
  PostgREST rejeita a linha inteira em colunas inválidas. A implementação seguiu o
  comportamento real do PostgREST (CL-004: gorjeta não bloqueia upload quando ausente;
  quando presente, tipo TEXT aceita qualquer string).
- **CHK204** `[Gap]` (UX checklist): rótulo "Gorjeta" adotado como padrão — baixa criticidade.
  Operador pode ajustar via PR separado se necessário.
- **CHK308** `[Gap]` (security checklist): visibilidade da gorjeta no painel da empresa
  fora de escopo — endereçar em feature futura de "relatório de gorjetas".

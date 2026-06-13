# Plano — Período (data inicial/final) por seleção no import, não pela planilha

> Briefing para rodar via `/feature-00c` em sessão fresca. Padrão dos planos em `docs/plans/`.

## 1. Problema

No upload de movimento (painel `app.moveelog.com.br`), as colunas **`dt_inicial`** e
**`dt_final`** vêm preenchidas **por linha** na planilha. Para grupos que **não** são o
Movee (`idReferencia ≠ 6`), essas datas são **obrigatórias por linha** e o upload é
**tudo-ou-nada**: se qualquer linha tiver data vazia ou em formato inválido, o backend
rejeita o **lote inteiro** com `400`.

Isso é frágil: o usuário pode digitar o período errado (ou esquecer) em **linhas
aleatórias** da planilha, e o lote todo falha — exatamente o que ocorreu no smoke da
feature gorjeta (3 linhas sem `dt_inicial`/`dt_final` → `400`).

## 2. Objetivo

No momento do **import da planilha de movimento**, o usuário **seleciona um range de
datas** (data inicial e data final) **na UI**. O backend aplica esse range a **TODAS as
linhas** do lote — substituindo a leitura por-linha. As colunas `dt_inicial`/`dt_final`
da planilha deixam de ser a fonte da verdade (passam a ser ignoradas). Resultado: o
período é uniforme, não há mais erro de digitação por linha, e o upload deixa de
falhar por data ausente em linha aleatória.

## 3. Comportamento desejado (UX)

1. Usuário clica **Importar** e escolhe o `.xlsx`/`.xls` (como hoje).
2. Antes de enviar, abre um **diálogo** pedindo **Data inicial** e **Data final** do
   período do movimento.
3. Validação na UI: ambas obrigatórias, `dt_inicial ≤ dt_final`. Botão **Enviar** só
   habilita com range válido.
4. Ao confirmar, o upload envia o arquivo **+ o range** ao backend.
5. Backend aplica o range a todas as linhas e processa normalmente (gorjeta, valor,
   CNPJ, etc. seguem iguais).

## 4. Base de código (branch) — `main`

Verificado: `app_homologacao/frontend_v2` (painel `app.moveelog.com.br`, Next.js 16.2.3)
e `app_homologacao/backend/server.js` estão na **`main`**. Criar a branch de feature a
partir da `main`. (A `feat/design-system-movee-v2` já foi mergeada.)

## 5. Fatia vertical (3 camadas)

### 5.1 UI — `frontend_v2/components/import-button.tsx`
- Hoje: ao escolher o arquivo, chama direto `onUpload(file)` (sem campos extras).
- Mudar para um fluxo de **2 passos**: escolher arquivo → abrir **Dialog**
  (`components/ui/dialog.tsx` já existe) com dois `<input type="date">`
  (`components/ui/input.tsx`, padrão nativo já usado em `components/filters.tsx`) para
  **Data inicial** e **Data final**.
- Estado local: `{ dtInicial: string; dtFinal: string }` (formato `YYYY-MM-DD` do input
  nativo). Validar `dtInicial && dtFinal && dtInicial ≤ dtFinal` para habilitar Enviar.
- Ao confirmar: `onUpload(file, { dt_inicial, dt_final })`.
- **Sem nova lib** (não há `react-day-picker`/`date-fns` no projeto; usar input nativo).

### 5.2 Cliente HTTP / proxy
- `frontend_v2/lib/api-client.ts::uploadFile(path, file)` → estender para
  `uploadFile(path, file, extraFields?: Record<string,string>)`, fazendo
  `formData.append('dt_inicial', ...)` e `formData.append('dt_final', ...)`.
- Propagar a assinatura pelo hook `useEnvioMassa.uploadFile` e pelo `dashboard/page.tsx`
  → `ActionBar`/`ImportButton`.
- **Proxy `app/api/[...path]/route.ts`: SEM mudança** — ele já faz *streaming* do
  `multipart/form-data` preservando boundary; os campos extras passam transparentes.

### 5.3 Backend — `app_homologacao/backend/server.js` (rota `POST /upload`)
- A rota usa `upload.single('file')` (multer) → os campos de texto do FormData ficam em
  **`req.body.dt_inicial`** e **`req.body.dt_final`**.
- **Validar o range UMA vez** no início do handler (antes do loop de linhas):
  presença, conversão via `toTimestamptzMidnightSP` (já existe, ~linha 1350), e
  `dt_inicial ≤ dt_final`. Se inválido → `400` com mensagem clara (uma só, não por linha).
- No loop de linhas (~1472–1492): **remover** a leitura/validação por-linha de
  `row.dt_inicial`/`row.dt_final` (o bloco `if (!_isGrupoMovee) { ... dt_inicial é
  obrigatório ... }`). Em vez disso, usar os `dtIniTS`/`dtFimTS` **do range** para
  **todas** as linhas.
- As colunas `dt_inicial`/`dt_final` da planilha passam a ser **ignoradas**.

## 6. Decisões a fechar no `/clarify`

1. **Obrigatoriedade do range**: passa a ser obrigatório para **todos os grupos**
   (incl. Movee), eliminando o caminho per-row e o default `01/01/1982`?
   **Recomendado: SIM** (consistência; o range é a fonte única).
2. **Semântica de `dt_final`**: manter `meia-noite SP` (igual hoje) ou usar **fim do
   dia** (`23:59:59`) para o filtro pegar o dia inteiro? **Recomendado: manter
   meia-noite** (só muda a *fonte* das datas, não a semântica existente) — confirmar.
3. **Colunas na planilha**: removê-las do modelo (`docs/modelo_upload_...xlsx`) ou
   apenas ignorá-las se presentes? **Recomendado: ignorar se presentes** (retrocompat)
   e remover do modelo numa etapa de doc.
4. **Validação de range absurdo** (ex.: intervalo > N meses): adicionar teto? Default:
   sem teto (fora de escopo).

## 7. Pontos de código (referências `main`)

- UI upload: `frontend_v2/components/import-button.tsx` (`processFile` → `onUpload`).
- API client: `frontend_v2/lib/api-client.ts` (`uploadFile`).
- Hook/estado: `frontend_v2/hooks/useEnvioMassa` + `frontend_v2/app/dashboard/page.tsx`.
- Proxy (sem mudança): `frontend_v2/app/api/[...path]/route.ts`.
- Backend rota: `backend/server.js` `app.post('/upload', ...)` — range em `req.body`,
  loop de linhas ~1472–1516, helper `toTimestamptzMidnightSP` ~1350.

## 8. Ordem de implementação

1. Backend: aceitar `req.body.dt_inicial/dt_final`, validar o range, aplicar a todas as
   linhas, remover validação per-row. (Compatível com UI antiga enquanto a UI não muda?
   Ver §9.)
2. `api-client.ts`: `uploadFile` com `extraFields`.
3. UI: dialog de range no `import-button.tsx` + propagação do estado.
4. Testes + ajuste do modelo de planilha (doc).

## 9. Riscos / retrocompatibilidade

- **Janela de incompatibilidade**: se o backend passar a **exigir** `req.body.dt_inicial`
  antes da UI enviar, uploads pela UI antiga quebram. Mitigar com **deploy coordenado**
  (frontend_v2 + backend juntos) **ou** fase de transição: backend aceita o range; se
  ausente, cai no comportamento atual (per-row) por um curto período. **Recomendado:
  deploy coordenado** (é o mesmo rito da gorjeta).
- **multer + streaming**: confirmar que `upload.single('file')` popula `req.body` com os
  campos de texto quando o body chega via *stream* do proxy (comportamento padrão do
  multer; validar em teste de integração).
- **Ordem crítica de deploy** (rito do operador, host VPSTodo): build backend + frontend
  com **swap temporário 4G + `docker build --memory=2g`** (lição
  starvation), `service update --image` via `registry.todo-tips.com`. Sem DDL nesta
  feature (não há mudança de schema).

## 10. Testes / critérios de aceite

- Range válido → todas as linhas gravam `dt_inicial`/`dt_final` do range; lote insere.
- `dt_inicial > dt_final` → `400` com mensagem única e clara.
- Range ausente (se obrigatório) → `400`.
- Planilha com colunas de data divergentes/aleatórias → **ignoradas**; usa o range.
- Linha sem data na planilha → **não** falha mais (não depende mais da coluna).
- Regressão: `valor`, `gorjeta`, CNPJ, mensagens seguem inalterados.

## 11. Como rodar (sessão fresca)

`cwd` na raiz do repo, branch `main`. Pré-reqs OK na `main` (`docs/constitution.md`,
`docs/01-briefing-discovery/briefing.md`). Comando:

`/feature-00c "Substituir as datas por-linha da planilha de movimento por um seletor de range (data inicial/final) na UI do import, aplicado a todas as linhas; briefing em docs/plans/import-range-datas-movimento.md" import-range-datas`

(aprovar o warm-up de permissões no início). Deploy = frontend_v2 + backend
coordenados, sob o rito do operador (sem DDL).

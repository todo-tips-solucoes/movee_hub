# Plano — Persistir e exibir o valor da gorjeta (upload → banco → app motorista)

> **Como usar:** briefing autocontido para rodar numa **sessão fresca pelo cstk**, de forma
> **autônoma** (pipeline SDD via `/feature-00c`). Trabalho de código → fluxo normal; **DDL no banco
> e deploy no ambiente do cliente exigem RITO DE PRODUÇÃO** (ver §8). Criado 2026-06-12, revisado
> 2026-06-12 (escopo ampliado: a gorjeta NÃO está persistida hoje — ver §2).

## 1. Objetivo

A **gorjeta** de cada movimento **já vem na planilha de upload** do app de gerenciamento (painel),
mas é **descartada na importação** porque (a) o backend não a mapeia no insert e (b) **não existe a
coluna `gorjeta` na tabela `EnvioMassa`**. Este plano faz a **fatia vertical completa**:

1. **Persistir** a gorjeta no banco a partir da planilha de upload (criar a coluna + mapear no import).
2. **Expor** a gorjeta na API do motorista.
3. **Exibir** o valor da gorjeta na tela de movimento do app motorista (`app.motorista.moveelog.com.br`).

## 2. Diagnóstico (estado atual) — por que a gorjeta some hoje

Planilha modelo: `docs/modelo_upload_envio_em_massa_movee (2).xlsx`. **Confirmado**: a planilha tem
uma coluna de cabeçalho **`gorjeta`** (snake_case, igual aos outros headers que batem com colunas da
`EnvioMassa`). Valores no formato BRL, ex.: `R$ 22,00`, `R$ 15,00`, e **`R$ -`** quando não há gorjeta.

| Camada | Arquivo / ponto | Situação |
|---|---|---|
| **Planilha** | `docs/modelo_upload_envio_em_massa_movee (2).xlsx` | tem coluna `gorjeta` (valores BRL; `R$ -` = vazio). |
| **Upload (parse+insert)** | `app_homologacao/backend/server.js` — validação por linha (~1154-1226) e `dataToInsert.push({ number, nome, valor, mensagem1, …, id_empresa })` (**~1228-1249**) | monta um objeto com **campos FIXOS**; **`gorjeta` NÃO está na lista** → é **descartada** no insert (`postgrestRequest('EnvioMassa','POST',dataToInsert)` ~1288). |
| **Tabela** | `EnvioMassa` (banco `chatmasterveloz`, via PostgREST) | **NÃO existe coluna `gorjeta`** — não há onde gravar. |
| **Leitura (motorista)** | `app_homologacao/backend/routes/motorista.js` → `GET /motorista/movimento-aberto` (auth `authenticateMotorista`, ~337); consulta `EnvioMassa?…&mov_fechado=eq.false&limit=1` **sem `select=` (= `select *`)**; mapper `movimento = { id, valor, dtInicial, dtFinal, nome, cnpjTomador, cnpjPrestador, tribnac, notaOk, erroValidacao, tomador }` (~379-391) | o `select *` **já traria** a coluna se existisse, mas o mapper **não inclui** `gorjeta`. |
| **Tela motorista** | `app_homologacao/frontend_motorista/app/(app)/movimento/page.tsx` (~194 render do `valor`) | renderiza `valor`/`nome`/`tomador`; **não** mostra gorjeta. |

**Conclusão:** a gorjeta nunca chega ao banco (sem coluna + sem mapeamento no upload), logo nunca
chega ao app. Precisa de: **criar a coluna** + **persistir no upload** + **mapear na leitura** +
**renderizar**.

## 3. Decisões a fechar no clarify

1. **Tipo/precisão da coluna `gorjeta`** na `EnvioMassa`: **espelhar a coluna `valor`**. Hoje o
   upload grava `valor` como string `.toFixed(2)` (ex.: `"99.99"`) via `toNumberBR` (server.js ~1180).
   Confirmar o tipo real da coluna `valor` (text vs numeric) e usar o mesmo para `gorjeta`,
   gravando no mesmo formato.
2. **Valor vazio**: a planilha usa `R$ -`. Definir → gravar `null` (recomendado) ou `0`. Na tela do
   motorista, decidir ocultar vs mostrar `R$ 0,00`/`—`.
3. **Obrigatoriedade**: gorjeta é **opcional** — planilhas antigas (sem a coluna) e linhas com
   `R$ -` **não podem** quebrar o upload (diferente de `valor`, que é obrigatório).

## 4. ⚠️ Base de código (branch) — NÃO é a `main`

Os arquivos do motorista (`frontend_motorista/`, `backend/routes/motorista.js`) **não estão na
`main`** — vivem em **`feat/design-system-movee-v2`** (reskin Movee do motorista, DEPLOYADO e não
mergeado — [[reskin-entrego-motorista]] / [[redesign-movee-v2]]). O `backend/server.js` (upload)
existe nas duas, mas para manter tudo junto e bater com as imagens no ar, **fazer todas as mudanças
na branch `feat/design-system-movee-v2`**, criando a branch de feature a partir dela. Confirmar com
o operador que essa branch corresponde às imagens no ar (`app-motorista-frontend` e
`envio-massa-backend:cadastro-motorista-base`).

## 5. Escopo

**Muda:**
- **Banco (`EnvioMassa`):** `ALTER TABLE … ADD COLUMN gorjeta …` (aditivo, idempotente) + **reload
  do schema do PostgREST** (senão a nova coluna não é exposta).
- **`backend/server.js` (upload):** ler `row.gorjeta` (parse BRL como o `valor`, vazio→null) e
  **adicionar `gorjeta` ao objeto `dataToInsert.push({…})`** (~1248). Tolerar ausência/`R$ -`.
- **`backend/routes/motorista.js` (leitura):** adicionar `gorjeta: m.gorjeta` ao objeto `movimento`
  do `/movimento-aberto` (~389).
- **`frontend_motorista`:** adicionar `gorjeta` ao tipo do `movimento` e **renderizar** na tela
  (`movimento/page.tsx`, perto do `valor`, em BRL via `formatCurrency`).

**NÃO muda:** demais colunas/validações do upload, painel além do upload, validação NFS-e, proxy,
autenticação, o `frontend_v2` (painel) e o `frontend` legado.

## 6. Passos de implementação (sessão fresca autônoma)

1. **Clarify** (§3): tipo da coluna (espelhar `valor`), comportamento de vazio, opcionalidade.
2. **Branch base** (§4): criar feature a partir de `feat/design-system-movee-v2`.
3. **DDL** idempotente/aditiva: `ALTER TABLE "EnvioMassa" ADD COLUMN IF NOT EXISTS gorjeta <tipo de valor>;`
   — **`pg_dump -t '"EnvioMassa"'` antes** (backup). Depois **reload do PostgREST**
   (`NOTIFY pgrst, 'reload schema';` ou recriar/atualizar o serviço `pgadmin_postgrest`).
4. **Backend upload** (`server.js`): parse `row.gorjeta` (reusar `toNumberBR`; `R$ -`/vazio → null) e
   incluir `gorjeta` no `dataToInsert.push({…})`. **Manter idempotência**: linhas sem gorjeta não
   geram erro.
5. **Backend leitura** (`routes/motorista.js`): `gorjeta: m.gorjeta` no objeto `movimento`.
6. **Frontend** (`frontend_motorista`): tipo + render (rótulo "Gorjeta", BRL, tratamento de vazio).
   Manter o design system Movee.
7. **Verificação local:** `tsc --noEmit`/lint/`build` no `backend` e `frontend_motorista`; atualizar
   `backend/tests/motorista-integration.test.js` (shape do movimento + gorjeta) e qualquer teste de
   upload.
8. **Deploy sob rito** (§8): DDL → reload PostgREST → backend → frontend_motorista.

## 7. Critérios de aceite

- Upload de planilha **com** `gorjeta` preenchida → valor **persistido** na `EnvioMassa` (verificar
  via PostgREST/pgAdmin de homologação).
- Upload com `gorjeta = R$ -`/vazio → grava `null`/`0` (conforme clarify), **sem erro**.
- Upload de planilha **antiga sem a coluna `gorjeta`** → continua funcionando (gorjeta opcional).
- **Regressão**: uploads existentes (demais campos) seguem idênticos.
- App motorista mostra a gorjeta na tela de movimento (BRL, rótulo, tratamento de vazio); isolamento
  por motorista preservado (`authenticateMotorista`); estado "sem movimento" intacto.
- `tsc`/lint/`build` limpos; testes verdes.

## 8. Governança — RITO DE PRODUÇÃO ⚠️ (inclui DDL!)

Ambiente do cliente: host `VPSTodo`; banco `chatmasterveloz`/`pgadmin_db`; serviços
`…_backend_homologacao`, `…_frontend_motorista_homologacao`, `pgadmin_postgrest`. Ver `CLAUDE.md` /
`docs/RITO-PRODUCAO.md`.

- Código/PR/build → fluxo normal.
- **DDL (escrita no banco do cliente)** — ponto mais sensível ([[regra-nao-tocar-producao]]):
  **aditiva e idempotente** (`ADD COLUMN IF NOT EXISTS`), **`pg_dump -t '"EnvioMassa"'` antes**, e
  **reload do schema do PostgREST** depois. **Rollback:** a coluna aditiva **FICA** (não dropar —
  é inócua); rollback do comportamento = reverter as imagens.
- **⚠️ ORDEM CRÍTICA:** aplicar **DDL + reload do PostgREST ANTES** de subir o backend que envia
  `gorjeta` no insert. Se o backend novo subir antes da coluna existir, o PostgREST **rejeita o
  insert (coluna inexistente) e quebra TODO o upload**. Sequência: (1) `pg_dump`, (2) `ALTER TABLE`,
  (3) reload PostgREST, (4) deploy backend, (5) deploy frontend_motorista, (6) smoke.
- **Deploy** = `docker service update --image` (**nunca** `stack deploy`), sob os **5 gates**.
  Muda **2 imagens**: `envio-massa-backend` e `app-motorista-frontend`.
- **Build seguro neste host** (lição [[incidente-swarm-starvation-2026-06-11]]): host de produção,
  pouca RAM/zero swap → buildar com **cap de recurso**:
  `DOCKER_BUILDKIT=0 docker build --memory=2g --memory-swap=2g --cpu-quota=200000 --cpu-period=100000 -t <img> <ctx>`,
  em background + monitor do Swarm; abortar matando **só o PID exato** se algum serviço cair p/ `0/`.
  **NUNCA** `pkill -f <nome amplo>` nem prune `-a`/`--volumes`.
- Combinado vigente: o agente executa DDL/deploy **mostrando os comandos antes** de rodar; em dúvida
  no banco, **parar e devolver ao operador**. Smoke test ao final (`app.motorista.moveelog.com.br`).

## 9. Execução autônoma via cstk (janela fresca)

- Subir o cstk numa **sessão fresca** (ver [[cstk-setup]] / `CONTINUAR-CSTK.md`).
- Rodar `/feature-00c` (specify → clarify → plan → checklist → create-tasks → execute-task →
  review-task) com **este plano como briefing**. Clarify resolve §3 + branch base (§4).
- Guardar o ponteiro de onda após cada etapa ([[feature00c-reconcile-premature-review]]).
- Deploy sob o rito (§8, com a **ordem crítica DDL→reload→backend→frontend**) e validação no celular.

## 10. Referências de código (branch `feat/design-system-movee-v2`)

- `docs/modelo_upload_envio_em_massa_movee (2).xlsx` — planilha modelo (coluna `gorjeta`).
- `app_homologacao/backend/server.js` — upload: validação por linha (~1154), objeto de insert
  `dataToInsert.push({…})` (~1228-1249), `postgrestRequest('EnvioMassa','POST',…)` (~1288); helper
  `toNumberBR` (parse BRL do `valor`, ~1180).
- `app_homologacao/backend/routes/motorista.js` — `/movimento-aberto` (~337) + mapper `movimento`
  (~379-391).
- `app_homologacao/frontend_motorista/app/(app)/movimento/page.tsx` — tela de movimento (~194).
- `app_homologacao/backend/tests/motorista-integration.test.js` — testes do movimento-aberto.

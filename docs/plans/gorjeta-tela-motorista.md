# Plano — Exibir o valor da gorjeta na tela do app do motorista

> **Como usar:** briefing autocontido para rodar numa **sessão fresca pelo cstk**, de forma
> **autônoma** (pipeline SDD via `/feature-00c`, igual às features anteriores). Trabalho de
> código → fluxo normal; **deploy no ambiente do cliente exige RITO DE PRODUÇÃO** (ver §8).
> Criado em 2026-06-12.

## 1. Objetivo

No app do **motorista** (`app.motorista.moveelog.com.br`), na tela de **movimento aberto**,
exibir o **valor da gorjeta** referente àquele movimento. Esse valor **já existe na tabela
`EnvioMassa`** (banco `chatmasterveloz`, exposto via PostgREST) e **já é trazido** pelo backend
na consulta do movimento — só **não é mapeado nem renderizado** hoje.

## 2. Diagnóstico (estado atual) — fluxo de dados ponta a ponta

Tela do motorista → proxy same-origin → backend → PostgREST → `EnvioMassa`.

| Camada | Arquivo / ponto | Situação |
|---|---|---|
| **UI (tela movimento)** | `app_homologacao/frontend_motorista/app/(app)/movimento/page.tsx` | renderiza **um** movimento: `valor` (`formatCurrency(movimento.valor)`, ~linha 194), `nome`/`tomador.razaoSocial`, `cnpjTomador`. **Não** mostra gorjeta. |
| **Tipo `movimento`** | tipo do objeto `movimento` consumido pela tela (procurar em `frontend_motorista/lib`/`contexts`/`types`) | **não** tem campo `gorjeta`. |
| **Proxy** | `app_homologacao/frontend_motorista/app/api/[...path]/route.ts` | same-origin → `BACKEND_URL`. (Não muda.) |
| **Backend (endpoint)** | `app_homologacao/backend/routes/motorista.js` → `GET /motorista/movimento-aberto` (auth `authenticateMotorista`, ~linha 337) | consulta `EnvioMassa?<filtro cnpj>&mov_fechado=eq.false&order=created_at.desc&limit=1` **sem `select=` → retorna TODAS as colunas** em `m` (a gorjeta já vem aqui). |
| **Mapper** | mesmo arquivo, objeto `movimento = { id, valor, dtInicial, dtFinal, nome, cnpjTomador, cnpjPrestador, tribnac, notaOk, erroValidacao, tomador }` (~linhas 379-391) | **não inclui** a gorjeta no objeto devolvido. |
| **Dado-fonte** | coluna de gorjeta na tabela `EnvioMassa` (PostgREST) | **existe no banco, mas NÃO é referenciada em nenhum código** (backend, tipos, SQL, docs). Nome exato **a confirmar** (ver §3). |

**Conclusão:** como o backend já faz `select *` (sem lista de colunas), a gorjeta **já está em
`m`**. A mudança é mínima: **mapear** `m.<coluna_gorjeta>` no objeto `movimento` e **renderizar**
na tela. Sem mexer no PostgREST nem na query.

## 3. ⚠️ Incógnita a resolver primeiro — nome exato da coluna da gorjeta

A coluna **não aparece em código nenhum**, então o nome real precisa ser descoberto antes de
mapear. Opções (em ordem de preferência, **sem o agente tocar o banco de produção** —
[[regra-nao-tocar-producao]]):

1. **Introspecção via PostgREST** (mesma via que o app já usa, read-only): a resposta de
   `GET /motorista/movimento-aberto` (ou um `GET EnvioMassa?...&limit=1` pelo PostgREST de dev)
   traz o objeto bruto `m` com **todas** as chaves — logar/inspecionar `Object.keys(m)` em dev
   revela o nome (candidatos: `gorjeta`, `gorgeta`, `taxa`, `valor_gorjeta`, `servico`, etc.).
2. **Confirmar com o operador** o nome da coluna (ele tem acesso ao `chatmasterveloz`/pgAdmin).

Registrar o nome confirmado no spec antes de codar. **Não inventar o nome.**

## 4. ⚠️ Base de código (branch) — NÃO é a `main`

O `frontend_motorista/` e o `backend/routes/motorista.js` **não estão na `main`** (a `main` só tem
`backend` (server.js), `frontend`, `frontend_v2`). Eles vivem na branch **`feat/design-system-movee-v2`**
(reskin EntreGô/Movee do motorista, atualmente DEPLOYADO mas não mergeado — ver
[[reskin-entrego-motorista]] / [[redesign-movee-v2]]).

**Antes de codar:** confirmar com o operador qual branch corresponde à **imagem do motorista hoje
no ar** (`registry.todo-tips.com/app-motorista-frontend`) e ao **backend no ar**
(`registry.todo-tips.com/envio-massa-backend:cadastro-motorista-base`). Basear o trabalho nessa
branch (provavelmente `feat/design-system-movee-v2`), criando uma branch de feature a partir dela —
**não** a partir da `main`, senão os arquivos não existem.

## 5. Escopo

**Muda:**
- `app_homologacao/backend/routes/motorista.js` — adicionar `gorjeta: m.<coluna_gorjeta>` ao objeto
  `movimento` no handler `/movimento-aberto` (~linha 389). (Query não muda — já é `select *`.)
- `app_homologacao/frontend_motorista/` — tipo do `movimento` (+ campo `gorjeta`) e a tela
  `app/(app)/movimento/page.tsx` (renderizar a gorjeta perto do `valor`, em BRL).

**NÃO muda:** PostgREST/`EnvioMassa` (DDL), o proxy, autenticação, o painel `frontend_v2`, o app
`frontend` legado, upload, validação NFS-e.

## 6. Passos de implementação (sessão fresca autônoma)

1. **Descobrir o nome da coluna** da gorjeta (§3) e registrar no spec.
2. **Confirmar a branch base** (§4) e criar a branch de feature a partir dela.
3. **Backend:** no `/motorista/movimento-aberto`, mapear `gorjeta: m.<coluna>` no objeto
   `movimento` (snake_case → camelCase, seguindo o padrão das outras chaves). Tolerar
   ausente/`null` (movimento sem gorjeta = não bloquear). Atualizar o teste
   `backend/tests/motorista-integration.test.js` se cobrir o shape do movimento.
4. **Frontend (tipo):** adicionar `gorjeta?: number | string | null` ao tipo do `movimento`.
5. **Frontend (UI):** em `movimento/page.tsx`, exibir a gorjeta perto do `valor`, com rótulo
   claro (ex.: "Gorjeta"), **formatação BRL** (reusar o helper `formatCurrency` já usado p/ valor)
   e tratamento de vazio/zero (se `null`/`0`/`''`, ou ocultar ou mostrar "—"/"R$ 0,00" —
   decidir no clarify). Manter o design system Movee do app (ver [[skill-ui-ux-pro-max]] se
   precisar de polimento; o classifier bloqueia rodar os scripts da skill — usar só as regras).
6. **Build + verificação local:** `npm run build` (ou `tsc --noEmit` + lint) no `frontend_motorista`
   e no `backend`. Sem erros.
7. **Deploy sob rito** (§8) — backend **e** frontend_motorista (ambos mudaram).

## 7. Critérios de aceite

- Movimento **com** gorjeta: tela do motorista mostra o valor em BRL, com rótulo, perto do valor.
- Movimento **sem** gorjeta (coluna `null`/`0`/vazia): comportamento definido no clarify (ocultar
  ou "R$ 0,00"/"—"), sem quebrar a tela nem o estado vazio (sem movimento aberto).
- Isolamento por motorista preservado (escopo por token/CNPJ — `authenticateMotorista`); um
  motorista nunca vê dado de outro.
- Backend tolerante: coluna ausente não derruba o endpoint.
- `tsc`/lint/`build` limpos no backend e no frontend_motorista.
- Smoke test no ar (§8): `https://app.motorista.moveelog.com.br` 200 + login + movimento exibindo
  a gorjeta.

## 8. Governança — RITO DE PRODUÇÃO ⚠️

O app motorista é produção do cliente (host `VPSTodo`, serviços
`envio-massa-homologacao_frontend_motorista_homologacao` e `..._backend_homologacao`). Ver
`CLAUDE.md` e `docs/RITO-PRODUCAO.md`.

- Código/PR/build de imagem → **fluxo normal**.
- **Deploy** = build → push → `docker service update --image` (**nunca** `stack deploy`) nos
  serviços do cliente → **somente com os 5 gates**: (1) autorização explícita e específica,
  (2) janela combinada, (3) rollback à mão (imagem anterior anotada via `docker service inspect`),
  (4) `docker service update --image`, (5) smoke test depois.
- **Build seguro neste host** (lição do [[incidente-swarm-starvation-2026-06-11]]): este host roda
  produção e tem pouca RAM/zero swap — buildar com **cap de recurso**:
  `DOCKER_BUILDKIT=0 docker build --memory=2g --memory-swap=2g --cpu-quota=200000 --cpu-period=100000 -t <img> <ctx>`,
  em background + monitor do Swarm, abortando (matar só o **PID exato** do build) se algum serviço
  cair p/ `0/`. **NUNCA** `pkill -f <nome amplo>` nem prune `-a`/`--volumes`.
- Dois serviços mudam → buildar/pushar/atualizar **backend** e **frontend_motorista**. Smoke após
  cada um. Rollback por serviço, à imagem anterior anotada.
- Combinado vigente ([[regra-nao-tocar-producao]] atualizado): o agente executa o deploy
  **mostrando os comandos antes** de rodar. Em dúvida, parar e devolver ao operador.

## 9. Execução autônoma via cstk (janela fresca)

- Subir o cstk (ver [[cstk-setup]] / `CONTINUAR-CSTK.md`) numa **sessão fresca**.
- Rodar a pipeline SDD com **`/feature-00c`** (specify → clarify → plan → checklist →
  create-tasks → execute-task → review-task), tendo **este plano como briefing**. O clarify deve
  resolver: nome da coluna (§3), branch base (§4), e o comportamento de "sem gorjeta" (§7).
- Guardar o ponteiro de onda após cada etapa (gotcha [[feature00c-reconcile-premature-review]]).
- Ao final, deploy sob o rito (§8) e validação no celular.

## 10. Referências de código (na branch `feat/design-system-movee-v2`)

- `app_homologacao/backend/routes/motorista.js` — handler `/movimento-aberto` (~337) + mapper (~379-391).
- `app_homologacao/backend/server.js` — `app.use('/motorista', motoristaRoutes.router)` (~1822).
- `app_homologacao/frontend_motorista/app/(app)/movimento/page.tsx` — tela de movimento (~194 render do valor).
- `app_homologacao/frontend_motorista/app/api/[...path]/route.ts` — proxy same-origin.
- `app_homologacao/backend/tests/motorista-integration.test.js` — testes do movimento-aberto.

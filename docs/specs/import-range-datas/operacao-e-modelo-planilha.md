# Operação e modelo de planilha — import-range-datas

> Documentação de operador para a feature **seletor de range de datas no import de
> movimento**. Cobre a mudança de comportamento do modelo de planilha (tarefa 4.2.1),
> o novo fluxo do operador (tarefa 4.2.2) e o runbook de deploy coordenado (FASE 4.3,
> diferido ao operador).
>
> Status do código: FASE 1 (backend), FASE 2 (transporte) e FASE 3 (UI) **implementadas
> e commitadas**. FASE 4 (E2E + deploy no ambiente vivo) é **gate de operador** — ver
> seção [Pendências de operador](#pendências-de-operador-e2e--deploy).

---

## 1. Mudança de comportamento do modelo de planilha (4.2.1)

A partir desta feature, **as datas do movimento deixam de vir da planilha**: passam a
ser informadas uma única vez no diálogo de import (UI) e aplicadas a **todas as linhas
do lote**.

### Colunas `dt_inicial` / `dt_final` da planilha — agora IGNORADAS

| Antes | Depois |
|-------|--------|
| O backend lia `dt_inicial`/`dt_final` **por linha** da planilha. | O backend lê um **range único** de `req.body` (vindo da UI) e aplica a todas as linhas. |
| Linha sem data (ou com data inválida) → rejeição `400`. | Colunas `dt_inicial`/`dt_final` da planilha são **ignoradas**: presença ou ausência **não causa falha** (FR-006). |
| Grupo Movee usava fallback `01/01/1982` quando faltava data. | Fallback `01/01/1982` **eliminado**; grupo Movee e demais grupos recebem o mesmo range da UI (FR-008). |

**Implicação para quem mantém o modelo `.xlsx`:**

- As colunas `dt_inicial` e `dt_final` podem ser **removidas** do modelo de planilha
  distribuído ao cliente, ou mantidas por retrocompatibilidade — em ambos os casos
  seus valores são desconsiderados pelo backend.
- Não há binário de modelo versionado neste repositório; quando o modelo `.xlsx`
  oficial for atualizado, refletir esta nota no cabeçalho/instruções da planilha.
- Colunas **ainda obrigatórias** na planilha (inalteradas): `number`, `nome`, `valor`,
  `cnpj_tomador`, `cnpj_prestador` (mais `gorjeta` quando aplicável). Apenas a origem
  das **datas** mudou (FR-009: sem regressão em valor/gorjeta/CNPJ/mensagens).

---

## 2. Novo fluxo do operador (4.2.2)

Fluxo de **2 passos** no painel (`app.moveelog.com.br/dashboard`):

1. **Escolher o arquivo** — clicar **Importar XLSX** e selecionar a planilha (ou
   arrastar-e-soltar). O upload **não** dispara imediatamente.
2. **Informar o range no diálogo** — abre um diálogo com dois campos de data nativos:
   - **Data inicial** (`dt_inicial`)
   - **Data final** (`dt_final`)
   O botão **Enviar** só habilita quando ambas as datas estão preenchidas e
   `Data inicial ≤ Data final` (FR-002 / SC-2). Range invertido mostra mensagem de
   erro e mantém o botão desabilitado — bloqueado **antes** do envio.
3. **Enviar** — o painel converte as datas para `DD/MM/YYYY`, anexa `dt_inicial` e
   `dt_final` ao FormData e envia. O backend valida o range **uma única vez** (mensagem
   `400` única, não por linha) e grava o mesmo range em todas as linhas do lote.

### Comportamento esperado

- Lote com planilha **sem** colunas de data → **zero rejeições** `400` por falta de data
  (SC-1).
- Datas gravadas no banco = exatamente o range informado na UI, com a semântica de
  `dt_final` à meia-noite (horário de São Paulo) preservada (FR-007).
- `valor`, `gorjeta` (null vs valor), `cnpj_prestador`/`cnpj_tomador` e mensagens de
  envio: **inalterados** (FR-009).

Roteiro de validação manual detalhado: ver
[`quickstart.md`](./quickstart.md) (Cenários 1–7).

---

## 3. Pendências de operador (E2E + deploy)

As tarefas abaixo tocam o **ambiente vivo** (que neste projeto **é produção** —
ver `CLAUDE.md` §Rito de produção) e/ou exigem backend/frontend rodando. Por
cláusula pétrea, **o agente não toca produção**: estas ficam para o rito do operador.
São **diferidas**, não bloqueantes da pipeline de implementação.

### 3.1 Validação E2E (tarefas 4.1.x) — operator-gated

Executar os cenários do [`quickstart.md`](./quickstart.md) contra o ambiente vivo,
**após** o deploy coordenado:

- **4.1.1** Happy path P1 (escolher arquivo → diálogo → datas → enviar → gravação com
  range em todas as linhas).
- **4.1.2** Erros P2 (range inválido bloqueado na UI; backend `400` único — Cenários 3/4).
- **4.1.3** P3 comportamento uniforme entre grupos, incluindo Movee (fallback
  `01/01/1982` eliminado — Cenário 7).
- **4.1.4** Roundtrip E2E (Cenário 6): gorjeta (null vs valor), valor, CNPJ com/sem
  máscara — sem regressão (SC-5).
- **4.1.5** Confirmar que `multer` + streaming popula `req.body.dt_inicial/dt_final`
  quando o body chega via stream do proxy.

> Também diferidas para esta etapa E2E: subtarefas de teste de integração **1.1.6** e
> **1.2.7** (sem backend vivo no worktree; a lógica dos helpers foi validada por probe
> direto na FASE 1).

### 3.2 Deploy coordenado frontend_v2 + backend, **sem DDL** (tarefas 4.3.x)

Backend e frontend_v2 devem subir **no mesmo ciclo** para não abrir janela de
incompatibilidade (FR-010): o backend passa a **exigir** o range, então só pode entrar
no ar quando o frontend que o envia já estiver no ar.

#### Mini-runbook (executar sob os 5 gates do rito de produção — `CLAUDE.md`)

> **Pré-requisito de host:** o build de Next no `VPSTodo` sem mitigação já **starvou o
> control-plane do Swarm** uma vez (memória: incidente swarm starvation). Buildar com
> swap temporário **4G** + cap de memória do Docker (`--memory=2g`).

1. **Rollback à mão (antes de qualquer escrita):** anotar a imagem anterior de **ambos**
   os serviços:
   ```bash
   docker service ls   # anotar imagem atual de backend e frontend_v2
   # rollback = docker service update --with-registry-auth --image <anterior> <serviço>
   ```
   Sem DDL nesta feature (EX-01), então **não há** migração de banco a reverter.

2. **Build coordenado (host VPSTodo, com mitigação de starvation):**
   ```bash
   # swap temporário 4G
   fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile

   # backend (node:14) — sem cap de Next, mas mantém disciplina
   DOCKER_BUILDKIT=0 docker build --memory=2g \
     -t registry.todo-tips.com/envio-massa-backend:import-range \
     ./app_homologacao/backend

   # frontend_v2 (node:20-alpine, Next standalone) — cap obrigatório
   DOCKER_BUILDKIT=0 docker build --memory=2g \
     -t registry.todo-tips.com/envio-massa-frontend-v2:import-range \
     ./app_homologacao/frontend_v2

   docker push registry.todo-tips.com/envio-massa-backend:import-range
   docker push registry.todo-tips.com/envio-massa-frontend-v2:import-range

   # remover swap após o build
   swapoff /swapfile && rm -f /swapfile
   ```
   > ⚠️ Conferir o `ENV BACKEND_URL` do Dockerfile do `frontend_v2` antes de buildar
   > (aponta para a API do ambiente — `CLAUDE.md` §Convenções de deploy).

3. **Deploy no mesmo ciclo (nunca `docker stack deploy`):**
   ```bash
   docker service update --with-registry-auth \
     --image registry.todo-tips.com/envio-massa-backend:import-range \
     envio-massa-homologacao_backend_homologacao

   docker service update --with-registry-auth \
     --image registry.todo-tips.com/envio-massa-frontend-v2:import-range \
     envio-massa-homologacao_frontend_v2_homologacao
   ```
   Ordem prática: por o frontend (que envia o range) no ar **junto ou imediatamente
   antes** do backend que passa a exigi-lo, minimizando a janela em que um backend novo
   receberia requests de um frontend velho sem range.

4. **Smoke test (HTTP, sem expor segredos):**
   - Import com range válido grava em **todas** as linhas (200 OK).
   - Chamada sem `dt_inicial`/`dt_final` → `400` único.
   - Confirmar `1/1` réplicas em ambos os serviços (`docker service ls`).
   - Nenhum DDL aplicado (EX-01).

5. **Confirmar ausência de janela de incompatibilidade (FR-010):** backend exige range
   somente após o frontend que o envia estar no ar.

#### Rollback

```bash
docker service update --with-registry-auth --image <imagem-anterior-backend> \
  envio-massa-homologacao_backend_homologacao
docker service update --with-registry-auth --image <imagem-anterior-frontend_v2> \
  envio-massa-homologacao_frontend_v2_homologacao
```
Sem DDL → rollback é apenas troca de imagem; nenhum dado a reverter.

---

## Referências

- Spec: [`spec.md`](./spec.md) (FR-001 a FR-010, SC-1 a SC-5)
- Plano técnico: [`plan.md`](./plan.md) (§8 ordem de implementação, §9 deploy coordenado)
- Backlog: [`tasks.md`](./tasks.md) (FASE 4)
- Cenários de teste: [`quickstart.md`](./quickstart.md)
- Rito de produção: [`../../RITO-PRODUCAO.md`](../../RITO-PRODUCAO.md)

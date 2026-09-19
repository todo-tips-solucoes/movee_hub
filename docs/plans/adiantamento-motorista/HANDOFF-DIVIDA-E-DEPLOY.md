# Adiantamento pelo App — dívida conhecida e runbook de deploy

**Data:** 2026-09-18 · **Estado:** tudo mergeado na `main` (`a0efac3`), **nada deployado**.
**Para que serve:** retomar esta frente em sessão limpa, sem depender do histórico
da conversa que a produziu. Tudo aqui foi **medido**, não suposto; onde a
cobertura é parcial, está dito que é parcial.

---

## 1. O que está na `main`

| Commit | PR | O quê |
|---|---|---|
| `4abc418` | #182 | A feature completa |
| `f21d77c` | #183 | 7 ajustes da revisão de segurança sobre o código |
| `a0efac3` | #184 | CPF do entregador em campo próprio |

**Migrations desta entrega: `0066`–`0085`** (a `0073` e a `0075` pertencem a
outras correções da mesma série; a numeração é contínua). **Nenhuma foi aplicada
em produção** — só em stacks efêmeros `hub-test-*`, destruídos ao fim de cada
rodada.

### Gates, com números medidos na `main`

| Gate | Resultado |
|---|---|
| backend `npm test` | 1533/1533 |
| frontend_v2 `vitest` + `tsc --noEmit` | 718/718 · limpo |
| frontend_motorista `npm test` + `tsc --noEmit` | 97/97 · limpo |
| `hub-adiantamentos-integration.sh` (Postgres real) | 225/225 |
| fumaça ponta a ponta, sem simulação | hub 13/13 · app 13/13 |
| E2E de navegador | hub 10/10 · app 46/46 · push 17/17 |
| suíte agregada do hub | 12 ok / 2 not ok — **baseline herdada**, não regressão |
| driver RLS de importações | 15 PASS / 3 FAIL — **baseline herdada** |

---

## 2. Dívida conhecida

### 2.1 Repasse semanal (US6) — o item mais importante desta lista

Três achados da convergência ficaram **deliberadamente fora** (decisão do
operador, `dec-185`), porque têm a mesma raiz e exigem decisão de desenho, não
conserto pontual. Briefing próprio:
[`docs/plans/adiantamento-repasse-us6/BRIEFING.md`](../adiantamento-repasse-us6/BRIEFING.md).

| Item | Onde | O que acontece |
|---|---|---|
| **A1** | `0067:1811`, `:1925` | A janela de apuração do financeiro ignora o `apuracao_dia_inicio` configurado; a tela abre em `hoje`, então em **6 dos 7 dias** a janela sugerida não é a semana configurada |
| **A3** | `frontend_motorista/app/(app)/repasse/page.tsx:93-106` | O backend devolve `debitos` e a tela nunca renderiza — a soma exibida não fecha |
| **A4** | `hub-adiantamentos.js:1316` | `ApuracaoRepasseItem` é escrito (`0067:1997`) e **nunca lido**: `GET /repasse` e `/exportar` recalculam ao vivo mesmo depois do fechamento |

> ⚠️ **Consequência operacional, enquanto A1 não for resolvido:** não usar o
> botão **"fechar apuração"** em produção, ou usá-lo só com a data digitada e
> conferida à mão. `ApuracaoRepasse` é **imutável por trigger** (`0066:463`):
> fechar com a janela errada **não tem desfazer**.

### 2.2 Segurança — aceito e registrado

Da revisão independente sobre o código (a que gerou o PR #183). Estes foram
**avaliados e conscientemente não corrigidos**:

- **`hub_conta_bancaria_listar` não chama `hub_adiantamento_tem_permissao`.**
  Diferença **intencional**: a `detalhe` precisa do teste porque *decide* entre
  devolver dado mascarado ou completo; a `listar` devolve **sempre** mascarado e
  quem chega nela já passou pela permissão na rota e pela RLS. **Não gastar
  trabalho nisso.**
- **`POST /motorista/logout` sem autenticação** (`routes/motorista.js:520`).
  Deliberado e documentado no próprio arquivo: exigir sessão válida quebrava o
  caso mais comum de querer sair — a sessão já vencida. O risco real é logout
  forçado por site hostil: **incômodo, não perda de dado**.
- **`express.json()` global em 100 KB** (`server.js:220`). **Não subir**: está
  montado antes de toda autenticação, então aumentá-lo daria a qualquer um na
  internet o direito de fazer o processo parsear corpos grandes. O teto próprio
  de 5 MB já existe na rota do retorno, onde é preciso.
- **`next` com advisory crítica nos dois frontends.** Nos dois apps o controle
  de sessão está no proxy de rota, **não** em `middleware.ts`, então o bypass de
  middleware não tem o que burlar. **Agendar a atualização; não bloqueia deploy.**

### 2.3 Rastreabilidade — FASES 1 a 3

A convenção de evidência inline (`<!-- onda-NNN: ... -->`) só começou na FASE 4.
**48 itens `[x]` de implementação das FASES 1–3 não têm âncora verificável.**
Amostragem de 5 foi ao código e todos conferiam, mas a amostra é 5 de 48.

> **Ao reabrir qualquer coisa daquelas fases, tratá-las como NÃO auditáveis por
> leitura:** a verificação é reexecutar as suítes, não reler o `tasks.md`.

### 2.4 Cobertura parcial do alerta de documento

O alerta `DOCUMENTO_DIFERENTE` cobre:

- **titular PJ** — sempre (compara com o CNPJ do prestador);
- **titular PF** — só quando há CPF do entregador cadastrado
  (`EntregadorDocumento`, migration `0085`).

Sem CPF cadastrado **não há alerta** — ausência de sinal, nunca falso positivo.
A cobertura depende de quantos entregadores têm CPF: os da planilha de carga
(coluna `CPFEntregador`) mais os que o robô da EntreGô já enriqueceu.

### 2.5 Outras pendências herdadas

- **Suíte agregada do hub fecha 12 ok / 2 not ok** (`hub-admin-integration.sh` e
  `hub-faturamento-integration.sh`, asserção de "9 módulos" desatualizada desde
  a migration 0047). **Pré-existente, não é regressão desta entrega** — esta
  feature só afasta mais o número real do 9 fixo, ao somar o módulo
  `adiantamentos`.
- **Driver RLS de importações fecha 15 PASS / 3 FAIL** na `main`. Também
  pré-existente.

---

## 3. Runbook de deploy

> **Nada disto foi executado.** Produção segue exatamente como antes desta
> frente começar.

### 3.1 A ordem NÃO pode ser trocada

A `0083` faz `DROP + CREATE` em `hub_adiantamento_repasse` (o retorno da função
mudou, para devolver os totais do período). **Se o PostgREST não recarregar o
esquema entre a migration e o `service update`, a RPC responde com a assinatura
velha e os totais do repasse voltam a ser os da página** — que é justamente o
defeito corrigido.

```
1. backup          →  pg_dump -t das tabelas tocadas, ANTES de qualquer DDL
2. migrations      →  0066 … 0085, pelo migrate.sh (idempotente, registra em SchemaMigration)
3. reload PostgREST→  SIGUSR1 no container (ou NOTIFY pgrst, 'reload schema')
4. provar o reload →  conferir que hub_adiantamento_repasse devolve as colunas total_*
5. service update  →  backend, frontend_v2 e frontend_motorista
6. carga do estoque→  SELECT hub_entregador_documento_carregar_do_enriquecimento();
7. smoke           →  HTTP, sem expor segredo
8. prova de bundle →  achar no artefato servido uma string que só existe nesta entrega
```

> **Nunca `docker stack deploy`** — ele preserva env/labels/segredos do serviço.
> Sempre `docker service update --with-registry-auth --image`.

### 3.2 Rollback — as imagens que estão no ar HOJE

Medidas em 2026-09-18, antes de qualquer alteração:

| Serviço | Imagem atual (= alvo de rollback) |
|---|---|
| `envio-massa-homologacao_backend_homologacao` | `registry.todo-tips.com/envio-massa-backend:limites-avisos-45059b9` |
| `envio-massa-homologacao_frontend_v2_homologacao` | `registry.todo-tips.com/envio-massa-frontend-v2:limites-avisos-45059b9` |
| `envio-massa-homologacao_frontend_motorista_homologacao` | `registry.todo-tips.com/app-motorista-frontend:avisos-push-f10f5d4` |
| `envio-massa-homologacao_frontend_homologacao` | `registry.todo-tips.com/envio-massa-frontend:homologacao` — **não tocado** |

```bash
docker service update --with-registry-auth --image <imagem-acima> <serviço>
```

**As migrations são aditivas** (tabelas e funções novas; nenhuma coluna
removida, nenhum dado destruído), então o rollback de imagem é suficiente para
voltar o comportamento — o esquema novo simplesmente deixa de ser usado. Ainda
assim: `pg_dump -t` antes, porque é a regra e porque custa pouco.

### 3.3 Build

A imagem do backend sai do **`Dockerfile.hub`** (`node:20-alpine`) — **nunca**
do `Dockerfile` antigo, que é `node:14` e derrubaria o runtime sob o código do
hub. Conferir com `docker run --rm <tag> node --version` antes de entregar.

Antes de cada build: **`df -h /` ≥ 20 GB** e swap ativa. Cada imagem de backend
custa ~700 MB e o cache cresce sozinho; cinco builds num dia já encheram o disco
e derrubaram o banco de produção (2026-08-30).

---

## 4. O que só o operador pode fazer (não é código)

- [ ] **Valores iniciais de configuração** — uma versão completa de
      `AdiantamentoConfiguracao`: fonte da produção, categorias, dias e horários
      da janela, parâmetros da apuração do repasse, percentual e taxa.
- [ ] **Teste de upload na Transfeera** — gerar o `.xlsx` pelo fluxo real e
      subir no portal **só para validar o formato**, sem confirmar pagamento.
- [ ] **Conferência da planilha de contas × entregadores** — rodar a carga em
      `--simular` primeiro (relatório `0600`, fora do git, sem dado pessoal no
      terminal) e revisar as recusas antes de qualquer `--gravar`.
- [ ] **Procedimento de vínculo em massa em produção** — **não está coberto por
      nenhum artefato desta entrega**. Precisa ser definido.
- [ ] **Decidir sobre o botão "fechar apuração"** enquanto A1 não for resolvido
      (ver 2.1).

---

## 5. Como retomar em sessão limpa

1. Ler este documento e o
   [`BRIEFING.md` do repasse](../adiantamento-repasse-us6/BRIEFING.md).
2. `docs/specs/adiantamento-motorista/` tem a spec, o plano, os contratos e o
   `tasks.md` com 14 fases e evidência inline a partir da FASE 4.
3. **Antes de confiar em qualquer `[x]` das FASES 1–3, reexecutar as suítes.**
4. Estado da execução automatizada:
   `.claude/feature-00c-state/adiantamento-motorista/` (48 ondas, 192 decisões,
   2 bloqueios, ambos respondidos).

### Lições desta frente que valem para a próxima

- **Revisão adversarial independente sobre o diff pega o que auto-verificação
  não pega.** 48 ondas fecharam tudo verde; duas revisões com olhos frescos
  acharam 5 defeitos reais, um deles caminho de pagamento em duplicidade. Fazer
  isso **antes** de abrir o PR.
- **Controle negativo é obrigatório, e conferir QUAIS checks falham.** Numa das
  correções, 3 dos 4 checks novos passavam sem a correção — um deles era oco
  (a ordem do cenário o esvaziava). Um teste que passa nas duas execuções não
  está testando nada.
- **Ler a função inteira antes de classificar severidade.** Duas vezes nesta
  frente um achado foi superestimado por leitura de trecho: havia guarda
  algumas linhas abaixo, ou a definição citada era código morto substituído por
  migration posterior.

---

## 6. Imagens construídas e enviadas (2026-09-19)

Construídas a partir da `main` em `17a9bc6` e enviadas ao registry. **Ainda não
aplicadas** — imagem só vira produção no `docker service update`.

| Serviço | Imagem nova | Digest |
|---|---|---|
| backend | `registry.todo-tips.com/envio-massa-backend:adiantamento-17a9bc6` | `sha256:13ba00ff588d…` |
| frontend_v2 | `registry.todo-tips.com/envio-massa-frontend-v2:adiantamento-17a9bc6` | `sha256:be4ddbcef47a…` |
| frontend_motorista | `registry.todo-tips.com/app-motorista-frontend:adiantamento-17a9bc6` | `sha256:3dcf0557505e…` |

Provas feitas no build do backend (as duas obrigatórias do repositório):

- `docker run --rm <tag> node --version` → **v20.20.2**, igual ao que roda em
  produção (a imagem saiu do `Dockerfile.hub`, nunca do `Dockerfile` antigo, que
  é `node:14` e derrubaria o runtime sob o código do hub);
- conteúdo conferido dentro da imagem: 7 libs `adiantamento-*`, as 2 rotas, e o
  leitor `dividirCsvRfc4180` da última correção — ou seja, é o código de
  `17a9bc6`, não um build anterior.

> ⚠️ **Disco no limite.** Os três builds levaram `/` de 21 GB a 16 GB; voltou a
> 20 GB só depois de `docker builder prune -f` + `docker image prune -f` (as
> duas operações seguras — **nunca** `prune -a`, que apagaria as imagens de
> rollback). Antes de qualquer build futuro neste host, conferir `df -h /`.

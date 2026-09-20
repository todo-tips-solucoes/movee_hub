# Adiantamento pelo App — dívida conhecida e runbook de deploy

**Criado em:** 2026-09-18 · **Última atualização:** 2026-09-19.
**Estado:** 🚀 **EM PRODUÇÃO.** Três deploys executados — a feature (seção 7),
a barra inferior do app (seção 8) e o repasse semanal US6 (seção 9). `main` em
`3e865c9`, migrations `0066`–`0086` aplicadas.
**O que ainda falta é do operador, não de código:** ver seção 4 — enquanto o
módulo `adiantamentos` não for ligado para a entidade, a feature está no ar
mas **não em uso**.

**Para que serve:** retomar esta frente em sessão limpa, sem depender do histórico
da conversa que a produziu. Tudo aqui foi **medido**, não suposto; onde a
cobertura é parcial, está dito que é parcial. O resumo do que sobrou de dívida
está em [`BRIEFING-DIVIDA-RESTANTE.md`](./BRIEFING-DIVIDA-RESTANTE.md).

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

> ✅ **RESOLVIDO E EM PRODUÇÃO desde 2026-09-19 23h45** (PR #190, migration
> `0086`, imagens `repasse-us6-3e865c9`), com as três decisões de desenho
> tomadas pelo operador. Registro do deploy na **seção 9**.
>
> **O botão "fechar apuração" está LIBERADO.** Era o item A1 que o proibia, e
> a proteção agora vive no banco, no ponto da gravação irreversível: a
> gravação recusa (`PERIODO_DESALINHADO`) qualquer janela que não comece no
> dia configurado. **Em produção esse dia é SEGUNDA-FEIRA**
> (`apuracao_dia_inicio = 1`, medido no deploy).
>
> O texto abaixo é o registro do problema como foi medido — mantido porque
> explica por que cada escolha foi feita.

Três achados da convergência ficaram **deliberadamente fora** (decisão do
operador, `dec-185`), porque têm a mesma raiz e exigem decisão de desenho, não
conserto pontual. Briefing próprio:
[`docs/plans/adiantamento-repasse-us6/BRIEFING.md`](../adiantamento-repasse-us6/BRIEFING.md).

| Item | Onde | O que acontece |
|---|---|---|
| **A1** | `0067:1811`, `:1925` | A janela de apuração do financeiro ignora o `apuracao_dia_inicio` configurado; a tela abre em `hoje`, então em **6 dos 7 dias** a janela sugerida não é a semana configurada |
| **A3** | `frontend_motorista/app/(app)/repasse/page.tsx:93-106` | O backend devolve `debitos` e a tela nunca renderiza — a soma exibida não fecha |
| **A4** | `hub-adiantamentos.js:1316` | `ApuracaoRepasseItem` é escrito (`0067:1997`) e **nunca lido**: `GET /repasse` e `/exportar` recalculam ao vivo mesmo depois do fechamento |

> ~~⚠️ **Consequência operacional, enquanto A1 não for resolvido:** não usar o
> botão **"fechar apuração"** em produção~~ — **resolvido no deploy de
> 2026-09-19** (seção 9). `ApuracaoRepasse` continua **imutável por trigger**
> (`0066:463`) e fechar com a janela errada continua não tendo desfazer; o que
> mudou é que agora **não é mais possível fechar a janela errada** — a
> gravação recusa antes.

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

> ⚠️ **Este runbook JÁ FOI EXECUTADO** — três vezes (seções 7, 8 e 9). Fica
> aqui como receita para os próximos deploys desta frente, não como plano
> pendente. A regra da ordem abaixo continua valendo integralmente.

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

### 3.2 Rollback — as imagens que estavam no ar ANTES desta frente

> ⚠️ **Esta tabela é um retrato de 2026-09-18 e já não é o estado atual.** Para
> o alvo de rollback de hoje, ver a **última seção de deploy** do documento —
> hoje a **seção 9** (a mais recente sempre manda). Uma
> tabela de rollback desatualizada aponta para a imagem errada na hora errada.

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

---

## 7. Deploy EXECUTADO — 2026-09-19, 01h33–01h47 (sábado)

Janela escolhida pelo operador: madrugada de sábado, **fora** da janela de
adiantamento (09h–15h) e **fora** dos horários do robô de importação (11h, 13h,
14h). Executado pelo operador via terminal, passo a passo, com verificação do
agente entre cada passo.

> **Por que o operador executou, e não o agente:** a leitura do banco de
> produção foi recusada pela guarda do ambiente (`Production Reads`), o que é
> coerente com a cláusula do projeto — o agente entrega artefatos, o operador
> executa. O agente orquestrou e conferiu cada saída.

| # | Passo | Resultado |
|---|---|---|
| 1 | `pg_dump -t` das 7 tabelas pré-existentes tocadas | 32 KB em `/var/lib/backup-adiantamento-pre-20260919.sql` |
| 2 | Migrations `0066`–`0085` (20, cada uma em transação própria, com registro) | 20/20 OK |
| 3 | `SIGUSR1` no PostgREST de produção | `Schema cache loaded — 56 Relations, 118 Functions` |
| 4 | Prova do esquema | `repasse_totais=1 doc_table=1 gatilho=1 modulo=1 tabelas_novas=4` |
| 5 | `service update` backend | converged |
| 6 | `service update` frontend_v2 | converged |
| 7 | `service update` frontend_motorista | converged |
| 8 | Imagens no ar | as três em `adiantamento-17a9bc6` |
| 9 | Prova de código novo | API `/api/v1/adiantamentos/` → **401** (existe, pediu auth); painel e as 2 telas novas do app → **200** |
| 10 | Logs do backend (5 min) | nenhum erro |

O `frontend_homologacao` (v1 legado) **não foi tocado**, como planejado.

### Rollback, se ainda for preciso

```bash
docker service update --with-registry-auth --image registry.todo-tips.com/envio-massa-backend:limites-avisos-45059b9 envio-massa-homologacao_backend_homologacao
docker service update --with-registry-auth --image registry.todo-tips.com/envio-massa-frontend-v2:limites-avisos-45059b9 envio-massa-homologacao_frontend_v2_homologacao
docker service update --with-registry-auth --image registry.todo-tips.com/app-motorista-frontend:avisos-push-f10f5d4 envio-massa-homologacao_frontend_motorista_homologacao
```

As migrations são **aditivas** — voltar a imagem devolve o comportamento
anterior; o esquema novo apenas deixa de ser usado. O app do motorista é PWA:
depois do rollback o aparelho pode precisar de um recarregamento para voltar à
versão antiga, diferente dos outros dois, que são imediatos.

### O que AINDA NÃO foi feito (e por quê)

- **Carga do estoque de CPFs** —
  `SELECT hub_entregador_documento_carregar_do_enriquecimento();` **ainda não
  rodou**. A função exige um usuário com `adiantamentos.contas_revisar`, e o
  papel `financeiro` acabou de nascer na `0070`: **ninguém está atribuído a ele
  ainda**. Rodar depois de atribuir o papel. Não é bloqueante — o gatilho já
  cobre todo enriquecimento novo, e o CPF só importa quando houver cadastro de
  conta pelo app, que depende do módulo estar ligado.
- **Módulo `adiantamentos` ligado para a empresa** — a tabela `Modulo` tem o
  registro, mas ligar para a entidade é passo de configuração do operador.
  Enquanto não estiver ligado, o motorista vê as abas novas mas o recurso
  responde indisponível.
- **Valores iniciais de configuração**, teste de upload na Transfeera e carga de
  contas: ver seção 4.

---

## 8. Deploy EXECUTADO — 2026-09-19, 02h17–02h30 (sábado): barra inferior do app

Ajuste de UI pedido pelo operador depois de ver o app no ar: os 4 itens da
navegação inferior estavam pequenos e a barra, transparente demais. PR #188,
`main` em `f978c9a`. **Só o app do motorista foi tocado** — backend,
`frontend_v2` e o v1 legado seguem em `adiantamento-17a9bc6` e `homologacao`.

| | Antes | Depois |
|---|---|---|
| Fundo da barra | `.glass` (72% opaco) | `.glass` + `.glass-nav` (92%) |
| Rótulo | `0.68rem` (10,88px) | `0.8rem` (12,8px) |
| Ícone | 20px | 24px |
| 2º rótulo | "Adiantamento" | "Adiantar" |

**Imagem no ar:** `registry.todo-tips.com/app-motorista-frontend:barra-inferior-f978c9a`
(digest `sha256:a7b16da90162…`). Executado pelo agente sob os 5 gates, às 02h17
de sábado — fora da janela de adiantamento (09h–15h) e dos horários do robô
(11h, 13h, 14h). Serviço convergido, 1/1, sem erro nas tarefas.

### Por que "Adiantamento" virou "Adiantar"

A barra é uma grade de **4 colunas iguais**, então o rótulo mais longo limita
todos. A 12,8px, "Adiantamento" mede 91px contra uma coluna de 80px num
aparelho de 320px: o texto **se sobrepunha a "Notificações" em 11px**. Medido
no DOM via Playwright, não estimado no olho — a foto sozinha não mostraria
isso. Encurtar o rótulo é o que permitiu a fonte cheia em **toda** largura de
tela, sem degrau responsivo. A tela de destino continua se chamando
"Adiantamento" no próprio título.

Folga do texto dentro da sua coluna, depois do ajuste:

| Rótulo | 320px | 360px | 390px |
|---|---|---|---|
| Início | 48px | 58px | 66px |
| Adiantar | 28px | 38px | 46px |
| Notificações | −1px | 9px | 17px |
| Conta | 41px | 51px | 59px |

### Prova de que produção serve este código

HTTP 200 prova que o serviço subiu, não que subiu o código certo. O CSS servido
por produção é `c2cc3e7f0781a671.css` — **o mesmo hash do arquivo dentro da
imagem buildada** (o nome vem do conteúdo, então hash igual = bytes iguais).
Dentro dele: `.glass-nav{background:color-mix(in oklab,var(--card) 92%,transparent)}`
e `text-\[0\.8rem\]{font-size:.8rem}`; a fonte antiga `0.68rem` aparece **zero**
vezes. No chunk da navegação: `label:"Adiantar"` presente, `label:"Adiantamento"`
**zero** vezes.

### Rollback

```bash
docker service update --with-registry-auth \
  --image registry.todo-tips.com/app-motorista-frontend:adiantamento-17a9bc6 \
  envio-massa-homologacao_frontend_motorista_homologacao
```

O app é PWA: depois do rollback o aparelho pode precisar de um recarregamento
para voltar à versão antiga.

### O que ficou em aberto

- **"Notificações" passa 1px da coluna em 320px.** Sem colisão visual — a
  vizinha "Conta" tem 41px livres, e o que invade é espaço em branco, não outra
  palavra. Encurtá-la esbarraria em "Avisos", palavra que o app já usa para as
  mensagens push (`/avisos/[id]`). Decisão do operador.
- **Fallback de `color-mix`:** o compilador emite `.glass-nav{background:var(--card)}`
  antes da regra real. Em navegador sem `color-mix` a barra fica 100% opaca em
  vez de 92% — degradação segura, na direção pedida.

> ⚠️ **Disco: um build de frontend custou 5 GB.** `/` caiu de 20 GB para 15 GB
> com **um único** build do app motorista — os três builds da entrega anterior
> juntos custaram o mesmo. `docker builder prune -f` recuperou 790 MB e o host
> voltou a 20 GB, que é exatamente a linha de abortar. **Não cabe outro build
> aqui sem liberar espaço antes.** As ~35 GB que o Docker chama de
> "recuperáveis" são imagens **com tag** (rollbacks e histórico): o `prune`
> seguro não as toca, e apagá-las é decisão do operador, nunca do agente.

---

## 9. Deploy EXECUTADO — 2026-09-19, 23h27–23h45 (sábado): repasse semanal (US6)

PR #190 (`main` em `3e4120f`; build a partir de `3e865c9`, que inclui o
briefing da dívida restante). Fecha os 3 achados do briefing
`adiantamento-repasse-us6`. **Os três serviços foram atualizados**; o
`frontend_homologacao` (v1 legado) não foi tocado.

Executado pelo agente sob os 5 gates, com a **parte de banco rodada pelo
operador** (comando `!` no chat, saída conferida a cada passo). Janela: noite
de sábado, fora da janela de adiantamento (09h–15h) e dos horários do robô.

| Serviço | Imagem | Digest |
|---|---|---|
| backend | `envio-massa-backend:repasse-us6-3e865c9` | `sha256:7c495b131a3a…` |
| frontend_v2 | `envio-massa-frontend-v2:repasse-us6-3e865c9` | `sha256:5b15d355bbf9…` |
| frontend_motorista | `app-motorista-frontend:repasse-us6-3e865c9` | `sha256:67d837428060…` |

### A ordem, e por que ela importou

| # | Passo | Resultado |
|---|---|---|
| 1 | `pg_dump -t` de `ApuracaoRepasse` e `ApuracaoRepasseItem` | 8.383 bytes em `/var/lib/backup-repasse-us6-pre-202609192338.sql` |
| 2 | Migration `0086` em transação única | gatilho + 2 funções, medidos 0 antes e 1 depois |
| 3 | Registro em `SchemaMigration` | `INSERT 0 1` |
| 4 | `SIGUSR1` no PostgREST | `Schema cache loaded — 56 Relations, **120 Functions**` |
| 5 | `service update` backend | converged, 1/1, boot limpo |
| 6 | `service update` frontend_v2 | converged, 1/1 |
| 7 | `service update` frontend_motorista | converged, 1/1 |
| 8 | Smoke | API `/repasse` → **401** (existe, pede auth); painel e app → **200** |
| 9 | Logs do backend | **0** ocorrências de erro |

> 🔑 **A melhor prova do dia veio de graça, no passo 4: 120 funções.** O deploy
> anterior (seção 7) registrou **118**. A diferença de **+2** é exatamente o
> número de funções que a `0086` cria — uma prova aritmética de que o reload
> pegou a migration certa, e não "o schema cache foi recarregado" genérico.

### Prova de bundle

HTTP 200 prova que o serviço subiu, não que subiu o código certo. Técnica:
descobrir **dentro da imagem** qual arquivo contém o código novo e pedir
**esse arquivo exato** a produção.

- **app motorista** (`/_next/static/chunks/app/(app)/repasse/page-7d864e200e712904.js`):
  "Semana fechada", "Outros débitos" e "Valor a receber", todos presentes;
- **painel** (`/_next/static/chunks/0r0sed5td1gkp.js` e `0hn6g~ttvglgy.js`):
  a mensagem do desalinhamento, o campo `fechadoEm` e o `getDay` da fórmula de
  alinhamento;
- **contraprova**: a RPC `hub_adiantamento_repasse_congelado` aparece **0**
  vezes no cliente — correto, a escolha entre congelado e ao vivo é do
  servidor, nunca do navegador.

### O que mudou para o operador

- **A tela de repasse abre na semana configurada**, não em "hoje".
- ⚠️ **`apuracao_dia_inicio = 1` em produção — SEGUNDA-FEIRA.** O fechamento
  recusa qualquer janela que não comece numa segunda.
- **O botão "fechar apuração" está liberado.**
- Período fechado mostra o valor **congelado**, rotulado com a data do
  fechamento — na tela e no CSV exportado.
- O motorista passa a ver os **débitos** e a **última semana fechada** com o
  valor definitivo e a data do repasse.

### Rollback

```bash
docker service update --with-registry-auth --image registry.todo-tips.com/envio-massa-backend:adiantamento-17a9bc6 envio-massa-homologacao_backend_homologacao
docker service update --with-registry-auth --image registry.todo-tips.com/envio-massa-frontend-v2:adiantamento-17a9bc6 envio-massa-homologacao_frontend_v2_homologacao
docker service update --with-registry-auth --image registry.todo-tips.com/app-motorista-frontend:barra-inferior-f978c9a envio-massa-homologacao_frontend_motorista_homologacao
```

⚠️ **Voltar as imagens NÃO remove o gatilho.** Ele continuaria recusando janela
desalinhada, mas com o código antigo isso aparece como **500 genérico** em vez
de mensagem clara. Para reverter por completo:

```sql
DROP TRIGGER IF EXISTS apuracaorepasse_janela_chk ON "ApuracaoRepasse";
```

As duas funções novas podem ficar — ninguém as chama no código antigo.

### Tropeço do dia, registrado

O script de banco foi escrito com `-U postgres`, o padrão da imagem do
Postgres. **Aqui o papel tem o mesmo nome do banco: `chatmasterveloz`** (os
papéis que logam são `caluser` e `chatmasterveloz`). O Postgres recusou o
login no passo 0, antes do backup e de qualquer DDL — nada foi alterado, e a
conferência posterior provou (`0086` não registrada, gatilho ausente, última
migration `0085`). **Conferir `POSTGRES_USER` do container antes de escrever o
script**, em vez de assumir o padrão da imagem.

### Estado do host depois

Disco em **25 GB** livres (era 30 GB antes dos três builds). Os três builds
custaram ~7 GB. Nenhuma sobra de container ou imagem sem tag.

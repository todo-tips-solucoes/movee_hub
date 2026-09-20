# Briefing — o que sobrou da dívida do adiantamento (estado em 2026-09-19)

Prompt para sessão limpa. **Leia o `CLAUDE.md` do repositório antes de
qualquer coisa**: o ambiente chamado "homologação" É produção, o ciclo git é
cláusula pétrea e **autorização é por etapa**. Repositório é público —
nenhum dado pessoal real em código, teste, log ou documento.

Tudo aqui foi **medido**, não suposto. Onde a cobertura é parcial, está dito.

---

## 1. De onde isto vem

A feature `adiantamento-motorista` (adiantamento pelo app, dados bancários,
exportação Transfeera) foi entregue e está **em produção desde 2026-09-19**.
O registro completo — o que está na `main`, o runbook de deploy, os dois
deploys executados — vive em
[`HANDOFF-DIVIDA-E-DEPLOY.md`](./HANDOFF-DIVIDA-E-DEPLOY.md), que continua
sendo o documento principal. **Este aqui é só o resumo do que ficou em
aberto**, para quem for retomar.

| Entrega | PRs | Estado |
|---|---|---|
| A feature | #182, #183, #184 | em produção (`adiantamento-17a9bc6`) |
| Barra inferior do app | #188, #189 | em produção (`barra-inferior-f978c9a`) |
| Repasse semanal US6 | #190 | **na `main` (`3e4120f`); deploy no fim deste documento** |

---

## 2. O que sobrou, por ordem de valor

### 2.1 Dependências — o único item com risco de segurança real

- **`xlsx@0.18.5` tem 2 advisories HIGH sem correção publicada no npm**, e
  processa **arquivo vindo de terceiro** em `POST /lotes/:id/retorno`. O
  parser próprio (`dividirCsvRfc4180`, PR #183) já cobre o caminho CSV e
  valida o cabeçalho antes de processar; o `XLSX.read` que resta está em
  `lib/adiantamento-transfeera-xlsx.js:118`, onde o servidor relê o arquivo
  que **ele mesmo gerou** — exposição menor, mas não nula.
- **`next` com advisory crítica nos dois frontends.** Nos dois apps o
  controle de sessão está no proxy de rota, **não** em `middleware.ts`, então
  o bypass de middleware não tem o que burlar. **Agendar a atualização.**

**O que NÃO refazer:** `npm audit --omit=dev` no backend já foi rodado
(2026-09-18): 15 vulnerabilidades, 1 crítica (`tar`, pré-existente), 10 high.
A feature **não acrescentou nenhuma dependência nova** — o que ela mudou foi
a *exposição*, não o inventário.

### 2.2 Baselines de teste herdadas — o item mais barato

Duas suítes fecham com falha **na própria `main`**, e isso é anterior a toda
esta frente:

- **suíte agregada do hub: 12 ok / 2 not ok** — `hub-admin-integration.sh` e
  `hub-faturamento-integration.sh`, por uma asserção de "9 módulos"
  desatualizada desde a migration 0047. A feature só afastou mais o número
  real do 9 fixo, ao somar o módulo `adiantamentos`;
- **driver RLS de importações: 15 PASS / 3 FAIL** (RLS de
  `ImportacaoLinhaErro`, `obtido=-1`).

**Por que vale a pena:** enquanto houver falha de fundo, toda rodada exige
comparar com uma baseline de cabeça — e é exatamente aí que uma regressão
nova se esconde. O conserto é de asserção, não de produto.

⚠️ **Não "corrigir" contando módulos de novo com número fixo.** A asserção
tem de conferir o CONJUNTO de nomes esperado, não a contagem — foi o mesmo
erro que a tarefa 10.9 desta feature já corrigiu no driver de papéis.

### 2.3 Rótulo "Notificações" na barra do app — cosmético

Depois do PR #188 a barra inferior usa fonte de 12,8px. "Notificações" tem 12
caracteres e ultrapassa a coluna em **1px num aparelho de 320px**. Não há
colisão visual: a vizinha "Conta" tem 41px livres, e o que invade é espaço em
branco. Medido no DOM via Playwright, não estimado.

**O remédio é encurtar o rótulo** (foi o que resolveu "Adiantamento" →
"Adiantar"), mas "Avisos" esbarra na palavra que o app já usa para as
mensagens push (`/avisos/[id]`). **Decisão de produto, do operador.**

### 2.4 Cobertura parcial do alerta `DOCUMENTO_DIFERENTE` — não é código

O alerta cobre titular **PJ** sempre, e titular **PF** só quando há CPF do
entregador cadastrado (`EntregadorDocumento`, migration 0085). Sem CPF não há
alerta — **ausência de sinal, nunca falso positivo**.

A cobertura depende do estoque de CPFs, que depende de tarefas do operador
(ver §4). Nada a implementar.

### 2.5 Rastreabilidade das FASES 1–3 — dívida de processo

48 itens `[x]` de implementação sem âncora de evidência (a convenção inline só
começou na FASE 4). Amostragem de 5 foi ao código e todos conferiam, mas a
amostra é 5 de 48.

> **Ao reabrir qualquer coisa daquelas fases, tratá-las como NÃO auditáveis
> por leitura:** a verificação é reexecutar as suítes, não reler o `tasks.md`.

---

## 3. Como verificar, e com o que comparar

Baselines medidas na `main` em `3e4120f` (2026-09-19):

| Gate | Baseline |
|---|---|
| backend `npm test` | 1538/0 |
| painel `vitest` | 724/724 |
| app motorista `npm test` | 97/97 |
| `tsc --noEmit` (dois frontends) | limpo |
| `hub-adiantamentos-integration.sh` (Postgres real) | 231/0 |
| suíte agregada do hub | 12 ok / 2 not ok (**herdada**) |
| driver RLS de importações | 15 PASS / 3 FAIL (**herdada**) |

`npm run lint` **não roda** neste repositório: falta `eslint.config.js` desde
que o Next 16 removeu o `next lint`. Condição pré-existente — não é gate.

⚠️ **Controle negativo é obrigatório, e conferir QUAIS checks caem.** Um teste
que passa com e sem a correção não testa nada. Nesta frente isso já pegou um
teste oco (3 de 4 checks novos passavam sem a correção) e, no PR #190,
confirmou que 4 de 6 checks caem sem a migration — sendo os 2 que passam
exatamente as contraprovas.

⚠️ **Antes de afirmar que algo está no código, conferir se aquela definição
ainda é a viva.** Migrations posteriores fazem `DROP`+`CREATE`: a
`repasse_fechar` viva é a da **0082**, não a da 0067; a `repasse` e a
`repasse_motorista` vivas são as da **0083**. Errei isso duas vezes nesta
frente classificando por trecho.

⚠️ **`df -h /` ≥ 20 GB antes de qualquer build.** Um `docker build` de
frontend custou **5 GB** (medido em 2026-09-19). O acervo de imagens do host é
de **vários clientes** (`sara-hub`, `barbeariadavilla`, `sdr-whatsapp`,
`gold-webhook`…) e vive em `/var/lib/containerd`, não em `/var/lib/docker`.
**Nunca** `prune -a` nem `--volumes`: há volumes de banco de produção de
outros clientes neste host.

---

## 4. O que só o operador pode fazer (não é código, e ainda pende)

1. **Ligar o módulo `adiantamentos`** para a entidade. **Enquanto isso não
   acontecer, o motorista vê as abas novas mas o recurso responde
   indisponível** — ou seja, a feature está em produção mas não em uso.
2. **Atribuir o papel `financeiro`** a um usuário (nasceu na migration 0070,
   ninguém está nele).
3. **Rodar `SELECT hub_entregador_documento_carregar_do_enriquecimento();`** —
   depende do passo 2, porque a função exige `adiantamentos.contas_revisar`.
4. **Definir os valores iniciais de configuração**, testar o upload na
   Transfeera **sem confirmar pagamento**, e rodar a carga de contas com
   `--simular` primeiro.
5. **Conferir o `apuracao_dia_inicio` configurado antes de usar o botão
   "fechar apuração" pela primeira vez** — depois do PR #190 a gravação
   *recusa* uma janela que não comece nesse dia, com erro explícito
   (`PERIODO_DESALINHADO`), em vez de congelar a janela errada.

---

## 5. Onde cada coisa está registrada

- **Estado geral, runbook e deploys:** [`HANDOFF-DIVIDA-E-DEPLOY.md`](./HANDOFF-DIVIDA-E-DEPLOY.md)
- **Repasse semanal US6 (resolvido):** [`../adiantamento-repasse-us6/BRIEFING.md`](../adiantamento-repasse-us6/BRIEFING.md)
- **Spec, plano e tarefas da feature:** `docs/specs/adiantamento-motorista/`
- **Estado da execução automatizada:** `.claude/feature-00c-state/adiantamento-motorista/`
  (48 ondas, 192 decisões, 2 bloqueios — ambos respondidos)

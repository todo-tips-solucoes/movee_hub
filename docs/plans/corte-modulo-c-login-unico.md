# Plano — Corte controlado do Módulo C (login único do grupo)

> **Como usar:** briefing para rodar numa **sessão fresca** do Claude Code. Abra na raiz do
> projeto, cole o "Prompt de retomada" (final) e resolva a estratégia de corte COM o operador
> na clarify ANTES de implementar. Acompanhe o progresso pelo painel cstk.
>
> **Pré-requisito:** a feature [[grupo-unificado-filiais]] (Módulo C — login único) já está
> **mergeada na `main`** (PR #8, `bfb44501`) e **deployada em homologação**, validada E2E.
> Este plano trata APENAS do **corte/cutover do Módulo C para produção** — não reimplementa
> a feature.

---

## 1. Objetivo

O Módulo C bloqueia o login de qualquer empresa-filial (id_grupo setado e não-pai) com
**HTTP 403 "Acesse o painel usando o login do grupo"**. Hoje esse bloqueio é **global e
incondicional**. Levá-lo para **produção** bloquearia de uma só vez todas as filiais que
hoje têm login próprio — um breaking change para usuários reais.

O objetivo é implementar um **corte controlado** (cutover) que permita ativar o login único
**por grupo** e/ou com **janela/transição**, sem trancar usuários de surpresa.

---

## 2. Problema concreto (estado observado em homologação)

- **Grupo 1 = D&G EXPRESS** (pai `id=2`, `admin@dg.com.br`) com **5 filiais reais que logam
  hoje sozinhas**: ids **3, 4, 5, 7, 8** (São Bernardo, Campinas, Santo André, BH, Curitiba),
  todas com email/senha próprios.
- **Grupo 2 = Movee** (pai `id=6`) — após a limpeza do seed `006b`, só tem a matriz (sem
  filiais reais). O login único já pode ser ativado para a Movee sem impacto.
- Em **produção** os dados podem diferir — **a primeira tarefa é levantar, no banco de
  produção, quais grupos existem e quais filiais (id_grupo setado, não-pai) têm senha
  cadastrada** (essas são as que o corte vai afetar). Ver memória [[feature-config-ui-tenant]]
  ("Grupo de CNPJs D&G ids 2/3/4/5/7/8").

**Risco central:** se o corte for seco em produção, as 5 filiais D&G perdem acesso até
migrarem para o login do pai (`admin@dg.com.br`). É preciso decidir COMO e QUANDO.

---

## 3. Pontos de código (estado atual, pós-merge)

- **`app_homologacao/backend/server.js:216`** — guarda de filial no `POST /login`:
  `if (idGrupo !== null && isGrupoPai === false) { ...log...; return 403 }`.
- **`app_homologacao/backend/server.js:306`** — guarda equivalente no `POST /token/refresh`
  (OWASP LOW-004) — **qualquer mudança de estratégia deve ser aplicada NOS DOIS pontos**,
  senão um refreshToken antigo de filial fura o corte.
- **Tabela `Grupo`** (`docs/sql/001-config-ui-tenant-schema.sql`): `id, nome, id_empresa_pai,
  created_at, updated_at`. Não há flag de ativação — caberia adicionar uma.
- Backend roda **`node:14`**; rate limiting via **`express-rate-limit@6.11.2`** (NÃO subir p/ 7/8).
- Deploy backend: **`docker service update --image <digest>`** (preserva env/labels; NÃO usar
  `docker stack deploy` — apaga as 6 envs; ver nota em `app_homologacao/docker-compose.yml`).

---

## 4. Opções de estratégia de corte (decidir na CLARIFY — NÃO deduzir)

| # | Estratégia | Como | Prós | Contras |
|---|-----------|------|------|---------|
| **1 (recomendada)** | **Flag de ativação por grupo** | DDL `007`: `ALTER TABLE "Grupo" ADD COLUMN login_unico_ativo boolean NOT NULL DEFAULT false`. As guardas (216/306) só bloqueiam se o grupo da filial tiver `login_unico_ativo=true`. Operador ativa grupo a grupo. | Granular, **reversível**, auditável; ativa Movee já, D&G quando comunicar; sem big-bang | Requer DDL + 1 query a mais no login (cacheável) |
| 2 | Período de transição (dupla operação) | Filial loga normalmente mas recebe banner/aviso "migre para o login do grupo"; após data X, bloqueia | Sem ruptura | Mais complexo; exige UI + data de corte |
| 3 | Corte seco com aviso prévio | Comunica as 5 filiais D&G, define janela; no deploy de produção o bloqueio fica global (como já está) | Sem código novo | Abrupto; depende 100% da comunicação |
| 4 | Allowlist temporária | Lista de ids/emails que ainda podem logar durante a transição | Simples | Gambiarra; precisa limpar depois |

**Recomendação:** Opção 1 (flag por grupo) — é o cutover mais seguro e reversível, e encaixa
no modelo multi-tenant (Princípio II da constitution).

---

## 5. Ambiguidades para resolver COM o operador (CLARIFY — NÃO deduzir)

1. **Estratégia** (§4): qual das 4? (recomendo a 1).
2. **Ativação inicial**: ao subir para produção, o login único nasce **ativo para quais
   grupos**? (ex.: Movee=ativo, D&G=inativo até comunicar). Default da coluna = `false`
   (ninguém é bloqueado até o operador ativar) — confirmar.
3. **Comunicação/migração das filiais D&G**: quem avisa os usuários das 5 filiais? Eles têm
   a senha do pai `admin@dg.com.br`? (sem isso, ao ativar, ficam sem acesso). É processo, não código.
4. **Produção = mesmo schema/levantamento**: confirmar no banco de produção quais grupos e
   filiais-com-senha existem (pode haver outros além de D&G/Movee).
5. **Reversibilidade/rollback**: a flag deve poder ser desligada a quente (sem redeploy)?
   (com a Opção 1, sim — basta `UPDATE Grupo SET login_unico_ativo=false`).

---

## 6. Validação (E2E em homologação antes de produção)

Reaplicar o padrão de E2E já usado (ver `docs/specs/grupo-unificado-filiais/e2e-evidence.md`):
- Com `login_unico_ativo=false` no grupo: filial **loga normal** (200) — corte inativo.
- Com `login_unico_ativo=true`: filial → **403**; pai → **200**; refresh de filial → **403**.
- Toggle a quente (UPDATE) reflete sem redeploy.
- Pai continua acessando as filiais via seletor (`resolveScope`/[[feature-movimento-por-filial]]).
- Rate limiting intacto. Anti-enumeração intacto (senha errada → 400 genérico).
- **Não exercitar o Módulo A** via HTTP (dispara envio real na produção da Movee).

## 7. Governança
- **owasp-security obrigatório** (mexe em auth). Conferir que a flag não reintroduz
  enumeração (a checagem de grupo da filial vem APÓS senha válida, como no HIGH-001).
- DDL `007-*` **aplicada pelo operador** (não pelo agente).
- **Deploy em produção e a ativação por grupo SÓ com autorização explícita do operador.**
- Commit/push/merge só com autorização. Mensagem de commit termina com
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

---

## Prompt de retomada (colar na sessão fresca)

```
Trate o CORTE CONTROLADO do Módulo C (login único do grupo) da feature grupo-unificado-filiais,
que já está MERGEADA na main (PR #8, bfb44501) e deployada em homologação. NÃO reimplemente a
feature — o objetivo é só o cutover seguro para produção.

LEIA PRIMEIRO: docs/plans/corte-modulo-c-login-unico.md (este plano, tem o mapa do código e as
opções), docs/specs/grupo-unificado-filiais/owasp-review.md e .../e2e-evidence.md, e as memórias
[[feature-grupo-unificado-filiais]] e [[feature-movimento-por-filial]].

PROBLEMA: a guarda de filial no POST /login (app_homologacao/backend/server.js:216) e no
/token/refresh (server.js:306) bloqueia QUALQUER filial (403 "Acesse o painel usando o login do
grupo") de forma global e incondicional. Em produção isso bloquearia de uma vez as 5 filiais D&G
reais (grupo 1, pai id=2): ids 3,4,5,7,8 — que hoje logam sozinhas. O grupo Movee (2) já não tem
filiais (seed limpo via 006b).

NA CLARIFY, resolva COMIGO (não deduza): (1) qual estratégia de corte — recomendo flag por grupo
`Grupo.login_unico_ativo boolean default false` (DDL 007), com a guarda 216/306 só bloqueando se
o grupo da filial tiver a flag ativa; (2) quais grupos nascem ativos em produção; (3) comunicação/
senha do pai para as filiais D&G; (4) levantar no banco de PRODUÇÃO quais grupos/filiais-com-senha
existem; (5) se o toggle deve ser a quente (sem redeploy).

Implemente a estratégia escolhida nos DOIS pontos (login + refresh), gere a DDL 007 (aplicada por
mim), rode owasp-security e valide E2E em homologação (flag off = filial loga 200; flag on = filial
403, pai 200, refresh filial 403; toggle a quente). Backend roda node:14 — NÃO subir o
express-rate-limit além de 6.11.2. Deploy: docker service update --image (NÃO docker stack deploy).
Commit/push/merge/deploy e a ativação por grupo SÓ com a minha autorização explícita.
```

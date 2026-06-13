# Continuar — Setup do cstk + ngrok (movee_hub)

> Documento de retomada. Depois de reiniciar o Claude Code **neste diretório**
> (`/var/lib/envioMassa_homologacao`), cole o "Prompt de retomada" do final para
> o agente continuar de onde paramos.

## Contexto (onde paramos)

- Repo `movee_hub` já está no GitHub (`todo-tips-solucoes/movee_hub`), branch `main`, com READMEs (raiz, backend, frontend_v2). Credencial de git já salva em `~/.git-credentials` (push funciona direto).
- Objetivo: usar o **cstk (Claude Code Toolkit)** para implementar mudanças no repo via pipeline **Spec-Driven Development (SDD)**, e expor o painel `cstk serve` para fora da VPS via **ngrok**.
- Ambiente: Node v22 / npm 10 presentes. Projeto é **Node/Express + Next.js (TS)** → usar perfis `sdd` + `complementary` (as skills `language-go` NÃO se aplicam).

## Estado das tarefas

| # | Tarefa | Status |
|---|--------|--------|
| 1 | Instalar binário `cstk` (`install.sh`) | ✅ FEITO — cstk **v5.10.0** em `~/.local/bin/cstk` |
| 2 | `cstk install` (sdd) + `advisor bugfix owasp-security commit` | ✅ FEITO — 16 skills `clean`; `cstk doctor` = 28 OK, 0 problemas |
| 3 | Instalar ngrok | ✅ FEITO — **ngrok 3.39.6** em `/usr/local/bin/ngrok` |
| 3b | `ngrok config add-authtoken <TOKEN>` | ✅ FEITO — config válida |
| 3c | `build-essential` (make/gcc) p/ o painel compilar | ✅ FEITO |
| 5 | Subir `cstk serve` + túnel ngrok com basic-auth | ✅ VALIDADO — painel acessível via ngrok (IPv4 + basic-auth) |
| 4 | Reiniciar o Claude Code (skills/commands só aparecem após restart) | ⬜ **próximo** |
| 6 | Rodar o orquestrador `/feature-00c` para a 1ª mudança | ⬜ próxima sessão |

> Skills/commands instalados (todos `clean`, v5.10.0): briefing, constitution, specify,
> clarify, plan, checklist, create-tasks, analyze, execute-task, review-task, advisor,
> bugfix, owasp-security, commit, model-selector, agente-00c-runtime — mais os slash
> commands `/feature-00c`, `/agente-00c` (+ `-resume`/`-abort`).
> O PATH `~/.local/bin` já está ativo. Falta só o ngrok (Passo 3) — exige seu authtoken.

---

## Ciclos concluídos (changelog)

> Histórico completo e detalhes técnicos ficam na **memória do projeto** (`MEMORY.md` + arquivos
> `plano-*.md` / `feature-*.md`). Resumo dos ciclos rodados nesta VPS via cstk:

| Data | Ciclo | Como | Status |
|------|-------|------|--------|
| — | App Motorista PWA, config-ui-tenant, cadastro-filiais, movimento-por-filial, grupo-unificado | `/feature-00c` (SDD) | no ar em produção |
| 2026-06-12/13 | Gorjeta motorista, import-range-datas | `/feature-00c` | deployados em produção |
| **2026-06-13** | **Responsividade do painel `app.moveelog.com.br` (frontend_v2)** | **`/ui-ux-pro-max`, 3 fases (R001-R012), 1 PR por fase** | **✅ 3 fases deployadas + validadas no celular** |

### Ciclo responsividade do painel (2026-06-13) — referência

- **Plano:** `docs/plans/melhoria-responsividade-painel-moveelog.md` (PR #30, mergeado). Polish de
  responsividade mobile+desktop **preservando** o design system EntreGô 2.0 (NÃO re-skin).
- **Execução:** skill `/ui-ux-pro-max`, **uma fase por branch/PR**, base `main`, worktrees isolados:
  - Fase 1 (mobile crítico, R001-R005) -> **PR #31** + hotfix **#34** (action-bar).
  - Fase 2 (densidade, R006-R008+R012) -> **PR #32** (+ fix stats-cards na própria branch).
  - Fase 3 (desktop wide + polish, R009-R011) -> **PR #33**.
- **Deploy (rito de produção; o operador autorizou o agente a executar nesta sessão):** swap
  temporário 4G + `DOCKER_BUILDKIT=0 docker build --memory=2g`, `docker push`, `docker service
  update --with-registry-auth --image ... envio-massa-homologacao_frontend_v2_homologacao`.
  Registry `registry.todo-tips.com/envio-massa-frontend-v2`. Imagem final em prod:
  `:resp-painel-fase3`. **Sem DDL.** Smoke `/login`+`/register` = 200. `swapoff` ao final.
  Swarm 18 serviços 1/1 o tempo todo — **sem starvation**.
- **Gotcha (custou 2 builds):** comentário JSX `{/* */}` logo após `return (` antes do
  elemento/fragment raiz quebra o build turbopack ("Expected ',', got 'ident'"). Usar `//` acima
  do `return` ou pôr o comentário como FILHO. **Grepar `return ($` + `{/*` ANTES de cada build.**
- **Limpeza:** worktrees + branches (locais e remotas) das 3 fases e do hotfix removidas após validação.

> ⚠️ `gh` (GitHub CLI) NÃO está instalado nesta VPS — abrir/mergear PR via API REST do GitHub
> usando o token de `~/.git-credentials` (helper Python + `urllib`).

---

## Comandos (rode com o prefixo `!` no Claude Code)

### Passo 1 — Instalar cstk
```
curl -fsSL https://github.com/JotJunior/cstk/releases/latest/download/install.sh | sh
cstk --version
```

### Passo 2 — Instalar skills
```
cstk install
cstk install advisor bugfix owasp-security commit
cstk list
cstk doctor
```

### Passo 3 — Instalar e autenticar ngrok
```
curl -sSL https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-linux-amd64.tgz | tar xz -C /usr/local/bin
ngrok --version
ngrok config add-authtoken SEU_AUTHTOKEN     # https://dashboard.ngrok.com/get-started/your-authtoken
```

### Passo 4 — Reiniciar o Claude Code
As skills/commands do cstk só ficam visíveis após reiniciar a sessão.
1. Saia: `/exit` (ou Ctrl+C 2x / Ctrl+D).
2. Relance no mesmo diretório mantendo o histórico + carregando as skills:
   ```
   claude --continue
   ```
   (ou só `claude` para sessão limpa — o contexto está na memória e neste arquivo).
3. Confirme: digite `/` e veja se aparece `/feature-00c` (ou peça ao agente para listar).

> ✅ **Painel + túnel já estão no ar e DESTACADOS** (sobrevivem ao restart):
> - Painel `cstk serve` → `127.0.0.1:5173` (processo reparentado ao init).
> - ngrok → URL pública atual: **https://overprosperously-geomorphic-mathias.ngrok-free.dev**
>   (login `admin` / `Garantia.1182`). A URL pode mudar se o ngrok cair e subir de novo.
> - Para subir tudo de novo a qualquer momento (idempotente): `bash /root/cstk-up.sh`
>   (script fora do repo porque contém a senha do basic-auth).
> - Logs: `/tmp/cstk-serve.log` e `/tmp/ngrok.log`.

### Passo 5 — Subir o painel + túnel COM BASIC-AUTH (na próxima sessão)
O `cstk serve` sobe o painel em `http://127.0.0.1:5173`. O ngrok expõe essa porta —
**sempre com basic-auth** para que o link público não fique aberto a qualquer um:
```
cstk serve                                                  # deixa rodando (processo vivo)
ngrok http --basic-auth 'admin:UMA_SENHA_FORTE' 127.0.0.1:5173   # IPv4 explícito!
```
- ⚠️ **Use `127.0.0.1:5173`, NÃO `5173`/`localhost`**: o painel escuta só em IPv4; com
  `localhost` o ngrok tenta IPv6 (`::1`) e retorna **502 Bad Gateway**. Apontar para
  `127.0.0.1` resolve.
- Formato: `--basic-auth 'usuario:senha'` (a **senha precisa ter no mínimo 8 caracteres**).
  A flag `--basic-auth` aparece como "deprecated" mas **funciona** (testado: 401 sem senha,
  200 com senha).
- Ao abrir a URL pública, o navegador pede usuário/senha antes de mostrar o painel.
- A URL do ngrok-free **muda a cada execução**. Para fixar, reserve 1 domínio estático grátis
  em https://dashboard.ngrok.com/domains e use `--url https://seu-dominio.ngrok-free.app`.
- Pré-requisito já resolvido nesta VPS: `build-essential` (make/gcc) foi instalado para o
  painel compilar o módulo nativo `better-sqlite3`.

> Dica: peça ao agente para subir ambos em background e te devolver a URL pública do ngrok
> (ele lê de `http://127.0.0.1:4040/api/tunnels`). Escolha a senha você — **não** deixe a senha
> em texto no chat se quiser evitar exposição; pode passá-la direto no comando `!`.
> Derrube o túnel quando não estiver usando (`kill` no processo do ngrok ou Ctrl+C).

---

## Pipeline SDD — como o agente "implementa tudo"

### Opção A — Orquestrador autônomo (implementação total por agente) ✅ recomendado
Depois de ter **briefing + constitution** ratificados uma vez, use o slash command:
```
/feature-00c "<descrição curta da mudança>" [nome-curto]
```
Ele roda o pipeline inteiro encadeado e autônomo
(specify→clarify→plan→checklist→create-tasks→execute-task→review-task), criando estado
em `.claude/feature-00c-state/<nome-curto>/`. É a forma mais próxima de "faz tudo sozinho".
> Para um projeto inteiro (mais amplo, por ondas) existe `/agente-00c "<descrição>"`.
> Há `/feature-00c-resume` e `/feature-00c-abort` para retomar/abortar.

### Opção B — Passo a passo manual (mais controle)
Invoque as skills uma a uma (gatilho → o que produz):
1. `constitution` (uma vez) → `docs/constitution.md` (princípios do projeto)
2. `specify: <descrição da mudança>` → `docs/specs/{feature}/spec.md`
3. `clarify` → resolve ambiguidades (até 5 perguntas)
4. `plan` → `plan.md` + `research.md` + `data-model.md`
5. `criar tarefas` (create-tasks) → backlog com IDs e dependências
6. `analyze` → checagem de consistência (read-only)
7. `executar tarefa` (execute-task) → **implementa o código** (workflow de 9 etapas)
8. `revisar tarefas` (review-task) → relatório de status
9. `commit` → conventional commit + push

Para mudanças pequenas em código existente, pode começar direto no `specify`.
**Pré-requisito do `/feature-00c`:** ter rodado `constitution` (e idealmente `briefing`) antes.

**Boas práticas:**
- Crie uma branch antes de implementar: `git checkout -b feature/<nome>` (não implemente na `main`).
- Os `.env` já estão protegidos pelo `.gitignore` — não devem ser commitados.
- `execute-task` em features grandes consome muitos tokens: rode tarefa a tarefa e revise.

---

## PROMPT DE RETOMADA (cole no Claude em SESSÃO FRESCA — `claude` sem --continue)

> IMPORTANTE: reinicie com `claude` LIMPO (não `--continue`). O `--continue` não
> re-escaneia `~/.claude/skills/`, então `/feature-00c` e as skills do cstk não ficam
> invocáveis. Sessão fresca registra tudo. Contexto está na memória + neste arquivo.

```
Retomando no repo movee_hub (/var/lib/envioMassa_homologacao). Leia CONTINUAR-CSTK.md.

Estado: cstk v5.10.0 instalado (16 skills, doctor OK); ngrok instalado/autenticado;
painel cstk serve + túnel ngrok já no ar (suba com `bash /root/cstk-up.sh` se caíram).
Constituição criada em docs/constitution.md (branch chore/sdd-constitution).

Vamos implementar a 1ª feature: APP MOTORISTA (PWA) — consulta de valor de NF do
movimento aberto + upload/validação de XML de NFS-e. O brief COMPLETO e a recomendação
de stack estão em docs/specs/app-motorista-nfse/brief.md (branch feature/app-motorista-nfse).

Faça:
1. Confirme que as skills/commands do cstk apareceram (ex.: /feature-00c, specify, plan).
2. Confirme o painel/túnel no ar (senão `bash /root/cstk-up.sh`) e me dê a URL pública.
3. Leia docs/constitution.md e docs/specs/app-motorista-nfse/brief.md.
4. Conduza o pipeline SDD para esta feature: comece pelo `specify` usando o brief, depois
   `/clarify` (resolva as Perguntas em Aberto do brief comigo), `plan`, `create-tasks` e
   então `/feature-00c` (ou `execute-task`) para implementar. Confirme a stack comigo antes
   de codar.
```

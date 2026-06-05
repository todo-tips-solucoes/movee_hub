# Prompt — Feature: Configuração de UI por tenant (white-label) + Grupo de CNPJs

> Cole este prompt numa sessão fresca do Claude Code para iniciar a feature.
> Antes de implementar, **confirme as 4 decisões em aberto** listadas no fim.

---

## Contexto do projeto

Você é o Claude Code atuando no repo **movee_hub** (homologação), em
`/var/lib/envioMassa_homologacao` (use worktree para alterações).
Remote: `github.com/todo-tips-solucoes/movee_hub` (credential store já configurado;
`gh` NÃO está instalado — use a GitHub API com token via `git credential fill`).
Responda sempre em **português**. Conventional commits, terminando com
`Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

### Arquitetura atual (fatos verificados)
- **`app_homologacao/frontend_v2`** — painel **EnvioMassa** (Next.js 16 + React 19 +
  Tailwind 4 + shadcn + next-themes). Login **email+senha**, dados escopados por
  `id_empresa`. Domínio: `envmasshomologacao.todo-tips.com`. **Não tem tela de settings.**
- **`app_homologacao/frontend_motorista`** — **PWA compartilhado** do motorista
  (Next 16 + React 19 + Tailwind 4 + Serwist), login por **cnpj_prestador**.
  Domínio: `appmotorista.todo-tips.com`. Um motorista vê movimentos de **várias
  empresas (tomadores)**. Design system Movee já implementado em `app/globals.css`
  (azul #1F63EB, gradiente quente #FFC020→#FF7A18→#F23A20, menta #16A375).
- **Backend** `app_homologacao/backend` — Express **Node 14** (sem globals de Node 18+),
  JWT cookie httpOnly com separação de audiência (`aud: 'empresa'` vs `aud: 'motorista'`).
  Acessa **PostgREST** interno (porta 3000, não publicada) via `POSTGREST_URL`.
- **Banco**: tabela `Empresa` (id PK, cnpj_prestador, email, senha, nome, +
  endereco/numero/cep/email_nota/observacao). Tabela `Motorista` (cnpj_prestador UNIQUE).
  `EnvioMassa.id_empresa → Empresa.id`. **NÃO existe** relação matriz/filial nem
  white-label hoje — cores são hardcoded em CSS vars.

### Pegadinhas de ambiente (CRÍTICO — não pule)
- Deploy é **Docker Swarm**, NÃO compose. **NUNCA** `docker stack deploy` do
  docker-compose.yml completo (interpola `${VARS}` do shell e apaga secrets do backend
  FASTAPI_VALIDATION_TOKEN / N8N_API_TOKEN). Suba backend com
  `docker service update --image ... --force` (preserva os 7 envs).
- Frontends: `docker build` → `docker push registry.todo-tips.com/...` →
  `docker service update --with-registry-auth --force --image ...@sha256:<digest> <serviço>`.
  Serviços: `envio-massa-homologacao_frontend_v2_homologacao`,
  `envio-massa-homologacao_frontend_motorista_homologacao`. Sempre **rode `next build`
  antes** do ciclo Docker e **valide no ar** (curl HTTP 200 + task Running) reportando o digest.
- Recarregar schema do PostgREST após DDL:
  `docker kill -s SIGUSR1 $(docker ps -q -f name=pgadmin_postgrest)`.
- O **classifier** bloqueia: push no registry / stack deploy / docker exec-inspect em prod /
  leitura de secrets / acesso ao banco de prod. Quando bloqueado, **entregue ao usuário um
  comando pronto** para ele rodar com prefixo `!`. Migrações SQL: entregue o `.sql` para o
  usuário aplicar (ele roda e recarrega o schema).
- `.claude/` é gitignored. Use `$CLAUDE_JOB_DIR/tmp` para arquivos temporários. Mensagens
  de commit com aspas/caracteres especiais: escreva em arquivo e use `git commit -F`.

---

## Objetivo da feature (2 partes ligadas)

### Parte A — Configuração de UI por tenant (white-label dinâmico)
Criar uma **tela de configurações** no `frontend_v2` (ex.: `/dashboard/configuracoes/aparencia`)
onde o tenant define sua identidade visual: **logo, cor primária, cor de destaque/gradiente,
nome exibido** (e o que mais for decidido no escopo). Essa configuração deve valer:
- no **próprio painel EnvioMassa** (`frontend_v2`); e
- no **AppMotorista** (`frontend_motorista`) — ver Decisão #1 sobre "marca de quem".

Trabalho envolvido:
- **Banco**: nova tabela de branding por tenant (ex.: `tenant_branding` / `empresa_branding`)
  com `id_empresa` (ou `id_grupo`, ver Parte B), `logo_url`, `cor_primaria`,
  `cor_destaque`/gradiente, `nome_exibicao`, timestamps. DDL `IF NOT EXISTS` + `NOTIFY pgrst`.
- **Backend**: endpoints escopados por tenant — `GET/PUT /empresa/branding` (aud empresa) e um
  `GET` público/leve para o PWA resolver a marca a exibir (ver Decisão #1). Upload de logo:
  definir destino (storage/objeto vs base64 em coluna) — decidir no plano.
- **Frontend**: refatorar `globals.css` dos dois fronts para **tokens dinâmicos** (CSS custom
  properties sobrescritas em runtime a partir da config do tenant, em vez de hardcoded);
  form com **preview ao vivo**; provider que injeta as variáveis no `<html>`/`:root`.
  Respeitar dark/light mode existente.

### Parte B — Grupo de CNPJs (um CNPJ "pai" englobando vários filhos)
Criar a relação **grupo/holding** que hoje não existe, para que um CNPJ pai agregue múltiplos
CNPJs filhos, e a **branding (Parte A) seja definida no pai e herde para os filhos**.

> **Caso real para o agrupamento — D&G:** a tabela `Empresa` **já contém vários CNPJs** que
> pertencem à mesma empresa (**D&G**) e que devem ser **agrupados sob um único tenant**.
> Portanto a feature não é só estrutural: precisa **migrar os dados existentes** — identificar
> os CNPJs da D&G já cadastrados, criar/eleger o tenant (grupo) D&G e **vincular esses CNPJs ao
> grupo**. Primeiro passo na sessão: consultar a tabela `Empresa` para listar os CNPJs da D&G
> (entregar a query/`.sql` para o usuário rodar, já que o classifier bloqueia acesso ao banco)
> e validar com ele quais CNPJs entram no grupo antes da migração.
>
> **Query de levantamento dos CNPJs da D&G** (rodar primeiro; tolerante a `nome`/`nome_empresa`
> e a variações de grafia — D&G, D & G, DG). Ajuste os nomes de coluna conforme o schema real:
>
> ```sql
> -- Lista candidatos da D&G já cadastrados em Empresa.
> -- Confirme com o usuário quais entram no grupo antes de migrar.
> SELECT id,
>        COALESCE(nome_empresa, nome)        AS razao_social,
>        cnpj_prestador,
>        email,
>        endereco, numero, cep
> FROM "Empresa"
> WHERE COALESCE(nome_empresa, nome) ILIKE '%D&G%'
>    OR COALESCE(nome_empresa, nome) ILIKE '%D & G%'
>    OR COALESCE(nome_empresa, nome) ILIKE '%D AND G%'
>    OR COALESCE(nome_empresa, nome) ILIKE 'DG %'
> ORDER BY razao_social, id;
> ```
>
> Se a coluna de razão social não for `nome_empresa` nem `nome`, descobrir antes com:
> `SELECT column_name FROM information_schema.columns WHERE table_name = 'Empresa' ORDER BY ordinal_position;`

Trabalho envolvido:
- **Modelo de dados** (ver Decisão #3): auto-referência `Empresa.id_empresa_pai` *ou* nova
  entidade `Grupo`/`ContaMae` com tabela de associação. Migração de dados existentes.
- **Cadastro**: fluxo no `frontend_v2` para o pai cadastrar/vincular CNPJs filhos.
- **Autorização**: o usuário do CNPJ pai precisa **ver/gerenciar dados dos filhos** — isso
  **revisa o Princípio II da constituição** (escopo estrito por `empresaId` do token).
  Definir middleware que resolva "empresas que este token pode acessar" (próprio + filhos).
- **Herança de branding**: filho herda a config do pai, com possibilidade (ou não) de override.

---

## DECISÕES EM ABERTO — confirmar com o usuário ANTES de implementar

1. **Marca exibida no AppMotorista** (PWA compartilhado, motorista vê vários tomadores):
   (a) a do **tomador** do movimento consultado [aposta]; (b) **global Movee** (só EnvioMassa
   vira white-label); (c) a do **prestador**.
2. **"via cstk"**: (a) construir a feature pelo **pipeline SDD do cstk** (`/feature-00c`, como
   foi o app-motorista) [aposta]; (b) gerenciar CNPJs por um painel cstk.
3. **Modelo do CNPJ pai**: auto-referência em `Empresa` vs nova entidade `Grupo`. O usuário do
   pai **gerencia os filhos**? (implica rever isolamento multi-tenant / Princípio II).
4. **Escopo do "alterar interface"**: só **branding** (logo/cores/nome) no MVP, ou também
   **layout/toggles de funcionalidade**?

---

## Como começar (sugestão)
1. Confirme as 4 decisões acima.
2. Se Decisão #2 = (a): rode o pipeline SDD do cstk — `brief → /feature-00c specify → clarify
   → plan → checklist → create-tasks → execute-task`. Caso contrário, faça plano direto.
3. Comece pela **Parte B (modelo de grupo)** quando a branding for por grupo — a Parte A
   depende de "qual tenant escopa a branding". Se branding for por `id_empresa` puro, dá para
   fazer a Parte A primeiro.
4. Entregue o **`.sql` de migração** para o usuário aplicar; valide o schema reload.
5. Implemente backend → frontend → `next build` → ciclo Docker → valide no ar → commit → PR.

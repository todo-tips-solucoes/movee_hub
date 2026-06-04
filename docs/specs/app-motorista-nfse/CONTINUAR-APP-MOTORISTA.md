# Continuar — App Motorista (Movee)

> Prompt de retomada autossuficiente. Cole o bloco abaixo numa **sessão limpa** do
> Claude Code, preenchendo a seção **"O que eu quero agora"** com a próxima alteração.

---

```
# Contexto — Continuação do App Motorista (Movee) / projeto movee_hub

Você é o Claude Code atuando no repo movee_hub (homologação) em
/var/lib/envioMassa_homologacao. Sou o Paulo (paulo@todo-tips.com). Estou retomando
a implementação do APP MOTORISTA (PWA) e quero continuar evoluindo o design system /
as telas. Leia a memória do projeto antes de agir:
/root/.claude/projects/-var-lib-envioMassa-homologacao/memory/MEMORY.md
(em especial feature-app-motorista.md e cstk-setup.md).

## Onde está o código
- Worktree de trabalho: /var/lib/envioMassa_homologacao/.claude/worktrees/app-motorista-nfse
  branch `worktree-app-motorista-nfse`. NÃO use a checkout principal; rode tudo na worktree.
  (Sessão é background job; se for editar e ainda não estiver isolado, use EnterWorktree.)
- App frontend: app_homologacao/frontend_motorista/  (Next.js 16 + React 19 + Tailwind 4 + Serwist PWA)
- App backend (rotas /motorista/*): app_homologacao/backend/routes/motorista.js (Express, Node 14)
- Specs/SDD: docs/specs/app-motorista-nfse/ (spec, plan, tasks, HANDOFF.md)
- Imagens de marca: docs/brand/ (img_movee.jpg = logo Movee; img_tipo_cores*.jpg = peças EntreGO)
- PR aberto: #1 (https://github.com/todo-tips-solucoes/movee_hub/pull/1). `gh` NÃO está instalado;
  para abrir/atualizar PR use a API do GitHub com o token do `git credential fill`.

## Estado atual (TUDO já está NO AR e validado)
App em produção: https://appmotorista.todo-tips.com (login JWT cookie httpOnly, movimento-aberto
escopado por cnpj_prestador do token, validar NFS-e, PWA instalável). Tabela Motorista já aplicada
no PostgREST. Fluxo autenticado validado E2E.

Design system Movee já implementado e deployado (só no frontend_motorista):
- Identidade: azul royal #1F63EB (base) + gradiente quente assinatura amarelo→laranja→vermelho
  (#FFC020→#FF7A18→#F23A20) + menta #16A375 (sucesso). Poppins (títulos) + Inter (corpo) via next/font.
- Tokens light+dark em app/globals.css + utilitários .text-gradient-warm/.bg-gradient-warm/.bg-gradient-blue.
- Primitivos em components/ui/: button (variantes default/warm/success/outline/ghost/link/destructive),
  input, label, card, badge. Marca em components/brand/wordmark.tsx. Dark mode em components/theme-toggle.tsx
  + script anti-flash no app/layout.tsx.
- 4 telas refatoradas: app/(auth)/login, (auth)/cadastro, (app)/movimento, (app)/validar + splash app/page.tsx.
- Ícones PWA gerados com ImageMagick em public/icons/ (M gradiente sobre azul; 192/512/apple/maskable) +
  public/manifest.json com theme_color de marca.

## Arquitetura e PEGADINHAS de deploy (críticas — não erre)
- Ambiente é DOCKER SWARM (não `docker compose up`). Stack: `envio-massa-homologacao` (serviços:
  backend_homologacao, frontend_homologacao, frontend_v2_homologacao, frontend_motorista_homologacao).
  Traefik faz ingress em 80/443 por Host. Registry: registry.todo-tips.com (docker já logado).
- Imagem do app motorista: registry.todo-tips.com/app-motorista-frontend:homologacao (porta interna 3000).
- DEPLOY do frontend motorista (seguro): build → push → `docker service update --with-registry-auth
  --image registry.todo-tips.com/app-motorista-frontend:homologacao --force
  envio-massa-homologacao_frontend_motorista_homologacao`.
- NÃO faça `docker stack deploy` do docker-compose.yml COMPLETO: ele interpola ${VARS} do SHELL (não do
  .env) e o arquivo tem deriva — apagaria segredos do backend (FASTAPI_VALIDATION_TOKEN/N8N_API_TOKEN).
  Para bump do BACKEND use `docker service update --image ... --force` (preserva as 7 envs). O .env real
  fica em app_homologacao/backend/.env (fora do git).
- Backend roda NODE 14: não use APIs Node 18+ globais (ex.: FormData/fetch). Já corrigido com o pacote
  `form-data`. lucide-react@1.8.0 nas deps é suspeito — prefira SVG inline a importar lucide.
- PostgREST tem schema cache: ao mudar schema, recarregue com
  `docker kill -s SIGUSR1 $(docker ps -q -f name=pgadmin_postgrest)` (ou NOTIFY pgrst,'reload schema';).
- Build do frontend OK localmente (node v22) e em Docker; next/font baixa Poppins/Inter no build (a VPS
  tem rede no build). Valide sempre com `npm run build` na pasta frontend_motorista antes do ciclo Docker.

## Restrições do ambiente (classifier de segurança)
Algumas ações exigem autorização explícita e podem ser bloqueadas: push pro registry, docker stack deploy,
docker exec/inspect em containers de produção, leitura de segredos, acesso ao banco de produção. Quando
precisar de escrita no banco ou algo que o classifier bloqueie, me passe um comando pronto para EU rodar
no chat com o prefixo `!`. Não contorne guardrails.

## Pendências / próximos passos possíveis
1. (Funcional) Roundtrip empírico do validade_nfse com um XML real de NFS-e + um motorista com movimento
   aberto — o caminho multipart está cabeado mas não foi exercido com nota real (HANDOFF.md §3).
2. (Higiene) Removi/registrei conta de teste 00000000000000; confirme que não há resíduo.
3. (PR) Avaliar merge do PR #1 em `main` quando aprovado.
4. (Design) Possíveis evoluções que eu posso pedir: ajustar o ícone (o gradiente ficou mais
   laranja que vermelho — talvez deixar mais vermelho/azul), polir microinterações, estados de
   loading skeleton, telas adicionais, acessibilidade, e/ou estender o design system ao frontend_v2.

## O que eu quero agora
[DESCREVA AQUI a próxima alteração: ex. "ajuste o ícone para puxar mais o vermelho", ou
"adicione tela X", ou "estenda o design system ao frontend_v2", etc.]

Antes de codar: leia os arquivos relevantes, rode `npm run build` para validar, e só então
build+push+`service update --force`. Ao final, valide no ar (https://appmotorista.todo-tips.com) e
me diga o digest novo. Mantenha commits Conventional na branch worktree-app-motorista-nfse e atualize
o PR #1.
```

---

## Lembretes
- Preencha o bloco **"O que eu quero agora"** com a alteração específica antes de colar.
- Painel cstk (https://overprosperously-geomorphic-mathias.ngrok-free.dev) depende do `sqlite3`
  (já instalado) + `cstk recall --reindex`. Se voltar "Base degradada — base de dados corrompida",
  o procedimento está na memória `cstk-setup`.

# Deploy checklist — config-ui-tenant

> Deploy **Docker Swarm aditivo** (NUNCA `docker stack deploy` do compose completo —
> apaga os secrets do backend). Nomes reais extraídos de `app_homologacao/docker-compose.yml`.
> O classifier bloqueia push/registry/swarm para o agente → **comandos do operador**.

## Convenções reais (verificadas no compose)

| Serviço Swarm | Imagem | Host (Traefik) | Porta |
|---|---|---|---|
| `envio-massa-homologacao_backend_homologacao` | `registry.todo-tips.com/envio-massa-backend:homologacao` | envmassapihomologacao.todo-tips.com | 3000 |
| `envio-massa-homologacao_frontend_v2_homologacao` | `registry.todo-tips.com/envio-massa-frontend-v2:homologacao` | envmassv2.todo-tips.com | 3000 |
| `envio-massa-homologacao_frontend_motorista_homologacao` | `registry.todo-tips.com/app-motorista-frontend:homologacao` | appmotorista.todo-tips.com | 3000 |

## Pré-requisitos (antes do deploy)

- [x] SQL `001` + `002` aplicados + reload PostgREST (feito 2026-06-05).
- [ ] **Supabase Storage** para o logo (branding.js): criar bucket público `branding`
      e ter à mão `SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY`. Sem isso o upload de
      logo fica desabilitado (cores/nome funcionam mesmo assim — degradação graciosa).

## 1. Backend (primeiro — frontends dependem das rotas novas)

```bash
docker build -t registry.todo-tips.com/envio-massa-backend:homologacao app_homologacao/backend
docker push registry.todo-tips.com/envio-massa-backend:homologacao
# anote o digest impresso (sha256:...) e use-o no --image abaixo

# --force preserva os 6 envs existentes; --env-add ACRESCENTA os do Supabase.
docker service update --with-registry-auth --force \
  --image registry.todo-tips.com/envio-massa-backend@sha256:<DIGEST> \
  --env-add SUPABASE_URL=<sua-url> \
  --env-add SUPABASE_SERVICE_ROLE_KEY=<sua-service-role-key> \
  --env-add SUPABASE_BRANDING_BUCKET=branding \
  envio-massa-homologacao_backend_homologacao

# validar (espera 401 — rota existe e exige auth; 404 = imagem antiga ainda)
curl -s -o /dev/null -w "%{http_code}\n" https://envmassapihomologacao.todo-tips.com/empresa/branding
curl -s -o /dev/null -w "%{http_code}\n" https://envmassapihomologacao.todo-tips.com/grupo/filhos
docker service ps envio-massa-homologacao_backend_homologacao --no-trunc | head
```

## 2. Frontend v2 (painel)

```bash
cd app_homologacao/frontend_v2 && npx next build   # já validado local (TS OK, 10 rotas)
cd ../..
docker build -t registry.todo-tips.com/envio-massa-frontend-v2:homologacao app_homologacao/frontend_v2
docker push registry.todo-tips.com/envio-massa-frontend-v2:homologacao

docker service update --with-registry-auth --force \
  --image registry.todo-tips.com/envio-massa-frontend-v2@sha256:<DIGEST> \
  envio-massa-homologacao_frontend_v2_homologacao

# validar (espera 200 autenticado ou 307/redirect login — NÃO 404)
curl -s -o /dev/null -w "%{http_code}\n" https://envmassv2.todo-tips.com/dashboard/configuracoes/aparencia
```

## 3. Frontend motorista (PWA)

```bash
cd app_homologacao/frontend_motorista && npx next build   # já validado local (TS OK)
cd ../..
docker build -t registry.todo-tips.com/app-motorista-frontend:homologacao app_homologacao/frontend_motorista
docker push registry.todo-tips.com/app-motorista-frontend:homologacao

docker service update --with-registry-auth --force \
  --image registry.todo-tips.com/app-motorista-frontend@sha256:<DIGEST> \
  envio-massa-homologacao_frontend_motorista_homologacao

curl -s -o /dev/null -w "%{http_code}\n" https://appmotorista.todo-tips.com/
```

## 4. Validação E2E no ar (após os 3 deploys)

1. Login no painel (`envmassv2`) como **pai D&G** (id 2, admin@dg.com.br) → seção "Grupo de CNPJs" visível; lista os 5 filhos.
2. `/dashboard/configuracoes/aparencia` → setar cor primária + nome → **Salvar** → recarregar → branding persistida.
3. Login como **filho** (ex.: id 3, adminsbc@dg.com.br) → herda branding do grupo; seção de gestão de grupo oculta.
4. PWA (`appmotorista`) → abrir movimento de tomador D&G → cores/marca do grupo aplicadas (fallback Movee se sem branding).
5. Empresa **sem grupo** → fallback Movee.
6. Toggle dark/light (next-themes) continua funcionando com branding custom ativa.

**Critério**: nenhum 404/500 nas chamadas de branding; cenários 1–6 pass.

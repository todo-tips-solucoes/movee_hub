# Movee Hub — Envio em Massa (Homologação)

Aplicação de **CRUD e processamento em massa de movimentos/XML** para a Todo Tips. O ambiente deste repositório é o de **homologação**.

O projeto é composto por três serviços, orquestrados via Docker Swarm + Traefik:

| Serviço | Stack | Descrição | Host (homologação) |
|---|---|---|---|
| [`backend`](app_homologacao/backend/README.md) | Node.js / Express | API REST: autenticação, CRUD de envios, upload, processamento e validação de XML | `envmassapihomologacao.todo-tips.com` |
| `frontend` | HTML/CSS/JS + Nginx | Frontend legado (v1), estático | `envmasshomologacao.todo-tips.com` |
| [`frontend_v2`](app_homologacao/frontend_v2/README.md) | Next.js 16 + React 19 + Tailwind/shadcn | Frontend atual (v2) | `app.moveelog.com.br` |

> 📚 **Documentação por módulo:** [Backend (API e endpoints)](app_homologacao/backend/README.md) · [Frontend v2](app_homologacao/frontend_v2/README.md)

## Estrutura

```
app_homologacao/
├── backend/          # API Express (server.js, porta 3000)
├── frontend/         # Frontend v1 estático (Nginx, porta 80)
├── frontend_v2/      # Frontend v2 em Next.js (porta 3000)
└── docker-compose.yml
```

## Backend

API Express (`app_homologacao/backend/server.js`) que persiste dados via **PostgREST** e integra com **n8n** para o processamento. Principais endpoints:

- **Auth:** `POST /login`, `POST /register`, `POST /logout`, `POST /token/refresh`, `GET /verify-auth`
- **Envios em massa:** `GET /envio-massa`, `PATCH /update-envio-massa/:id`, `DELETE /envio-massa/:id`, `GET /export-envio-massa`
- **Upload e processamento:** `POST /upload`, `POST /start-process`, `POST /stop-process`, `GET /process-status`
- **Movimentos / XML:** `POST /close-movimento`, `GET /download-xml-movimento`, `POST /validate-xml-batch`

📖 Documentação completa dos endpoints (payloads, auth por cookie, respostas): **[app_homologacao/backend/README.md](app_homologacao/backend/README.md)**.

Principais dependências: `express`, `jsonwebtoken`, `bcrypt`, `multer`, `xml2js`, `xlsx`, `json2csv`, `archiver`, `axios`.

### Rodando o backend localmente

```bash
cd app_homologacao/backend
cp .env.example .env   # preencha os valores
npm install
npm start              # sobe em http://localhost:3000
```

## Frontend v2 (atual)

```bash
cd app_homologacao/frontend_v2
npm install
npm run dev            # http://localhost:3000
```

Configure `BACKEND_URL` em `.env.local` apontando para a API.

📖 Arquitetura, rotas, hooks e componentes: **[app_homologacao/frontend_v2/README.md](app_homologacao/frontend_v2/README.md)**.

## Variáveis de ambiente

> ⚠️ Os arquivos `.env` **não** são versionados (ver `.gitignore`). Use os `*.env.example` como referência.

**Backend** (`app_homologacao/backend/.env`):

| Variável | Descrição |
|---|---|
| `POSTGREST_URL` | URL do PostgREST |
| `POSTGREST_API_KEY` | Chave de API do PostgREST |
| `JWT_SECRET` | Segredo do token de acesso |
| `JWT_REFRESH_SECRET` | Segredo do token de refresh |
| `N8N_API_TOKEN` | Token da API do n8n (processamento) |
| `FASTAPI_VALIDATION_TOKEN` | Token do serviço de validação de XML |

**Frontend v2** (`app_homologacao/frontend_v2/.env.local`):

| Variável | Descrição |
|---|---|
| `BACKEND_URL` | URL base da API do backend |

## Deploy (Docker Swarm)

As imagens são publicadas no registry `registry.todo-tips.com` e roteadas por Traefik (TLS via Let's Encrypt). O stack de homologação está em `app_homologacao/docker-compose.yml`:

```bash
docker stack deploy -c app_homologacao/docker-compose.yml app_homologacao
```

A rede externa `app_homologacao_default` precisa existir previamente.

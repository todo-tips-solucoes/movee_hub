# Frontend v2 — Envio em Massa (Movee Hub)

Frontend atual da aplicação de envio em massa, em **Next.js 16 (App Router) + React 19 + TypeScript**, com **Tailwind CSS v4** e componentes **shadcn/ui** (sobre Base UI). É o sucessor do frontend estático (`../frontend`).

## Stack

- **Next.js 16** (App Router, `output: 'standalone'`) · **React 19** · **TypeScript**
- **Tailwind CSS v4** + `tw-animate-css`
- **shadcn/ui** / **Base UI** (`@base-ui/react`), ícones **lucide-react**
- **framer-motion** (animações), **sonner** (toasts), **next-themes** (tema claro/escuro)

## Como rodar

```bash
npm install
npm run dev      # http://localhost:3000
```

Scripts: `dev` · `build` · `start` · `lint`.

### Variável de ambiente

| Variável | Descrição |
|---|---|
| `BACKEND_URL` | URL base da API do backend (usada pelo proxy `/api/*`). Padrão: `http://localhost:3000` |

Configure em `.env.local` (ver `.env.example`).

## Arquitetura

### Proxy de API (`app/api/[...path]/route.ts`)
Todas as chamadas do cliente vão para `/api/*` e são repassadas pelo **Route Handler** para `BACKEND_URL`, **preservando os cookies** da requisição. Isso é essencial porque o backend autentica via cookies `httpOnly` (`accessToken`/`refreshToken`) — o proxy server-side garante que o cookie chegue ao backend, contornando restrições de cross-site. Requisições `multipart/form-data` (upload de planilha / XMLs) têm o corpo transmitido em stream (`duplex: 'half'`) para preservar o `boundary`.

### Cliente HTTP (`lib/api-client.ts`)
Wrapper `api.get/post/patch/del` sobre `fetch`, sempre com `credentials: 'include'`, base `/api`, timeout de **10s** (`AbortController`) e tratamento de erro padronizado (mensagens em PT; lança em `401` → "Não autorizado").

### Autenticação (`contexts/auth-context.tsx`)
`AuthProvider` expõe `user`, `loading`, `login`, `register`, `logout`. No mount chama `GET /verify-auth`; renova o token automaticamente via `POST /token/refresh` **a cada 10 min** (o access token do backend expira em 15 min).

## Rotas (App Router)

| Rota | Arquivo | Descrição |
|---|---|---|
| `/` | `app/page.tsx` | Entrada / redirecionamento conforme sessão |
| `/login` | `app/login/page.tsx` | Login |
| `/register` | `app/register/page.tsx` | Cadastro de empresa |
| `/dashboard` | `app/dashboard/page.tsx` | Tela principal: tabela do movimento, filtros, importação e disparo |
| `/dashboard/validacao-xml` | `app/dashboard/validacao-xml/page.tsx` | Validação em lote de XMLs de NFSe |
| `/api/*` | `app/api/[...path]/route.ts` | Proxy para o backend |

## Hooks (`hooks/`)

| Hook | Responsabilidade |
|---|---|
| `use-envio-massa` | CRUD do movimento (`GET/PATCH/DELETE /envio-massa`), exportação e fechamento |
| `use-process-status` | Estado do disparo em lote — `start`/`stop`/`status` (`/start-process`, `/stop-process`, `/process-status`) |
| `use-xml-validation` | Validação em lote de XMLs (`POST /validate-xml-batch`) |
| `use-debounce` | Debounce genérico (usado nos filtros/busca) |

## Componentes (`components/`)

Componentes de domínio — `data-table`, `filters`, `action-bar`, `stats-cards`, `import-button`, `process-controls`, `pagination-controls`, `edit-dialog`, `delete-dialog`, `close-movement-dialog`, `xml-validation-card`, `header`, `theme-toggle` — sobre a base de primitivos **shadcn/ui** em `components/ui/`.

## Deploy

Build standalone, conteinerizado (`Dockerfile`), servido na porta **3000** atrás do Traefik (host `envmassv2.todo-tips.com` em homologação). Ver `../docker-compose.yml`.

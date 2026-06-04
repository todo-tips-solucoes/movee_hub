# Briefing & Discovery — Movee Hub (Envio em Massa)

> Discovery em nível de projeto que contextualiza as features do `movee_hub`
> (ambiente de homologação). Base para o pipeline SDD (specify → plan → tasks).
> Capturado em 2026-06-04. Complementa `docs/constitution.md`.

## Visão

O **Movee Hub — Envio em Massa** é uma plataforma de homologação para automação de
envio de mensagens/documentos fiscais em massa e gestão de movimentos de pagamento de
prestadores (motoristas). O sistema lê e escreve dados de negócio via **PostgREST**
sobre PostgreSQL, expõe uma **API Express** autenticada por **JWT em cookie httpOnly**,
e um painel web **Next.js** (`frontend_v2`) para as empresas operarem seus envios.

A visão de produto é oferecer, sobre essa mesma base já em produção, **aplicações
focadas por público** que reaproveitam autenticação, proxy de cookies e deploy
conteinerizado — entregando rapidez, consistência e segurança. A primeira expansão
nesse sentido é o **App Motorista (PWA)**: levar ao motorista, no celular, a consulta
do valor do seu movimento aberto e a validação assistida da NFS-e em XML.

## Usuários-alvo

- **Empresa (operador do painel)**: usa o `frontend_v2` para importar planilhas,
  disparar e acompanhar envios em massa e fechar movimentos. Autentica por e-mail +
  senha; dados escopados por `id_empresa`.
- **Motorista (prestador de serviço)**: público da primeira feature nova. Acessa pelo
  celular (PWA instalável) para consultar o valor/período do seu movimento em aberto e
  subir/validar sua NFS-e. Identidade própria, login por **CNPJ prestador**; dados
  escopados por `cnpj_prestador`.
- **Operação/Infra**: mantém os containers da VPS (backend, frontends, PostgREST)
  atrás do Traefik; responsável por DNS, TLS e pelo registry `registry.todo-tips.com`.

## Restrições

- **Segurança & segredos (NON-NEGOTIABLE)**: autenticação por JWT em cookie httpOnly
  (`accessToken` 15 min, `refreshToken` 7 dias, `SameSite=Strict`, `Secure` em prod);
  senhas com hash **bcrypt**; segredos (`JWT_SECRET`, `JWT_REFRESH_SECRET`,
  `POSTGREST_API_KEY`, `FASTAPI_VALIDATION_TOKEN`, `N8N_API_TOKEN`) em `.env` **fora do
  git**. Detalhes em `docs/constitution.md` §I.
- **Isolamento multi-tenant (NON-NEGOTIABLE)**: toda operação é escopada por
  identificador extraído do **token** (`id_empresa` para Empresa, `cnpj_prestador`
  para Motorista) — nunca por id vindo do cliente. Constitution §II.
- **Contratos & proxy de cookies**: frontends falam com o backend apenas via proxy
  `/api/*` que repassa os cookies; integrações externas (ex.: validação NFS-e) são
  intermediadas server-side. Constitution §III.
- **Deploy conteinerizado (NON-NEGOTIABLE)**: todo serviço é container Docker roteado
  pelo Traefik (TLS Let's Encrypt) sob host DNS próprio; mudanças de infra são
  **aditivas** e não podem afetar containers em produção nem disputar as portas
  80/443. Constitution §V.
- **Stack vigente**: backend Node/Express (Node 14) + PostgREST; frontend Next.js 16 +
  React 19 + TypeScript + Tailwind 4 + shadcn/ui. Novas features reaproveitam essa
  stack por padrão.
- **Qualidade**: trabalho em branch dedicada, Conventional Commits, mensagens de erro
  ao usuário em português; mudanças em auth/upload/XML passam por revisão OWASP.

## Prioridades

1. **App Motorista (PWA)** — 1ª feature: login (com auto-cadastro guardado), consulta
   do movimento aberto (valor, período, dados fiscais) e upload+validação de XML de
   NFS-e com bloqueio de reenvio. Detalhado em `docs/specs/app-motorista-nfse/`.
2. **Reuso máximo da stack existente** — auth, proxy de cookies, cliente PostgREST,
   componentes e deploy do `movee_hub`, em vez de stacks paralelas.
3. **Segurança e isolamento por tenant** — não regredir nos princípios NON-NEGOTIABLE;
   toda nova superfície (rotas, upload, integração) é avaliada contra a constituição.
4. **Disponibilidade e escala** — backend stateless (JWT) para permitir réplicas;
   deploy conteinerizado aditivo, sem impacto nos serviços em produção.

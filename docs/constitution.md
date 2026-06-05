<!--
Sync Impact Report
- Version: (none) → 1.0.0
- Tipo de bump: criação inicial
- Princípios criados: I. Segurança de Autenticação & Segredos; II. Isolamento Multi-Tenant;
  III. Contratos de API & Proxy de Cookies; IV. Qualidade e Revisão de Mudanças;
  V. Deploy Conteinerizado e Convivência de Serviços
- Seções adicionadas: Padrões de Qualidade; Operações & Deploy; Governance
- Artefatos que precisam atualização manual:
  - CLAUDE.md: AUSENTE (criar futuramente para refletir estes princípios) — pendente
  - README.md (raiz/backend/frontend_v2): já alinhados (auth por cookie, segredos fora do git)
- TODOs pendentes: nenhum
-->

# Movee Hub — Envio em Massa — Constitution

Princípios imutáveis que governam decisões de arquitetura, qualidade e processo do projeto
`movee_hub` (backend Express + frontend estático v1 + frontend_v2 Next.js), ambiente de
homologação. Estes princípios são o gate de qualquer spec, plan, task ou PR.

## Core Principles

### I. Segurança de Autenticação & Segredos (NON-NEGOTIABLE)

- **MUST**: autenticação é feita por **JWT em cookies `httpOnly`** (`accessToken` 15 min,
  `refreshToken` 7 dias), com `sameSite=Strict` e `secure` em produção. Tokens NUNCA
  trafegam em `localStorage`, query string ou header customizado exposto ao browser.
  *(Why: cookies httpOnly mitigam roubo de token via XSS.)*
- **MUST**: segredos (`JWT_SECRET`, `JWT_REFRESH_SECRET`, `POSTGREST_API_KEY`,
  `N8N_API_TOKEN`, `FASTAPI_VALIDATION_TOKEN`) vivem em `.env` **fora do git**
  (`.gitignore`), com `*.env.example` como referência. Nenhum segredo entra em commit,
  log ou resposta de API.
  *(Why: vazamento de segredo no histórico é irreversível.)*
- **MUST**: senhas são armazenadas com hash `bcrypt` — nunca em texto plano.

### II. Isolamento Multi-Tenant por Empresa (NON-NEGOTIABLE)

- **MUST**: toda operação de dados é escopada pela `empresaId` extraída do token
  autenticado (`req.user.empresaId`), **nunca** por um id vindo do corpo/query do cliente.
  Consultas ao PostgREST sempre filtram por `id_empresa=eq.<empresaId>`.
  *(Why: previne acesso cruzado entre empresas — falha de tenant isolation é crítica.)*
- **MUST**: endpoints que mutam ou leem dados de negócio exigem o middleware
  `authenticateToken`. Rotas públicas se limitam a `login`, `register`, `token/refresh`.

### III. Contratos de API & Proxy de Cookies

- **MUST**: o frontend_v2 fala com o backend **apenas** via o proxy `/api/*`
  (`app/api/[...path]/route.ts`), que repassa os cookies de autenticação. Chamadas diretas
  cross-site ao backend são proibidas (quebram o fluxo de cookie httpOnly).
- **MUST**: o cliente HTTP usa `credentials: 'include'`; o CORS do backend permanece
  restrito às origens conhecidas (`allowedOrigins`) com `credentials: true`.
- **SHOULD**: mudanças em endpoints (path, payload, resposta, códigos de status) são
  refletidas nos READMEs (`backend/README.md`) na mesma mudança. *(Why: o README é o
  contrato vivo da API.)*

### IV. Qualidade e Revisão de Mudanças

- **MUST**: trabalho é feito em **branch dedicada** (`feature/*`, `fix/*`, `chore/*`),
  nunca commitando direto na `main`. PRs pequenos e focados.
- **MUST**: commits seguem **Conventional Commits** (`feat:`, `fix:`, `docs:`, `chore:` …).
- **SHOULD**: mudanças que tocam autenticação, manipulação de XML/NFSe ou upload passam por
  revisão de segurança (baseline **OWASP Top 10**) antes do merge.
- **SHOULD**: validação de entrada explícita em uploads (planilhas `.xlsx`, XMLs) — rejeitar
  arquivo inválido com erro claro, nunca assumir formato.

### V. Deploy Conteinerizado e Convivência de Serviços (NON-NEGOTIABLE)

- **MUST**: todo serviço do projeto é entregue como **container Docker**, roteado por
  **Traefik** (TLS Let's Encrypt) sob seu host DNS — nunca exposto por porta solta na VPS.
- **MUST**: novas instalações ou serviços na VPS **não podem afetar os containers já em
  produção** nem disputar as portas 80/443 já ocupadas. Mudanças de infraestrutura são
  aditivas e verificadas (`No containers need to be restarted`).
  *(Why: a VPS hospeda serviços vivos expostos à internet.)*

## Padrões de Qualidade

- Mensagens de erro ao usuário em **português**, claras e acionáveis; logs técnicos podem
  ser detalhados, mas **sem** vazar segredos ou tokens.
- Timeouts e tratamento de falha de rede no cliente (ex.: `AbortController`) são obrigatórios
  para chamadas de API.
- Nenhum `.env` real, dump de banco ou artefato com credencial é versionado.

## Operações & Deploy

- Imagens publicadas no registry `registry.todo-tips.com`; stack de homologação em
  `app_homologacao/docker-compose.yml`.
- Ferramentas de apoio (ex.: painéis de dev) que não sejam o produto podem rodar em
  `127.0.0.1` e ser expostas via túnel autenticado (ngrok com basic-auth) — **fora** do
  caminho 80/443 do Traefik.

## Governance

- Esta constituição **prevalece** sobre conveniência de implementação. Specs, plans e tasks
  que a violem devem ser ajustados ou ter exceção documentada e justificada.
- **Amendments**: alterações são versionadas por **SemVer** —
  **MAJOR** (remove/redefine princípio de forma incompatível),
  **MINOR** (novo princípio ou expansão material),
  **PATCH** (clarificação sem mudança semântica). Todo bump MAJOR/MINOR exige Sync Impact
  Report listando artefatos a atualizar.
- **Exceções**: registradas no PR que as introduz, com rationale e prazo de revisão.
- Conflitos entre princípios são resolvidos promovendo um a MUST e rebaixando o outro a
  SHOULD com trade-off documentado.

**Version**: 1.0.0 | **Ratified**: 2026-06-03 | **Last Amended**: 2026-06-03

# Research — App Motorista (PWA)

**Feature**: `app-motorista-nfse` | **Date**: 2026-06-04
**Fase**: Phase 0 (resolução de unknowns)

Base: exploração do `movee_hub` em `app_homologacao/` (backend Express Node 14 +
frontend_v2 Next 16). Todos os unknowns do Technical Context resolvidos abaixo.

---

## Decision 1 — Onde mora o backend do App Motorista

**Decision**: Estender o **backend Express existente** (`app_homologacao/backend/`)
com um conjunto novo de rotas `/motorista/*` e um middleware `authenticateMotorista`,
em vez de criar um segundo serviço de backend.

**Rationale**: o backend atual já contém tudo que a feature precisa reaproveitar —
`postgrestRequest()`, `bcrypt`, emissão/leitura de cookies httpOnly, e a chamada à
validação NFS-e (`FASTAPI_VALIDATION_TOKEN`). Um segundo backend duplicaria esse
código e adicionaria infra. Duas audiências (Empresa vs Motorista) convivem com
middlewares separados e claims de token distintos.

**Alternatives considered**:
- *Microserviço de backend separado* — rejeitado: duplica cliente PostgREST e lógica
  de validação; mais superfície de deploy/segredos para pouco ganho.
- *Reusar `authenticateToken` (empresa) para motorista* — rejeitado: viola o escopo
  por `cnpj_prestador` (Constituição II) e mistura audiências num mesmo token.

---

## Decision 2 — Onde mora o frontend (PWA)

**Decision**: Criar um **novo app Next.js** `app_homologacao/frontend_motorista/`,
mobile-first, com PWA via **Serwist**, reaproveitando os padrões do `frontend_v2`
(proxy `/api/[...path]`, `api-client.ts`, `auth-context`, componentes shadcn/Tailwind).

**Rationale**: audiência distinta (motoristas), UI mobile enxuta e requisito de PWA
instalável justificam um app dedicado. Manter no mesmo `frontend_v2` (que é o painel
desktop da empresa) misturaria dois produtos e complicaria o escopo do service worker.
Um app separado escala e faz deploy de forma independente (backend stateless via JWT).

**Alternatives considered**:
- *Rotas `/motorista` dentro do `frontend_v2`* — rejeitado: acopla dois produtos com
  públicos e fluxos de auth diferentes; PWA shell ficaria global ao painel.
- *React + Vite ou Expo/React Native* — rejeitado no brief: PWA foi pedido
  explicitamente e o alinhamento com Next.js maximiza reuso.

**PWA — biblioteca**: **Serwist** (`@serwist/next`), sucessor mantido do `next-pwa`
para Next 15/16. Gera service worker + precache do app shell; `manifest.json` para
instalação (ícones, `display: standalone`, `theme_color`).

---

## Decision 3 — Identidade e provisionamento do Motorista

**Decision**: Nova tabela **`Motorista`** no PostgREST com, no mínimo:
`cnpj_prestador` (chave de login, único), `senha` (hash bcrypt), `nome`, `ativo`.
Login emite cookie JWT com claim `cnpjPrestador`. Escopo de dados:
`EnvioMassa?cnpj_prestador=eq.{cnpjPrestador do token}&mov_fechado=eq.false`.

**Rationale**: a clarificação confirmou entidade Motorista própria com login por CNPJ
prestador. O backend já tem o padrão `Empresa?email=eq.{}` + `bcrypt.compare` — basta
replicar para `Motorista?cnpj_prestador=eq.{}`. Reusa o mesmo `JWT_SECRET`/
`JWT_REFRESH_SECRET` e o mesmo formato de cookie (`accessToken` 15m / `refreshToken`
7d, `httpOnly`, `sameSite=Strict`).

**Provisionamento (R-2 — DECIDIDO: auto-cadastro)**: o motorista cria a própria conta
no app via `POST /motorista/register` (CNPJ prestador + senha + nome). **Guard de
segurança do MVP**: o cadastro só é aceito se `cnpj_prestador` **já existir** em
`EnvioMassa` e **não** tiver conta em `Motorista` — impede que um CNPJ desconhecido se
registre e acesse dados (mitiga enumeração/acesso indevido). Espelha o padrão da rota
`POST /register` (Empresa) já existente. A verificação do guard e o tratamento de
mensagens (sem revelar se o CNPJ existe, para não virar oráculo de enumeração) entram
na revisão OWASP (FASE 7).

**Alternatives considered**:
- *Reusar contas `Empresa`* — rejeitado na clarificação (cada motorista emite com seu
  próprio CNPJ prestador).
- *Login por e-mail* — rejeitado: a chave funcional do motorista nos dados é o
  `cnpj_prestador`.
- *Seed/admin externo (sem cadastro no app)* — considerado, mas o solicitante optou
  por auto-cadastro (R-2).

---

## Decision 4 — Persistência do resultado de validação

**Decision**: Gravar na própria `EnvioMassa` (colunas **já existentes**):
`nota_ok` (status aprovado) e `erro_validacao` (campos reprovados, em JSON/texto).
A regra de bloqueio de reenvio (FR-008) lê `nota_ok` do movimento aberto do motorista.

**Rationale**: a clarificação escolheu colunas na `EnvioMassa`; a exploração confirmou
que `nota_ok` e `erro_validacao` **já existem** no schema referenciado pelo código —
**sem migração necessária**. PATCH ao PostgREST (`update-envio-massa` já faz isso para
Empresa) é o padrão reaproveitável.

**Alternatives considered**:
- *Tabela nova de validações (histórico)* — rejeitado para o MVP: mais modelagem; o
  estado atual basta para o bloqueio. Pode evoluir depois sem quebrar contrato.

---

## Decision 5 — Contrato da chamada à validação NFS-e (DIVERGÊNCIA a reconciliar)

**Decision (a seguir)**: usar o contrato **confirmado pelo solicitante**:
- Endpoint: `https://fastapihomologacaonexus.todo-tips.com/validade_nfse`
- `xml_input = JSON.stringify([{ filename, data }])` (`data` = XML em UTF-8)
- `validar_descricao_servico = false`, `nexus = false`
- Header `Authorization: {FASTAPI_VALIDATION_TOKEN}`
- Resposta: array `[{ valid, details: { valid_cnpj_prestador, valid_cnpj,
  valid_descricao_servico, valid_valor, valid_trib_nac, valid_trib_mun,
  valid_dCompet } }]`

**Divergência observada**: a rota de validação existente no backend
(`validate-xml-batch`) monta o payload de forma diferente (`xml_input` como string
crua, parâmetro `id_empresa`, e troca a URL entre `fastapihomologacao` e
`fastapihomologacaonexus` conforme `tribnac`). Ou seja, há **dois contratos
aparentes** para o mesmo serviço.

**Plano de reconciliação**: a função do App Motorista (`callValidacaoNfse`) implementa
o contrato confirmado pelo solicitante. Durante `execute-task`, executar o **cenário
roundtrip real** do `quickstart.md` (chamada de verdade ao `validade_nfse` com um XML
de exemplo) e comparar a resposta ao shape declarado antes de fixar o parser. Se a API
rejeitar o `xml_input` no formato `[{filename,data}]`, cair para o formato que a rota
existente já usa em produção, registrando a decisão.

**Rationale**: seguir a fonte que o solicitante autorizou explicitamente, mas tratar a
divergência como risco conhecido e validá-la empiricamente (evita o tipo de drift de
contrato que a skill `plan` alerta).

**Alternatives considered**:
- *Copiar cegamente a rota `validate-xml-batch`* — rejeitado: contradiz o que o
  solicitante confirmou para este app.
- *Assumir só o contrato do brief sem teste* — rejeitado: a divergência real no código
  exige verificação empírica antes de fixar.

---

## Decision 6 — Atalho do portal e seleção de período

**Decision**: Botão de atalho abre `https://www.nfse.gov.br` (NFS-e Nacional) em nova
aba (`target=_blank`, `rel=noopener`). A consulta mostra **apenas o movimento aberto**
(`mov_fechado = false`), sem seletor de período no MVP.

**Rationale**: ambos confirmados na clarificação. Mantém a UI mobile enxuta.

---

## Decision 7 — Deploy conteinerizado (Constituição V)

**Decision**: Adicionar **um** serviço novo ao
`app_homologacao/docker-compose.yml`: `frontend_motorista_homologacao`
(imagem `registry.todo-tips.com/envio-massa-motorista:homologacao`), roteado pelo
Traefik sob um host DNS próprio (ex.: `appmotorista.todo-tips.com`), com
`BACKEND_URL=https://envmassapihomologacao.todo-tips.com`. O backend **não** ganha
novo serviço — apenas novas rotas no `backend_homologacao` existente.

**Rationale**: o solicitante pediu que o app more no Docker já rodando na VPS. Traefik
roteia por host, então o serviço novo é **aditivo** e não disputa 80/443 nem as portas
dos containers em produção (Constituição V). Dockerfile do `frontend_v2` (Node
20-alpine, `output: standalone`) é o template para o do app motorista.

**Alternatives considered**:
- *Expor por porta solta na VPS* — rejeitado (Constituição V: tudo atrás do Traefik).
- *Novo docker-compose isolado* — rejeitado: o pedido é conviver no compose existente.

> ⚠️ **Pendência operacional**: criar o registro DNS do host novo
> (`appmotorista.todo-tips.com`) apontando para a VPS, para o Traefik emitir o
> certificado Let's Encrypt. Tarefa de infra fora do código.

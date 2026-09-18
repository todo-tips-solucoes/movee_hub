# Contracts: API do app do motorista (`/motorista/*`)

Duas partes: **contratos existentes** (extraídos do código, com a fonte) e **contratos
novos** (`[PROPOSTA — a validar na implementação]`, seguindo a PLANO §13 e §16.1).

O app chama tudo como `/api/motorista/...`; o proxy
`app_homologacao/frontend_motorista/app/api/[...path]/route.ts` tira o prefixo `/api` e
repassa para `${BACKEND_URL}/motorista/...` com os cookies. O cliente é
`app_homologacao/frontend_motorista/lib/api-client.ts` (`BASE = '/api'`, timeout 15 s).

---

## Parte 1 — Contratos existentes (fonte: código)

### Autenticação e sessão

| Item | Valor real | Fonte |
|---|---|---|
| Montagem | `app.use('/motorista', motoristaRoutes.router)` | `backend/server.js:2821` |
| Middleware | `authenticateMotorista`: lê o cookie `accessToken`, `jwt.verify(token, JWT_SECRET)`, exige `aud === 'motorista'`, põe `req.motorista = {cnpjPrestador, nome, aud, iat, exp}` (+ `entregadorUuid` só no login por `ContaMotorista`) | `backend/routes/motorista.js:155-176` |
| Cookies | `accessToken` (15 min) e `refreshToken` (7 d), `httpOnly`, `sameSite: 'Strict'`, `secure` só em produção | `backend/routes/motorista.js:181-195` |
| Login | `POST /motorista/login` `{cnpjPrestador, senha}` → `{cnpjPrestador, nome}` | `:299`, `:356` |
| Refresh | `POST /motorista/token/refresh` → `{message:'Token renovado.'}`; 401 sem cookie; 403 inválido. **Reconstrói o payload só com `{cnpjPrestador, nome}`** | `:475-504` (`:490`) |
| Logout | `POST /motorista/logout` (exige access válido) → `{message:'Logout bem-sucedido.'}` | `:511-514` |
| Verificação | `GET /motorista/verify-auth` → `{authenticated:true, nome, cnpjPrestador}` | `:520-526` |
| Erros deste arquivo | `{error:'<mensagem em português>'}` | ex.: `:158`, `:304` |

### Rotas autenticadas penduradas no router do motorista

`motoristaRoutes.router.use('/', motoristaRoutes.authenticateMotorista, motoristaPushRoutes.router)`
(`backend/server.js:2847`). Erros no formato `{erro:'CODIGO', motivo?}`.

| Método e caminho | Resposta | Fonte |
|---|---|---|
| `GET /motorista/avisos/:id` | 200 `{id, titulo, corpo, enviadoEm}`; 404 `{erro:'AVISO_NAO_DISPONIVEL'}` (id inválido ou sem acesso); 502 `{erro:'INDISPONIVEL'}` | `backend/routes/motorista-push.js:179-206` |
| Limiter do push | 15 min, 30 req, chave `req.motorista.cnpjPrestador` (ou IP); 429 `{erro:'LIMITE_EXCEDIDO'}` | `backend/routes/motorista-push.js:47` |

`GET /motorista/avisos/:id` chama `rpc/hub_aviso_para_motorista` com a claim
`{motoristaCnpj}`; hoje a função exige uma linha de `"AvisoEntrega"` para o CNPJ
(`infra/hub/migrations/0061_push_avisos.sql:313-334`).

### Mudanças em contratos existentes (desta feature)

| Contrato | Mudança | Origem |
|---|---|---|
| `GET /motorista/avisos/:id` | A autorização passa a ser pela linha de `NotificacaoMotorista` do CNPJ (o aviso fica visível para quem não ativou push). Resposta inalterada. (Marcar como lida é o `POST /notificacoes/:id/lida` que o app chama no toque, PLANO §19.) | D-15, PLANO §16.1 |
| `POST /motorista/logout` | Deixa de exigir access válido: limpa os cookies mesmo com o access expirado. Resposta inalterada. | Q-N16, PLANO §29 item 2 |
| `lib/api-client.ts` (cliente) | Lê `body.erro` (código) além de `message`/`error` e traduz o código para pt-BR. | FR-054, PLANO §29 item 4 |
| Guarda `app/(app)/layout.tsx` (cliente) | Com 401 no `/verify-auth`, tenta `POST /motorista/token/refresh` uma vez antes de ir ao login. | FR-053, Q-N16 |

---

## Parte 2 — Contratos novos `[PROPOSTA — a validar na implementação]`

Arquivo: `backend/routes/motorista-adiantamento.js`, pendurado como o push (atrás de
`authenticateMotorista`). Regras comuns:

- **Escopo**: o entregador vem de `cnpjPrestador` do token, resolvido no SQL a cada
  requisição. Nenhum id de conta, entregador ou empresa é aceito do corpo ou da query.
- **JSON** em camelCase; **dinheiro** em string decimal com 2 casas (`"129.05"`); datas
  `YYYY-MM-DD`; instantes ISO 8601 com o offset do fuso da configuração.
- **Erros**: `{erro:'CODIGO', motivo?}`. Genéricos: 400 `DADOS_INVALIDOS` (`motivo` = nome
  do campo), 404 `NAO_ENCONTRADO`, 409 `TRANSICAO_INVALIDA`, 429 `LIMITE_EXCEDIDO`,
  502 `INDISPONIVEL` (PostgREST ou verificação de grupo falhou; fail-closed).
- **Limiters** (chave `cnpjPrestador`): solicitar e cancelar 10 / 15 min; conta bancária
  5 / 15 min (PLANO §20). Leituras seguem sem limiter próprio.
- **Paginação** do app: `?pagina=` (1-based), 20 por página; resposta
  `{itens, total, pagina, porPagina}`.

### GET /motorista/adiantamento/disponibilidade

**Auth**: cookie do motorista. Resposta 200 (PLANO §13; chaves em inglês como no contrato
aprovado):

| Field | Type | Description |
|-------|------|-------------|
| canRequest | boolean | pode solicitar agora |
| reason | string ou null | ver lista abaixo |
| requestDate | date | hoje, no fuso da configuração |
| productionDate | date | `requestDate − 1` (D-1 calendário) |
| timezone | string | `America/Sao_Paulo` |
| openingTime / cutoffTime | `HH:MM` | da versão vigente |
| enabledDays | int[] | 0 = domingo |
| percentage | number | ex.: `60` |
| fee | string | ex.: `"0.35"` |
| paymentForecast | string | texto da configuração |
| nextAvailableAt | string ou null | próximo dia habilitado + abertura, com offset (ex.: `"2026-09-18T09:00:00-03:00"`) |
| estimate | object ou null | `{available, production, gross, fee, net, eligible, final:false}`; `available:false` se a produção D-1 ainda não está disponível (`eligible` também sai `null` nesse caso). `null` só quando a própria configuração/vínculo não existe (mesmos casos em que os demais campos de configuração também saem `null`). **3.8.1** (dec-076): `eligible:false` quando a produção é zero ou o líquido não seria positivo (mesma regra de `hub_adiantamento_calcular_liberacao`) — `net` sai `null` nesse caso, nunca um valor negativo |
| bankAccount | object ou null | `{status, bank:"<código> – <nome>", masked:"Ag. 0001 · CORRENTE ******45-7"}` — 2 dígitos visíveis + `*` (mesmo mascaramento de `hub_conta_bancaria_mascarar`/`GET /conta-bancaria`, decisão 3.2/dec-074; corrige o exemplo antigo `••••4521-7`/4 visíveis, nunca implementado) |
| todayRequest | object ou null | resumo da solicitação do dia (`id`, `status`, `integrationId`) |
| configVersion | int | versão de EXIBIÇÃO da configuração vigente (`AdiantamentoConfiguracao.versao` — o protótipo M06/M15 mostra "versão 3" ao motorista) |
| configuracaoId | bigint | identificador da configuração vigente (`AdiantamentoConfiguracao.id`, PK) — é este valor que `POST /motorista/adiantamentos` espera de volta em `configuracaoId`, NUNCA `configVersion` |

`reason` ∈ `DAY_NOT_ALLOWED`, `BEFORE_OPENING`, `AFTER_CUTOFF`, `ALREADY_REQUESTED`,
`NO_BANK_ACCOUNT`, `BANK_ACCOUNT_PENDING`, `NOT_LINKED`, `NOT_CONFIGURED`,
`MODULE_DISABLED`, `OUTSIDE_GROUP`. Ordem de avaliação: módulo → grupo → vínculo →
configuração → conta bancária → dia → horário → solicitação do dia.

### GET /motorista/adiantamento/regras

200 `{configVersion, configuracaoId, texto, itens:[{titulo, descricao}], aceiteSha256}` — o
texto das regras vigentes, o mesmo que o app mostra na caixa de aceite (R-05, R-18).
`configVersion` é só exibição (`versao`); `configuracaoId` é o identificador (PK) a
devolver em `POST /motorista/adiantamentos`.

### POST /motorista/adiantamentos

| Field | Type | Required | Validation |
|-------|------|----------|------------|
| aceite | boolean | yes | deve ser `true` |
| chaveIdempotencia | uuid | yes | gerada por abertura da tela |
| configuracaoId | bigint | yes | o `configuracaoId` (PK) cujo texto foi aceito — NUNCA `configVersion` (acréscimo à PLANO §16.1 para amarrar o hash à configuração exata, R-05/R-06) |

| Status | Body | Quando |
|---|---|---|
| 201 | detalhe da solicitação (abaixo) | criada em `AGUARDANDO_CORTE` |
| 200 | o mesmo detalhe | reenvio com a mesma `chaveIdempotencia` (edge 11) |
| 400 | `DADOS_INVALIDOS` | `aceite` ausente/falso, uuid inválido |
| 409 | `{erro:'SOLICITACAO_INDISPONIVEL', motivo:<reason>, nextAvailableAt}` | qualquer `reason` da disponibilidade (inclui `ALREADY_REQUESTED`) |
| 409 | `VERSAO_DESATUALIZADA` | a configuração mudou depois de o app mostrar as regras |

### GET /motorista/adiantamentos?pagina=

200 `{itens:[{id, integrationId, dataSolicitacao, dataProducao, status, statusRotulo, valorLiquido}], total, pagina, porPagina}`.

### GET /motorista/adiantamentos/:id

200 com: `id`, `integrationId` (`ADV-000123`), `status`, `motivoStatus`, `dataSolicitacao`,
`dataProducao`, `solicitadaEm`, `configVersion` (versão de EXIBIÇÃO da configuração
GRAVADA com a solicitação, nunca a vigente atual), `calculo` (`null` antes do corte;
depois `{producao, percentual, bruto, taxa, liquido, fonte, calculadoEm}`),
`contaMascarada` (retrato mascarado gravado com a solicitação — `null` até o cálculo,
LIBERADA em diante, nunca a conta atualmente aprovada), `previsaoPagamento` (texto da
configuração usada nesta solicitação, nunca a vigente atual),
`timeline:[{etapa, status, ocorridoEm, motivo}]`
(etapas da PLANO §11.1, com os ramos de rejeição, inelegível, falha, pendência e
cancelada). 404 se não for do motorista.

### POST /motorista/adiantamentos/:id/cancelar

200 com o detalhe (`CANCELADA`). 409 `TRANSICAO_INVALIDA` fora de `AGUARDANDO_CORTE` ou
depois do corte (edge 22). 404 se não for do motorista.

### GET /motorista/conta-bancaria

200 `{aprovada, pendente, ultimaRejeicao}`; cada item mascarado:
`{id, status, banco, agencia, contaMascarada, tipoConta, titularNome, documentoMascarado,
chavePixTipo, emailComprovante, solicitadaEm, motivoRejeicao}`.

Mascaramento (decisão 3.2/dec-074): o Node nunca vê os dígitos crus da própria conta
(RLS sem `SELECT`, só `hub_conta_bancaria_mascarar` — mesmo caminho de
`GET /adiantamento/disponibilidade`/`GET /adiantamentos/:id`) — 2 dígitos visíveis,
prefixo `*` (não `•`/4 visíveis; **narrower discloure**, mesma convenção em toda a app
do motorista). Exemplos reais: `contaMascarada:"******45-7"`,
`documentoMascarado:"***.***.***-41"` (CPF) / `**.***.***/****-90"` (CNPJ),
`emailComprovante:"jo••••@•••.com"` (prefixo de 2 chars do local-part + domínio
reduzido à extensão, igual ao protótipo M12/M13). `chavePixTipo` sai sem máscara (é só
o enum, não revela a chave).

### POST /motorista/conta-bancaria/solicitacoes

| Field | Type | Required | Validation |
|-------|------|----------|------------|
| titularNome | string | yes | 1–120 após aparar |
| titularDocumento | string | yes | CPF (11) ou CNPJ (14) com DV válido; aceita máscara |
| bancoCodigo | string | yes | 3 dígitos na lista COMPE |
| agencia | string | yes | até 4 dígitos, normalizada para 4 |
| conta | string | yes | 1–20 dígitos, zeros preservados |
| contaDigito | string | yes | `[0-9]` |
| tipoConta | string | yes | `CORRENTE` ou `POUPANCA` |
| chavePixTipo | string | no | `CPF` ou `CNPJ` ou `EMAIL` ou `TELEFONE` ou `ALEATORIA` |
| chavePix | string | se `chavePixTipo` | validada pelo tipo |
| emailComprovante | string | no | e-mail válido, até 254 |

201 com a conta `PENDENTE` (mascarada); uma `PENDENTE` anterior vira `CANCELADA`. 400
`DADOS_INVALIDOS` com `motivo` = campo (FR-016). 409 `{erro:'SOLICITACAO_INDISPONIVEL',
motivo:'NOT_LINKED'}` sem vínculo. 409 `{erro:'SOLICITACAO_INDISPONIVEL', motivo:'OUTSIDE_GROUP'}`
com módulo ativo para empresa fora do grupo Movee (12.1, mesma defesa em profundidade de
`POST /adiantamentos`).

### GET /motorista/bancos?q=

200 `{itens:[{codigo:"260", nome:"Nu Pagamentos"}]}` — até 20, busca por código ou nome.

### Notificações

| Método e caminho | Resposta |
|---|---|
| `GET /motorista/notificacoes?pagina=&categoria=&naoLidas=` | `{itens:[{id, categoria, titulo, corpo, link, criadaEm, lida}], total, pagina, porPagina}` |
| `GET /motorista/notificacoes/nao-lidas` | `{total}` |
| `POST /motorista/notificacoes/:id/lida` | 204 (idempotente; 404 se não for do CNPJ) |
| `POST /motorista/notificacoes/lidas` | 204 |

`categoria` ∈ `adiantamento`, `pagamento`, `conta_bancaria`, `sistema`, `aviso`. `link`
vem da allowlist (`/adiantamento`, `/adiantamento/<id>`, `/conta-bancaria`,
`/avisos/<id>`, `/repasse`); o app valida de novo antes de navegar.

### GET /motorista/repasse

200 `{periodoInicio, periodoFim, dataRepasse, situacao:"EM_APURACAO"|"FECHADA",
creditos, adiantamentos:[{id, integrationId, dataProducao, valorBruto, emProcessamento}],
debitos, remanescente, negativo}`. 404 `{erro:'NAO_DISPONIVEL'}` quando
`repasse_visivel_app = false` ou a apuração não está configurada (D-13).

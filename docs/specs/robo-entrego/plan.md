# Implementation Plan: Robô de Importação EntreGô

**Feature**: `robo-entrego` | **Date**: 2026-08-27 | **Spec**: [spec.md](./spec.md)

## Summary

Substituir a coleta manual diária dos relatórios Performance e Financeiro do portal
do franqueado EntreGô por uma rotina Node.js agendada (systemd timer, mesmo padrão
já em produção de `infra/producao/backup-producao.*`), que: (1) reusa uma sessão do
hub (login a cada execução, sem risco de anti-bot) para enviar os arquivos ao
endpoint já existente `POST /api/v1/importacoes`; (2) mantém uma sessão PERSISTIDA e
reutilizada do portal EntreGô (Playwright + `storageState`), só refazendo o login
completo — a etapa frágil, sujeita a PerimeterX/Akamai — quando uma chamada
retornar `401`; (3) lê o código de 2FA por IMAP (Gmail, senha de app); (4) para e
alerta imediatamente diante de qualquer sinal de desafio anti-bot, nunca tenta
contornar; (5) em falha definitiva, produz as três reações exigidas por FR-013 (log
+ e-mail + auditoria do hub — esta última via um endpoint novo e mínimo, proposto
neste plano, porque hoje não existe escrita pública em `Auditoria`).

## Technical Context

**Language/Version**: Node.js (mesma convenção do resto do repositório — sem
precedente de outro runtime; roda dentro da imagem oficial `mcr.microsoft.com/playwright:v1.61.1-jammy`, que inclui Node)
**Primary Dependencies**: `playwright` (automação do portal — mesma versão pinada
`^1.61.1` já usada como devDependency em `frontend_v2/package.json`), `imapflow`
(leitura do código 2FA por IMAP — novo), `nodemailer` (alerta por e-mail — novo),
`axios` (chamadas HTTP ao hub e download de CSV do S3 — já é dependência do backend,
`app_homologacao/backend/package.json`, reaproveitada por convenção, não por
`require` cross-projeto)
**Storage**: nenhuma nova (arquivos em disco: `storageState` do Playwright, log
JSON Lines, config `.env`/`config.json` — ver data-model.md). Dados de negócio
persistem só no hub (`ImportacaoArquivo`, `Auditoria` — tabelas já existentes)
**Testing**: `node --test` (mesma ferramenta usada em `app_homologacao/backend`,
`npm test`) para unit (parsing de e-mail/código, taxonomia de erro, geração de
mensagem); Playwright para o fluxo de login contra fixture/mock (nunca contra o
portal real de produção do franqueado a partir de execução automatizada); roundtrip
real contra `hub-homolog` para o endpoint novo (quickstart.md Scenario 6)
**Target Platform**: host `VPSTodo`, fora de Docker Swarm — `systemd` timer +
`docker run` sob demanda da imagem Playwright (mesmo padrão de
`infra/producao/backup-producao.service`, que já roda fora do Swarm com
`Requires=docker.service`)
**Project Type**: script batch agendado (CLI/one-shot), não um serviço HTTP — não
expõe porta, não é roteado por Traefik
**Performance Goals**: SC-002 (alerta em até 15 min após falha definitiva) — não há
meta de throughput (2 arquivos/execução, 1-2 execuções/dia)
**Constraints**: zero contorno de anti-bot (restrição inegociável do projeto); zero
instalação de browser no host (`bash-guard.sh` bloqueia; sempre containerizado);
segredos SOMENTE em `/var/lib/hub_secrets/`; execução tem `Nice=10` +
`IOSchedulingClass=idle` (não competir com tráfego de cliente no host)
**Scale/Scope**: 1 franquia (Movee/EntreGô), 2 tipos de relatório, 1-2 execuções/dia
— escopo deliberadamente pequeno (YAGNI: nenhuma abstração multi-portal/multi-franquia)

## Constitution Check

*GATE: Deve passar antes do Phase 0. Re-checar após Phase 1.*

| Princípio | Status | Notas |
|-----------|--------|-------|
| I. Segurança de Autenticação & Segredos | PASS | Credenciais do robô (portal EntreGô, IMAP/SMTP, usuário de serviço do hub) ficam em `/var/lib/hub_secrets/robo-entrego/.env`, fora do git, com `.env.robo-entrego.example` versionado — mesmo padrão já usado pelo hub (`.env.hub.*`). A comunicação com o hub em si já é JWT em cookie httpOnly (nada muda nesse contrato, o robô só passa a ser mais um CLIENTE dele). Nenhum segredo passa a existir em log (log JSON Lines nunca inclui campos de credencial; `scrubDetalhes` já filtra o corpo enviado à Auditoria). |
| II. Isolamento Multi-Tenant por Empresa | PASS | O robô NUNCA envia `id_empresa` no corpo de nenhuma requisição — a entidade é sempre resolvida pelo hub a partir da claim `entidade_ativa` do token do usuário de serviço (igual a qualquer outro cliente da API). `HUB_ID_EMPRESA` na configuração do robô é só uma CONFERÊNCIA pós-login (falha aí é erro de configuração, não bypass de escopo). |
| III. Contratos de API & Proxy de Cookies | N/A | Esse princípio rege a comunicação frontend_v2 ↔ backend via proxy Next.js (`app/api/[...path]`) para clientes BROWSER. O robô é um cliente backend-to-backend (script Node chamando a API HTTP diretamente, com seu próprio cookie jar) — não um cliente de browser, não passa pelo proxy, não é o caso que o princípio governa. |
| IV. Qualidade e Revisão de Mudanças | PASS (com gate pendente) | Trabalho em branch dedicada, Conventional Commits — sem exceção. A cláusula SHOULD de revisão de segurança (autenticação + upload) é diretamente aplicável aqui (login automatizado + envio de arquivo) — coberta pelo gate `owasp-security` desta pipeline, a rodar logo após este plano (ver "## Quality Gates" do orquestrador). |
| V. Deploy Conteinerizado e Convivência de Serviços | PASS (com nota) | O robô NÃO é um "serviço" no sentido do princípio (não fica no ar, não escuta porta, não é roteado por Traefik) — é um job batch disparado por `systemd timer` que faz `docker run --rm` sob demanda, mesmo padrão já em produção (`infra/producao/backup-producao.service`, que também roda fora do Swarm/Traefik). Não disputa porta 80/443, não afeta containers já em produção (`Nice=10`+`IOSchedulingClass=idle` cede recursos). Instalação do timer no host é ADITIVA (unit files novos, nomes exclusivos `robo-entrego.*`) — nenhum serviço existente é tocado. |

Nenhuma violação de princípio MUST. Segue para Phase 0/1.

## Project Structure

### Documentation (this feature)

```
docs/specs/robo-entrego/
├── spec.md
├── plan.md          # This file
├── research.md      # Phase 0 output
├── data-model.md     # Phase 1 output
├── quickstart.md     # Phase 1 output
└── contracts/         # Phase 1 output
    ├── entrego-portal.md   # contrato externo (portal do franqueado, medido)
    └── hub-api.md           # contrato interno (endpoints do hub, existentes + 1 proposto)
```

### Source Code (repository root)

Segue o padrão real já existente em `infra/producao/` (script + unit + timer,
irmãos, sem subpastas) e `infra/hub/` (scripts/, migrations/, testes/ — quando o
volume justifica subpastas). Como o robô tem lógica Node não-trivial (parsing,
taxonomia de erro, chamadas HTTP, automação de browser), a estrutura fica mais
próxima de `infra/hub/scripts/` do que do único arquivo `.sh` de `infra/producao/`:

```
infra/robo-entrego/
├── README.md                      # operação: como instalar timer, rodar manualmente, ler logs
├── package.json                   # deps: playwright, imapflow, nodemailer, axios
├── config.json                    # horários (FR-009) — não-segredo, versionado
├── .env.robo-entrego.example      # template do segredo (real fica em /var/lib/hub_secrets/robo-entrego/.env)
├── src/
│   ├── index.js                   # orquestração da rotina (entrypoint)
│   ├── entrego-portal.js          # login 4 passos + fetch de urls (Playwright)
│   ├── imap-codigo.js             # leitura do código 2FA
│   ├── hub-client.js              # login + upload + polling no hub (axios)
│   ├── alerta-email.js            # nodemailer
│   ├── log-execucao.js            # escrita JSON Lines (data-model.md)
│   └── taxonomia-erro.js          # research.md Decision 11
├── test/
│   └── *.test.js                  # node --test — unit puro, sem rede real
├── scripts/
│   ├── docker-run.sh              # wrapper: docker run da imagem Playwright + bind mounts
│   └── gerar-timer.sh             # regenera OnCalendar= a partir de config.json (Decision 7)
├── robo-entrego.service           # systemd oneshot (ExecStart=scripts/docker-run.sh)
├── robo-entrego.timer             # systemd timer (OnCalendar= múltiplo)
└── sql/
    └── 001-usuario-servico-robo-entrego.sql   # cadastro do usuário de serviço + grant importacoes.criar (id_empresa=6) — artefato para o operador aplicar, não executado por esta pipeline
```

Alteração ADITIVA no backend do hub (endpoint proposto, `research.md` Decision 9):

```
app_homologacao/backend/
├── routes/hub-robo-entrego.js     # NOVO — POST /api/v1/robo-entrego/eventos
└── server.js                      # + 1 linha: app.use('/api/v1/robo-entrego', ...)
```

**Structure Decision**: `infra/robo-entrego/` como diretório-irmão de `infra/hub/` e
`infra/producao/` — consistente com "cada preocupação de infraestrutura isolada em
seu próprio diretório na raiz de `infra/`", já estabelecido pelos dois precedentes
existentes. O robô NÃO vira um novo serviço dentro de `app_homologacao/` (não é
parte do produto Swarm) — só o endpoint novo de auditoria toca o backend existente,
e de forma mínima (1 rota + 1 mount line).

## Convenções de Borda

O robô é majoritariamente uma feature single-layer do ponto de vista de "camadas
internas" (não tem banco próprio, não tem frontend) — mas atravessa DUAS fronteiras
HTTP externas que precisam de convenção declarada explicitamente, porque os dois
lados usam convenções DIFERENTES de nome de campo (achado real, não hipotético):

| Fronteira | Case style | Validação | Fonte da verdade |
|-----------|------------|-----------|-------------------|
| Portal EntreGô — request (BFF) | camelCase (`initialDate`, `finalDate`) | nenhuma do nosso lado — API de terceiro | `contracts/entrego-portal.md` (medido) |
| Portal EntreGô — tipo de relatório | UPPER_SNAKE (`PERFORMANCE`, `FINANCE`) | tradução explícita no robô | `contracts/entrego-portal.md` §GET .../urls |
| Hub — request `POST /api/v1/auth/login` | mistura: `email` (inglês) + `senha` (português) | nenhuma — reproduzir literalmente | `contracts/hub-api.md` §login (verificado no código) |
| Hub — request `POST /api/v1/importacoes` | `tipo` em português, valores lower_snake (`faturamento`, `performance`) | `TIPOS_SUPORTADOS` no backend | `lib/hub-import-parser.js:42` |
| Hub — claim do JWT | snake_case (`entidade_ativa`) | decodificado, nunca reconstruído pelo robô | `lib/hub-access-token.js` (verificado no código) |
| Hub — response `GET /importacoes/:id` | camelCase (`dataReferencia`, `erroResumo`) | consumo read-only pelo robô | `contracts/hub-api.md` (fonte: contrato ratificado de `hub-importacoes`) |

**Mapper layer**: `src/entrego-portal.js` traduz `PERFORMANCE`→`performance` e
`FINANCE`→`faturamento` num único ponto (data-model.md, campo `tipo_hub`) — nenhuma
outra parte do robô reimplementa essa tradução.

**Validação**: nenhum Zod/schema formal introduzido (ladder: 2 campos de tradução
fixos não justificam uma dependência de validação nova) — a tradução é uma tabela
de 2 entradas (`const TRADUCAO_TIPO = { PERFORMANCE: 'performance', FINANCE:
'faturamento' }`), testada por unit test (`test/taxonomia-erro.test.js` ou
equivalente).

## Complexity Tracking

Nenhuma violação de princípio MUST da constitution — tabela não aplicável.

### Riscos declarados (não são violações de constitution, mas afetam o backlog)

| Risco | Impacto | Mitigação no plano |
|-------|---------|---------------------|
| Colunas do CSV do EntreGô podem não bater com o normalizer do hub (research.md Decision 10) | Upload pode falhar/ser rejeitado (`422`) mesmo com o robô funcionando corretamente | Tarefa dedicada em `create-tasks`: baixar 1 CSV real de cada tipo e comparar ANTES de codificar o upload |
| Causa raiz do `401` do `fetch` fora do browser nunca foi identificada (ACHADOS-PORTAL.md §3) | Design assume que `page.evaluate` contorna — não 100% garantido até testar | `quickstart.md` Scenario 1/2 validam empiricamente na primeira execução real (ambiente controlado, não produção do franqueado) |
| Assinatura de desafio anti-bot nunca foi observada (nunca ocorreu durante o levantamento) | Detecção é conservadora (qualquer desvio estrutural), pode ter falsos positivos | Aceitável: falso positivo só gera alerta extra (barato); falso negativo (não detectar e tentar contornar) é o risco que a restrição inegociável do projeto proíbe — a assimetria justifica a postura conservadora |
| Endpoint `POST /api/v1/robo-entrego/eventos` é proposta nova, não testada em produção | Auditoria de falhas pré-upload depende de código novo no backend | `quickstart.md` Scenario 6 exige roundtrip real contra `hub-homolog` antes de considerar a tarefa concluída |

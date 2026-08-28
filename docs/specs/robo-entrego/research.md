# Research: Robô de Importação EntreGô

Documento produzido no Phase 0 do `/plan`. Todas as decisões abaixo se apoiam em
`docs/plans/robo-entrego/ACHADOS-PORTAL.md` (medição ao vivo no portal real) e em
leitura direta do código-fonte deste repositório — nunca em suposição (Constitution
não tem princípio de veracidade de dados explícito, mas o Principio VI do toolkit
SDD deste projeto exige a mesma disciplina: nada de endpoint/seletor/campo inventado).

## Decision 1: Runtime e linguagem

**Decision**: Node.js (mesma major do backend do hub — `node:20-alpine`/`node:20` —
sem exigência de paridade exata, mas evita introduzir um segundo runtime no projeto).

**Rationale**: o projeto inteiro (backend, frontend_v2, frontend_motorista) é
Node/TypeScript-adjacente; não há precedente de script Python neste repositório. Um
robô Node reaproveita convenções já conhecidas do time (axios para HTTP, npm para
deps) e roda dentro da MESMA imagem Playwright oficial usada em
`infra/hub/testes/hub-shell-e2e-browser.sh` (`mcr.microsoft.com/playwright`, que já
inclui Node).

**Alternatives considered**: Python + Playwright-Python — rejeitado por introduzir
um runtime novo no host sem nenhum precedente no projeto (viola a convenção
"stdlib/já-existente antes de dependência nova" — aqui, "convenção já existente no
projeto" antes de convenção nova).

## Decision 2: Automação da sessão do portal EntreGô — Playwright containerizado, sessão E chamadas de API dentro do browser

**Decision**: TODA interação com o portal EntreGô (checagem de sessão viva, os 4
passos de login quando necessário, e as chamadas ao BFF de relatórios) roda dentro
de um contexto Playwright com `storageState` persistido — nunca via HTTP client puro
(axios) fora do browser para essas chamadas específicas. Comando de execução:
`docker run --rm -v <script-dir>:/work -v /var/lib/hub_secrets/robo-entrego:/secrets
mcr.microsoft.com/playwright:v1.61.1-jammy node /work/index.js` — mesma versão pinada
já usada como devDependency (`app_homologacao/frontend_v2/package.json`,
`@playwright/test: ^1.61.1`) e como imagem de driver E2E
(`infra/hub/testes/hub-shell-e2e-browser.sh`). Download dos CSVs (URLs pré-assinadas
do S3, achado §4) e as chamadas ao hub (`/api/v1/auth/login`, `/api/v1/importacoes`)
NÃO precisam do browser — são feitas com HTTP client puro (axios) dentro do mesmo
processo Node.

**Rationale**: ACHADOS-PORTAL.md §3 mediu que um `fetch` do console do browser, com
os MESMOS headers e `credentials:'include'`, recebe `401` — só o `XMLHttpRequest`
disparado pelo próprio app passa. A causa raiz **não foi verificada**
(candidatos anotados: PerimeterX, `withCredentials` do axios, ordem/origem da
requisição) e o achado é explícito: "resolver na implementação — o caminho seguro é
chamar a API de dentro da página (`page.evaluate`), herdando a sessão do browser".
Reproduzir headers manualmente via axios fora do browser é exatamente o padrão que já
falhou uma vez (o `fetch` do console) — não há garantia de que replicá-lo com axios
teria resultado diferente, e a superfície de risco (acionar PerimeterX/Akamai por um
padrão de requisição fora do fluxo normal do app) é uma das restrições inegociáveis
do projeto. `page.evaluate` herda literalmente o mesmo `fetch`/cookies/origin que o
app usa quando funciona.

**Alternatives considered**:
- Replicar headers via axios fora do browser — rejeitado: reproduz exatamente o
  padrão que falhou no achado, sem entender a causa raiz (não verificada).
- Extrair só o cookie de sessão do `storageState` e usar em axios — mesmo risco do
  item acima; o cookie sozinho é insuficiente segundo o achado (headers "corretos" +
  `credentials:'include'` já foram tentados e falharam no console).

## Decision 3: Persistência de sessão do portal EntreGô

**Decision**: `storageState` do Playwright (cookies + `localStorage`, formato JSON
nativo da própria lib) salvo em `/var/lib/hub_secrets/robo-entrego/entrego-session.json`
(fora do git, mesmo diretório-padrão de segredos do hub), permissão `600`. A cada
execução: carregar o `storageState` se existir, tentar uma chamada leve dentro do
browser (`page.evaluate` de `GET .../operation/users/authentication/me` — já
mapeada no achado §7 como parte do próprio fluxo de login, passo 4) para validar a
sessão; `401` (ou ausência de `storageState`) dispara o fluxo de login completo (FR-016
da spec — decisão do operador em `block-003`: duração da sessão NÃO é medida nem
assumida, só descoberta por tentativa).

**Rationale**: é o mecanismo nativo do Playwright para persistir sessão de browser
entre execuções — sem inventar formato próprio de serialização de cookies. Reduz a
frequência de login completo (a etapa frágil, sujeita a PerimeterX/Akamai) ao mínimo
necessário, exatamente como o operador pediu.

**Alternatives considered**: medir e fixar TTL da sessão antecipadamente — descartado
explicitamente pelo operador (`block-003`, requisito dissolvido).

## Decision 4: Leitura do código de 2FA — IMAP

**Decision**: biblioteca `imapflow` (cliente IMAP moderno, baseado em Promises, ativo
e amplamente adotado no ecossistema Node) para conectar em `imap.gmail.com:993`
(TLS implícito) com autenticação por senha de app, filtrar mensagens não lidas com
assunto "Código de Acesso" recebidas **após** o timestamp do disparo de
`POST authentication/validate` (achado §7, passo 2), e extrair o código de 6 dígitos
do corpo.

**Rationale**: não há dependência IMAP já instalada em nenhum `package.json` deste
repositório (`app_homologacao/backend/package.json` não lista `imapflow`,
`node-imap` nem `nodemailer`) — biblioteca nova é necessária (ladder rung 5: melhor
dependência já instalada resolve; não há uma). `imapflow` foi escolhido sobre a
alternativa mais antiga `node-imap` por ter API baseada em `async/await` nativa
(menos código de integração que uma API baseada em callback/EventEmitter).

**Alternatives considered**: `node-imap` (mais antigo, API por evento — mais código
de integração para o mesmo resultado); ler e-mail via API do Gmail (OAuth2) —
rejeitado pelo próprio operador em `block-001` (senha de app, não OAuth2, porque a
conta usa 2FA e simplifica o provisionamento).

**Hardening obrigatório (gate `owasp-security`, achado MEDIUM)**: a senha de app dá
acesso à caixa INTEIRA (`paulo@todo-tips.com`), não só às mensagens de código — o
robô MUST:
1. Abrir a mailbox em modo **read-only** (`readOnly: true` do `imapflow`, ou
   equivalente a `\Peek` do protocolo IMAP) — nunca marcar como lida, nunca mover,
   nunca deletar. Least privilege de comportamento mesmo com credencial de escopo
   amplo.
2. Validar o CONTEÚDO extraído do e-mail com regex estrito `^\d{6}$` antes de
   preencher `input#code` no portal — nunca repassar texto livre do corpo do e-mail
   para o formulário. Fecha um vetor de e-mail spoofing: alguém que consiga entregar
   uma mensagem com assunto "Código de Acesso" para essa caixa (SPF/DKIM não
   verificados pelo robô) na janela certa poderia tentar fazer o robô submeter um
   código incorreto — o pior caso, com a validação de formato + timestamp já
   especificada, é o robô falhar a tentativa (cai em FR-012, retry) e nunca é um
   vetor de submissão de conteúdo arbitrário no formulário do portal.

## Decision 5: Envio do alerta de falha — SMTP com a mesma credencial do IMAP

**Decision**: `nodemailer` via SMTP do Gmail (`smtp.gmail.com:465`, TLS implícito),
reusando a MESMA senha de app já provisionada para IMAP (mesma conta
`paulo@todo-tips.com`, mesma credencial — não há necessidade de uma segunda senha de
app). Destinatário(s) vêm do arquivo de configuração (lista, não valor único — FR-014
+ resposta do operador em `block-004`).

**Rationale**: Google Workspace permite usar a MESMA senha de app para IMAP e SMTP
(escopo "Mail" da conta); criar uma segunda credencial só para envio seria
duplicação sem benefício. `nodemailer` é a biblioteca de fato padrão do ecossistema
Node para SMTP (nenhuma alternativa amplamente usada compete em simplicidade para
este caso de uso — envio pontual, sem fila, sem template engine).

**Alternatives considered**: reaproveitar algum serviço de e-mail transacional já
usado pelo projeto — não encontrado nenhum (grep em `package.json` do backend não
lista `nodemailer`, `sendgrid`, `ses` nem similar; o hub nunca envia e-mail hoje).

## Decision 6: Agendamento — systemd timer no host (mesmo padrão de `infra/producao/`)

**Decision**: `systemd` oneshot service + timer, seguindo EXATAMENTE o padrão já em
produção em `infra/producao/backup-producao.{sh,service,timer}` — script wrapper no
host que faz `docker run` da imagem Playwright, `Nice=10` + `IOSchedulingClass=idle`
(o robô não é urgente o suficiente para competir com tráfego de cliente), log em
stdout/journal. Horários vêm de um arquivo de configuração lido pelo timer (ou por
múltiplas unidades `.timer` geradas a partir da config — ver Decision 7) — nunca
hardcoded na unit, para satisfazer FR-009 (mudar horário sem alterar código/deploy).

**Rationale**: é o único precedente real de "tarefa agendada batch, fora de
container Swarm" já em produção neste host, resolvido, testado e documentado. Reusar
em vez de inventar um mecanismo novo (Swarm cron sidecar, `node-cron` dentro de um
serviço always-on, etc.) é a opção mais simples e a que menos introduz risco de
colidir com os serviços já rodando (Constitution V: novas instalações não podem
afetar containers em produção nem disputar portas 80/443 — um systemd timer que só
dispara `docker run` sob demanda, sem expor porta nenhuma, satisfaz isso
trivialmente).

**Alternatives considered**:
- `node-cron`/`setInterval` dentro de um processo Node always-on — rejeitado: exigiria
  um novo serviço de longa duração (violaria a simplicidade do batch job e
  aumentaria a superfície de "serviço vivo" a monitorar, sem necessidade — a rotina
  roda 1-2x/dia).
- Cron do sistema (`crontab`) em vez de systemd timer — tecnicamente equivalente,
  mas o precedente real do projeto (`backup-producao`) já usa systemd timer com
  `list-timers`/`journalctl` como interface operacional conhecida pelo operador;
  manter o MESMO mecanismo é mais previsível que introduzir um segundo.

## Decision 7: Múltiplos horários por dia (FR-009) sem editar código

**Decision**: uma unidade `robo-entrego@.timer` **templated** do systemd (uma
instância por horário configurado, ex.: `robo-entrego@0800.timer`,
`robo-entrego@1830.timer`), cada uma com `OnCalendar=` derivado do horário — OU,
alternativa mais simples ainda, um `robo-entrego.timer` único com MÚLTIPLAS linhas
`OnCalendar=` (o systemd aceita `OnCalendar=` repetido na mesma unit para múltiplos
disparos). A segunda opção é a escolhida por não exigir gerar/instalar unidades
dinamicamente — um arquivo de configuração (`config.yaml`/`.env`) alimenta um script
gerador de unit (`scripts/gerar-timer.sh`, rodado manualmente pelo operador ao mudar
horários) que reescreve a lista de `OnCalendar=` e roda `systemctl daemon-reload`.
Isso mantém "mudar horário = editar configuração" (FR-009) sem exigir alteração de
CÓDIGO da rotina em si — só reaplicar a unit (operação de infraestrutura, não deploy
de aplicação).

**Rationale**: `OnCalendar=` múltiplo é um recurso nativo e documentado do systemd —
zero dependência nova, zero geração dinâmica complexa. É consistente com o padrão
`infra/producao/*.timer` já existente (arquivo estático, gerido pelo operador).

**Alternatives considered**: agendamento interno ao script Node (ex.: ler
`config.yaml` e ele mesmo decidir "é hora de rodar?") com o systemd disparando a cada
minuto — rejeitado: reintroduz um "serviço sempre ativo" de fato (roda a cada
minuto só para checar), contrariando a simplicidade do padrão oneshot já usado.

## Decision 8: Lock contra execução concorrente (FR-010)

**Decision**: `flock` (utilitário POSIX padrão, sempre presente no host Linux) sobre
um arquivo de lock fixo (`/var/lib/hub_secrets/robo-entrego/robo-entrego.lock`) no
início do script wrapper do systemd, com `flock -n` (non-blocking): se já há uma
execução em andamento, a nova simplesmente desiste (log + exit) — não fica em fila
indefinida (a spec exige "aguarda ou é descartada, nunca roda em paralelo", e
`flock -n` implementa a opção "descartada", mais simples de implementar
corretamente que uma fila).

**Rationale**: `flock` já é usado no ecossistema systemd/shell Linux como o
mecanismo padrão de mutex entre processos — nenhuma dependência nova, funciona
mesmo se dois `systemd timer` diferentes dispararem ao mesmo tempo (cenário do
Acceptance Scenario 2 da User Story 4).

**Alternatives considered**: lock a nível de aplicação (arquivo `.pid` + checagem
manual) — rejeitado: `flock` já resolve isso de forma atômica e testada pelo
kernel, reinventar checagem de PID é mais código para o mesmo resultado (ladder
rung 3/4: "stdlib"/"feature nativa da plataforma" cobre).

## Decision 9: Trilha de auditoria do hub para falhas ANTES do upload (FR-013, gap descoberto)

**Decision**: novo endpoint mínimo no backend do hub, `POST /api/v1/robo-entrego/eventos`
— **[PROPOSTA — a validar na implementação, não existe hoje]** — protegido pela MESMA
permissão `importacoes.criar` já concedida à identidade de serviço (nenhuma permissão
nova precisa ser criada), que resolve `id_empresa` da claim `entidade_ativa` do token
(mesmo padrão de `routes/hub-importacoes.js:217-227`) e delega para a função interna
já existente `registrarAuditoria()` (`lib/hub-auditoria.js`) com `recurso: 'RoboEntrego'`,
`acao` e `detalhes` vindos do corpo. Ver `contracts/hub-api.md`.

**Rationale**: FR-013 exige que TODA falha definitiva registre evento na auditoria do
hub — não só as que chegam a tentar o upload. Mas `registrarAuditoria()` é uma função
interna do backend, sem endpoint HTTP público hoje (grep confirmado em
`routes/hub-me.js`: só existe `GET /api/v1/auditoria`, leitura). Sem um endpoint de
escrita, uma falha de login no portal EntreGô (o caso mais provável de falha
definitiva, dado o risco de PerimeterX) nunca chegaria à Auditoria — quebrando FR-013
justamente no cenário mais comum. A tabela `Auditoria` (migration
`infra/hub/migrations/0004_auditoria.sql`) já tem as colunas necessárias
(`acao text`, `recurso text`, `detalhes jsonb`) — zero migration nova, só uma rota
que reusa a função de escrita já existente e testada.

**Alternatives considered**:
- Deixar de fora a auditoria do hub para falhas pré-upload, cumprindo só log+e-mail
  — rejeitado: contradiz FR-013 MUST explicitamente ("as três reações... nunca só
  uma").
- Robô assina um JWT de claims e chama o PostgREST diretamente — rejeitado: exigiria
  o robô ter acesso ao `JWT_SECRET` do backend (segredo interno do processo backend,
  nunca distribuído a um cliente externo) — violaria Constitution I ("segredos vivem
  em `.env` fora do git" não é sobre isso, mas o princípio geral de não distribuir
  segredos de assinatura para fora do processo que os possui é o mesmo espírito).

**Hardening obrigatório (gate `owasp-security`, achados MEDIUM)**:
1. **`acao` é allowlist, não texto livre** — o handler MUST validar `acao` contra um
   conjunto fechado (`robo_entrego.sucesso`, `robo_entrego.falha_definitiva`,
   `robo_entrego.suspeita_antibot`, `robo_entrego.falha_configuracao`), `422` para
   qualquer outro valor. Sem isso, o endpoint vira um canal de escrita de texto
   arbitrário na trilha de auditoria imutável (poluição/desinformação de auditoria).
2. **Reuso de `importacoes.criar` é um trade-off documentado, não uma decisão
   silenciosa**: qualquer credencial que já tenha essa permissão passa a poder
   registrar eventos como `RoboEntrego` — aceitável enquanto o único portador dessa
   permissão for o usuário de serviço do robô (situação de hoje), mas se uma segunda
   automação futura também ganhar `importacoes.criar`, ela herdaria a capacidade de
   escrever nesse `recurso` também. Caso isso passe a ser um problema real, a correção
   é introduzir uma permissão dedicada (`robo_entrego.eventos.criar`) — não fazer
   isso agora é YAGN, mas o limite está documentado aqui para não ser esquecido.
3. **Tamanho de payload**: já coberto pelo limite global existente
   `app.use(express.json())` (`server.js:179`, sem `limit` explícito = default do
   `body-parser`, 100kb) — nenhum limite adicional necessário só para esta rota.
4. **Rate limiting**: não é crítico dado o volume esperado (poucas chamadas/dia),
   mas como o corpo é escrita em tabela imutável, aplicar o MESMO
   `authRateLimiter` (ou equivalente) já usado em `/api/v1/auth/login` é uma
   defesa barata contra uso indevido da credencial de serviço para flood de
   auditoria — recomendado, não bloqueante.

## Decision 10: Mapeamento de colunas do CSV — RESOLVIDO (2026-08-27, dec-027)

**Decision original**: o plano NÃO afirmava que as colunas do CSV do EntreGô
(`performance-report_*.csv`, `finance-report_*.csv`) batiam 1:1 com o schema
esperado pelos normalizadores existentes do hub (`lib/hub-import-normalizer.js`,
`lib/hub-import-hash.js` — mapeiam campos por `tipo` para
`performance`/`faturamento`). Isso não tinha sido medido: ACHADOS-PORTAL.md
registrava os PATHS dos arquivos baixados, não o cabeçalho/colunas internas.

**Rationale**: Principio VI (Zero Fabricação) — inventar nomes de coluna sem ter
aberto um CSV real seria exatamente o tipo de dado factual que não pode ser suposto.

**Achado real (tarefa 1.1, operador forneceu os cabeçalhos dos 2 relatórios
baixados do portal em 2026-08-27)**: comparação programática contra
`HEADER_PERFORMANCE`/`HEADER_FATURAMENTO` de `lib/hub-import-normalizer.js`:

- `performance`: 19/19 colunas — 0 faltando, 0 extra, ordem idêntica.
- `faturamento`: 20/20 colunas — 0 faltando, 0 extra, ordem idêntica.
- Delimitador do CSV real observado = `;` (ponto-e-vírgula), igual ao
  `DELIMITADOR = ';'` já usado por `lib/hub-import-parser.js:40`.

**Conclusão**: **nenhuma camada de conversão/tradução de coluna é necessária.**
O robô envia o CSV exatamente como veio do portal, sem transformação de
cabeçalho. FASE 3 (`hub-client.js`) do backlog está destravada — não há
escopo de mapeamento a implementar. Não reabrir esta investigação nem
especificar normalização de colunas para este fluxo.

## Decision 11: Taxonomia de erro (o que é retry, o que é parada imediata, o que é sucesso)

**Decision**:

| Sinal | Classificação | Reação |
|---|---|---|
| Timeout de rede, erro de conexão, 5xx do portal ou do hub | Transitório | retry automático (FR-012: até 3x, backoff 1/5/15 min) |
| `401` na chamada de sessão salva do EntreGô | Não é falha | login completo (FR-016), sem contar como tentativa/retry |
| Resposta estruturalmente diferente da mapeada em ACHADOS-PORTAL.md (schema inesperado, HTML no lugar de JSON, elemento de login não aparece dentro do timeout) | Suspeita de desafio anti-bot | **parada imediata da rodada + alerta** (FR-011) — nunca contada como transitória, nunca retry |
| `201` do `POST /api/v1/importacoes` | Sucesso (aceito, ainda `pending`) | poll `GET /:id` até status terminal |
| `409 CONFLITO` do `POST /api/v1/importacoes` | Sucesso idempotente (FR-008) | trata como concluído, não retry, não alerta |
| `422 INVALIDO` do `POST /api/v1/importacoes`, ou status terminal `failed`/`completed_with_errors` do polling | Falha do hub ao processar (edge case da US3, cenário 3) | registra motivo (campo `motivo`/`erroResumo` do contrato) de forma legível — não é ambíguo com desafio anti-bot |
| Esgotadas as 3 tentativas transitórias, OU suspeita de anti-bot confirmada, OU falha estrutural do hub sem retry aplicável | Falha definitiva da rodada | as 3 reações simultâneas de FR-013 |

**Rationale**: sem essa tabela, "retry" e "desafio anti-bot" poderiam ser confundidos
na implementação (ex.: um 403 genérico sendo tratado como transitório e re-tentado —
exatamente o comportamento que a User Story 2 proíbe). Ter a distinção explícita no
plano fecha essa ambiguidade antes do `create-tasks`.

**Alternatives considered**: classificar por código de status HTTP sozinho (ex.: "todo
4xx é anti-bot, todo 5xx é transitório") — rejeitado: `401` de sessão expirada e `422`
de validação do hub são ambos 4xx mas têm reações completamente diferentes da
suspeita de anti-bot.

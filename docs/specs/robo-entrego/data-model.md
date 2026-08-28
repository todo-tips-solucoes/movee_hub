# Data Model: Robô de Importação EntreGô

Nenhuma entidade abaixo exige nova tabela em banco de dados — o robô é *stateless*
do ponto de vista de persistência relacional; o histórico "de negócio" de cada
execução já é o próprio `ImportacaoArquivo`/`Auditoria` do hub (tabelas existentes,
`infra/hub/migrations/0004_auditoria.sql` e `0011_importacao_arquivo.sql`). As
"entidades" abaixo são estruturas de dados internas do robô (arquivos em disco +
objetos em memória durante uma execução), não linhas de banco.

## Entity: Execução Agendada

Corresponde à entidade de mesmo nome em `spec.md §Key Entities`. Materializada como
1 linha de log estruturado (JSON Lines) por execução, em
`/var/lib/hub_secrets/robo-entrego/log/execucoes.jsonl` (FR-015 — consultável sem
acessar `journalctl`).

| Field | Type | Constraints | Notes |
|-------|------|-------------|-------|
| execucao_id | string (UUID v4) | gerado no início da execução | correlaciona todas as linhas de log da mesma rodada |
| disparado_em | timestamp ISO 8601 (UTC) | obrigatório | momento em que o systemd timer disparou |
| concluido_em | timestamp ISO 8601 (UTC) \| null | preenchido ao fim | null enquanto em andamento (linha atualizada por reescrita append-only — ver Nota) |
| resultado | enum | `sucesso` \| `falha_parcial` \| `falha_total` \| `pulado_lock` | `pulado_lock` = outra execução já rodando (FR-010) |
| relatorios | array de `Relatório do Franqueado` (ver abaixo) | pode ter 0, 1 ou 2 entradas | 1 entrada por tipo processado nesta rodada |
| tentativas_totais | int | >= 1 | soma de tentativas entre os relatórios desta rodada |
| motivo_falha | string \| null | preenchido só se `resultado != sucesso` | texto legível (nunca segredo/token) |

**Nota (append-only)**: como o log é JSON Lines (1 objeto por linha, nunca
reescrito), "atualizar" uma execução em andamento significa: escrever uma linha
`inicio` ao começar e uma linha `fim` (mesmo `execucao_id`) ao terminar — não um
UPDATE in-place. Consultar o estado de uma execução = agrupar por `execucao_id`.

**Nota (falha parcial, tarefa 1.2.3, dec-025)**: o enum `resultado` já é
compatível com a decisão de falha parcial por relatório sem nenhum ajuste —
`falha_parcial` = 1 dos 2 relatórios de `relatorios[]` tem `status_hub`
terminal de sucesso (`completed`/`completed_with_errors`/`duplicado`) e o
outro não teve sucesso após esgotar tentativas; `motivo_falha` descreve só o
relatório que falhou. Nenhuma mudança de schema necessária.

### Relationships

- `Execução Agendada` 1:N `Relatório do Franqueado` via `execucao_id` (embutido no
  array `relatorios`, não uma tabela separada — volume baixo, 2 relatórios/execução).

### State Transitions

```
disparada → em_andamento → (sucesso | falha_parcial | falha_total | pulado_lock)
```

Terminal sempre — o robô nunca retoma uma execução "no meio"; se cair, a próxima
execução agendada é uma rodada nova (idempotência do lado do hub via `409 CONFLITO`
cobre reprocessamento acidental do mesmo dia).

## Entity: Relatório do Franqueado

Corresponde à entidade de mesmo nome em `spec.md §Key Entities`.

| Field | Type | Constraints | Notes |
|-------|------|-------------|-------|
| tipo_portal | enum | `PERFORMANCE` \| `FINANCE` | valor usado nas chamadas ao BFF do EntreGô (ACHADOS-PORTAL.md §2) |
| tipo_hub | enum | `performance` \| `faturamento` | valor usado em `POST /api/v1/importacoes` — `FINANCE`→`faturamento`, `PERFORMANCE`→`performance` (tradução, achado §5.4) |
| data_referencia | date (`yyyy-MM-dd`) | = data de execução − 1 dia | parâmetro `initialDate`/`finalDate` do BFF (mesmo dia nos dois — range de 1 dia) |
| url_s3 | string (URL) | pré-assinada, obtida do BFF `/urls` | não logar por completo (URL pré-assinada é, na prática, um bearer token de curta duração pro objeto — tratar como sensível apesar de "não precisar de autenticação" per achado §4) |
| sha256 | string (hex) | calculado localmente antes do upload | usado só para log/correlação — o hub recalcula e dedupe o seu próprio (`UNIQUE(id_empresa, tipo, hash_sha256)`) |
| importacao_id | int \| null | preenchido após `201`/`409` do hub | `null` se a rodada nem chegou a tentar o upload (falha antes disso) |
| status_hub | enum \| null | `pending`\|`validating`\|`processing`\|`completed`\|`completed_with_errors`\|`failed`\|`cancelled`\|`duplicado` | `duplicado` é um valor do ROBÔ (não do hub) para marcar que a resposta foi `409 CONFLITO` — o hub em si não tem esse status na máquina de estados de `ImportacaoArquivo` |
| tentativas | int | >= 1 | quantas tentativas (transitórias) essa entrada consumiu |

### Relationships

- N:1 `Execução Agendada` (ver acima).
- Corresponde, no hub, a 0 ou 1 linha de `ImportacaoArquivo` (só existe lá se o
  upload foi de fato tentado) — relação por `importacao_id`, fora do escopo de
  escrita do robô (é o hub quem cria essa linha).

### State Transitions

Espelha a máquina de estados do próprio hub (fonte: `contracts/importacoes-api.md`
da feature `hub-importacoes`, seção "Convenção de máquina de estados"):

```
(não tentado) → pending → validating → processing → completed
                                              └──────→ completed_with_errors
                                              └──────→ failed
(não tentado) → duplicado   [409 imediato, sem passar pelos estados acima]
```

O robô só CRIA (`POST`) e CONSULTA (`GET :id` via polling); nunca transiciona o
estado diretamente.

## Entity: Sessão Persistida (EntreGô)

| Field | Type | Constraints | Notes |
|-------|------|-------------|-------|
| storage_state_path | string (path) | fixo: `/var/lib/hub_secrets/robo-entrego/entrego-session.json` | formato nativo do Playwright (`browserContext.storageState()`) — cookies + localStorage |
| valida_desde | timestamp \| null | atualizado a cada login completo bem-sucedido | informativo/log apenas — NUNCA usado para decidir expirar por tempo (Decision 3/FR-016: duração não é medida nem assumida) |

### State Transitions

```
ausente ──(login completo OK)──▶ presente/assumida-válida
presente ──(chamada 401)──▶ login completo ──▶ presente/assumida-válida (nova)
presente ──(chamada OK)──▶ presente/assumida-válida (reusada, sem relogar)
```

## Entity: Identidade de Serviço do Hub

Não é uma entidade de dados do robô — é uma referência à entidade já existente
`Usuario`/`UsuarioEntidade` do hub (fora do escopo de escrita desta feature; o
cadastro do usuário de serviço é um artefato SQL entregue pelo plano, aplicado pelo
operador). Documentada aqui só pelos campos que o robô CONSOME via configuração:

| Field | Type | Constraints | Notes |
|-------|------|-------------|-------|
| email | string | configuração (não segredo por si, mas fica no mesmo arquivo `.env`) | credencial de login em `POST /api/v1/auth/login` |
| senha | string | segredo, `/var/lib/hub_secrets/robo-entrego/.env` | nunca em log/git |
| id_empresa_alvo | int | configuração — `6` no ambiente atual (resposta `block-002`) | usado só para conferência pós-login (`entidade_ativa` retornada no token deve bater com este valor — falha aqui é bloqueio de configuração, não falha transitória) |

## Entity: Configuração da Rotina

Arquivo único `/var/lib/hub_secrets/robo-entrego/.env` (fora do git, template
`.env.robo-entrego.example` versionado, permissão `600` — mesmo padrão de
`entrega-session.json`, gate `owasp-security`) + arquivo `config.json` (não-segredo,
pode viver em `infra/robo-entrego/config.json`, versionado) para os horários
(FR-009).

| Field | Fonte | Type | Notes |
|-------|-------|------|-------|
| ENTREGO_EMAIL / ENTREGO_SENHA | `.env` (segredo) | string | credencial do franqueado no portal EntreGô |
| GMAIL_APP_PASSWORD | `.env` (segredo) | string | senha de app, usada em IMAP e SMTP |
| GMAIL_EMAIL | `.env` | string | `paulo@todo-tips.com` |
| HUB_SERVICO_EMAIL / HUB_SERVICO_SENHA | `.env` (segredo) | string | credencial do usuário de serviço do hub |
| HUB_ID_EMPRESA | `.env` | int | `6` — conferência pós-login (não usado para escopar requisição, isso é sempre resolvido pelo token) |
| ALERTA_DESTINATARIOS | `.env` | string (lista separada por vírgula) | `paulo@todo-tips.com` por padrão, parametrizável (`block-004`) |
| horarios | `config.json` | array de string `HH:MM` | consumido por `scripts/gerar-timer.sh` (Decision 7) para regerar `OnCalendar=` |

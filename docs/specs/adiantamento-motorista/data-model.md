# Data Model: Adiantamento pelo App, Dados Bancários e Exportação Transfeera

Materializa a PLANO §11–§12. O DDL final nasce na fase F1, em migrations novas a partir de
`infra/hub/migrations/0066_*.sql` (a última aplicada é a `0065`). Convenções da série:

- tabelas `"PascalCase"`, colunas `snake_case`;
- `id_empresa int NOT NULL` com RLS por `id_empresa = ANY (hub_jwt_escopo_ids())`
  (`0006_rls_policies.sql:43-61`; padrão de policy em `0015_rls_importacoes.sql:80-93`);
- dinheiro `numeric(12,2)` (totais de lote `numeric(14,2)`), datas de negócio `date`,
  instantes `timestamptz`;
- migrations idempotentes (`IF NOT EXISTS`, `ON CONFLICT DO NOTHING`,
  `DROP POLICY IF EXISTS`), aplicadas por `infra/hub/scripts/migrate.sh`;
- escrita **só** por funções `hub_adiantamento_*` `SECURITY DEFINER SET search_path =
  public, pg_temp`, com `REVOKE ALL … FROM PUBLIC` + `GRANT EXECUTE … TO authenticated`
  (padrão `0061_push_avisos.sql:408-419, 702-703`). Os roles reais são `authenticated` e
  `hub_web_anon`.
- As tabelas novas só concedem `SELECT` a `authenticated` (com RLS). Não há `INSERT`,
  `UPDATE` nem `DELETE` direto. Exceções (gate de segurança, dec-023):
  `"ContaBancariaMotorista"` e `"NotificacaoMotorista"` **não** têm `SELECT` direto — só
  RPC, com o mascaramento feito no SQL; a coluna `"AdiantamentoLote".arquivo` fica fora do
  `GRANT SELECT` (grant por coluna) e só sai pela RPC de download.
- `[PROPOSTA — a validar na implementação]`: limites de tamanho que o PLANO não fixa
  (motivo até 500, texto de previsão até 120, e-mail até 254) e as colunas auxiliares
  `id_empresa` (RLS) em evento/item, `dados` no evento, `arquivo_expurgado_em` e
  `nao_enviado_declarado` no lote.

Entidades existentes que a feature **lê**: `"ContaMotorista"` (`0021`),
`"Entregador"` (`0010`; vínculo `motorista_id`, único global por `0021:57-58`),
`"FaturamentoLancamento"` (`0013`), `"PerformanceTurno"` (`0014`),
`"ImportacaoArquivo"` (`0011`), `"Motorista"` (legado, fonte `legado` dos avisos).
Entidades existentes que a feature **altera**: `"Aviso"` (`0061`), a policy de INSERT de
`"Auditoria"` (`0063`), `hub_aviso_criar`, `hub_aviso_alcance` (nova irmã) e
`hub_aviso_para_motorista` (`0061`).

---

## Entity: AdiantamentoConfiguracao (versionada, só inserção)

| Field | Type | Constraints | Notes |
|-------|------|-------------|-------|
| id | bigserial | PK | |
| id_empresa | int | NOT NULL | escopo do grupo Movee (empresa 6) |
| versao | int | NOT NULL, `UNIQUE (id_empresa, versao)` | N+1 a cada salvamento |
| vigente_desde | timestamptz | NOT NULL, default `now()` | pode ser futura |
| timezone | text | NOT NULL, `CHECK (timezone IN ('America/Sao_Paulo'))` | lista fechada |
| dias_habilitados | smallint[] | NOT NULL, elementos 0..6, sem repetição | 0 = domingo; inicial `{1,2,3,4,5,6}` |
| horario_abertura | time | NOT NULL | inicial 09:00 |
| horario_corte | time | NOT NULL, `CHECK (horario_abertura < horario_corte)` | inicial 15:00 |
| percentual | numeric(5,2) | NOT NULL, `CHECK (percentual > 0 AND percentual <= 100)` | inicial 60.00 |
| taxa_fixa | numeric(12,2) | NOT NULL, `CHECK (taxa_fixa >= 0)` | inicial 0.35 |
| fonte_producao | text | NULL, `CHECK IN ('financeiro_lancamento','financeiro_referencia','performance_taxas')` | nulo até o financeiro preencher (Q-B3) |
| categorias_producao | text[] | NULL; obrigatório (não vazio) quando a fonte é financeira | valores de `FaturamentoLancamento.descricao` |
| previsao_pagamento_texto | text | NOT NULL, 1–120 | inicial "entre 17h e 18h de hoje" |
| descricao_pix_modelo | text | NOT NULL, contém `{nome}` | inicial `Antecipação entregador mei {data_producao:DD.MM.AA}_{nome}` |
| apuracao_dia_inicio | smallint | NULL, 0..6 | Q-B2 |
| apuracao_dias_ate_repasse | smallint | NULL, `>= 0` | Q-B2 |
| apuracao_data_base | text | NULL, `CHECK IN ('data_lancamento','data_referencia')` | Q-B2 |
| categorias_extrato | text[] | NULL | Q-B2 |
| desconto_adiantamentos | boolean | NOT NULL, default true | D-10; padrão = protótipo H14, confirmado pelo financeiro no go-live (F12) |
| desconto_debitos | boolean | NOT NULL, default false | D-10; idem |
| repasse_visivel_app | boolean | NOT NULL, default false | D-13; idem (M16 só aparece se ligado) |
| criado_por | int | NULL, FK `"Usuario"` | nulo só na versão semeada pela migration |
| criado_em | timestamptz | NOT NULL, default `now()` | |
| motivo | text | NULL, até 500 | justificativa da alteração |

**Vigente** = maior `vigente_desde <= now()` da empresa. **Configuração completa** (FR-025)
= `fonte_producao` preenchida, `categorias_producao` não vazia quando a fonte é financeira,
e os quatro campos de apuração preenchidos. Incompleta → `reason = NOT_CONFIGURED`.
**Salvar** = `hub_adiantamento_configuracao_salvar(p_versao_esperada, …)`: insere N+1 se a
vigente ainda é `p_versao_esperada`; senão `VERSAO_DESATUALIZADA`.

---

## Entity: ContaBancariaMotorista

| Field | Type | Constraints | Notes |
|-------|------|-------------|-------|
| id | bigserial | PK | |
| id_empresa | int | NOT NULL | empresa do entregador |
| entregador_id | int | NOT NULL, FK `"Entregador"` | |
| conta_motorista_id | int | NULL, FK `"ContaMotorista"` | nulo na carga inicial |
| origem | text | NOT NULL, `CHECK IN ('APP','CARGA_INICIAL')` | |
| status | text | NOT NULL, `CHECK IN ('PENDENTE','APROVADA','REJEITADA','SUBSTITUIDA','CANCELADA')` | §11.3 |
| titular_nome | text | NOT NULL, 1–120 após aparar | |
| titular_documento | text | NOT NULL, `~ '^\d{11}$' OR ~ '^\d{14}$'` | só dígitos; DV conferido no Node e no SQL |
| titular_tipo | text | NOT NULL, `CHECK IN ('PF','PJ')` | derivado do tamanho |
| banco_codigo | text | NOT NULL, `~ '^\d{3}$'` | COMPE |
| banco_nome | text | NOT NULL | snapshot da lista |
| agencia | text | NOT NULL, `~ '^\d{4}$'` | sem dígito de agência |
| conta | text | NOT NULL, `~ '^\d{1,20}$'` | sem o dígito |
| conta_digito | text | NOT NULL, `~ '^[0-9X]$'` | `X` só após V-3 (o formulário aceita só `[0-9]` hoje) |
| tipo_conta | text | NOT NULL, `CHECK IN ('CORRENTE','POUPANCA')` | D-19 |
| chave_pix_tipo | text | NULL, `CHECK IN ('CPF','CNPJ','EMAIL','TELEFONE','ALEATORIA')` | Q-N18 |
| chave_pix | text | NULL; obrigatório se `chave_pix_tipo` preenchido | validada por tipo; não exportada |
| email_comprovante | text | NULL, até 254 | D-18 |
| alertas | jsonb | NOT NULL, default `'[]'` | ex.: `TITULAR_DIFERENTE`, `CPF_NAO_CONFERIDO` |
| motivo_rejeicao | text | NULL, até 500; obrigatório se `REJEITADA` | |
| entregador_confirmado_id | int | NULL; obrigatório se `APROVADA` | o que o financeiro viu (D-07) |
| solicitada_em | timestamptz | NOT NULL, default `now()` | |
| revisada_em | timestamptz | NULL | |
| revisada_por | int | NULL, FK `"Usuario"` | |

**Índices**: `UNIQUE (entregador_id) WHERE status = 'APROVADA'`;
`UNIQUE (entregador_id) WHERE status = 'PENDENTE'`; `(id_empresa, status, solicitada_em DESC)`.

### State Transitions

```text
[novo envio] ──> PENDENTE ──aprovar──> APROVADA ──(outra aprovada)──> SUBSTITUIDA
                   │  └──rejeitar(motivo)──> REJEITADA
                   └──novo envio do motorista──> CANCELADA
```

Aprovar exige `entregador_confirmado_id = entregador_id` (senão `DADOS_INVALIDOS`); na
mesma transação, a `APROVADA` anterior vira `SUBSTITUIDA`. Rejeitar não toca a
`APROVADA` vigente (FR-017, edge 10).

---

## Entity: AdiantamentoSolicitacao

| Field | Type | Constraints | Notes |
|-------|------|-------------|-------|
| id | bigserial | PK | base do `ADV-NNNNNN` |
| id_empresa | int | NOT NULL | empresa do entregador |
| conta_motorista_id | int | NOT NULL, FK `"ContaMotorista"` | |
| cnpj_prestador | text | NOT NULL, `~ '^\d{14}$'` | snapshot |
| entregador_id | int | NOT NULL, FK `"Entregador"` | |
| configuracao_id | bigint | NOT NULL, FK `"AdiantamentoConfiguracao"` | versão vigente na criação (R-06) |
| data_solicitacao | date | NOT NULL | `(now() AT TIME ZONE tz)::date` |
| data_producao | date | NOT NULL, `CHECK (data_producao = data_solicitacao - 1)` | R-01 |
| solicitada_em | timestamptz | NOT NULL, default `now()` | |
| aceite_texto_sha256 | char(64) | NOT NULL | hash do texto de regras aceito (R-05) |
| status | text | NOT NULL, CHECK na lista abaixo | |
| motivo_status | text | NULL | `SEM_PRODUCAO`, `VALOR_INSUFICIENTE`, motivo de veto etc. |
| chave_idempotencia | uuid | NOT NULL | vem do cliente |
| fonte_producao | text | NULL | snapshot no cálculo |
| categorias_producao | text[] | NULL | snapshot no cálculo |
| producao_valor | numeric(12,2) | NULL | |
| producao_lancamentos | int | NULL | |
| producao_por_categoria | jsonb | NULL | `{descricao: "valor"}` |
| percentual | numeric(5,2) | NULL | snapshot |
| valor_bruto | numeric(12,2) | NULL | `round(producao * percentual / 100, 2)` |
| taxa | numeric(12,2) | NULL | snapshot |
| valor_liquido | numeric(12,2) | NULL | `valor_bruto - taxa`; `> 0` exigido para `LIBERADA` |
| calculado_em | timestamptz | NULL | |
| tentativas_producao | int | NOT NULL, default 0 | ciclos em `AGUARDANDO_PRODUCAO` |
| conta_bancaria_id | bigint | NULL, FK `"ContaBancariaMotorista"` | snapshot da conta aprovada na liberação (R-10) |

**Índices** (PLANO §12.3):
- `UNIQUE (conta_motorista_id, data_solicitacao) WHERE status <> 'CANCELADA'`;
- `UNIQUE (entregador_id, data_producao) WHERE status <> 'CANCELADA'`;
- `UNIQUE (conta_motorista_id, chave_idempotencia)`;
- `(status, data_solicitacao)` parcial em `('AGUARDANDO_CORTE','AGUARDANDO_PRODUCAO')` para o tick;
- `(id_empresa, data_solicitacao DESC)` para as listas do hub.

**Invariantes** (CHECK): `status = 'LIBERADA'` e posteriores exigem `valor_liquido > 0` e
`conta_bancaria_id` não nulo; `status = 'REJEITADA'` exige `motivo_status`;
`status = 'ENCERRADA'` exige `motivo_status` (D-23, mesma exigência de `REJEITADA`).

### State Transitions (PLANO §11.1; `ENCERRADA` acrescentada por D-23, operador 2026-09-17)

```text
AGUARDANDO_CORTE ─motorista, antes do corte─> CANCELADA
AGUARDANDO_CORTE ─corte · D-1 indisponível──> AGUARDANDO_PRODUCAO
AGUARDANDO_CORTE ─corte · sem produção / líquido ≤ 0─> INELEGIVEL
AGUARDANDO_CORTE ─corte · válida────────────> LIBERADA
AGUARDANDO_PRODUCAO ─produção chegou────────> LIBERADA | INELEGIVEL
AGUARDANDO_PRODUCAO ─financeiro encerra─────> INELEGIVEL
AGUARDANDO_PRODUCAO ─veto───────────────────> REJEITADA
LIBERADA ─veto (motivo)─────────────────────> REJEITADA
LIBERADA ─incluída em lote──────────────────> EM_LOTE
EM_LOTE ─lote cancelado antes do download───> LIBERADA
EM_LOTE ─1º download────────────────────────> EXPORTADA
EXPORTADA ─lote cancelado + "não enviado"───> LIBERADA
EXPORTADA ─confirmação / retorno────────────> PAGA | FALHOU
FALHOU ─reprocessar (motivo)────────────────> LIBERADA
FALHOU ─encerrar sem pagamento (motivo)─────> ENCERRADA
PAGA, REJEITADA, INELEGIVEL, CANCELADA, ENCERRADA ─> finais
```

`ENCERRADA` (D-23): estado terminal para uma solicitação `FALHOU` que o financeiro decide
que não será mais paga — via `hub_adiantamento_encerrar_falha` (motivo obrigatório,
permissão `adiantamentos.reprocessar`, mesma autoridade que decide sobre falhas). Sem
`ENCERRADA`, uma `FALHOU` sem solução bloquearia o fechamento da apuração para sempre
(ver `hub_adiantamento_repasse_fechar` abaixo). Notifica o motorista ("pagamento não
realizado"); audita `adiantamento.encerrado_sem_pagamento` (rota Node, FASE 4).

`CALCULANDO` é transitório dentro da transação e não é persistido. A tabela de transições
válidas vive numa função SQL; um trigger `BEFORE UPDATE OF status` recusa qualquer par
fora dela com `TRANSICAO_INVALIDA` (não há precedente de trigger de máquina de estados no
repo; o padrão mais próximo é o trigger de imutabilidade da `Auditoria`, `0004:31-41`).

---

## Entity: AdiantamentoEvento (só inserção)

| Field | Type | Constraints | Notes |
|-------|------|-------------|-------|
| id | bigserial | PK | |
| solicitacao_id | bigint | NOT NULL, FK | |
| id_empresa | int | NOT NULL | para RLS |
| status_de | text | NULL | nulo na criação |
| status_para | text | NOT NULL | |
| ocorrido_em | timestamptz | NOT NULL, default `now()` | |
| ator_tipo | text | NOT NULL, `CHECK IN ('motorista','sistema','usuario')` | |
| ator_usuario_id | int | NULL, FK `"Usuario"` | só para `usuario` |
| motivo | text | NULL, até 500 | |
| lote_id | bigint | NULL, FK `"AdiantamentoLote"` | |
| dados | jsonb | NOT NULL, default `'{}'` | ex.: resultado do cálculo; sem dado pessoal |

Gravado pelo mesmo trigger/função da transição: toda mudança de `status` gera exatamente
um evento. Alimenta a timeline do app (PLANO §11.1) e o detalhe do hub. Sem `UPDATE`/`DELETE`.

---

## Entity: AdiantamentoLote

| Field | Type | Constraints | Notes |
|-------|------|-------------|-------|
| id | bigserial | PK | número do lote (`NNNNNN` no nome do arquivo) |
| id_empresa | int | NOT NULL | claim `empresa_ativa` do criador |
| status | text | NOT NULL, `CHECK IN ('GERANDO','GERADO','EXPORTADO','CONCLUIDO','CONCLUIDO_COM_FALHAS','CANCELADO')` | §11.2 |
| criado_por | int | NOT NULL, FK `"Usuario"` | |
| criado_em | timestamptz | NOT NULL, default `now()` | |
| chave_idempotencia | uuid | NOT NULL, `UNIQUE (criado_por, chave_idempotencia)` | duplo clique devolve o mesmo lote |
| quantidade | int | NOT NULL, `CHECK (quantidade BETWEEN 1 AND 5000)` | R-17 |
| valor_total | numeric(14,2) | NOT NULL, `CHECK (valor_total > 0)` | = Σ itens (conferido na função) |
| arquivo_nome | text | NULL | `transfeera_adiantamentos_<AAAA-MM-DD>_lote-<NNNNNN>.xlsx` |
| arquivo | bytea | NULL | expurgado em 90 dias (FR-052) |
| arquivo_sha256 | char(64) | NULL | |
| arquivo_bytes | int | NULL | |
| arquivo_expurgado_em | timestamptz | NULL | |
| gerado_em | timestamptz | NULL | |
| primeiro_download_em | timestamptz | NULL | |
| downloads | int | NOT NULL, default 0 | |
| cancelado_em / cancelado_por / cancelado_motivo | timestamptz / int / text | NULL; motivo obrigatório ao cancelar | `falha_geracao` para cancelamento automático |
| nao_enviado_declarado | boolean | NULL | obrigatório `true` para cancelar depois do download |
| concluido_em | timestamptz | NULL | |

`GERADO` exige `arquivo`, `arquivo_sha256` e `arquivo_bytes` não nulos (CHECK).

### State Transitions (PLANO §11.2)

```text
GERANDO ─arquivo gerado e validado──> GERADO ─1º download──> EXPORTADO
GERANDO ─falha de geração / órfão > 5 min──> CANCELADO
GERADO ─financeiro──> CANCELADO
EXPORTADO ─financeiro + "não enviado à Transfeera"──> CANCELADO
EXPORTADO ─todos os itens pagos──> CONCLUIDO
EXPORTADO ─≥ 1 falhou, nenhum pendente──> CONCLUIDO_COM_FALHAS
```

---

## Entity: AdiantamentoLoteItem

| Field | Type | Constraints | Notes |
|-------|------|-------------|-------|
| id | bigserial | PK | |
| lote_id | bigint | NOT NULL, FK | |
| solicitacao_id | bigint | NOT NULL, FK | |
| id_empresa | int | NOT NULL | da solicitação (RLS) |
| linha | int | NOT NULL, `>= 3`, `UNIQUE (lote_id, linha)` | linha do Excel |
| col_nome | text | NOT NULL | A — snapshot formatado |
| col_documento | text | NOT NULL | B — com máscara |
| col_email | text | NOT NULL, default `''` | C |
| col_banco | text | NOT NULL | D |
| col_agencia | text | NOT NULL | E |
| col_conta | text | NOT NULL | F |
| col_digito | text | NOT NULL | G |
| col_tipo_conta | text | NOT NULL | H — `Conta Corrente`/`Conta Poupança` |
| valor | numeric(12,2) | NOT NULL, `> 0` | I |
| col_id_integracao | text | NOT NULL | J — `ADV-000123` |
| col_data_agendamento | text | NOT NULL, default `''` | K — vazio (D-22) |
| col_descricao_pix | text | NOT NULL, até 140 caracteres | L |
| conta_bancaria_id | bigint | NOT NULL, FK | |
| situacao | text | NOT NULL, `CHECK IN ('incluido','pago','falhou','cancelado')` | |
| situacao_motivo | text | NULL; obrigatório se `falhou` | |
| situacao_em | timestamptz | NULL | |
| situacao_por | int | NULL, FK `"Usuario"` | |
| origem_situacao | text | NULL, `CHECK IN ('retorno','manual')` | `retorno` só na F9 |
| item_anterior_id | bigint | NULL, FK self | reprocessamento |

**Garantias**: `UNIQUE (solicitacao_id) WHERE situacao IN ('incluido','pago')` (edge 13,
FR-051); `quantidade`/`valor_total` do lote conferidos contra os itens na função e em teste.

### Relationships

- `AdiantamentoLote` 1:N `AdiantamentoLoteItem`
- `AdiantamentoSolicitacao` 1:N `AdiantamentoLoteItem` (no máximo 1 ativo)
- `AdiantamentoSolicitacao` 1:N `AdiantamentoEvento`
- `AdiantamentoSolicitacao` N:1 `AdiantamentoConfiguracao`, `ContaBancariaMotorista`,
  `ContaMotorista`, `Entregador`
- `ContaBancariaMotorista` N:1 `Entregador` (≤ 1 `APROVADA` e ≤ 1 `PENDENTE` por entregador)

---

## Entity: NotificacaoMotorista

| Field | Type | Constraints | Notes |
|-------|------|-------------|-------|
| id | bigserial | PK | |
| cnpj_prestador | text | NOT NULL, `~ '^\d{14}$'` | identidade da leitura (claim) — dec-016 |
| conta_motorista_id | int | NULL, FK `"ContaMotorista"` | nulo quando a fonte do público é `legado` |
| categoria | text | NOT NULL, `CHECK IN ('adiantamento','pagamento','conta_bancaria','sistema','aviso')` | |
| titulo | text | NOT NULL, 1–60 | |
| corpo | text | NOT NULL, 1–180 | |
| link | text | NULL, CHECK na allowlist | `/adiantamento`, `/adiantamento/<id>`, `/conta-bancaria`, `/avisos/<id>`, `/repasse` |
| aviso_id | int | NOT NULL, FK `"Aviso"` `ON DELETE CASCADE` | todo evento passa por um `Aviso` (expurgo de 90 dias) |
| criada_em | timestamptz | NOT NULL, default `now()` | |
| lida_em | timestamptz | NULL | |

**Índices**: `(cnpj_prestador, criada_em DESC)`; parcial
`(cnpj_prestador) WHERE lida_em IS NULL` (badge); `UNIQUE (aviso_id, cnpj_prestador)`.
RLS ligado sem policy de leitura direta: o app lê só pelas RPCs
`hub_notificacao_*` com a claim de CNPJ (padrão de `AvisoEntrega`, `0061:150-158`).

## Alteração: Aviso (`0061:55-75`)

| Field | Mudança |
|-------|---------|
| origem | nova, `text NOT NULL DEFAULT 'hub'`, `CHECK IN ('hub','sistema')` |
| categoria | nova, `text NOT NULL DEFAULT 'aviso'`, mesma lista da notificação |
| criado_por | passa a aceitar nulo; `CHECK (origem = 'sistema' OR criado_por IS NOT NULL)` |

---

## Entity: ApuracaoRepasse e ApuracaoRepasseItem (snapshot ao fechar)

Criadas em `0066_adiantamento_tabelas.sql` junto do estado `ENCERRADA` — desbloqueadas por
D-23 (operador, 2026-09-17), que resolveu o Gap CHK025/tarefa 4.5. **Regra de fechamento
(D-23)**: `hub_adiantamento_repasse_fechar(p_periodo_inicio)` (`0067`) RECUSA o fechamento
(409 `APURACAO_COM_PENDENCIAS`, com a contagem por status) enquanto existir
`AdiantamentoSolicitacao` com `data_producao` no período `[inicio, inicio+6]` em qualquer
status NÃO finalizado: `AGUARDANDO_CORTE`, `AGUARDANDO_PRODUCAO`, `LIBERADA`, `EM_LOTE`,
`EXPORTADA` ou `FALHOU`. Finalizados que NÃO bloqueiam: `PAGA`, `REJEITADA`, `INELEGIVEL`,
`CANCELADA`, `ENCERRADA` — por isso `FALHOU` precisa de uma saída terminal própria
(`ENCERRADA`, ver §State Transitions acima), senão uma falha sem solução travaria o
fechamento do período para sempre. Segunda tentativa do mesmo período →
`UNIQUE(id_empresa, periodo_inicio)` rejeita com `APURACAO_JA_FECHADA`.

| Field | Type | Constraints | Notes |
|-------|------|-------------|-------|
| id | bigserial | PK | |
| id_empresa | int | NOT NULL, `UNIQUE (id_empresa, periodo_inicio)` | empresa da configuração |
| periodo_inicio / periodo_fim | date | NOT NULL, `fim = inicio + 6` | |
| data_repasse | date | NOT NULL | |
| configuracao_id | bigint | NOT NULL, FK | versão usada |
| fechado_por | int | NOT NULL, FK `"Usuario"` | |
| fechado_em | timestamptz | NOT NULL, default `now()` | |

| Field (item) | Type | Constraints | Notes |
|-------|------|-------------|-------|
| id | bigserial | PK | |
| apuracao_id | bigint | NOT NULL, FK | |
| id_empresa | int | NOT NULL | do entregador |
| entregador_id | int | NOT NULL, `UNIQUE (apuracao_id, entregador_id)` | |
| creditos | numeric(12,2) | NOT NULL | |
| adiantamentos | numeric(12,2) | NOT NULL | bruto das `PAGA` do período |
| debitos | numeric(12,2) | NOT NULL | `abs`, 0 se desligado |
| remanescente | numeric(12,2) | NOT NULL | pode ser negativo (Q-N4) |
| detalhe | jsonb | NOT NULL | ids das solicitações descontadas |

Imutável: sem `UPDATE`/`DELETE` (trigger no padrão da `Auditoria`).

---

## Dados estáticos

- **Lista COMPE** (`app_homologacao/backend/lib/fixtures/bancos-compe.json`): código de
  3 dígitos, nome, ISPB; com a data de extração do arquivo público do BCB. Usada pelo
  `GET /motorista/bancos`, pela validação do cadastro e pela carga (F8).
- **Contrato Transfeera** (`app_homologacao/backend/lib/fixtures/transfeera-contrato.json`):
  ver `contracts/transfeera-xlsx.md`.

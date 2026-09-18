# Contracts: funções SQL (RPC via PostgREST)

O backend chama as funções por `hubPostgrestRequest('rpc/<nome>', 'POST', {p_...}, claims)`
(`app_homologacao/backend/lib/hub-postgrest.js:53`). O JWT do PostgREST é gerado por
`generateHubPostgrestJWT` (`lib/hub-postgrest-jwt.js:77`), sempre com
`role:'authenticated'`.

## Existentes que esta feature usa (fonte: migrations)

| Função / claim | Contrato real | Fonte |
|---|---|---|
| `hub_jwt_escopo_ids()` | `int[]` da claim `escopo` | `infra/hub/migrations/0006_rls_policies.sql:43-61` |
| `hub_jwt_motorista_cnpj()` | CNPJ da claim `motorista_cnpj`; exige 14 dígitos | `0061_push_avisos.sql:43-49` |
| `hub_jwt_push_worker()` | booleano da claim `hub_push_worker` (modelo para a claim nova) | `0061_push_avisos.sql:32-37` |
| `hub_aviso_criar(p_titulo, p_corpo, p_modo, p_ids int[], p_chave_idempotencia uuid, p_key_id, p_fonte_conta)` → `(aviso_id, visados, reutilizado)` | exige `sub` e a empresa 6 no escopo (`FORA_DO_GRUPO_MOVEE`); reusa por `(criado_por, chave)`; grava `Aviso` e `AvisoEntrega`; `SEM_INSCRICOES_ATIVAS` se o alcance for vazio | `0061:408-453` |
| `hub_aviso_alcance(p_modo, p_ids, p_key_id, p_fonte_conta)` → `(cnpj_prestador, inscricao_id)` | só CNPJs com `PushInscricao`; fonte `conta_motorista` ou `legado` | `0061:339-404` |
| `hub_aviso_para_motorista(p_aviso_id)` | exige `AvisoEntrega` do CNPJ da claim | `0061:313-334` |
| `hub_push_reivindicar` / `hub_push_registrar_resultado` / `hub_push_expurgo` | lease + `FOR UPDATE SKIP LOCKED`; expurgo de avisos com mais de 90 dias | `0061:554-665`, `0064`, `0065` |
| Padrão de segurança | `LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp`; `REVOKE ALL … FROM PUBLIC; GRANT EXECUTE … TO authenticated` | `0061:408-419, 702-703` |

## Novas `[PROPOSTA — a validar na implementação]`

Todas `SECURITY DEFINER SET search_path = public, pg_temp`, com `REVOKE`/`GRANT`
explícitos. Erros de negócio saem como `RAISE EXCEPTION '<CODIGO>'` e o Node traduz para
`{erro:'<CODIGO>'}` (padrão de `FORA_DO_GRUPO_MOVEE`). Toda mudança de `status` passa pelo
trigger de transições, que grava `AdiantamentoEvento`.

### Claims

| Claim de entrada (`generateHubPostgrestJWT`) | Claim JWT | Uso |
|---|---|---|
| `motoristaCnpj` (existente) | `motorista_cnpj` | rotas do app |
| `escopo` (existente) | `escopo` | ids do grupo Movee, calculados no servidor |
| `adiantamentoWorker` (**nova**) | `hub_adiantamento_worker` | tick; lida por `hub_jwt_adiantamento_worker()` (nova) |

### Internas (sem `GRANT` a `authenticated`)

| Função | Papel |
|---|---|
| `hub_adiantamento_config_vigente(p_id_empresa)` | versão vigente (`vigente_desde <= now()`) |
| `hub_adiantamento_config_completa(p_config)` | **dec-053**: `boolean` — fonte/categorias da produção + apuração semanal preenchidos (Q-B2/Q-B3); extraída de `_disponibilidade` e reusada em `_solicitar` (`NOT_CONFIGURED`) |
| `hub_adiantamento_janela(p_config, p_instante)` | `(data_solicitacao, data_producao, dia_habilitado, antes_abertura, apos_corte)` no fuso da versão — fronteiras `abertura <= t < corte` |
| `hub_adiantamento_producao(p_entregador_id, p_data, p_config)` | `(disponivel, valor, lancamentos, por_categoria)` conforme a fonte (research D7/D8) |
| `hub_adiantamento_transicao_valida(de, para)` | tabela de transições (data-model) |
| `hub_adiantamento_notificar(p_solicitacao_id, p_evento)` | cria `Aviso(origem='sistema')`, `NotificacaoMotorista` e `AvisoEntrega` para os inscritos |
| `hub_adiantamento_tem_permissao(p_codigo text)` | confere, em `"UsuarioEntidade"`/`"PapelPermissao"`/`"Permissao"`, que o `sub` tem a permissão na `empresa_ativa` (e que o módulo está ativo). Chamada no início das RPCs sensíveis do hub, como segunda barreira além do `requirePermission` do Node (dec-023) |
| `hub_adiantamento_integration_id(p_id)` | `ADV-` seguido de `lpad(p_id::text, 6, '0')` se `p_id < 1000000`; senão `ADV-` seguido de `p_id::text` (o `lpad` trunca textos maiores) |
| `hub_adiantamento_bruto_liquido(p_valor_producao, p_config)` | **3.7.1** (revisão da sessão pai, dec-071): `(bruto, liquido)` — arredondamento meio para cima (D-06/R-07), extraído de `_calcular_liberacao` para ser reusado por `_disponibilidade` (prévia `estimate`) sem herdar o `RAISE EXCEPTION 'NO_BANK_ACCOUNT'` |
| `hub_adiantamento_elegibilidade(p_valor_producao, p_liquido)` | **3.8.1** (revisão da sessão pai, dec-076): `(elegivel, motivo)` — produção=0 → `false`/`SEM_PRODUCAO`; líquido<=0 → `false`/`VALOR_INSUFICIENTE`; senão `true`/`NULL`. Extraída de `_calcular_liberacao` para ser reusada por `_disponibilidade` (prévia `estimate.eligible`/`net:null`) sem duplicar a comparação |
| `hub_adiantamento_calcular_liberacao(p_entregador_id, p_data_producao, p_config)` | **1.6.1**: cálculo puro produção→bruto meio para cima→líquido (via `_bruto_liquido`)→snapshot da conta aprovada→`LIBERADA`/`INELEGIVEL`; `disponivel=false` sem gravar nada (quem chama decide: `_recalcular` levanta `PRODUCAO_INDISPONIVEL`, `_processar` marca `AGUARDANDO_PRODUCAO`); levanta `NO_BANK_ACCOUNT` se liberaria mas não há conta `APROVADA` |
| `hub_adiantamento_repasse_pode_fechar(p_config, p_fim, p_instante)` | **1.6.3**: `p_instante >= (p_fim+1) + horario_corte` no fuso de `p_config`; `p_instante` injetável para teste de fronteira, a RPC pública só chama com `now()` |
| `hub_adiantamento_corte_passou(p_data_solicitacao, p_horario_corte, p_timezone, p_instante)` | **1.6.5** (dec-047/dec-049): `p_instante >= (p_data_solicitacao + p_horario_corte) AT TIME ZONE p_timezone` — o corte do tick considera o DIA da solicitação, não só a hora; `hub_adiantamento_processar` chama com `now()`. Corrige o defeito de comparar só `(now() AT TIME ZONE tz)::time >= horario_corte`, que deixava uma solicitação de dia anterior esperando o corte do dia corrente |
| `hub_jwt_motorista_id_empresa()` | **1.3.1** (dec-050): `id_empresa` do `Entregador` ativo vinculado ao CNPJ do claim `motorista_cnpj` (`NULL` sem claim/vínculo). `SECURITY DEFINER` — contorna `entregador_select_por_escopo` (0015), que uma sessão só-motorista (sem `escopo`) não atravessaria; usada só na policy de INSERT de `"Auditoria"` (0069) |

### App do motorista (claims `motorista_cnpj` + `escopo`)

| Função | Retorno / efeito |
|---|---|
| `hub_adiantamento_disponibilidade()` | uma linha com vínculo, empresa, módulo ativo, configuração vigente (`configuracao_id` = PK/identificador, `configuracao_versao` = versão de exibição — 3.7.3/dec-071, os dois NUNCA são o mesmo campo), conta aprovada/pendente (mascarada), solicitação do dia e `estimate` D-1 (`{available, production, gross, fee, net, eligible, final:false}`, 3.7.1/dec-071 — via `_producao`/`_bruto_liquido`, sem GRANT novo; `eligible`/`net:null` quando produção=0 ou líquido<=0, 3.8.1/dec-076 — via `hub_adiantamento_elegibilidade`, mesma regra de `_calcular_liberacao`) |
| `hub_adiantamento_solicitar(p_configuracao_id bigint, p_aceite_sha256 text, p_chave uuid)` | revalida R-02..R-05 com `now()`; exige `p_configuracao_id` = vigente (`VERSAO_DESATUALIZADA`) — o valor é sempre o PK (`AdiantamentoConfiguracao.id`, campo `configuracaoId` no app), nunca `.versao`; recusa se a config vigente não estiver completa (`NOT_CONFIGURED`, FR-025, dec-053) — checagem via `hub_adiantamento_config_completa`, mesma extraída para `_disponibilidade`; cria `AGUARDANDO_CORTE`; reenvio com a mesma chave devolve a existente (`reutilizado = true`); violação do índice único do dia → `ALREADY_REQUESTED` |
| `hub_adiantamento_cancelar(p_id)` | só do próprio CNPJ, `AGUARDANDO_CORTE` e antes do corte da versão |
| `hub_adiantamento_listar_motorista(p_pagina)` / `hub_adiantamento_detalhe_motorista(p_id)` | histórico e detalhe + eventos, só do CNPJ. O detalhe (3.7.2/dec-071) acrescenta ao jsonb da solicitação o RETRATO gravado: `configuracao_versao`/`previsao_pagamento_texto` (join pelo `configuracao_id` imutável da própria linha, nunca a config vigente) e `conta_bancaria_mascarada` (join pelo `conta_bancaria_id` snapshot — `null` antes do cálculo, LIBERADA em diante; nunca a conta atualmente aprovada) |
| `hub_conta_bancaria_motorista()` | aprovada, pendente e última rejeição (mascaradas) |
| `hub_conta_bancaria_solicitar(p_dados jsonb)` | revalida formatos e DV; cancela a `PENDENTE` anterior; cria `PENDENTE` com `origem='APP'` e `alertas` (titular diferente do vínculo) |
| `hub_notificacao_listar(p_pagina, p_categoria, p_nao_lidas)` / `hub_notificacao_nao_lidas()` / `hub_notificacao_marcar_lida(p_id)` / `hub_notificacao_marcar_todas()` | só linhas do CNPJ da claim |
| `hub_adiantamento_repasse_motorista()` | previsão do período corrente; vazio se `repasse_visivel_app = false` |

### Hub (claims `sub`, `empresa_ativa`, `escopo`)

RPCs que movem dinheiro ou expõem dado bancário completo também chamam
`hub_adiantamento_tem_permissao` com o código da rota (código completo
`adiantamentos.<ação>`, igual a `Permissao.codigo`): `configuracao_salvar`
(`configurar`), `conta_bancaria_detalhe` com `p_completo` e `conta_bancaria_aprovar*`
(`contas_revisar`), `lote_criar` (`lote_criar`), `lote_download` (`exportar`),
`lote_cancelar`/`reprocessar`/`encerrar_falha` (`reprocessar`), `lote_confirmar`/
`repasse_fechar` (`pagamento_confirmar`). Sem a permissão → `PERMISSAO_NEGADA`.

| Função | Retorno / efeito |
|---|---|
| `hub_adiantamento_rejeitar(p_id, p_motivo)` / `_recalcular(p_id)` / `_encerrar(p_id, p_motivo)` / `_atualizar_conta(p_id, p_motivo)` / `_reprocessar(p_id, p_motivo)` | transições do hub (R-11, R-14, Q-N14, R-10); `id_empresa` da solicitação ∈ escopo. **1.6.1**: `_recalcular` só em `AGUARDANDO_PRODUCAO` (`TRANSICAO_INVALIDA` em `LIBERADA`/`INELEGIVEL` — hub-api.md já documentava assim) |
| `hub_adiantamento_encerrar_falha(p_id, p_motivo)` | **D-23** (operador, 2026-09-17): `FALHOU -> ENCERRADA`, motivo obrigatório; segunda barreira `reprocessar` (mesma autoridade que decide sobre falhas); notifica "pagamento não realizado" |
| `hub_adiantamento_configuracao_salvar(p_versao_esperada int, p_dados jsonb)` | N+1 ou `VERSAO_DESATUALIZADA`; devolve o diff |
| `hub_adiantamento_categorias(p_fonte)` | categorias dos últimos 90 dias + flag "sem motorista identificado" |
| `hub_conta_bancaria_listar(...)` / `hub_conta_bancaria_detalhe(p_id, p_completo bool)` | mascaramento feito no SQL; o completo só é chamado pelo Node depois de conferir `contas_revisar` |
| `hub_conta_bancaria_aprovar(p_id, p_entregador_confirmado_id)` / `_rejeitar(p_id, p_motivo)` / `_aprovar_lote(p_ids bigint[])` | §11.3; aprovação substitui a anterior na mesma transação; notifica |
| `hub_adiantamento_lote_previa(p_ids bigint[])` | aptas + pendências por id (PLANO §14.3); não grava |
| `hub_adiantamento_lote_criar(p_ids bigint[], p_quantidade_esperada int, p_total_esperado numeric, p_chave uuid)` | trava as solicitações `FOR UPDATE` em ordem de id; exige `LIBERADA`; recalcula a prévia; divergência → `PREVIA_DESATUALIZADA`; já em lote ativo → `SOLICITACOES_EM_OUTRO_LOTE` (com os ids); > 5.000 → `LOTE_ACIMA_DO_LIMITE`; cria o lote `GERANDO` + itens com o snapshot das 12 colunas; solicitações → `EM_LOTE`; mesma chave → mesmo lote |
| `hub_adiantamento_lote_arquivo(p_lote_id, p_arquivo text /*base64*/, p_sha256, p_bytes, p_nome)` | só em `GERANDO`; confere o sha256 de `decode(p_arquivo,'base64')`; → `GERADO` |
| `hub_adiantamento_lote_download(p_lote_id)` | só `GERADO`/`EXPORTADO`/`CONCLUIDO*` com bytes presentes; incrementa `downloads`; no 1º: lote → `EXPORTADO`, solicitações → `EXPORTADA` (notifica "pagamento em processamento"); devolve `encode(arquivo,'base64')`, sha256, nome e nº do download |
| `hub_adiantamento_lote_cancelar(p_lote_id, p_motivo, p_nao_enviado bool)` | `GERANDO`/`GERADO` → `CANCELADO`; `EXPORTADO` só com `p_nao_enviado = true`; itens → `cancelado`, solicitações → `LIBERADA` |
| `hub_adiantamento_lote_confirmar(p_lote_id, p_falhas jsonb)` | itens `incluido` → `pago`/`falhou` (`origem_situacao='manual'`); solicitações → `PAGA`/`FALHOU`; lote → `CONCLUIDO` ou `CONCLUIDO_COM_FALHAS`; notifica |
| `hub_adiantamento_repasse(p_periodo_inicio date, p_busca, p_somente_negativos, p_offset, p_limite)` | linhas por entregador (research D9) + totais + `nao_pagos_no_periodo` |
| `hub_adiantamento_repasse_fechar(p_periodo_inicio date)` | **D-23**: recusa (`APURACAO_COM_PENDENCIAS`, com a contagem por status no `DETAIL` do erro) se houver solicitação com `data_producao` no período em status NÃO finalizado (`AGUARDANDO_CORTE`, `AGUARDANDO_PRODUCAO`, `LIBERADA`, `EM_LOTE`, `EXPORTADA`, `FALHOU`); senão grava `ApuracaoRepasse` + itens (desconta o bruto das `PAGA` do período); `APURACAO_JA_FECHADA` na 2ª tentativa do mesmo período (`UNIQUE(id_empresa,periodo_inicio)`); `APURACAO_NAO_CONFIGURADA` sem `apuracao_data_base`. **1.6.3**: `PERIODO_EM_ABERTO` (via `hub_adiantamento_repasse_pode_fechar`) enquanto `now()` no fuso da config vigente for anterior a `(periodo_fim + 1) + horario_corte` |

### Worker (claim `hub_adiantamento_worker`)

As três funções recusam (`PERMISSAO_NEGADA`) qualquer JWT sem a claim; a claim só é
montada pelo `lib/adiantamento-worker.js`, nunca a partir de dado de requisição.

| Função | Retorno / efeito |
|---|---|
| `hub_adiantamento_processar(p_limite int DEFAULT 200)` | seleciona `AGUARDANDO_CORTE` com corte da versão já passado e `AGUARDANDO_PRODUCAO` com `FOR UPDATE SKIP LOCKED`; calcula e move para `LIBERADA` (com snapshot da conta aprovada), `INELEGIVEL` ou `AGUARDANDO_PRODUCAO` (`tentativas_producao + 1`); notifica; devolve `(id, id_empresa, status_para, resultado jsonb)` para a auditoria no Node |
| `hub_adiantamento_lote_orfaos(p_minutos int DEFAULT 5)` | `GERANDO` há mais de 5 min → `CANCELADO` (`falha_geracao`); devolve os lotes afetados |
| `hub_adiantamento_expurgo_arquivos(p_dias int DEFAULT 90)` | zera `arquivo` e grava `arquivo_expurgado_em` em lotes concluídos/cancelados há mais de 90 dias; o snapshot dos itens fica |

## Alterações em funções existentes

| Função | Mudança |
|---|---|
| `hub_aviso_criar` | grava `NotificacaoMotorista` para o público total (função irmã `hub_aviso_publico`, sem exigir `PushInscricao`) e `AvisoEntrega` só para os inscritos; `SEM_DESTINATARIOS` com público vazio; aviso sem entregas nasce `concluido`; `origem='hub'` |
| `hub_aviso_para_motorista` | autoriza por `NotificacaoMotorista` do CNPJ |
| Policy de INSERT de `"Auditoria"` (vigente em `0063:24-43`, alterada em `0069`) | dois ramos novos: motorista (`adiantamento.solicitado`/`.cancelado`, `conta_bancaria.solicitada`) com `hub_jwt_motorista_cnpj()` e `id_empresa = hub_jwt_motorista_id_empresa()`; tick (`adiantamento.calculado`/`.aguardando_producao`) com `hub_jwt_adiantamento_worker()`. Demais ações de PLANO.md §22 caem no ramo já existente `id_empresa = ANY(hub_jwt_escopo_ids())` |

A assinatura de `hub_aviso_criar` não muda (o `REVOKE`/`GRANT` de `0061:702-703` continua
valendo); se mudar, a migration recria os `GRANT`s.

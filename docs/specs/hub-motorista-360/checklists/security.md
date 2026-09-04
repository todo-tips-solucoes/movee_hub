# Security Checklist: Hub Motorista 360

**Purpose**: gate de qualidade dos REQUISITOS (não da implementação) das duas
áreas onde esta feature concentra risco — (a) dados pessoais trazidos da
EntreGô: classificação, RBAC, retenção, log/auditoria; (b) raspagem da
EntreGô, cujo endpoint segue `[PROPOSTA — a validar na implementação]`.
**Created**: 2026-09-04
**Feature**: [spec.md](../spec.md)
**Domínio**: security
**Gate de cobertura**: `requirement-coverage.sh` → `requirements=16|covered=16|errors=0`

## A. Dados pessoais — classificação e escopo

- [x] CHK001 - A lista de campos tratados como dados pessoais sensíveis está enumerada de forma fechada (sem "etc." / "entre outros")? [Clareza, Spec §FR-014] {auto} — FR-014 enumera exatamente: CPF, RG, nome dos pais, contato de emergência, e-mail.
- [x] CHK002 - A lista de sensíveis de FR-014 é consistente com o que o contrato de resposta de fato protege? **[Conflict — CORRIGIDO nesta onda]** [Consistência, Spec §FR-013/FR-014 vs `contracts/hub-motoristas-detalhe.md` §Response] {auto} — o contrato devolvia `documentos {rg, cnh}` "sempre", justificando "RG/CNH não estão na lista de sensíveis de FR-014", e `quickstart.md` Scenario 4 repetia a exposição de RG ao perfil `leitura`. FR-013 e FR-014 enumeram **RG** literalmente. Contrato e quickstart foram alinhados: `documentos.rg` passa a ser omitido sem a permissão `motoristas.dados_sensiveis`; `cnh` (ausente de ambas as listas) segue sempre presente.
- [x] CHK003 - Está definido quais campos NÃO são sensíveis e permanecem sempre visíveis? [Completude, `contracts/hub-motoristas-detalhe.md` §Response] {auto} — `dadosPessoaisBasicos` (nome completo, data de nascimento, telefone) + `informacoesEntrega`.
- [ ] CHK004 - A classificação de nome completo / data de nascimento / telefone como NÃO sensíveis está expressa em requisito, ou só no contrato? **[Gap]** [Completude, Spec §FR-013/FR-014] {auto} — nenhum FR classifica esses três campos; a exclusão existe apenas em `contracts/hub-motoristas-detalhe.md`. Como requisito, a decisão não é rastreável nem contestável.
- [ ] CHK005 - Expor telefone e data de nascimento do motorista ao perfil `leitura` está dentro do apetite de risco do produto? [Risco] {humano}
- [x] CHK006 - Fotos de documentos estão explicitamente fora de escopo? [Cobertura, Spec §FR-002] {auto} — "exclusivamente RG e CNH — fotos de documentos ficam fora de escopo desta entrega".

## B. Dados pessoais — controle de acesso (RBAC)

- [x] CHK007 - O requisito nomeia os perfis exatos autorizados a ver os sensíveis? [Clareza, Spec §FR-013] {auto} — `admin_entidade` e `admin_plataforma`, "apenas".
- [x] CHK008 - Está definido o que o perfil `leitura` continua vendo? [Completude, Spec §FR-013] {auto} — "MUST continuar vendo o cadastro do motorista, porém sem esses campos sensíveis".
- [x] CHK009 - O requisito é verificável sem depender do nome final da permissão? [Mensurabilidade, `quickstart.md` §Scenario 4] {auto} — Scenario 4 testa por papel (`leitura` vs `admin_entidade`) e por presença/ausência de chave no JSON, não pelo código da permissão.
- [ ] CHK010 - O identificador da nova permissão foi confirmado contra o padrão da migration 0044, como FR-013 exige? **[Ambiguity]** [Clareza, Spec §FR-013; `research.md` Decision 10] {auto} — FR-013 diz que o identificador "MUST ser confirmado na fase de plano ... nunca suposto"; a fase de plano propôs `motoristas.dados_sensiveis` marcado `[PROPOSTA]`. O padrão de seed foi confirmado (0044); o código da permissão, não.
- [x] CHK011 - O requisito distingue gate de rota de máscara de campo? [Clareza, `research.md` Decision 10] {auto} — rota segue exigindo só `motoristas.consultar`; a permissão nova filtra campos dentro do DTO.
- [ ] CHK012 - Existe requisito exigindo OMITIR a chave (em vez de `null`/máscara) quando a permissão falta? **[Gap]** [Completude, Spec §FR-013 vs `contracts/hub-motoristas-detalhe.md` §RBAC de campo] {auto} — a regra ("omitir a chave, não retornar `null`/string mascarada — evita vazar até o formato do dado") vive só no contrato. Nenhum FR a exige, então uma implementação que devolvesse `***.***.***-**` satisfaria FR-013 ao pé da letra.
- [ ] CHK013 - Há requisito cobrindo outras rotas que exponham `dados_entrego_json` fora de `buscarDetalheMotorista()`? **[Gap]** [Cobertura, `contracts/hub-motoristas-detalhe.md` §Defesa em profundidade] {auto} — o contrato declara o risco residual como aceito (mascaramento é só app-layer), mas nenhum requisito proíbe um endpoint futuro de devolver o JSON bruto.
- [ ] CHK014 - As permissões do papel de serviço `robo_entrego_servico` aparecem em algum requisito? **[Gap]** [Completude, `research.md` Decision 11; `data-model.md` §Permissao] {auto} — `motoristas.enriquecimento.consultar` / `.atualizar` são `[PROPOSTA]` e existem só no plano; nenhum FR trata o acesso do worker aos dados sensíveis.

## C. Dados pessoais — retenção e ciclo de vida

- [ ] CHK015 - Existe requisito de prazo de retenção para `dados_entrego_json`? **[Gap]** [Completude, Spec §Requirements] {auto} — busca por `reten[cç]|expurg|anonimiz|LGPD` nos 8 artefatos de `docs/specs/hub-motorista-360/` retorna **zero** ocorrências. A feature grava CPF/RG/filiação por tempo indeterminado sem requisito que o limite.
- [ ] CHK016 - Está definido o que acontece com os dados sensíveis quando o motorista é desativado ou tem o vínculo removido? **[Gap]** [Cobertura de Edge Cases] {auto} — `Entregador.ativo` existe (`data-model.md`), mas nenhum requisito liga desativação a descarte/bloqueio dos campos enriquecidos.
- [ ] CHK017 - Há requisito para atender pedido de exclusão do titular sobre os dados enriquecidos? **[Gap]** [Completude] {auto} — nenhum artefato menciona direito do titular.
- [ ] CHK018 - FR-016 define o destino do payload anterior que a atualização semestral substitui? **[Gap]** [Clareza, Spec §FR-016; `data-model.md` §dados_entrego_json] {auto} — FR-016 define atualização e throttle; o campo é sobrescrito sem requisito sobre versionamento, histórico ou descarte do dado substituído.
- [ ] CHK019 - Qual prazo de retenção e qual base legal se aplicam aos dados de terceiros (o motorista não é usuário do hub)? [Risco] {humano}
- [ ] CHK020 - Os backups do hub (timer diário) entram no escopo da retenção decidida? [Assumption] {humano}

## D. Dados pessoais — log e auditoria

- [x] CHK021 - Existe requisito de auditoria para ações sobre os dados sensíveis? [Completude, Spec §FR-014] {auto} — "sujeitos ... ao mesmo padrão de auditoria já aplicado hoje a ações sobre credencial de motorista no hub".
- [ ] CHK022 - "mesmo padrão de auditoria" está quantificado — quais ações e quais campos gravados? **[Ambiguity]** [Clareza, Spec §FR-014] {auto} — FR-014 delega a um padrão existente sem enumerar. O plano enumera só 3 ações (`motorista.entrego_enriquecido`, `motorista.entrego_enriquecimento_falhou`, vínculo automático), todas de **escrita**.
- [ ] CHK023 - O ACESSO DE LEITURA aos dados sensíveis (quem visualizou o CPF, quando) gera registro de auditoria? **[Gap]** [Cobertura, `contracts/entrego-enriquecimento.md` §PATCH; `contracts/vinculo-automatico.md`] {auto} — nenhum requisito nem contrato audita `GET /motoristas/:id` quando ele devolve `dadosPessoais`. Para dado pessoal de terceiro, a trilha de quem consultou costuma valer mais que a de quem gravou.
- [x] CHK024 - Existe requisito proibindo o payload sensível dentro do registro de auditoria? [Completude, `contracts/entrego-enriquecimento.md` §PATCH] {auto} — "**nunca** incluir o payload de dados sensíveis em `detalhes`"; `scrubDetalhes()` declarado como defesa adicional, não substituto da disciplina.
- [ ] CHK025 - A proibição de registrar sensíveis vale também para log de aplicação e de exceção do worker? **[Gap]** [Cobertura] {auto} — a regra foi escrita para a tabela de auditoria. O worker de `infra/robo-entrego/` manipula o payload inteiro e nenhum requisito cobre stdout/stack trace/log de falha.

## E. Raspagem EntreGô — endpoint `[PROPOSTA]`

- [x] CHK026 - Algum requisito declara explicitamente que o endpoint da EntreGô NÃO está confirmado? [Clareza, Spec §FR-016; `research.md` Decision 9] {auto} — FR-016: "MUST ser confirmado ... antes da implementação — nunca suposto (Constitution VI)". Decision 9: "Nenhum endpoint para dados de cadastro do motorista está documentado."
- [ ] CHK027 - A proibição de supor a rota alcança a busca SOB DEMANDA (FR-005), ou só a rotina semestral? **[Gap]** [Consistência, Spec §FR-005 vs §FR-016] {auto} — a cláusula "nunca suposto" está redigida somente em FR-016. FR-005 dispara exatamente a mesma navegação contra o mesmo portal e não repete a restrição — uma tarefa derivada só de FR-005 poderia assumir a rota como existente sem violar requisito escrito.
- [x] CHK028 - Está definido ONDE a rota, quando levantada empiricamente, deve ser documentada? [Completude, Spec §FR-016; `research.md` Decision 9] {auto} — `docs/plans/robo-entrego/ACHADOS-PORTAL.md`, fonte única de endpoints do portal.
- [x] CHK029 - Existe plano B declarado caso a via de API não se confirme? [Cobertura, `research.md` Decision 9; `contracts/entrego-enriquecimento.md` §3] {auto} — os 6 XPaths do briefing como fallback de UI, declarado como plano B, não como via preferida.
- [ ] CHK030 - Existe critério de aceite que FALHE se uma tarefa assumir a rota como existente? **[Gap]** [Qualidade de Critérios de Aceite, Spec §Success Criteria] {auto} — SC-001..SC-005 não cobrem FR-016 nem a confirmação do endpoint. A regra é prosa normativa sem gate observável — exatamente o tipo de restrição que se perde na decomposição em tarefas.
- [x] CHK031 - O shape persistido é declarado como interno, e não como cópia do payload da EntreGô? [Clareza, `data-model.md` §Shape interno] {auto} — "nomes de chave escolhidos pelo hub — internos, não afirmam nome de campo da EntreGô".

## F. Raspagem EntreGô — sessão, antibot e throttle

- [x] CHK032 - O requisito proíbe credencial ou mecanismo de sessão novos? [Completude, Spec §FR-007/FR-016] {auto} — reuso da sessão persistida em `/var/lib/hub_secrets/robo-entrego/entrego-session.json`, "sem introduzir credencial nova".
- [ ] CHK033 - O "throttle entre motoristas" de FR-016 está quantificado? **[Ambiguity]** [Mensurabilidade, Spec §FR-016] {auto} — FR-016 exige throttle sem número. `research.md:150` traz "ex.: a cada 5 min, `[PROPOSTA — ajustar em create-tasks]`". Requisito não verificável como está.
- [x] CHK034 - O comportamento diante de bloqueio antibot está definido? [Cobertura de Edge Cases, Spec §FR-016] {auto} — backoff 1/5/15 min até 3 tentativas; `ErroAntibotSuspeito` → `ehFalhaDefinitiva`, "parando em vez de insistir".
- [ ] CHK035 - Existe limite de frequência para a busca SOB DEMANDA (FR-005), que usa a mesma sessão compartilhada? **[Gap]** [Requisitos Não-Funcionais, Spec §FR-005/FR-007] {auto} — FR-016 protege a rotina agendada; nada limita um gestor acionando o botão repetidamente. A sessão é a mesma da importação diária, então o dano de um bloqueio antibot não fica contido nesta feature.
- [x] CHK036 - Está definido que a falha da busca não descarta o enriquecimento anterior? [Cobertura de Edge Cases, Spec §FR-007; `quickstart.md` §Scenario 6] {auto}
- [ ] CHK037 - Bloquear a sessão compartilhada (e com ela a importação diária das 06:00) é risco aceitável para uma ação disparada por gestor? [Risco] {humano}

## G. Vínculo automático — critério de casamento

- [ ] CHK038 - A chave de vínculo afirmada em FR-009/FR-012 corresponde ao mecanismo real? **[Conflict]** [Consistência, Spec §FR-009/FR-012 vs `research.md` Decision 12] {auto} — FR-009 e a Clarification de 2026-09-03 afirmam que o CNPJ "já é a chave de vínculo `ContaMotorista`↔`Entregador` usada hoje no fluxo manual existente". Decision 12 constata o oposto: `Entregador` (migration 0010) **não tem coluna de CNPJ** e o casamento existente é por **similaridade de nome** (RPC `hub_motoristas_candidatos`, migration 0023). A spec não foi atualizada após a constatação — FR-009, FR-012 e a Clarification seguem afirmando um fato do sistema que o plano já refutou.
- [ ] CHK039 - "correspondência confiável" (FR-009/FR-010, US1 cenário 3) está quantificada em requisito? **[Ambiguity]** [Mensurabilidade, Spec §FR-009/FR-010] {auto} — o critério (exatamente 1 candidato com similaridade ≥ 0.9) existe apenas como `[PROPOSTA — confirmar em create-tasks]` em `research.md` Decision 12. Sem número no requisito, SC-002 ("para os casos em que a correspondência é confiável") não é verificável.
- [x] CHK040 - A idempotência do vínculo automático está requerida? [Completude, Spec §FR-011; `quickstart.md` §Scenario 1] {auto} — "MUST NOT criar um segundo vínculo nem sobrescrever um vínculo existente".

- [ ] CHK041 - A busca por um caminho CNPJ→`Entregador` esgotou as fontes disponíveis? **[Gap]** [Dependências e Premissas, `research.md` Decision 12] {auto} — Decision 12 conclui "não pode ser um `SELECT ... WHERE cnpj`" a partir de `Entregador` isolado, mas não avalia a ponte `"EnvioMassa".cnpj_prestador` → `"EnvioMassa".entregador_uuid` → `Entregador.id_externo`, criada pela migration 0046. Essa coluna é NULL-able e a migration declara-se aplicada **somente** em `hub_homolog`/`hub-test`, nunca em produção — a disponibilidade da ponte no ambiente do cliente é premissa não verificada, e nenhum requisito ou decisão a registra.

## Notes

- Items `{auto}` vêm resolvidos: `[x]` com a citação que prova, ou `[ ]` com marcador `[Gap]`/`[Ambiguity]`/`[Conflict]` apontando o que falta.
- Items `{humano}` (CHK005, CHK019, CHK020, CHK037) nunca são auto-marcados — dependem de apetite de risco e base legal, que são do dono do produto.
- Este checklist valida a QUALIDADE DOS REQUISITOS, não a implementação.

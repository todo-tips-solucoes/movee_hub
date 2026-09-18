# API Checklist: Adiantamento pelo App, Dados Bancários e Exportação Transfeera

**Purpose**: Validar a qualidade dos requisitos de contrato de API (hub + app motorista +
RPCs SQL + arquivo de exportação): versionamento, error handling, idempotência, retry,
observabilidade, consistência entre contratos novos e existentes.
**Created**: 2026-09-17
**Feature**: [spec.md](../spec.md) · [plan.md](../plan.md) · [contracts/hub-api.md](../contracts/hub-api.md) · [contracts/motorista-api.md](../contracts/motorista-api.md) · [contracts/sql-rpc.md](../contracts/sql-rpc.md) · [contracts/transfeera-xlsx.md](../contracts/transfeera-xlsx.md)

## Contratos novos — completude e rótulo `[PROPOSTA]`

- [x] CHK001 - Todo endpoint novo (hub e motorista) está explicitamente marcado como `[PROPOSTA — a validar na implementação]`, distinguindo do que já existe em produção? [Consistência, contracts/hub-api.md §Parte 2, contracts/motorista-api.md §Parte 2] {auto}
- [x] CHK002 - O contrato de rótulos de permissão por rota (10 códigos) está completo e consistente com as 10 permissões distintas exigidas por FR-045? [Completude, contracts/hub-api.md §Permissões por rota, Spec §FR-045] {auto}
- [x] CHK003 - As mudanças em contratos EXISTENTES (ex.: `hub_aviso_criar`, rotas do router do motorista) estão separadas das rotas totalmente novas, com o risco de regressão identificado (driver `hub-push-avisos-integration.sh`)? [Consistência, contracts/motorista-api.md §Mudanças em contratos existentes, plan.md §Riscos] {auto}

## Idempotência e concorrência (contrato)

- [x] CHK004 - O contrato da RPC de solicitação (`hub_adiantamento_solicitar`) define o comportamento exato de reenvio com a mesma chave de idempotência (devolve a existente, `reutilizado = true`), em vez de deixar implícito? [Mensurabilidade, sql-rpc.md, Spec §FR-050] {auto}
- [x] CHK005 - O contrato define o código de erro específico para tentativa de nova solicitação já existente no dia por outro caminho (violação de índice único → `ALREADY_REQUESTED`), distinto do fluxo de idempotência normal? [Clareza, sql-rpc.md `hub_adiantamento_solicitar`] {auto}
- [x] CHK006 - O requisito de criação de lote idempotente (FR-050) tem o mesmo tratamento explícito de chave de idempotência que a criação de solicitação, ou só um dos dois fluxos está detalhado no contrato? [Consistência, Spec §FR-050, sql-rpc.md] {auto}

## Error handling

- [x] CHK007 - Os erros de negócio das RPCs seguem um padrão único e documentado (`RAISE EXCEPTION '<CODIGO>'` → `{erro:'<CODIGO>'}`), reutilizando o padrão já existente (`FORA_DO_GRUPO_MOVEE`) em vez de introduzir um formato paralelo? [Consistência, sql-rpc.md §Novas] {auto}
- [x] CHK008 - O requisito de recusa de solicitação (FR-003) exige um motivo específico por causa (dia não permitido, antes da abertura, depois do corte, já solicitado), e não uma mensagem genérica de "recusado"? [Mensurabilidade, Spec §FR-003] {auto}
- [x] CHK009 - O contrato define o comportamento de falha do lote (geração/validação do arquivo) como cancelamento automático com devolução ao status liberado, sem expor arquivo parcial — o requisito é verificável observando o estado pós-falha? [Mensurabilidade, Spec §FR-029] {auto}
- [ ] CHK010 - Os contratos novos (`hub-api.md` Parte 2) enumeram os códigos de erro HTTP e de negócio esperados por rota (ex.: 409 para conflito de versão de configuração via FR-023), ou isso fica implícito e só aparece nas RPCs? [Gap, contracts/hub-api.md §Parte 2] {auto}

## Versionamento e consistência de configuração

- [x] CHK011 - O requisito de versionamento de configuração (FR-022) associa cada solicitação à versão vigente no momento da criação, e a RPC de solicitação valida explicitamente essa versão (`VERSAO_DESATUALIZADA` se desatualizada)? [Consistência, Spec §FR-022, sql-rpc.md `hub_adiantamento_solicitar`] {auto}
- [x] CHK012 - O requisito de conflito de salvamento simultâneo de configuração (FR-023) é mensurável — define o sinal exato de aviso de conflito (ex.: comparação de versão) que a implementação deve emitir? [Mensurabilidade, Spec §FR-023] {auto}
- [ ] CHK013 - O contrato HTTP para `PUT /configurações` (hub-api.md §Configuração) especifica o código de status e o corpo de resposta exatos para o caso de conflito de FR-023, ou essa mecânica fica só a nível de requisito funcional sem contrato de API correspondente? [Ambiguity, contracts/hub-api.md §Configuração, Spec §FR-023] {humano}

## Autenticação/claims nas RPCs (contrato)

- [x] CHK014 - Cada grupo de RPC novo declara explicitamente as claims exigidas (motorista: `motorista_cnpj`+`escopo`; hub: `sub`+`empresa_ativa`+`escopo`; worker: `hub_adiantamento_worker`), sem RPC "órfã" de claim? [Completude, sql-rpc.md §Novas] {auto}
- [x] CHK015 - A claim nova do worker (`hub_adiantamento_worker`) tem uma função de leitura dedicada (`hub_jwt_adiantamento_worker()`) documentada, em vez de reusar implicitamente a leitura de claim de usuário humano? [Clareza, sql-rpc.md §Claims] {auto}
- [x] CHK016 - As RPCs do app do motorista (`hub_adiantamento_cancelar`, `hub_conta_bancaria_motorista`, etc.) restringem consistentemente o retorno ao CNPJ da própria claim, sem uma delas aceitar um `id`/CNPJ arbitrário do chamador? [Consistência, sql-rpc.md §App do motorista] {auto}

## Contrato do arquivo de exportação (Transfeera)

- [x] CHK017 - O contrato do arquivo (transfeera-xlsx.md) define layout, colunas e nome do arquivo com fonte rastreável (PLANO §6/§7.1), sem coluna inventada sem citação? [Completude, contracts/transfeera-xlsx.md §Estrutura, §Colunas] {auto}
- [x] CHK018 - O requisito de conteúdo de linha (FR-055) e o contrato do arquivo concordam byte-a-byte nos mesmos 11 campos (nome, documento mascarado, e-mail, banco, agência, conta+dígito, tipo, valor, id de integração, data de agendamento vazia, descrição), sem um campo a mais ou a menos em um dos dois documentos? [Consistência, Spec §FR-055, contracts/transfeera-xlsx.md §Colunas] {auto}
- [x] CHK019 - O requisito de reprodutibilidade do download (FR-030 — mesmo conteúdo em todo download repetido) tem um mecanismo de contrato explícito (retrato imutável salvo, não regeração), evitando que uma regeração produza bytes diferentes? [Mensurabilidade, Spec §FR-030, plan.md §Riscos "retrato das linhas exportadas"] {auto}
- [x] CHK020 - A função de identificador de integração (`hub_adiantamento_integration_id`) documenta o caso de borda de IDs com mais de 6 dígitos (o `lpad` trunca), com uma solução explícita, em vez de deixar o comportamento de overflow implícito? [Cobertura de Edge Cases, sql-rpc.md, plan.md §Riscos "lpad do Postgres trunca"] {auto}
- [x] CHK021 - O contrato do arquivo define o comportamento quando o banco de uma conta não consta na lista COMPE carregada (`lib/fixtures/bancos-compe.json`)? Sim, por composição de dois requisitos: FR-016 recusa no envio (app) qualquer banco fora da lista oficial — logo nenhuma conta *aprovada* por esse caminho pode ter banco inválido; para a carga legada (F8), dec-027 desta onda fixa que contas com banco fora da lista MUST ser recusadas/reportadas, nunca mapeadas por suposição. [Consistência, Spec §FR-016, plan.md §Pontos para confirmação item 3 (dec-027)] {auto}

## Retry, rate limiting e observabilidade

- [x] CHK022 - O requisito de agendamento periódico (FR-049) define que o processo tenta novamente automaticamente solicitações em "aguardando produção" sem intervenção manual, com critério de parada (produção disponível) mensurável? [Mensurabilidade, Spec §FR-011, §FR-049] {auto}
- [x] CHK023 - **RESOLVIDO na onda-016 (3.3.5):** `lib/adiantamento-worker.js#chamarProcessarComRetry` distingue os dois cenários explicitamente — erro transitório de infra (timeout/5xx/429/código de rede POSIX, mesma classificação de `hub-import-processor.js#errorTransiente`) retenta com backoff limitado (3 tentativas, `[500,2000]`ms) e loga alerta se esgotar; "produção ainda não disponível" NUNCA é um erro (a própria RPC `hub_adiantamento_processar` já decide isso por linha, devolvendo `status_para='AGUARDANDO_PRODUCAO'` sem lançar exceção) — o tick só audita e deixa o próximo tick (60s) tentar de novo, indefinidamente. O contrato define uma política de retry para a chamada da fonte de produção quando ela responde com erro transitório (timeout/5xx), distinta do caso "produção ainda não disponível" (FR-011), ou os dois cenários ficam indistinguíveis no requisito? [Ambiguity, Spec §FR-011, §FR-009] {auto}
- [x] CHK024 - O limite de consumo de recursos do tick (200 por execução, geração < ~1s, plan.md S8) está definido com número verificável, não como "processamento rápido"? [Mensurabilidade, plan.md §Segurança S8] {auto}

## Regra financeira pendente de decisão do operador (acrescentado pela sessão pai)

- [x] CHK025 - **RESOLVIDO em 2026-09-17 pelo operador (D-23, dec-038):** o fechamento é recusado enquanto houver solicitação não finalizada no período (aguardando corte, aguardando produção, liberada, em lote, exportada, falhou); novo estado `ENCERRADA` para falha que não será paga; o snapshot desconta o bruto das pagas. Registrado em spec FR-034/FR-041 e plan.md. Pergunta original: Está definido o que o fechamento da apuração semanal faz quando há adiantamentos do período já exportados (EM_LOTE/EXPORTADA) e ainda não confirmados como pagos: (a) descontar só os pagos e avisar (leitura atual do plan.md, dec-020), (b) recusar o fechamento enquanto houver pendentes, ou (c) descontar também os exportados? Risco de (a): adiantamento já transferido não descontado do repasse (pagamento em dobro). A pergunta foi levada ao operador em 2026-09-17; a implementação do fechamento (F4, FR-041) NÃO pode começar antes da resposta registrada como Decisão. [Gap, Spec §FR-037, §FR-041, plan.md §Pontos para confirmação item 1] {humano}

## Notes

- Items `{auto}` já vêm resolvidos pelo agente (`[x]` com citação, ou marcador `[Gap]`/`[Ambiguity]`).
- Items `{humano}` ficam `[ ]` aguardando decisão do dono do produto.
- CHK021 foi resolvido nesta onda pela combinação de FR-016 (validação no envio) + dec-027 (recusa explícita na carga legada, F8) — sem gap remanescente.

# Quickstart: Adiantamento pelo App, Dados Bancários e Exportação Transfeera

Cenários que validam a implementação de ponta a ponta. Rodam **só** em stack efêmero
`hub-test-*` ou no `hub-homolog` (exceção `hub-*` do CLAUDE.md); nunca em produção. Dados
sempre fictícios (CPF/CNPJ gerados com DV válido, nomes inventados).

## Preparação

1. `cd /var/lib/envioMassa_homologacao`; conferir `df -h /` (parar abaixo de 20 GB) e swap
   ativa (`swapon --show`).
2. Driver de integração novo: `infra/hub/testes/hub-adiantamentos-integration.sh` — sobe um
   `hub-test-*` com `infra/hub/compose.hub.test.yml`, aplica as migrations com
   `infra/hub/scripts/migrate.sh` **duas vezes** (idempotência), semeia dados e roda
   `node --test` sobre `app_homologacao/backend/tests/hub-adiantamentos-integration.test.js`.
3. Semente mínima: empresa 6 com o módulo `adiantamentos` ativo; um usuário `financeiro`;
   uma versão de configuração **completa** (fonte `financeiro_lancamento`, categoria
   `"Corrida"` fictícia, apuração com início na quinta e repasse 0 dia após o fim); uma
   `ContaMotorista` + `Entregador` vinculado; uma conta bancária `APROVADA`; lançamentos
   `Credito` somando R$ 215,67 na data D-1.
4. Depois de qualquer E2E, reverter o `package-lock.json` reescrito pelo container.

## Scenario 1: Solicitar dentro da janela e ser liberado (US1, happy path)

1. Com uma versão de configuração **de teste** cuja janela cobre o instante real do teste
   (todos os dias habilitados, 00:00–23:59; o relógio do banco não é manipulado), o
   motorista chama `GET /motorista/adiantamento/disponibilidade`.
2. **Expected**: `canRequest: true`, `productionDate` = ontem,
   `estimate.gross: "129.40"`, `estimate.net: "129.05"`.
3. `POST /motorista/adiantamentos {aceite:true, chaveIdempotencia, versaoConfiguracao}`.
4. **Expected**: 201, `status: "AGUARDANDO_CORTE"`, evento "Solicitação recebida".
5. Repetir o POST com a **mesma** chave. **Expected**: 200 com o mesmo `id`.
6. Simular o corte sem mexer no relógio: semear (como superusuário do stack de teste) uma
   solicitação `AGUARDANDO_CORTE` com `data_solicitacao` = ontem, ligada à versão
   semeada, e os lançamentos na `data_producao` correspondente; executar
   `hub_adiantamento_processar`. (Trocar a versão não serve: R-06 mantém a versão da
   solicitação.)
7. **Expected**: `LIBERADA`, `producao 215.67`, `bruto 129.40`, `taxa 0.35`,
   `liquido 129.05`, `conta_bancaria_id` preenchido, uma `NotificacaoMotorista`
   "Adiantamento liberado" e a auditoria `adiantamento.calculado` sem documento/conta.

## Scenario 2: Fronteiras de horário e D-1 (US1, SC-002, edges 2–5, 27)

1. Chamar a função interna de janela com os instantes `08:59:59`, `09:00:00`, `14:59:59` e
   `15:00:00` do fuso da configuração (e os mesmos instantes em UTC, para provar o fuso).
2. **Expected**: `✗ ✓ ✓ ✗` (`BEFORE_OPENING`, ok, ok, `AFTER_CUTOFF`).
3. Domingo (desabilitado) → `DAY_NOT_ALLOWED` com `nextAvailableAt` na segunda 09:00.
4. Segunda 01/03 e sexta 01/01 → `data_producao` = domingo 28/02 (ou 29/02) e 31/12 do
   ano anterior.
5. Unit (`adiantamento-regras-unit.test.js`): os mesmos casos em JS, e a mudança do relógio
   do cliente não altera nada (a API não aceita horário).

## Scenario 3: Recusas e pré-requisitos (US1/US2, edges 7–11, 22)

1. Motorista sem vínculo → `reason: NOT_LINKED`. Sem conta → `NO_BANK_ACCOUNT`. Só com
   `PENDENTE` → `BANK_ACCOUNT_PENDING`. Com `APROVADA` + `PENDENTE` nova → pode solicitar.
2. Configuração sem fonte → `NOT_CONFIGURED`.
3. Duas `POST /motorista/adiantamentos` **em paralelo** com chaves diferentes.
   **Expected**: uma 201 e uma 409 `SOLICITACAO_INDISPONIVEL/ALREADY_REQUESTED`; uma linha só.
4. Cancelar antes do corte → `CANCELADA`; nova solicitação no mesmo dia → 201 (Q-N1).
5. Cancelar depois do corte → 409 `TRANSICAO_INVALIDA`.
6. D-1 sem nenhum lançamento, mas com importação `processing` de faturamento →
   `AGUARDANDO_PRODUCAO`; importação concluída com lançamentos → `LIBERADA` no ciclo
   seguinte. D-1 com dados mas sem crédito do entregador → `INELEGIVEL SEM_PRODUCAO`.
7. Taxa ≥ bruto → `INELEGIVEL VALOR_INSUFICIENTE`.

## Scenario 4: Conta bancária (US2/US3, edges 9, 10, 16)

1. `POST /motorista/conta-bancaria/solicitacoes` com CPF de DV inválido.
   **Expected**: 400 `{erro:'DADOS_INVALIDOS', motivo:'titularDocumento'}`.
2. Envio válido com agência `1` e conta `0012345`. **Expected**: `PENDENTE`, agência `0001`,
   conta `0012345` preservada.
3. Financeiro: `GET /api/v1/adiantamentos/contas` mostra `••••2345-x` e
   `***.***.***-NN`; `GET /contas/:id?completo=true` sem `contas_revisar` → 403; com a
   permissão → dados completos + auditoria `conta_bancaria.visualizada`.
4. `POST /contas/:id/aprovar` com `entregadorConfirmadoId` errado → 400; certo →
   `APROVADA`, a anterior → `SUBSTITUIDA`, notificação "Conta aprovada".
5. Rejeitar outra `PENDENTE` com motivo → `REJEITADA`; a `APROVADA` continua valendo.

## Scenario 5: Lote, Excel e download (US5, edges 12–21, 25, 26)

1. Semear 5 `LIBERADA`: 3 aptas, 1 com conta aprovada trocada depois da liberação e
   1 já `EXPORTADA`.
2. `POST /api/v1/adiantamentos/lotes/previa` com os 5 ids + 1 id repetido.
   **Expected**: 3 aptas, pendências `CONTA_ALTERADA`, `STATUS_INVALIDO`,
   `DUPLICADA_NA_SELECAO`; total apto correto.
3. `POST /lotes` com total esperado errado → 409 `PREVIA_DESATUALIZADA`.
4. `POST /lotes` correto → 201 `GERADO`. Reenvio com a mesma chave → 200, mesmo lote.
5. **Concorrência real**: dois usuários `financeiro` criam lotes com ids sobrepostos em
   paralelo. **Expected**: um 201 e um 409 `SOLICITACOES_EM_OUTRO_LOTE` com os ids; nenhuma
   solicitação em dois itens ativos.
6. `GET /lotes/:id/arquivo` duas vezes. **Expected**: bytes idênticos (sha256), headers
   `Cache-Control: no-store` e `Content-Disposition: attachment; filename="transfeera_adiantamentos_<data>_lote-<NNNNNN>.xlsx"`;
   `downloads = 2`; lote `EXPORTADO`; solicitações `EXPORTADA`; notificação "Pagamento em
   processamento". Sem `exportar` → 403 mesmo com `pagamentos_consultar`.
7. O teste relê o arquivo: aba `Página1`, mescla `A1:L1`, 12 cabeçalhos, agência `0001`
   e conta `0012345` como texto (`t='s'`), valor numérico com 2 casas, IDs `ADV-` únicos,
   coluna K vazia, Descrição Pix com a data da produção.
8. Falha injetada na geração → lote `CANCELADO (falha_geracao)`, solicitações `LIBERADA`,
   `GET /arquivo` → 409 `ARQUIVO_INDISPONIVEL`.
9. `ids` com 5.001 itens → 422 `LOTE_ACIMA_DO_LIMITE`.

## Scenario 6: Cancelar, confirmar e reprocessar (US5, edge 20)

1. Cancelar um lote `EXPORTADO` sem `naoEnviadoATransfeera` → 409
   `CONFIRMACAO_NAO_ENVIADO_OBRIGATORIA` (13.5: converge — o código já
   distinguia esse caso de dado malformado); com `true` → `CANCELADO`,
   solicitações `LIBERADA`, auditoria com a declaração.
2. Em outro lote exportado: `POST /lotes/:id/confirmacao {falhas:[{id, motivo}]}` →
   `CONCLUIDO_COM_FALHAS`; uma `FALHOU`, as demais `PAGA`; notificações correspondentes.
3. `POST /:id/reprocessar {motivo}` na `FALHOU` → `LIBERADA`; novo lote aceita; o item novo
   tem `item_anterior_id`; o `ID integração` é o mesmo.

## Scenario 7: Configuração versionada (US4, edge 6)

1. Duas pessoas leem a versão 3; a primeira salva (versão 4); a segunda salva com
   `versaoEsperada: 3`. **Expected**: 409 `VERSAO_DESATUALIZADA`.
2. Uma solicitação criada na versão 3 é calculada com o percentual da versão 3 mesmo
   depois de a versão 4 mudar o percentual.
3. **Expected**: auditoria `adiantamento.configuracao_alterada` com o diff.

## Scenario 8: Remanescente (US6)

1. Período com crédito de R$ 1.000,00 e um adiantamento `PAGA` com bruto R$ 129,40 e
   `data_producao` no período.
2. **Expected**: remanescente `870.60` (D-11); taxa não descontada de novo.
3. Outro motorista com crédito menor que o bruto → valor negativo e `negativo: true`.
4. Uma solicitação `EXPORTADA` no período aparece na previsão como "em processamento".
5. `POST /repasse/:periodo/fechar` → snapshot; segunda vez → 409 `APURACAO_JA_FECHADA`;
   um lançamento novo no período depois do fechamento não altera o snapshot.
6. `GET /motorista/repasse` → 404 com `repasse_visivel_app = false`; 200 com `true`.

## Scenario 9: Notificações sem push (US7, SC-008)

1. Hub envia um aviso `toda_base` quando nenhum motorista tem `PushInscricao`.
   **Expected**: 201 (não mais `SEM_INSCRICOES_ATIVAS`), `NotificacaoMotorista` para todas
   as contas do público, zero `AvisoEntrega`; prévia "N motoristas · 0 com push".
2. O motorista sem push abre `GET /motorista/notificacoes` e `GET /motorista/avisos/:id`.
   **Expected**: 200 nos dois; `nao-lidas` diminui após `POST /notificacoes/:id/lida`.
3. Motorista de outro CNPJ pede o mesmo aviso → 404 `AVISO_NAO_DISPONIVEL`.

## Scenario 10: Auditoria sem dado pessoal (SC-006, SC-010)

1. Ao fim do driver, rodar `infra/hub/scripts/scan-auditoria-sensivel.sh -f … -p … -e …`.
2. **Expected**: zero achados; nenhum `detalhes` com documento, conta ou base64 de arquivo.

## Scenario 11: Roundtrip End-to-End (obrigatório — borda backend ↔ frontend)

Payload **real**, sem mock.

1. No `hub-test-*` do driver, com o backend no ar, autenticar o motorista semeado
   (`POST /motorista/login`) e o usuário `financeiro` (`POST /api/v1/auth/login`), guardando
   os cookies.
2. Chamar de verdade: `GET /motorista/adiantamento/disponibilidade`,
   `GET /motorista/adiantamentos/:id`, `GET /api/v1/adiantamentos?page=1`,
   `POST /api/v1/adiantamentos/lotes/previa`, `GET /api/v1/adiantamentos/configuracoes`.
3. Comparar o shape com `contracts/motorista-api.md` e `contracts/hub-api.md`:
   - chaves em camelCase (nenhuma `snake_case` vazando da tabela);
   - dinheiro como **string** com 2 casas (`typeof === 'string'`, `/^-?\d+\.\d{2}$/`);
   - listas do hub com `itens` (e não `items`), `total`, `page`, `pageSize`;
   - enums de `status`/`reason` dentro das listas declaradas.
4. Os mesmos payloads alimentam os tipos TypeScript de `frontend_v2/lib/hub/adiantamentos-api.ts`
   e `frontend_motorista/lib/adiantamento-api.ts` (teste que parseia o JSON capturado).
5. **Expected**: zero divergência entre payload real, contrato e tipo do front.

## Scenario 12: E2E de browser (via driver, nunca no host)

1. Hub: `infra/hub/testes/hub-adiantamentos-e2e-browser.sh` — configurar → revisar conta →
   selecionar → prévia com pendência → gerar → baixar (arquivo relido e validado) →
   confirmar; axe ≥ 95 e contraste nos dois temas, com dados semeados antes de medir.
2. App: `infra/hub/testes/hub-motorista-adiantamento-e2e-browser.sh` — disponível,
   indisponível, prazo encerrado, solicitar, cancelar, timeline, conta, notificações;
   relógio do navegador adulterado não muda o resultado.
3. **Expected**: todos verdes; `package-lock.json` revertido depois.

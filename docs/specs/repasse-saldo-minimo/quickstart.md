# Quickstart / Cenários de teste: repasse-saldo-minimo

Todos os cenários rodam **só** no ambiente isolado do hub (`hub-dev`/`hub-test-*`/
`hub-homolog`, exceção G1) ou em teste unit — nunca contra produção. Drivers em
`infra/hub/testes/*.sh`; SQL em `infra/hub/testes/sql/`.

## F1 — Identificador no repasse

### Cenário F1.1 — tela e CSV trazem o identificador (happy path)
1. Semana aberta com ≥ 1 motorista → `GET /api/v1/adiantamentos/repasse?periodo=<seg>`.
2. Mesma chamada para uma semana fechada.
3. `GET /repasse/exportar?periodo=<seg>` nas duas.
→ **Expected**: todo item tem `idExterno` igual ao `id_externo` do `Entregador`; o CSV
começa por `Identificador,Entregador,…`; o valor bate com `GET /motoristas` (tela de
Motoristas) para o mesmo motorista.

### Cenário F1.2 — lotes de 100
1. Unit: helper recebe 1.021 ids distintos.
→ **Expected**: 11 chamadas, nenhuma com mais de 100 ids; ids duplicados/`null` ignorados.

### Cenário F1.3 — falha da busca de identificador (error case)
1. Unit/rota: PostgREST devolve erro na busca de `Entregador`.
→ **Expected**: resposta de erro (sem linha sem identificador); nenhum CSV parcial.

### Cenário F1.4 — Roundtrip End-to-End
1. No `hub-homolog`, chamada **real** ao backend (sem mock) de `GET /repasse`.
2. Validar o payload contra `contracts/hub-repasse-api.md` (camelCase, `idExterno` string uuid).
→ **Expected**: shape idêntico ao contrato; `RepasseItem` do frontend tipado com `idExterno`.

## F2 — Aprovação restrita e trava

### Cenário F2.0 — controle negativo do furo (roda ANTES da migration 0097)
1. Ambiente `hub-test-*` em 0096. JWT de `admin_entidade` da empresa de teste.
2. `POST /api/v1/usuarios/:id/vinculos` com `papelId` de `admin_plataforma`; repetir direto
   no PostgREST (`POST /UsuarioEntidade`) e `POST /PapelPermissao`.
3. `PUT /api/v1/usuarios/:id` trocando a senha de um usuário com vínculo `admin_plataforma`.
→ **Expected (hoje)**: as quatro **passam** — prova do furo. Guardar a saída como evidência.
Após 0097 + backend novo, as mesmas quatro chamadas **falham** (F2.4).

### Cenário F2.1 — aprovação negada a financeiro e admin_entidade
1. Após 0097: com `financeiro` puro e com `admin_entidade` puro, chamar
   `POST /repasse/:periodo/fechar`, `POST /repasse/:periodo/movimentos`,
   `POST /lotes/:id/confirmacao`, `POST /lotes/:id/retorno`.
2. Chamar direto no PostgREST `rpc/hub_adiantamento_repasse_fechar` e
   `rpc/hub_adiantamento_lote_confirmar` com o JWT de cada um.
→ **Expected**: 403 `PERMISSAO_NEGADA` nas 4 rotas; `PERMISSAO_NEGADA` nas 2 RPCs.

### Cenário F2.2 — aprovador e admin plataforma aprovam
1. Mesmas ações com `financeiro_aprovador` e com `admin_plataforma` (com vínculo na empresa).
→ **Expected**: permitidas.

### Cenário F2.3 — aprovador = financeiro + aprovar
1. SQL: diferença de conjuntos de `PapelPermissao` entre os dois papéis.
→ **Expected**: `aprovador − financeiro = {adiantamentos.pagamento_confirmar}`,
`financeiro − aprovador = ∅`.

### Cenário F2.4 — trava de papel restrito (error case)
1. `admin_entidade` tenta: criar usuário com papel restrito; criar vínculo restrito;
   trocar para restrito; desativar/alterar vínculo cujo papel atual é restrito; o mesmo
   sobre o próprio vínculo; `PUT /usuarios/:id` (senha, nome, `ativo=false`) sobre usuário
   com papel restrito.
2. Repetir direto no PostgREST (`UsuarioEntidade`; `POST /PapelPermissao`).
→ **Expected**: rota → 403 `PAPEL_RESTRITO` + linha `usuario_vinculo_negado` na Auditoria;
PostgREST → 403 no INSERT/`WITH CHECK`, `[]` e linha intacta no UPDATE de vínculo restrito,
`42501`/403 no `POST /PapelPermissao`. `admin_plataforma` faz as mesmas operações com 2xx.

### Cenário F2.5 — sem regressão para papéis comuns
1. `admin_entidade` cria usuário `operador`, troca para `leitura`, desativa.
→ **Expected**: tudo 2xx, como hoje.

### Cenário F2.6 — rollback
1. `0097-rollback.sql` num banco sem vínculo `financeiro_aprovador` → volta ao estado 0096.
2. Com vínculo `financeiro_aprovador` existente → rollback **recusa** e avisa.
3. Após o rollback, `authenticated` volta a ter `INSERT, UPDATE` nas quatro tabelas da matriz.
4. Pré-deploy (operador, produção): confirmar `JWT_SECRET` ≠ `PGRST_JWT_SECRET` sem exibir
   os valores (ex.: comparar hashes).
→ **Expected**: `0097-rollback.test.sql` verde nos dois casos; `ROLLBACK=1` conferido.

## F3 — Saldo mínimo carregado (driver `hub-repasse-saldo-minimo.sh` + `0098-saldo-minimo.test.sql`)

Piso = 5,50. Cada caso fecha semanas **em sequência** para um motorista de teste.

| # | Sequência | Expected |
|---|---|---|
| 1 | 3,00 → 4,00 | sem. 1 retida (pago 0, transp. 3,00); sem. 2 paga **7,00**, uma nota com os componentes somados |
| 2 | 3,00 → **sem atividade** | sem. 2 **tem item** com `saldo_anterior = 3,00`, segue retida |
| 3 | 2,00 → 1,50 → 1,00 → 4,00 | acumula 4,50 retido; sem. 4 paga 8,50 |
| 4 | 5,50 | paga (limite `<`) |
| 5a | −10,00 sem saldo | nada transporta; alerta como hoje |
| 5b | 3,00 → −10,00 → 4,00 | sem. 2: pago 0, transp. 3,00 (D9); sem. 3 paga 7,00 |
| 6 | fechar semana anterior à última / pular uma | `APURACAO_FORA_DE_ORDEM` nos dois |
| 7 | conservação | `Σ remanescente(>=0 semanas) = Σ valor_pago + último valor_transportado` por motorista |
| 8 | retrato antes/depois | semana fechada antes de 0098 lê idêntica (colunas antigas iguais; novas `NULL`) |
| 9 | motorista desativado com saldo | item continua sendo criado |

**Controles negativos** (conferir QUAIS falham): sem a inclusão do saldo no CTE `linhas`
→ o caso 2 **tem** de falhar; sem somar `saldo_anterior` → casos 1, 3 e 7 **têm** de
falhar; sem a guarda de ordem → caso 6 falha. `ROLLBACK=1` conferido.

### Cenário F3.10 — piso editável só por quem aprova
1. `admin_entidade` (tem `configurar`, não tem `pagamento_confirmar`) faz
   `PUT /configuracoes` com `repasseValorMinimo: "6.00"`; depois direto na RPC.
2. `financeiro_aprovador` repete; tenta também `0` e `-1`.
→ **Expected**: 403 `PERMISSAO_NEGADA_PISO` / RPC recusa; aprovador salva 6,00 (nova
versão); `0`/`-1` → 400 e `CHECK` do banco.

### Cenário F3.11 — CSV com retido
1. Exportar semana com motorista retido.
→ **Expected**: linha presente, `A pagar = 0,00`, `Passou para a próxima semana = 3,00`.

### Cenário F3.12 — app do motorista
1. Motorista com saldo retido abre o app antes do próximo fechamento; depois consulta a
   semana fechada retida.
→ **Expected**: linha "Saldo da semana anterior" e aviso de que o valor entra no próximo
repasse; no card da semana fechada, a linha final vira "Passou para a próxima semana:
R$ 3,00" (sem data, sem a palavra "Retido") no lugar de "Valor a receber" (texto
aprovado pelo operador em 2026-09-26, block-007/dec-047 —
`frontend_motorista/app/(app)/repasse/page.tsx:242-243`; E2E
`hub-motorista-adiantamento-e2e-browser.sh`).

### Cenário F3.13 — Roundtrip End-to-End
1. `hub-homolog`, chamadas reais a `GET /api/v1/adiantamentos/repasse` e
   `GET /motorista/repasse` após fechar uma semana com retido.
→ **Expected**: payloads batem com os contratos (camelCase, campos novos presentes, `null`
só em apuração pré-regra).

### Cenário F3.14 — rollback
1. `0098-rollback.sql` sem apuração fechada após 0098 → volta aos corpos vigentes
   (0088/0086/0092/0091) e remove colunas.
2. Com apuração pós-0098 com `valor_transportado > 0` → rollback **recusa** (perderia saldo devido).

### Cenário F3.15 — piso vigente no fechamento, não no início da semana (FR-025a, block-006)
1. Piso da empresa = 5,50. Abre a semana (prévia usa 5,50).
2. Antes de fechar, `financeiro_aprovador` altera o piso para 8,00 via `PUT /configuracoes`.
3. Fecha a semana com um motorista em 6,00 (entre os dois valores).
→ **Expected**: fecha usando **8,00** (vigente no momento do fechamento) — motorista fica
retido (6,00 < 8,00), não pago (6,00 ≥ 5,50 seria pago se valesse o piso do início da
semana). `ApuracaoRepasse.piso_aplicado = 8.00`. Apuração fechada antes da 0098 mostra
`piso_aplicado = NULL`.

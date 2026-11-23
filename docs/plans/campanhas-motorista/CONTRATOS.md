# Campanhas: contratos fechados (fonte única para as ondas W1–W4)

> Derivado do `PLANO.md` aprovado em 2026-11-22. **Nenhum agente decide nada fora daqui.**
> Se algo aqui se mostrar impossível ou contraditório: PARE e devolva ao orquestrador com o
> motivo medido. Não improvise.

## Erratas validadas pelo orquestrador depois da W1 (2026-11-22)

- "Praça" = coluna `PerformanceTurno.subpraca` (a mesma de `/performance/areas` e da 0051), não `praca`.
- Nota de pedidos é limitada a 100, inclusive a hipotética de quem passa o líder.
- Formatos de retorno: `hub_campanha_listar` → `TABLE(item jsonb)` em camelCase; detalhe e RPCs do
  motorista em camelCase; `hub_campanha_ranking` e `hub_campanha_opcoes` em snake_case (§6).
- Prêmio aceita `id` opcional no `hub_campanha_salvar`: com id, atualiza e preserva a foto.
- O motorista é resolvido pelo Entregador da **empresa da campanha** (um por empresa).
- `posicao_anterior` só avança quando `dados_ate` muda (2ª e 3ª importação do dia não zeram a variação).
- Links de notificação `/campanhas/<id>` são aceitos no CHECK do banco, em `linkPermitidoOuNulo`
  (backend) e em `lib/notificacao-link.ts` (app).
- **Deploy:** a 0127 não habilita o módulo `campanhas` para nenhuma entidade (fail-closed). No deploy,
  habilitar em `ModuloEntidade` para a entidade **6 (Movee)**. O app é exclusivo do grupo Movee; outras
  entidades só sob decisão do operador.

## Erratas da revisão adversarial W5 (2026-11-22) — decisões do orquestrador

- **A1/A2 planilha de prêmios (dinheiro):**
  - Data do pagamento de cada linha = **data (SP) do `exportado_em`** daquele vencedor, carimbada uma vez
    só. O download repetido reproduz as mesmas linhas e datas, e o reimport dá `JA_APLICADO`.
  - Ao carimbar, um vencedor cujo CNPJ **já tem** outro vencedor de dinheiro (qualquer campanha da
    empresa) com `exportado_em` no mesmo dia SP **não é carimbado**: fica pendente para o dia seguinte e
    volta como `adiados` na resposta.
  - RPC `hub_campanha_marcar_exportado(p_id)` → `TABLE(cnpj, nome, valor_centavos, posicao, data_pagamento date, adiado boolean)`.
    Inclui as linhas já exportadas (com a data original) e as recém-carimbadas; `adiado=true` não entra
    no XLSX. Sem CNPJ continua fora.
  - Rota: `POST /:id/premios-dinheiro.xlsx` (era GET; GET não carimba nada). Resposta = arquivo; o
    cabeçalho `X-Premios-Adiados: <n>` informa quantos ficaram para amanhã.
- **A3:** o proxy `frontend_v2/app/api/[...path]/route.ts` repassa `image/jpeg|png|webp` como binário,
  com teto de 600 KB antes da leitura. Generaliza o ramo do XLSX numa tabela `mime → teto`, sem um
  segundo `if` copiado.
- **M1:** fechamento automático exige `max(data_periodo) >= data_fim` **e** `hub_hoje_sp() > data_fim`.
- **M2/B1:** `fechar_interno` e `recalcular_interno` retornam sem efeito se a campanha está cancelada ou
  já fechada (relido sob `FOR UPDATE`).
- **M3:** o aviso de início só é enfileirado a partir das 08:00 de São Paulo do dia de início.
- **B2:** as RPCs de foto passam a receber `(p_campanha_id, p_premio_id, …)` e exigem que o prêmio
  pertença à campanha (`CAMPANHA_NAO_ENCONTRADA` se não pertencer). A auditoria usa o mesmo id.
- **B3:** `alcance.rodaram` respeita o filtro de modal (e `sem_modal` continua contando os sem modal do público).
- **B6:** `id` de prêmio repetido no corpo → `VALIDACAO` (campo `premios`); o gatilho do prêmio checa
  também `OLD.campanha_id`.
- **B7:** o valor em reais no formulário é lido no formato BR (`1.234,56`), reaproveitando o parser já
  existente no frontend (se houver), e nunca removendo todo ponto.
- **B8:** as RPCs do motorista exigem o módulo `campanhas` ativo na empresa da campanha.
- **B4 recusado:** prêmio de vencedor sem CNPJ está pendente de verdade.

## 0. Regras transversais

- Hoje = `(now() AT TIME ZONE 'America/Sao_Paulo')::date`. Uma única função SQL: `hub_hoje_sp()`.
- Unidades: taxas e cortes de taxa em **fração 0..1** (como `PerformanceMeta`); notas em 0..100 com 2 casas.
- Canonização de texto (praça, turno, modal) para comparar: `upper(btrim(x))`. Guardar o texto canônico.
- Nome abreviado para o app: função SQL `hub_nome_abreviado(text)` = primeiro token + espaço + inicial
  do último token + `.` (ex.: "Juliana Pereira Lima" → "Juliana L."); 1 token → só ele; NULL/vazio → "Motorista".
  O nome completo de terceiros **nunca** sai das RPCs do motorista.
- Toda RPC: `SECURITY DEFINER`, `SET search_path = public, pg_temp`, `REVOKE ALL … FROM PUBLIC`,
  `GRANT EXECUTE … TO authenticated`. Escopo do hub por `hub_jwt_escopo_ids()`; motorista por
  `hub_jwt_motorista_cnpj()` (+ `hub_jwt_motorista_id_empresa()`), resolvendo o entregador **como faz
  `hub_adiantamento_repasse_motorista()` (0117)**. Erros com `ERRCODE` estável + `MESSAGE` = token
  (lista em §5).

## 1. Situação da campanha (derivada, uma função: `hub_campanha_situacao(c "Campanha") → text`)

```
cancelada_em IS NOT NULL                        → 'cancelada'
lancada_em  IS NULL                             → 'rascunho'
fechada_em  IS NOT NULL                         → 'encerrada'
hoje < data_inicio                              → 'agendada'
hoje <= data_fim                                → 'em_andamento'
senão                                           → 'apurando'
```

## 2. Regras de cálculo (`hub_campanha_recalcular(p_campanha_id int) → jsonb {classificados, abaixo_corte, sem_minimo, sem_modal, ms}`)

1. Universo = linhas de `mv_performance_dia` com `id_empresa` da campanha, `data_periodo` entre início e
   `LEAST(data_fim, hoje)`, `upper(btrim(periodo)) = ANY(turnos)` se `turnos` não for nulo, e — se `pracas`
   não for nulo — `(entregador_id, data_periodo, periodo) IN (SELECT … FROM "PerformanceTurno" WHERE
   id_empresa = … AND upper(btrim(praca)) = ANY(pracas) AND data_periodo BETWEEN …)` (semi-join; **proibido**
   `EXISTS` correlacionado — medido a 1,5 s na 0051).
2. Agrega por entregador: `turnos = count(*)`, somas de ofertadas, aceitas, completadas, pedidos
   (`pedidos_concluidos`), `online_epoch`, `periodo_epoch`.
3. Modal = `upper(btrim("Entregador".dados_entrego_json->'informacoesEntrega'->>'modal'))`.
   Com `modais` definido: modal nulo/vazio → `sem_modal`; modal fora de `modais` → **não grava linha**.
4. `turnos < min_turnos` → `sem_minimo`.
5. Leituras: `aceitacao = aceitas/ofertadas`, `conclusao = completadas/aceitas`,
   `tempo = LEAST(online_epoch/periodo_epoch, 1)`; denominador 0/nulo → leitura nula.
   Indicador com peso > 0 e leitura nula → conta como **abaixo do corte** se houver corte, senão nota 0
   naquele indicador (não há "pular"); pedidos nulo com peso > 0 → 0 (o formulário já impede lançar com
   cobertura < 95%, §4).
6. Corte: indicador com peso > 0 e corte definido e leitura < corte → `abaixo_corte`, `motivo_corte` recebe o
   código (`aceitacao|conclusao|tempo|pedidos`). Pedidos compara a contagem com `corte_pedidos`.
7. Notas (só para quem passou em 3–6 = classificados): `nota_aceitacao = aceitacao*100` etc.;
   `nota_pedidos = pedidos / max(pedidos dos classificados) * 100` (máx 0 → 0).
   `nota = round(Σ peso_i * nota_i / 100, 2)`.
8. Posição: `row_number() OVER (ORDER BY nota DESC, pedidos DESC NULLS LAST, tempo DESC NULLS LAST, entregador_id ASC)`.
9. `abaixo_corte`: `nota_hipotetica` com a mesma fórmula (pedidos normalizado pelo mesmo máximo dos
   classificados) e `posicao_hipotetica = 1 + count(classificados com nota > nota_hipotetica)`.
10. `posicao_anterior` = posição gravada antes deste recálculo (NULL se não havia).
11. Grava em `"CampanhaRanking"` por `INSERT … ON CONFLICT (campanha_id, entregador_id) DO UPDATE` e
    **apaga** as linhas da campanha que não vieram neste recálculo, na mesma transação.
    Atualiza `Campanha.dados_ate = max(data_periodo)` do universo da empresa.

`hub_campanhas_recalcular_ativas(p_id_empresa int) → jsonb` (chamada pelo processador de importação
depois de `hub_performance_refresh_mv`, com o JWT da importação): para cada campanha lançada, não
cancelada, não fechada, com `data_inicio <= max(data_periodo) da empresa`: recalcula; se
`max(data_periodo) >= data_fim` → **fecha** (§3).

## 3. Fechamento (`hub_campanha_fechar_interno(p_id)`, usado pelo automático e pelo manual)

Recalcula; grava `fechada_em = now()`; insere `"CampanhaVencedor"` para cada classificado cuja posição
cai numa faixa de `"CampanhaPremio"` (uma linha por vencedor, `premio_id` da faixa); enfileira aviso de
resultado (`evento='resultado'`) se `avisar`. Manual: `hub_campanha_fechar(p_id)` exige situação
`apurando` e `hoje >= data_fim + 3`.

## 4. Formulário: limites validados no DTO (backend) **e** em CHECK/RPC (banco)

| Campo | Regra |
|---|---|
| nome | 3..120 caracteres |
| descricao | 0..1000 |
| data_inicio / data_fim | fim ≥ início; duração ≤ 92 dias; **ao lançar** `data_inicio ≥ hoje` |
| pracas / turnos / modais | NULL (todos) ou 1..50 itens, cada 1..120, canonizados; ao lançar, cada item ∈ opções existentes (§6 `opcoes`) |
| min_turnos | 1..200 |
| pesos | inteiros 0..100, soma = 100, ≥ 1 positivo |
| cortes de taxa | NULL ou 0..1 (4 casas); só faz sentido com peso > 0 (corte com peso 0 → erro `CORTE_SEM_PESO`) |
| corte_pedidos | NULL ou 1..100000 |
| prêmios | 1..20 faixas; `1 ≤ posicao_de ≤ posicao_ate ≤ 500`; sem sobreposição; tipo `objeto|dinheiro`; descricao 1..200; `valor_centavos` obrigatório e 1..500000 para dinheiro (= `TETO_CENTAVOS` do lançamento externo, **importado**, não redigitado), opcional para objeto |
| foto | JPEG/PNG/WebP por bytes iniciais (`FF D8 FF` / `89 50 4E 47` / `RIFF....WEBP`), ≤ 512000 bytes |
| pedidos | lançar com `peso_pedidos > 0` exige `cobertura_pedidos ≥ 0.95` no público (erro `PEDIDOS_SEM_COBERTURA`) |
| teto | ≤ 10 campanhas lançadas não canceladas não fechadas por entidade (`TETO_CAMPANHAS_ATIVAS`) |

## 5. Tokens de erro (RPC `MESSAGE` = token; backend → HTTP)

`CAMPANHA_NAO_ENCONTRADA` 404 · `CAMPANHA_IMUTAVEL` 409 · `CAMPANHA_SITUACAO_INVALIDA` 409 ·
`TETO_CAMPANHAS_ATIVAS` 409 · `PEDIDOS_SEM_COBERTURA` 422 · `INICIO_NO_PASSADO` 422 ·
`FAIXAS_SOBREPOSTAS` 422 · `PESOS_INVALIDOS` 422 · `CORTE_SEM_PESO` 422 · `OPCAO_DESCONHECIDA` 422 ·
`FECHAMENTO_ANTECIPADO` 409 · `FOTO_INVALIDA` 422 · `CONFIRMACAO_AUSENTE` 422 · `SEM_VINCULO` 404 (motorista sem entregador) ·
`VALIDACAO` 422 (DTO, com `campo`).

## 6. RPCs (assinaturas exatas)

Hub:
```
hub_campanha_opcoes(p_id_empresa int, p_pracas text[], p_turnos text[], p_modais text[]) → jsonb
  {pracas:[text], turnos:[text], modais:[text],          -- valores distintos canônicos, últimos 60 dias
   cobertura_pedidos: numeric|null,                      -- fração dos turnos do público (30 dias) com pedidos não nulo
   alcance:{rodaram:int, sem_modal:int}}                 -- público dos últimos 30 dias
hub_campanha_salvar(p_id_empresa int, p_id int, p_dados jsonb) → int      -- p_id NULL cria; só rascunho
hub_campanha_lancar(p_id int) → void
hub_campanha_cancelar(p_id int, p_motivo text) → void                    -- motivo 5..500
hub_campanha_fechar(p_id int) → void
hub_campanha_listar(p_id_empresa int, p_situacao text) → TABLE(... ver §7 item da lista ...)
hub_campanha_detalhe(p_id int) → jsonb          -- §7 detalhe
hub_campanha_ranking(p_id int, p_situacao text, p_limite int, p_offset int) → TABLE(linha do ranking §7)
hub_campanha_ranking_contagem(p_id int) → jsonb {classificado, abaixo_corte, sem_minimo, sem_modal}
hub_campanha_vencedores(p_id int) → TABLE(posicao, entregador_id, nome, cnpj, nota, premio_id, premio_tipo,
                                           premio_descricao, valor_centavos, entregue_em, entregue_por_nome,
                                           observacao, exportado_em)
hub_campanha_registrar_entrega(p_id int, p_posicao int, p_observacao text) → void   -- só objeto, só uma vez
hub_campanha_marcar_exportado(p_id int) → TABLE(cnpj text, nome text, valor_centavos int, posicao int)
                                         -- dinheiro com CNPJ; carimba exportado_em; sem CNPJ não volta
hub_campanha_premio_foto_salvar(p_premio_id int, p_mime text, p_base64 text) → void  -- só rascunho
hub_campanha_premio_foto(p_premio_id int) → TABLE(mime text, base64 text)
hub_campanha_recalcular(p_campanha_id int) → jsonb
hub_campanhas_recalcular_ativas(p_id_empresa int) → jsonb
```
Motorista (sem parâmetro de identidade):
```
hub_motorista_campanhas() → jsonb [item app §7]
hub_motorista_campanha(p_id int) → jsonb   -- §7 tela do app
hub_motorista_campanha_foto(p_premio_id int) → TABLE(mime text, base64 text)   -- só se a campanha é visível a ele
```
Avisos:
```
hub_campanhas_avisar_inicio() → int   -- push worker; idempotente por aviso_inicio_em; enfileira Aviso na_fila
```
Visibilidade para o motorista (A10): campanha lançada, não cancelada, situação ≠ rascunho, da empresa
do motorista; encerrada só até 30 dias após `fechada_em`; se `pracas` não nulo, só se ele tem turno
numa praça selecionada nos últimos 60 dias **ou** linha no ranking.

## 7. API REST (JSON camelCase; backend `routes/hub-campanhas.js` montado em `/api/v1/hub/campanhas`,
`routes/motorista-campanhas.js` montado junto das rotas do app motorista)

Item da lista (hub):
```json
{"id":12,"nome":"Rei do Jantar — Novembro","situacao":"em_andamento","dataInicio":"2026-11-10","dataFim":"2026-11-30",
 "pracas":["SAO PAULO"],"turnos":["JANTAR 18H-22H"],"modais":["MOTO"],"minTurnos":5,
 "pesos":{"aceitacao":30,"conclusao":30,"tempo":20,"pedidos":20},
 "contagem":{"classificado":184,"abaixoCorte":23,"semMinimo":41,"semModal":12},
 "premiosPendentes":0,"dadosAte":"2026-11-21"}
```
Detalhe (hub) = item + `descricao`, `cortes:{aceitacao,conclusao,tempo,pedidos}` (fração/contagem ou null),
`premios:[{id,posicaoDe,posicaoAte,tipo,descricao,valorCentavos,temFoto}]`, `avisar`, `criadaPor`,
`criadaEm`, `lancadaPor`, `lancadaEm`, `canceladaEm`, `motivoCancelamento`, `fechadaEm`, `notaCorteTop10`.

Linha do ranking (hub):
```json
{"posicao":1,"entregadorId":88,"nome":"Marcos Vinícius Andrade","modal":"MOTO","situacao":"classificado",
 "turnos":19,"aceitacao":0.962,"conclusao":0.991,"tempo":0.94,"pedidos":412,"nota":97.3,
 "notaHipotetica":null,"posicaoHipotetica":null,"motivoCorte":[],"posicaoAnterior":3}
```

| Método | Rota hub | Permissão | Corpo / resposta |
|---|---|---|---|
| GET | `/opcoes?pracas=&turnos=&modais=` | `campanhas.gerir` | `{pracas,turnos,modais,coberturaPedidos,alcance:{rodaram,semModal}}` |
| GET | `/?situacao=` | `campanhas.consultar` | `{itens:[item]}` |
| POST | `/` | `campanhas.gerir` | corpo = formulário (§4, camelCase) → `201 {id}` |
| PUT | `/:id` | `campanhas.gerir` | idem → `200 {id}` |
| POST | `/:id/lancar` | `campanhas.gerir` | `{confirmo:true}` → `204` |
| POST | `/:id/cancelar` | `campanhas.gerir` | `{motivo}` → `204` |
| POST | `/:id/fechar` | `campanhas.gerir` | → `204` |
| GET | `/:id` | `campanhas.consultar` | detalhe |
| GET | `/:id/ranking?situacao=classificado&pagina=1` | `campanhas.consultar` | `{itens:[linha],contagem:{…},pagina,porPagina:50}` |
| GET | `/:id/ranking.csv` | `campanhas.consultar` | CSV via `lib/hub-csv.js` |
| GET | `/:id/vencedores` | `campanhas.consultar` | `{itens:[{posicao,nome,nota,premio:{tipo,descricao,valorCentavos},entregueEm,entreguePor,observacao,exportadoEm,semCnpj}]}` |
| POST | `/:id/vencedores/:posicao/entrega` | `campanhas.entregar` | `{observacao?}` → `204` |
| GET | `/:id/premios-dinheiro.xlsx` | `campanhas.entregar` | XLSX com `CABECALHO_ESPERADO` **importado** de `lib/lancamento-externo.js`; Data do pagamento = hoje; Observação = `Prêmio campanha #<id> — <posição>º` |
| PUT | `/:id/premios/:premioId/foto` | `campanhas.gerir` | corpo binário (`express.raw`, limite 600 KB **na rota**, nunca global) → `204` |
| GET | `/:id/premios/:premioId/foto` | `campanhas.consultar` | binário, `Content-Type` do banco, `X-Content-Type-Options: nosniff`, `Cache-Control: private, max-age=300` |

Formulário (POST/PUT):
```json
{"nome":"…","descricao":"…","dataInicio":"2026-11-10","dataFim":"2026-11-30",
 "pracas":["SAO PAULO"]|null,"turnos":[…]|null,"modais":[…]|null,"minTurnos":5,
 "pesos":{"aceitacao":30,"conclusao":30,"tempo":20,"pedidos":20},
 "cortes":{"aceitacao":0.8,"conclusao":0.9,"tempo":null,"pedidos":null},
 "premios":[{"posicaoDe":1,"posicaoAte":1,"tipo":"objeto","descricao":"Moto Honda CG 160","valorCentavos":1600000}],
 "avisar":true}
```
(⚠️ `valorCentavos` de objeto é só estimativa e não tem o teto do dinheiro; foto vai por rota própria depois de salvar.)

App motorista:
| GET | `/api/motorista/campanhas` | `{itens:[{id,nome,situacao,dataInicio,dataFim,minhaPosicao,total,minhaSituacao,naZonaPremio}]}` (`dataInicio` acrescentado em 2026-11-22: o card escolhe a agendada que começa primeiro) |
| GET | `/api/motorista/campanhas/:id` | ver abaixo |
| GET | `/api/motorista/campanhas/:id/premios/:premioId/foto` | binário |

Tela do app:
```json
{"campanha":{"id":12,"nome":"…","descricao":"…","situacao":"em_andamento","dataInicio":"…","dataFim":"…",
  "pracas":[…]|null,"turnos":[…]|null,"modais":[…]|null,"minTurnos":5,
  "pesos":{…},"cortes":{…},"dadosAte":"2026-11-21","fechadaEm":null},
 "premios":[{"id":3,"posicaoDe":1,"posicaoAte":1,"tipo":"objeto","descricao":"…","valorCentavos":null,"temFoto":true}],
 "eu":{"situacao":"classificado","posicao":7,"posicaoAnterior":10,"nota":90.1,"turnos":18,
       "leituras":{"aceitacao":0.882,"conclusao":0.958,"tempo":0.903,"pedidos":362},
       "notas":{"aceitacao":88.2,"conclusao":95.8,"tempo":90.3,"pedidos":87.9},
       "motivoCorte":[],"notaHipotetica":null,"posicaoHipotetica":null,
       "ofertadas":200,"aceitas":176,"completadas":169,
       "acima":{"nome":"Aline R.","nota":90.6}|null,
       "premio":{"tipo":"dinheiro","descricao":"R$ 100 no repasse"}|null,
       "entregueEm":null}|null,
 "lider":{"pedidos":412},
 "top10":[{"posicao":1,"nome":"Marcos V.","nota":97.3,"souEu":false}],
 "totalClassificados":184}
```
`eu = null` quando o motorista não tem linha (não rodou no público). O frontend calcula a partir
desses números (funções puras com teste): "faltam X pontos" (`acima.nota - eu.nota`), "onde ganhar mais"
(maior `peso × (100 - nota)`), "aceite as próximas K" (`K = ceil((c*ofertadas - aceitas)/(1-c))`, idem
conclusão com completadas/aceitas), contagem regressiva até `dataFim 23:59:59 -03:00`.

## 8. Ganchos em código existente (únicos pontos tocados fora dos arquivos novos)

- `lib/hub-import-processor.js`: depois do refresh de `performance`, chamar `rpc/hub_campanhas_recalcular_ativas`
  com o mesmo JWT; **falha aqui loga e não derruba a importação** (o ranking é derivado).
- `lib/hub-push-worker.js` (varredura de 60 s do PR #319): antes de `retomarAvisosPendentes`, chamar
  `rpc/hub_campanhas_avisar_inicio` com o JWT do push worker; falha loga e segue.
- `lib/lancamento-externo.js`: **exportar** `CABECALHO_ESPERADO` e `TETO_CENTAVOS` (hoje são `const` internos).
- Migration: `INSERT` do tipo `PREMIO_CAMPANHA` (sinal +1) em `"LancamentoExternoTipo"`; `TIPOS` em
  `lib/lancamento-externo.js` passa a incluir `'PREMIO_CAMPANHA'` (conferir onde `TIPOS` é usado e se o frontend
  tem lista espelhada — se tiver, atualizar também).
- Avisos: criar `hub_notificacao_enfileirar(...)` genérica extraída do corpo de `hub_adiantamento_notificar` (0068)
  e fazer **as duas** usarem-na (CREATE OR REPLACE da 0068 com o mesmo comportamento), provado pelos drivers
  existentes de adiantamento/avisos verdes. Se a extração mudar qualquer comportamento medido: PARE e devolva.
- Módulo `campanhas` e permissões no padrão da 0003/0126; papéis `admin_entidade`, `financeiro`,
  `financeiro_aprovador` recebem as três permissões.
- Navegação do hub: item "Campanhas" no `module-nav` (gated por módulo + `campanhas.consultar`).
- App: card na Início (`app/(app)/movimento/page.tsx`) abaixo do card de adiantamento; rota `app/(app)/campanhas/[id]`.

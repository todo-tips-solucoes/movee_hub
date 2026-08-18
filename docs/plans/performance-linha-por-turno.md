# Plano — a linha da tabela de Performance passa a ser o TURNO

> Documento de retomada. Escrito para ser lido por uma sessão **sem nenhum
> contexto anterior**: tudo que é preciso saber está aqui ou apontado daqui.
>
> Origem: sessão de 2026-08-17/18, logo após o deploy da migration 0050
> (tempo disponível medindo o período). Mockups das alternativas:
> https://claude.ai/code/artifact/f800e4e4-2a4c-4448-b641-0be5a78ac3a6

## 1. Ponto de partida (o que JÁ está no ar)

- **PR #118** (squash `0246f7a`) e **#119** (`c510116`) mergeados na `main`.
- **Migration 0050 aplicada em produção** (`chatmasterveloz`, SchemaMigration
  0049 → 0050) e backend deployado: `envio-massa-backend:hub-tempo-periodo-c510116`.
  Rollback: `:hub-metas-4eb7780`. Frontend_v2 **não** foi tocado.
- O tempo disponível agora é `Σ tempo_disponivel / Σ duracao`, com a duração
  contada **uma vez por turno** e o online **somado entre as praças**, teto de
  100% por turno. Em produção o indicador saiu de 46,19% para **42,89%**.
- Coluna gerada `PerformanceTurno.tempo_disponivel_periodo_pct` = % do período
  **naquela linha/praça** (somável entre as praças do turno).
- `mv_performance_dia` tem grão `(id_empresa, data_periodo, periodo, entregador_id)`
  — **que é exatamente o grão do turno**, com `online_epoch`/`periodo_epoch`.

## 2. O problema que este plano resolve

Medido na renderização real (Playwright, viewport 1800×1200, hub-homolog):

| medida | valor |
|---|---|
| altura da linha da tabela | **143px** (linha comum: 40–48px) |
| quanto disso é o veredito de meta | **106px — 74%** |
| largura da coluna “Funil de corridas e metas” | **510px de 1.470px (35%)** |
| repetições de “da meta de” na página | **17** |
| duplicação | tempo disponível aparece 2× na mesma linha |

E, mais grave que o visual: **o julgamento está no nível errado.** A meta é
cadastrada por **praça × turno** (migrations 0048/0049) e é aplicada por
**linha** — mas a linha é a fatia de uma praça dentro do turno. Quando alguém
roda em duas praças, a tela emite dois vereditos para o mesmo turno e nenhum dos
dois números é o desempenho da pessoa naquele turno.

Exemplo real (hub-homolog, entregador `DEMO 0050 Duas Pracas`, 2026-08-10):
a tabela mostra linhas de **25,0%** e **12,5%**; o turno foi **37,5%** — que é o
que o card mostra ao filtrar por esse entregador. **Tabela e card discordam.**

No CSV real de produção, 47 turnos (3,6% das linhas) são multi-praça.

## 3. O que muda

A linha da lista passa a ser o **turno** = `(entregador, data_periodo, periodo)`.
As praças viram detalhe dentro da linha (chips), o veredito de meta é emitido
**uma vez**, no nível em que a meta existe, e os indicadores viram colunas
próprias com a distância até a meta em pontos percentuais.

## 4. Decisões pendentes (confirmar com o operador antes de codar)

| # | Decisão | Status |
|---|---|---|
| **D1** | Filtro por sub-praça no grão de turno | ✅ **DECIDIDA (operador, 2026-08-18): o turno inteiro.** O filtro escolhe *quais* turnos entram; os indicadores continuam sendo os do turno. E a **coluna Sub-praça lista todas as sub-praças** em que a pessoa trabalhou naquele turno, não uma só. |
| **D2** | O CSV exporta turno, linha, ou os dois? | ✅ **DECIDIDA: por turno.** O CSV embasa cobrança e precisa dizer o mesmo que a tela. |
| **D3** | Preservação do que foi importado | ✅ **DECIDIDA: os registros de Performance e Faturamento ficam integralmente salvos na base, com cópia do CSV importado.** Ver §4.1 — em grande parte **já existe**; o grão de linha permanece acessível via `?grao=linha`. |
| **D4** | Ordenação padrão | ✅ **DECIDIDA pelo operador (2026-08-18): fica a ordem que o índice serve.** A proposta original foi medida e recusada por custo. Ordenar por `entregador_nome` custa **1,6s** sobre 270k turnos (o nome vive noutra tabela: obriga a juntar e ordenar o período inteiro antes do LIMIT), contra **0,8ms** da ordem que o índice serve. Implementado `data_periodo desc, periodo desc, entregador_id desc` — a unique `uq_mv_performance_dia_grao` lida de trás para frente, total e sem sort. Se o alfabético for necessário, custa um índice novo; achar uma pessoa já é trabalho do filtro de entregador. |
| **D5** | Linhas gêmeas da origem (3 em 2.720) | ⬜ **DÍVIDA REGISTRADA, fora desta entrega.** O tempo já tem teto (0050); corridas e taxas ainda contam em dobro nessas 3 linhas. Visível na tela: os chips de praça de um turno gêmeo somam mais de 100% enquanto o total do turno fica em 100%. |

### 4.1 D3 — o que já existe (medido) e o que falta

Medido em **produção** em 2026-08-18, antes de escrever qualquer linha:

| garantia | estado |
|---|---|
| Arquivo original preservado | ✅ `/data/hub-uploads/<id>/original.zip`, em **volume nomeado** (`envio_massa_hub_uploads`), com `HUB_UPLOADS_DIR` apontando para ele — sobrevive a deploy |
| É provadamente o mesmo arquivo | ✅ `sha256` dos dois arquivos guardados **bate exatamente** com `ImportacaoArquivo.hash_sha256` |
| Download pela aplicação | ✅ `GET /importacoes/:id/original`, permissão `importacoes.exportar` |
| Linhas aceitas na base | ✅ `PerformanceTurno` / `FaturamentoLancamento`, append-only, dedupe por `hash_linha` |
| Linhas **rejeitadas** | ⚠️ `ImportacaoLinhaErro` guarda linha, motivo, campo e `valor_mascarado` — **nunca o conteúdo cru** (decisão explícita de LGPD, comentário na migration 0012). Para a importação de faturamento (`completed_with_errors`), essas linhas existem **só dentro do ZIP** |
| Retenção / expurgo dos arquivos | ⚠️ **Não existe política** — há um `TODO` em `lib/hub-import-storage.js`. Hoje nada apaga, o que atende a D3, mas cresce sem limite |
| Backup do volume | 🔴 **Não há backup.** Nenhum serviço de backup no Swarm e nenhum cron no host cobre `envio_massa_hub_uploads`. Se o volume se perder, a cópia do CSV se perde com ele |

**Decisões que D3 abre e que precisam do operador:**

- **D3a** — backup do volume de uploads: incluir num backup existente, ou criar
  um? Hoje a “cópia do CSV” depende de um volume sem cópia.
- **D3b** — retenção: guardar para sempre, ou expurgar junto com a política de
  12 meses já decidida para auditoria (D5 do hub-frota)?
- **D3c** — linha rejeitada: mantém mascarada (LGPD) ou passa a guardar a linha
  bruta? Manter é o padrão do projeto; mudar é decisão de privacidade, não de
  engenharia.

## 4.2 O que a D1 decidiu junto, e não estava escrito

A D1 diz que o filtro de sub-praça **escolhe quais turnos entram** e que os
indicadores continuam sendo os do turno. Isso não cabe só na lista: até a 0050,
com sub-praça filtrada, as RPCs do **resumo** agregavam apenas as linhas
daquela sub-praça. Manter os dois comportamentos reintroduziria pela porta do
filtro exatamente a discordância tabela × card que esta entrega existe para
acabar — e o §8 pede que os dois digam o mesmo número.

Então a 0051 aplica a D1 na tela inteira: `p_subpraca` virou um semi-join
(`EXISTS`) nas três RPCs. Efeito colateral bem-vindo — os ramos
`IF p_subpraca IS NULL … ELSE` de 0050 sumiram, e com eles a segunda cópia da
fórmula do tempo disponível. A tela avisa por escrito quando o filtro está
aplicado.

Isto **diverge do §5.1**, que previa manter um caminho tabela-base para o filtro
de sub-praça. O §5.1 foi escrito antes de a D1 ser decidida desse jeito.

## 5. Desenho técnico

### 5.1 Banco — migration `0051_performance_turnos_rpc.sql`

Duas partes:

**(a) Completar a MV.** `mv_performance_dia` não tem `corridas_rejeitadas`,
`corridas_canceladas` nem `pedidos_concluidos`. Adicionar as três somas
(DROP + CREATE, como fez a 0050 — `CREATE MATERIALIZED VIEW IF NOT EXISTS` não
altera a forma de uma MV existente; recriar os 3 índices e os REVOKEs).

**(b) RPC nova `hub_performance_turnos(...)`**, `SECURITY DEFINER`,
`SET search_path = public, pg_temp`, com o **mesmo guard de escopo** das outras
(`p_id_empresa = ANY (hub_jwt_escopo_ids())` — fora do escopo devolve zero
linhas, nunca erro):

```
hub_performance_turnos(
  p_id_empresa int, p_de date, p_ate date,
  p_periodo text, p_subpraca text, p_entregador_id int,
  p_limit int, p_offset int
) RETURNS TABLE (
  entregador_id int, data_periodo date, periodo text,
  corridas_ofertadas bigint, corridas_aceitas bigint, corridas_rejeitadas bigint,
  corridas_completadas bigint, corridas_canceladas bigint,
  pedidos_concluidos bigint, taxas_centavos bigint,
  tempo_disponivel_pct text,   -- numeric(6,2)::text, mesma fórmula da 0050
  pracas jsonb,                -- [{subpraca, praca, tempo_disponivel_pct, ofertadas, aceitas, completadas, taxas_centavos}]
  total_turnos bigint          -- count(*) OVER () no conjunto filtrado
)
```

Pontos que a implementação **não pode errar**:

- `total_turnos` vem por `count(*) OVER ()` **na mesma consulta**, e não por
  `Prefer: count=exact` — RPC com count é o tipo de detalhe que muda entre
  versões do PostgREST; a janela é autocontida.
- Caminho MV quando `p_subpraca IS NULL` (rápido, índices existentes); caminho
  tabela-base quando há filtro de sub-praça — **mesmo padrão de 0031/0050**.
- O `pracas` sai da tabela-base sempre (a MV não tem sub-praça). Para não pagar
  `json_agg` sobre o conjunto inteiro, agregar **só a página**: `LIMIT/OFFSET`
  primeiro, `LEFT JOIN LATERAL` das praças depois.
- Tempo por turno = `LEAST(SUM(EXTRACT(EPOCH FROM tempo_disponivel)) FILTER (…),
  MAX(EXTRACT(EPOCH FROM duracao)) FILTER (…)) / MAX(…) * 100`, com o
  **`FILTER` em ambos** — ver Gotcha G1.
- `GRANT EXECUTE … TO authenticated`.

**Performance (SC-004 < 1s):** medir contra o volume da S10 (~900k linhas) com
`infra/hub/testes/carga-s10.sh`. Se o caminho tabela-base (filtro de sub-praça)
não couber no orçamento, considerar índice em `(id_empresa, subpraca, data_periodo)`
— já existe `idx_performance_empresa_subpraca` (0020), confirmar que serve.

### 5.2 Backend — `routes/hub-performance.js` + `lib/hub-performance-dto.js`

- `GET /performance` ganha `?grao=turno|linha` (default **turno**, D3).
  `grao` inválido → `400 { erro: 'GRAO_INVALIDO' }`, no mesmo padrão de
  `GROUP_BY_INVALIDO`.
- Grão turno: `POST /rpc/hub_performance_turnos` com `p_limit/p_offset` da
  paginação; `total` vem de `total_turnos` da primeira linha (0 se vazio).
- Nome do entregador: hoje vem por embed `entregador:Entregador(nome)`. Na RPC
  não há embed — resolver como faz `hub-faturamento-dto.js#nomeMap`: um
  `Entregador?id=in.(…)` com os ids da página. **Nunca** expor a tabela inteira.
- `mapPerformanceTurnoItem(row)` novo no DTO (o `mapPerformanceListItem` fica
  para `grao=linha`). Campos camelCase; `pracas` como array já mapeado.
- Chave de React/identidade: não há `id`. Usar
  `${entregadorId}|${dataPeriodo}|${periodo}` — documentar no contrato.
- Avaliação de meta no servidor (`avaliarRegistro`, usado pelo CSV) passa a
  receber o registro do **turno**.
- **CSV (D2): exporta turno.** Cabeçalho muda — some `subpraca` como coluna
  única e entra a lista de sub-praças do turno; as colunas de meta passam a ser
  do turno. É mudança de contrato: atualizar `contracts/performance-api.md` e o
  assert de cabeçalho em `hub-performance-integration.sh`.

### 5.3 Frontend — `app/hub/dashboard/performance/page.tsx`

- Tabela: colunas `Entregador · Turno · Praças · Aceitação · Conclusão ·
  Tempo disp. · Pedidos · Taxas`. Some a coluna “Funil de corridas e metas”.
- Cada indicador: número + ponto de estado + distância em pp (`−15pp`).
  O ponto **não pode ser o único portador do estado** — `aria-label` e `title`
  com a frase completa (“Taxa de aceitação: 66,7%, abaixo da meta de 90%”).
- **Sub-praça (D1)**: a coluna lista **todas** as sub-praças do turno — chips
  `ZONA SUL 25,0%` `CENTRO 12,5%`. Um chip só quando houve uma praça. Com filtro
  de sub-praça aplicado, os chips continuam mostrando todas (o turno é o mesmo);
  o que o filtro faz é escolher quais turnos aparecem.
- **O layout de cartão (mobile, `md:hidden`) muda junto** — hoje há dois pontos
  de render de `MarcasDeMeta` (linhas ~730 e ~783). Foi achado adversarial na
  r24 que a marcação existia só no desktop; não repetir o erro ao contrário.
- ~~`FunilCorridas` continua existindo para `grao=linha`; não apagar.~~
  **Revisto pelo operador em 2026-08-18: apagados.** Sem a tela renderizando
  `grao=linha`, `FunilCorridas` e `MetaBadge` ficaram sem chamador, com testes
  verdes protegendo código que ninguém executa — o padrão que
  `lib/hub-performance-meta.js` já documenta como pior que ter uma
  implementação só. As regras que o `MetaBadge` guardava foram herdadas por
  `IndicadorMeta`, com os mesmos casos de teste.
- Aviso quando `subpraca` está filtrada (D1): uma linha de texto dizendo que os
  indicadores são do turno inteiro.

### 5.4 Testes (todos obrigatórios antes do PR)

| gate | o que cobrir |
|---|---|
| unit backend (`node --test`) | `mapPerformanceTurnoItem`; `grao` inválido; total de turnos vazio → 0 |
| unit frontend (`vitest`) | novo componente de indicador: estado abaixo/acima/na meta/sem leitura; distância em pp; `aria-label` completo |
| integração (`infra/hub/testes/hub-performance-integration.sh`) | turno multi-praça agrega (o seed já existe: `demo`/`multipraca`, espera 37,50); `pracas` traz as 2 fatias; paginação por turno com `total_turnos`; filtro de sub-praça (D1); guard de escopo cross-tenant devolve 0 linhas |
| E2E (`infra/hub/testes/hub-shell-e2e-browser.sh`) | a tela renderiza turno com 2 praças e **um** veredito |
| medição | repetir a sonda de altura de linha: alvo ≤ 56px (hoje 143px) |

## 6. Fases

1. **F1 — decisões.** Fechar D1–D5 com o operador. Sem isso não começa.
2. **F2 — banco.** Migration 0051 (MV completa + RPC). Aplicar no hub-homolog,
   rodar `hub-performance-integration.sh`. Medir com carga S10.
3. **F3 — backend.** `?grao`, DTO, resolução de nome, CSV (D2). Unit verde.
4. **F4 — frontend.** Tabela + cartão mobile + componente de indicador.
   `tsc --noEmit`, `next build`, vitest, detector impeccable.
5. **F5 — verificação.** E2E, sonda de altura, comparação antes/depois em
   imagem, e conferência de que **tabela e card passam a dizer o mesmo número**.
6. **F6 — entrega.** Rito do ciclo git (branch → gates com números → commit →
   PR → merge → build da main com tag `<rótulo>-<sha7>` → deploy 5 gates →
   prova do bundle). **A 0051 em produção é rito integral** — as tabelas do hub
   vivem dentro do `chatmasterveloz`.

## 7. Gotchas desta sessão (não redescobrir)

- **G1 — `LEAST` ignora `NULL`.** `LEAST(NULL, duracao)` devolve a duração, e o
  turno sem leitura vira **100%** — ausência virando nota máxima. Por isso a
  coluna gerada da 0050 usa `CASE` e os agregados usam `FILTER` nas duas somas.
  Minha própria consulta de conferência caiu nessa armadilha.
- **G2 — verificar RPC no psql.** `SET LOCAL ROLE authenticated` **antes** de
  ler `id_empresa` faz a RLS devolver vazio, o escopo sai nulo e a RPC responde
  tudo `null` — parece defeito da migration e é erro da consulta. Ler os
  parâmetros como owner, depois trocar de papel.
- **G3 — `information_schema` não lista materialized views.** Conferir MV em
  `pg_attribute`/`pg_matviews`, senão a checagem “passa” medindo nada.
- **G4 — `hub-performance-integration.sh` precisa de `ModuloEntidade`.** A suíte
  ficou quebrada em silêncio (403 `MODULO_DESABILITADO`, script Node morria antes
  do 1º assert). Corrigido no #118; se aparecer de novo em outra suíte, é a
  mesma causa.
- **G5 — o container do Playwright reescreve `package-lock.json`** via bind
  mount. Conferir e reverter **antes de commitar**.
- **G6 — acesso ao hub-homolog.** Traefik publicado só em `127.0.0.1:8443`
  (PR #114, proposital). Do browser: `ssh -N -L <porta>:127.0.0.1:8443
  root@178.156.254.243` e `https://localhost:<porta>/hub/login`. Porta ocupada
  no Windows/WSL é comum (faixas reservadas pelo Hyper-V) — trocar de porta.
  Login: `qa.importacoes@moveelog.local` / `Teste@Hub2026`, empresa 9001.
- **G7 — dados de demonstração no hub-homolog.** 6 registros em `2026-08-10`
  (empresa 9001) e 4 entregadores `DEMO 0050 %` cobrindo: turno em 2 praças,
  escalado parcial, linhas gêmeas e turno sem leitura. Úteis para esta feature.
  Limpeza: `DELETE FROM "PerformanceTurno" WHERE id_empresa=9001 AND
  data_periodo='2026-08-10'; DELETE FROM "Entregador" WHERE id_empresa=9001 AND
  nome LIKE 'DEMO 0050 %'; REFRESH MATERIALIZED VIEW mv_performance_dia;`
- **G8 — produção é pequena.** `PerformanceTurno` tem 2.720 linhas / 2.669
  turnos, 1 empresa (id 6), um único dia (2026-07-03), 1.408 kB. A 0050 (que
  reescreve a tabela) levou 195ms. Não confundir com o volume da carga S10.
- **G9 — a MV já tem grão de turno.** É o que torna esta feature barata: o
  agregado existe; falta o detalhe por praça, a paginação e 3 contadores.

## 7.1 Resultado medido (execução de 2026-08-18)

| item | antes | depois |
|---|---|---|
| altura da linha da tabela | 143px | **52,25px** (medido no DOM pelo E2E, alvo ≤56px) |
| linhas para o turno multi-praça | 2 (25,0% e 12,5%) | **1** (37,5%) |
| vereditos de meta por turno | 2 | **1** |
| tabela × card para o mesmo turno | 25,0/12,5 × 37,5 | **37,5 × 37,5** |

Gates: `tsc --noEmit` 0 · vitest 511/511 · `next build` OK · lint 5 erros /
14 avisos (= baseline exata da main, todos em arquivos legados do painel) ·
backend `node --test` 700/700 · integração do hub 129 asserts, 0 falhas · E2E
do hub 138/138 · detector impeccable 0 achados nos arquivos tocados (os 2
`gradient-text` do legado seguem sendo a baseline).

Carga sintética de 900k turnos (990k linhas), medida no hub-homolog dentro de
uma transação revertida: página de 30 dias **411ms**, com filtro de sub-praça
**213ms**, janela de 100 dias **455ms**, página profunda (offset 5000)
**110ms** — todos abaixo do teto de 1s do SC-004, a ~340× o volume de
produção. A primeira versão da RPC levava **18,7s** na janela de 30 dias; o
que a derrubou está documentado no bloco 3 da migration.

O vitest caiu de 527 para 511 porque `funil-corridas` e `meta-badge` foram
apagados com seus testes (decisão do operador, ver §5.3).

**Achado alheio ao escopo, corrigido e declarado:** o seed do E2E deu dados a
telas que estavam vazias, e três checagens de contraste ficaram vermelhas de
uma vez — em Performance, Motoristas e Importações. O defeito é antigo e
independe desta feature (`text-primary` #2c67ea sobre o creme dá 4,46:1, abaixo
do mínimo AA de 4,5:1; e o badge `bg-success/10 text-success`, 3,87:1). O gate
passava por **vacuidade**: sem linha na tela, não havia o que medir. Corrigido
com o menor escurecimento que cruza a barra — `--primary` #2c66e9 e `--success`
#00715e. O verde exigiu resolver um ponto fixo: escurecê-lo escurece também o
fundo `success/10`, e a primeira tentativa saiu de 3,87 para 4,46 e continuou
reprovando.

## 8. Critério de pronto

1. A tabela mostra **uma linha por turno**, com as praças visíveis dentro dela.
2. O veredito de meta aparece **uma vez por turno**, e o número julgado é o
   mesmo que o card mostra ao filtrar por aquele entregador.
3. Altura da linha ≤ 56px, medida com a mesma sonda que deu 143px.
4. Nenhum indicador depende só de cor: `aria-label`/`title` com a frase inteira.
5. Mobile e desktop com a mesma informação.
6. Todos os gates do §5.4 verdes, com números no corpo do PR.

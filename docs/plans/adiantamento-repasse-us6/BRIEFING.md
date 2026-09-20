# Briefing — fechamento do remanescente semanal (US6), 3 pontas soltas

> ## ✅ RESOLVIDO NO CÓDIGO — 2026-09-19, migration `0086`
>
> As três decisões de "O que decidir antes de começar" foram tomadas pelo
> operador e implementadas. **Não abrir esta frente de novo**; o que segue
> abaixo é o registro do problema como foi medido, mantido porque explica
> *por que* cada escolha foi feita.
>
> | | Decisão do operador | Como ficou |
> |---|---|---|
> | **A1** | a gravação RECUSA janela desalinhada e a tela sugere a certa | gatilho `BEFORE INSERT` em `ApuracaoRepasse` (`PERIODO_DESALINHADO`) + a tela do hub abre na semana configurada |
> | **A4** | período fechado mostra o CONGELADO, rotulado "fechado em X" | `hub_adiantamento_repasse_congelado`; `GET /repasse` e `/repasse/exportar` escolhem a RPC pelo estado do período |
> | **A3** | débitos na tela **e** a semana fechada | `debitos` renderizado + seção "Semana fechada" + `hub_adiantamento_repasse_motorista_ultimo_fechado` |
>
> **Duas descobertas da implementação que valem mais que o conserto:**
>
> 1. **O próprio driver de integração fechava uma janela desalinhada.** A
>    fixture configurava a semana começando no domingo e os cenários fechavam
>    `2026-01-01`, uma quinta. Passava porque *nada conferia o alinhamento* —
>    o defeito A1 estava reproduzido dentro da suíte que deveria pegá-lo. O
>    gatilho novo quebrou 3 checks existentes na primeira execução, e foi
>    assim que apareceu.
> 2. **O motorista nunca via uma semana fechada.** A RPC dele mostra sempre a
>    semana que contém *hoje*, e o fechamento só ocorre depois que a semana
>    termina — quando fecha, ele já está vendo a seguinte. O A3 não era
>    rotular o que existia: era acrescentar o que não existia. (Há um ramo
>    `situacao === 'FECHADA'` na tela do app que, por isso, é inalcançável —
>    deixado como está, é anterior a esta mudança.)
>
> **O que NÃO foi feito, por escolha do operador:** alerta de divergência
> entre o valor congelado e o recalculado (lançamento retroativo entrando
> depois do fechamento). A tela mostra o congelado e a data — não compara.
>
> ⚠️ **Em produção a dívida só acaba no deploy.** Até lá, segue valendo:
> **não usar o botão "fechar apuração"**.

Prompt para sessão futura (nova frente, não paralela a `adiantamento-motorista`
enquanto ela estiver em execução — ver `CLAUDE.md` §Abrir outra frente de
trabalho). **Leia o `CLAUDE.md` do repositório antes de qualquer coisa**: o
ambiente chamado "homologação" É produção, e o ciclo git é cláusula pétrea
(branch → gates com números → `git add` por caminho → commit → PR → merge →
build da main com tag `<rótulo>-<sha7>` → deploy pelos 5 gates → prova do
bundle servido). **Autorização é por etapa.** Repo é **público** — nenhum dado
pessoal real em código, teste, log ou este documento (nenhum aqui).

## Origem

Feature `adiantamento-motorista` (`docs/specs/adiantamento-motorista/`), 3ª
passada da skill `converge` (onda-046, execução autônoma `feature-00c`) achou
10 divergências entre spec/contratos e código. O operador decidiu (dec-185,
`block-002`) apendar **7** à própria feature (FASE 13 de `tasks.md`) e deixar
**estas 3** de fora — são a MESMA raiz (o fechamento semanal do remanescente,
US6, ficou meio-implementado: a apuração congela dados mas quase nada os
consome depois) e exigem decisão de desenho de produto, não um fix mecânico
de convergência. Ver `docs/specs/adiantamento-motorista/tasks.md` §Escopo
Excluído (linhas com `A1`/`A3`/`A4`) e as Decisões `dec-184`/`dec-185` no
state da execução.

## O problema, medido (não suposto)

### A1 (FR-037) — a janela default do fechamento ignora o dia de início configurado

`infra/hub/migrations/0067_adiantamento_funcoes.sql`:

- `hub_adiantamento_repasse_fechar` (l.1811) e `hub_adiantamento_repasse_pode_fechar`
  calculam `v_fim := p_periodo_inicio + 6` — uma janela fixa de 7 dias a
  partir do `p_periodo_inicio` que o CALLER passa, sem nunca olhar
  `AdiantamentoConfiguracao.apuracao_dia_inicio`.
- O caminho do MOTORISTA (`hub_adiantamento_repasse_motorista`, l.1006) faz
  diferente: `v_inicio := current_date - ((extract(dow FROM current_date)::int
  - v_config.apuracao_dia_inicio + 7) % 7)` — alinha o início da semana ao dia
  configurado (ex.: se `apuracao_dia_inicio = 3` = quarta-feira, a semana do
  motorista sempre começa numa quarta).
- A TELA do hub (`frontend_v2`, listagem de repasse) abre com `periodo =
  hoje` como default (não recalcula o início alinhado) — então, na maioria
  dos dias da semana, o período que a tela sugere fechar e o período que o
  motorista está vendo **não é o mesmo intervalo de 7 dias**. Desalinha em
  **6 de cada 7 dias possíveis** (só bate quando `hoje` cai exatamente no
  `apuracao_dia_inicio`).
- Consequência prática: fechar o período sugerido pela tela pode congelar
  (`ApuracaoRepasse`/`ApuracaoRepasseItem`, **imutáveis por trigger**,
  `0066:463/477`) uma janela que **não é** a semana operacional configurada —
  e não há como desfazer depois.

### A3 (FR-039) — a tela do motorista recebe `debitos` do backend e nunca mostra

- `app_homologacao/backend/routes/motorista-adiantamento.js:879` (rota `GET
  /repasse` do app) devolve um campo `debitos` no payload.
- `app_homologacao/frontend_motorista/app/(app)/repasse/page.tsx:93-106`
  nunca lê nem renderiza esse campo — só `creditos`/`adiantamentos`/
  `remanescente` aparecem na tela.
- Consequência: a soma que o motorista vê na tela **não fecha** com o que o
  backend calculou (falta a parcela de débitos), mesmo quando o cálculo em si
  está certo — é um problema de exibição, não de dado.

### A4 (FR-041/FR-038) — o item congelado no fechamento nunca é lido de volta

- `hub_adiantamento_repasse_fechar` grava uma linha por motorista em
  `ApuracaoRepasseItem` (`0067:1997`) no momento do fechamento.
- `GET /repasse` e `GET /repasse/exportar` (`hub-adiantamentos.js:1316`)
  **recalculam ao vivo** a cada chamada — nunca fazem `SELECT` em
  `ApuracaoRepasseItem` — mesmo para um período já **fechado**
  (`ApuracaoRepasse` existe para aquele `id_empresa`/`periodo_inicio`).
- Consequência: o cenário 8.5 do `quickstart.md` (mostrar o valor **congelado**
  de um período já fechado, e não o recalculado) não é observável hoje — o
  usuário sempre vê o número recalculado na hora, mesmo que ele tenha mudado
  desde o fechamento (ex.: um lançamento de faturamento retroativo entrou
  depois).

## Por que as 3 NÃO entraram em `adiantamento-motorista` (FASE 13)

`converge` resolve divergência **spec-vs-código** de forma mecânica (código
diz uma coisa, contrato/spec diz outra — corrige o lado errado). Estas 3 são
diferentes: a spec e o código concordam em cada peça isolada, mas a
**composição** das peças (janela default + tela do app + leitura pós-fechamento)
deixa a User Story 6 (remanescente semanal) com um buraco de produto
que **um fix mecânico point-a-point pioraria ou mascararia**:

- Corrigir só A1 (alinhar a janela default) sem revisitar A4 não resolve o
  problema de fundo: mesmo alinhada, a tela AINDA recalcularia ao vivo depois
  do fechamento em vez de mostrar o congelado.
- Corrigir só A3 (renderizar `debitos`) é seguro isoladamente, mas foi
  deixado junto porque é a MESMA tela (`repasse/page.tsx`) que provavelmente
  precisa ser redesenhada para também distinguir "período aberto" (ao vivo)
  de "período fechado" (congelado) — refazer a tela duas vezes é retrabalho.
- A4 sozinho (ler `ApuracaoRepasseItem` quando existir) é a peça que decide a
  arquitetura da tela (ao vivo vs. congelado) — depende de uma resposta de
  produto: **quando existe `ApuracaoRepasse` para o período, a tela deve
  mostrar o congelado, ou o operador quer sempre o recalculado com um aviso
  de que já fechou?**

## O que decidir antes de começar

1. **A1**: alinhar `hub_adiantamento_repasse_fechar`/`_pode_fechar` ao mesmo
   cálculo de início de semana que `hub_adiantamento_repasse_motorista` já
   usa? Ou o default da TELA (`periodo=hoje`) deve mudar para sugerir o
   início da semana configurada, deixando as RPCs como estão (quem manda o
   `p_periodo_inicio` já seria sempre alinhado)? São dois pontos de correção
   possíveis para o mesmo sintoma — escolher um, não os dois.
2. **A4**: quando `ApuracaoRepasse` existe para o período pedido, `GET
   /repasse`/`/exportar` devem ler `ApuracaoRepasseItem` (congelado) em vez
   de recalcular? Se sim, o que fazer se o congelado e o recalculado
   divergirem (ex.: lançamento retroativo) — mostrar os dois? Só o
   congelado, com um aviso "fechado em X"?
3. **A3**: simples de decidir — é bug de exibição puro, some **debitos** na
   tela do app. Mas convém decidir JUNTO com a resposta de A4, porque a
   tela pode precisar de um segundo layout para "período fechado".

## O que NÃO refazer

- Não reabrir a investigação de onde vêm os números (`creditos`/
  `adiantamentos`/`debitos`/`remanescente`) — o cálculo em si (fontes,
  filtros de status, `FaturamentoLancamento`) já foi auditado a fundo pela
  FASE 13 de `adiantamento-motorista` (13.7 alinhou o critério de status do
  fechamento ao da listagem/app) e está correto nas 3 fontes.
- Não duplicar `docs/specs/adiantamento-motorista/` — esta é spec NOVA
  (`specify` desta frente decide o `short_name`), mesmo que reuse tabelas/RPCs
  já existentes daquela feature.

## Restrições (herdadas do repositório, ver `CLAUDE.md` completo)

- Rito de produção: `chatmasterveloz`, serviços `envio-massa-homologacao_*`,
  domínios moveelog — nenhuma escrita direta; artefatos para o operador.
- Repo público: nenhum CNPJ/CPF/nome real, nenhuma planilha de
  `conta_bancária_drivers.xlsx`/`modelo_transfeera.xlsx` como fixture.
- `ApuracaoRepasse`/`ApuracaoRepasseItem` são **imutáveis por trigger**
  (`0066:463/477`, dec-023/D-23) — qualquer mudança de cálculo do
  fechamento precisa ser provada com o driver de integração ANTES de
  qualquer sugestão de rodar contra dado real, nunca só por unit/mock.
- `df -h /` ≥ 20 GB e swap ativa antes de qualquer driver/build (histórico:
  incidente de disco cheio 2026-08-30, `docs/memory/incidente-disco-cheio-2026-08-30.md`
  na memória do projeto).

## Entregáveis esperados

- `docs/specs/<short-name>/spec.md` cobrindo as 3 decisões acima como User
  Stories/FRs novos (ou emenda a US6 existente, se a spec for reaberta como
  extensão de `adiantamento-motorista` em vez de feature nova — decisão de
  quem abrir esta frente).
- Migration(s) novas (próxima livre: conferir `ls infra/hub/migrations/ |
  sort -V | tail -1` no momento — não assumir `0083`, esta feature pode ter
  avançado o contador).
- Driver de integração provando A1 (janela alinhada) e A4 (leitura do
  congelado pós-fechamento) com dado sintético, mesmo padrão de
  `infra/hub/testes/hub-adiantamentos-integration.sh`.
- PR normal, autorização por etapa, nada de commit/deploy sem pedido
  explícito do operador.

# Plano — enriquecimento EntreGô em massa dos motoristas pendentes

**Preparado em 2026-09-06.** Proposta para aprovação do operador. Nenhum passo
abaixo foi executado. Envolve **escrita na produção** e **carga no portal
externo EntreGô com PII** — exige os 5 gates do rito
([`docs/RITO-PRODUCAO.md`](../../RITO-PRODUCAO.md)) e autorização explícita.

## 1. Situação (medida em 2026-09-06, empresa 6 / Movee, read-only)

| Entregador (Movee) | qtde |
|---|---|
| total (todos ativos) | 1281 |
| já enriquecidos no EntreGô | 6 |
| **não enriquecidos** | **1275** |
| desses, com vínculo EntreGô (`id_externo`) → enriquecíveis | 1275 (todos) |
| sem vínculo EntreGô (não enriquecível) | 0 |
| na fila sob-demanda agora | 0 |

Ou seja: o enriquecimento em massa praticamente não rodou (só 6), e **todos os
1275 pendentes são enriquecíveis** (têm `id_externo`). O número 471 que aparece
em anotações antigas é outra coisa — vínculo de **credencial** (`motorista_id`),
não enriquecimento.

## 2. Objetivo

Enriquecer os 1275 motoristas pendentes, buscando o cadastro na EntreGô, sem
derrubar o import diário de performance/financeiro nem atrair bloqueio do portal.

## 3. Por que a rotina semestral NÃO serve

O modo `semestral` seleciona `dados_entrego_enriquecidos_em < agora−6meses` — só
*re*atualiza quem já foi enriquecido e ficou velho. Por desenho **não pega quem
nunca foi enriquecido** (`IS NULL`). Rodar o semestral hoje seleciona 0. O
caminho correto é a fila **sob-demanda**.

## 4. Mecânica (como funciona hoje)

- **Enfileirar** = gravar `dados_entrego_solicitado_em`. Endpoint por motorista:
  `POST /api/v1/motoristas/:id/entrego-enriquecimento` (perm. `motoristas.editar`,
  202, dedup 429 `JA_PENDENTE`, 409 se sem `id_externo`). Alternativa em massa:
  um `PATCH` direto no PostgREST setando o carimbo para os pendentes.
- **Worker** `entrego-enriquecimento-sob-demanda`: timer a cada 5 min (`*:0/5`),
  puxa **20 por rodada** (`LOTE_ENRIQUECIMENTO_DEFAULT`), **60 s entre cada**
  (`THROTTLE_MS_ENTRE_MOTORISTAS`, anti-bloqueio), drena do mais antigo. Uma
  rodada de 20 leva ~20 min e segura a trava; os ticks de 5 min que caem no meio
  são pulados. Throughput efetivo ≈ **50–60 motoristas/hora (~1/min)**.
- **Trava compartilhada** (`flock -n`, `robo-entrego.lock`) com o import diário.
  O import roda 11h/13h/14h. Se uma rodada de enriquecimento estiver segurando a
  trava na hora do import, **o import daquele tick é pulado** — e não há novo
  tick até o dia seguinte. Import pulado = D-1 daquele dia **não importado**
  (dado perdido). **Proteger as janelas de import é o requisito mais duro deste
  plano.**

## 5. Duração e riscos

- **Duração**: 1275 ÷ ~1/min ≈ **21–25 h de processamento ativo**.
- **Import diário**: precisa ficar intocado (ver §4). Duas formas de proteger:
  esvaziar a fila fora das janelas (plano recomendado), ou guardar o worker
  contra rodar 10:45–14:30 (alternativa).
- **Anti-bloqueio (PerimeterX)**: 1275 buscas externas. O throttle de 60 s é o
  guard; o robô quase não toca UI (busca via BFF em `page.evaluate`), o que
  historicamente evitou bloqueio. Atividade sustentada por horas é mais que o
  padrão quase-ocioso de hoje — risco baixo, não nulo. Parar ao primeiro
  `ErroAntibotSuspeito`.
- **PII / retenção**: enriquecer 1275 grava CPF/RG/CNH de 1275 pessoas. A
  **retenção segue sem prazo definido** (pendência aberta do hub-motorista-360).
  Convém decidir a retenção **antes** de multiplicar o volume de PII por ~200x.

## 6. Plano recomendado — lotes noturnos (imports nunca tocados)

Ideia: alimentar a fila em lotes pequenos numa janela ociosa; o worker esvazia
antes das janelas de import; nas horas de import a fila já está vazia, então o
worker não segura a trava.

1. **Janela**: ~20:00 America/Sao_Paulo (após o último import das 14h, longe do
   próximo às 11h).
2. **Lote**: ~150 motoristas/noite (drena em ~2,5 h, encerra ~22:30, muito antes
   das 11h). 1275 ÷ 150 ≈ **9 noites**.
3. **Enfileirar o lote** (escrita na produção — rito): selecionar os 150
   `id` mais antigos com `dados_entrego_enriquecidos_em IS NULL AND
   dados_entrego_solicitado_em IS NULL AND id_externo IS NOT NULL` e gravar
   `dados_entrego_solicitado_em=now()` neles (um `PATCH id=in.(...)` no
   PostgREST com claim de escopo 6, ou 150 chamadas ao endpoint por motorista).
4. **Deixar o worker existente drenar** (nenhuma mudança de systemd).
5. **Verificar** de manhã: `enriquecidos_em IS NULL` caiu ~150; fila
   (`solicitado_em NOT NULL AND enriquecidos_em IS NULL`) voltou a ~0;
   `journalctl -u entrego-enriquecimento-sob-demanda` sem `ErroAntibotSuspeito`.
6. **Repetir** por ~9 noites; parar quando `enriquecidos_em IS NULL` chegar a ~0.

Prós: imports intocados; sem mudança de código/systemd; pausável a qualquer
noite; taxa idêntica à operação normal (baixo risco de bloqueio).
Contra: ~9 dias de calendário; exige um disparo de enfileiramento por noite
(manual, ou um `systemd --timer` temporário só para o enfileiramento).

## 7. Alternativa — disparo único + guarda de janela (~1,5 dia)

Enfileirar os 1275 de uma vez e adicionar um `ExecStartPre` no
`docker-run-enriquecimento.sh` (ou drop-in do serviço) que **encerra sem rodar
entre 10:45 e 14:30** (protege os três imports). O worker trickle-drena nas
demais ~19 h/dia; conclui em ~1,5 dia. Remover a guarda ao fim.

Prós: mais rápido; um único enfileiramento.
Contra: exige **mudança de código** (guarda de janela) pelo ciclo git + deploy;
21–25 h de atividade contínua no portal (risco de bloqueio um pouco maior).

## 7-bis. DECIDIDO (2026-09-06) — uma madrugada com throttle de 30 s

O operador pediu o caminho mais rápido que **não trave** o import, aproveitando
que ainda não há usuários. O único gargalo real é o throttle (o tamanho do lote
não muda a taxa, porque a taxa ≈ 1/throttle):

| throttle | rodada de 20 | taxa efetiva | 1275 motoristas |
|---|---|---|---|
| 60 s (hoje) | ~19 min → 4 ticks | 1/min | ~21 h |
| **30 s (escolhido)** | ~9,5 min → 2 ticks | **2/min** | **~10,6 h** |
| 15 s | ~4,75 min → 1 tick | 4/min | ~5,3 h — frágil: qualquer atraso volta a 2/min |

Com 30 s tudo cabe em **uma madrugada**: início 20:00, fim ~06:40, contra o
próximo import às 11h — **4 h de folga**. O import não é protegido por guarda de
código, e sim pelo fato de a **fila já estar vazia** quando ele roda.

15 s foi descartado: o risco que manda aqui é o antibot do portal, e um bloqueio
derrubaria **também** a importação diária (mesma conta/sessão, dec-039). "Não ter
usuários" elimina o risco interno, não esse.

**Desvio de spec assumido**: FR-016 fixa 60 s como mínimo. O override é por env
(`ENRIQ_THROTTLE_MS`), **temporário**, some sozinho quando a env some, tem piso
de 1 s e default 60 s inalterado (suíte do robô 211/211).

### Execução (cada passo exige autorização)

1. **Merge do habilitador** — `ENRIQ_THROTTLE_MS` + repasse ao container.
   Merge = deploy (o `ExecStart` roda do diretório vivo do repo).
2. **20:00** — enfileirar os 1275 (`dados_entrego_solicitado_em=now()` nos
   pendentes com `id_externo`). Escrita única na produção.
3. **20:00** — `Environment=ENRIQ_THROTTLE_MS=30000` no serviço sob-demanda
   (drop-in do systemd) e deixar o timer drenar.
4. **Monitorar**; **parada dura às 09:30** se não terminou — o que sobrar fica
   enfileirado e drena na madrugada seguinte (com o timer desligado até lá).
5. **Ao terminar** — remover o drop-in (volta a 60 s) e conferir o import das 11h.

## 8. Monitoramento e verificação (ambos os planos)

- Restante: contagem `Entregador?id_empresa=eq.6&dados_entrego_enriquecidos_em=is.null`
  (deve cair a cada noite/rodada).
- Sucesso/falha por motorista: eventos de auditoria no hub
  (`motorista.entrego_enriquecido` / `motorista.entrego_enriquecimento_falhou`).
- Saúde da rodada: `journalctl -u entrego-enriquecimento-sob-demanda` (resultado
  JSON de `executarRodadaEnriquecimento`; sessão `reusada`/`renovada`/`relogou`).
- Import diário intacto: `execucoes.jsonl` com `fim/sucesso` nos três horários.

## 9. Pausar / reverter

- **Pausar**: parar de enfileirar (plano 6) ou `systemctl stop`+`disable`
  `entrego-enriquecimento-sob-demanda.timer` (planos 6 e 7). A fila já gravada
  (`solicitado_em`) permanece; nada drena até religar.
- **Reverter um enfileiramento** feito por engano: limpar `solicitado_em` dos
  ainda-não-processados (`enriquecidos_em IS NULL`). Enriquecimentos já feitos
  não se desfazem (nem precisam — são idempotentes e re-executáveis).

## 10. Autorização

Cada enfileiramento é escrita no `chatmasterveloz` (produção) e cada drenagem é
carga no portal externo com PII → **5 gates + autorização explícita por etapa**.
Recomendo: (a) decidir a retenção de PII antes; (b) começar por **1 motorista
piloto** (o Aldemir, id 10448 — tem vínculo, não enriquecido, fora da fila) para
provar o pipeline ponta a ponta; (c) então liberar os lotes noturnos.

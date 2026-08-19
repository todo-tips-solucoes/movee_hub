# Backup de produção

Fecha a D3a do plano do grão de turno. Antes disto, **produção não tinha cópia
de nada** — nem do banco `chatmasterveloz` (342 MB, dados de todos os clientes),
nem do volume `envio_massa_hub_uploads` (os arquivos originais importados).
Verificado em 2026-08-18: sem cron, sem timer, sem serviço no Swarm, sem
arquivo de dump no host. O `hub_homolog_backup` que existe cobre **só** o
ambiente isolado de teste.

## O que é copiado, e por que os dois

| artefato | tamanho | por quê |
|---|---|---|
| `chatmasterveloz` (`pg_dump -Fc`) | 342 MB → **27 MB** medido | o banco inteiro, inclusive as tabelas do hub, que vivem dentro dele |
| `envio_massa_hub_uploads` (`tar.gz`) | 1,35 MB → **138 KB** medido | **não é redundante com o banco** — ver abaixo |

O volume parece dispensável e não é. Medido em produção: a importação de
faturamento aceitou 3.835 linhas e **rejeitou 179** (linhas 9 a 1169, todas por
`id_da_pessoa_entregadora` com UUID inválido). Dessas 179 o banco guarda apenas
`valor_mascarado = '**'`, por decisão de LGPD da migration 0012 — não dá nem
para saber de quem era. O conteúdo real existe **só dentro do ZIP**. Backup só
do banco perderia 179 lançamentos de faturamento para sempre, justamente os que
alguém precisaria reprocessar depois de corrigir o UUID.

A importação de performance, essa sim, está íntegra no banco: 2.720 aceitas,
zero rejeitadas.

## Verificado de ponta a ponta em 2026-08-18

Não é script entregue no escuro — rodou contra produção antes de ser instalado:

| checagem | resultado |
|---|---|
| execução completa | **3,9 s**; dump de 27.454.712 bytes e tar de 140.645 bytes |
| guarda de verificação | a 1ª execução **abortou de propósito** e preservou o `.parcial` (um `pg_restore --list -` lia o traço como nome de arquivo). Era exatamente o comportamento desejado: nada não-verificado vira "backup do dia" |
| round-trip do volume | `sha256` dos dois ZIPs extraídos **idêntico** ao dos originais |
| restauração do banco | dump restaurado num banco descartável: `PerformanceTurno` 2.720, `FaturamentoLancamento` 3.835, `ImportacaoLinhaErro` 179, `Entregador` 789 — **todos batendo com produção** |
| a materialized view sobrevive | o indicador calculado no banco restaurado deu **42,89%**, o mesmo de produção |

O banco descartável foi apagado por `trap`, então falha no meio do teste também
não deixaria resíduo. Produção não foi tocada em nenhum momento.

## Estado: INSTALADO e ativo desde 2026-08-18

```
NEXT                            LEFT  UNIT                  ACTIVATES
Wed 2026-08-19 00:30:01 -03  2h 19min backup-producao.timer backup-producao.service
```

`systemctl is-active` → `active`; `is-enabled` → `enabled` (sobrevive a reboot).
Primeira execução disparada **pelo systemd** (não pelo shell) concluiu sem
falha, com o journal registrando dump de 27.454.865 bytes e tar de 140.645
bytes. Os passos abaixo ficam para reinstalar noutro host ou depois de um
`daemon-reload` perdido.

## Instalação (uma vez, no host)

```bash
sudo ln -sf /var/lib/envioMassa_homologacao/infra/producao/backup-producao.service /etc/systemd/system/
sudo ln -sf /var/lib/envioMassa_homologacao/infra/producao/backup-producao.timer   /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now backup-producao.timer
```

Os symlinks apontam para o repo de propósito: atualizar a rotina passa a ser um
`git pull`, sem cópia divergindo do que está versionado.

Rodar uma vez na mão, para não descobrir na primeira madrugada que algo falta:

```bash
sudo systemctl start backup-producao.service
journalctl -u backup-producao.service -n 20 --no-pager
```

## Saúde — o comando de uma linha

```bash
systemctl list-timers backup-producao.timer --no-pager; ls -lh /var/backups/envio-massa | tail -5
```

O timer diz quando rodou e quando roda de novo; o `ls` mostra se os arquivos do
dia realmente existem. **Arquivo com sufixo `.parcial` é sinal de falha** — a
verificação não passou e ele foi mantido de propósito para inspeção.

⚠️ **Não há alerta ativo.** Uma falha marca o serviço como `failed` e fica no
journal, mas ninguém é avisado. Backup que falha em silêncio é o modo clássico
de descobrir o problema no pior dia possível — montar alerta é decisão à parte,
registrada como pendência.

## Restauração

### Provar que a cópia presta, SEM tocar em produção

Isto é o que transforma o backup de esperança em garantia. Restaura num banco
descartável, confere e apaga:

```bash
DUMP=/var/backups/envio-massa/chatmasterveloz_AAAAMMDD_HHMMSS.dump
CONT=$(docker ps -qf name=pgadmin_db.1)

docker exec "$CONT" sh -c 'psql -U "$POSTGRES_USER" -c "CREATE DATABASE teste_restore"'
docker exec -i "$CONT" sh -c 'pg_restore -U "$POSTGRES_USER" -d teste_restore --no-owner' < "$DUMP"

# confere que veio dado de verdade, comparando com produção
docker exec "$CONT" sh -c 'psql -U "$POSTGRES_USER" -d teste_restore -tAc "SELECT count(*) FROM \"PerformanceTurno\""'
docker exec "$CONT" sh -c 'psql -U "$POSTGRES_USER" -d chatmasterveloz -tAc "SELECT count(*) FROM \"PerformanceTurno\""'

docker exec "$CONT" sh -c 'psql -U "$POSTGRES_USER" -c "DROP DATABASE teste_restore"'
```

Os dois `count` têm de bater (a menos do que entrou depois do dump).

### Restaurar de verdade

🔴 **Rito integral dos 5 gates.** Sobrescrever o banco do cliente é a operação
mais destrutiva deste host — autorização explícita, janela combinada e o dump
do estado ATUAL feito antes, para poder desfazer a restauração.

```bash
# 1. dump do estado atual ANTES de qualquer coisa (o rollback da restauração)
sudo systemctl start backup-producao.service

# 2. só então restaurar
docker exec -i "$CONT" sh -c 'pg_restore -U "$POSTGRES_USER" -d chatmasterveloz --clean --if-exists --no-owner' < "$DUMP"

# 3. recarregar o cache de schema do PostgREST
docker kill -s SIGUSR1 $(docker ps -qf name=pgadmin_postgrest)
```

### Restaurar os arquivos importados

```bash
MOUNT=$(docker volume inspect --format '{{.Mountpoint}}' envio_massa_hub_uploads)
tar -xzf /var/backups/envio-massa/uploads_AAAAMMDD_HHMMSS.tar.gz -C "$MOUNT"
```

O `tar` não apaga o que já está lá — restaura por cima, o que é o
comportamento desejado para arquivos append-only.

## Desinstalar

```bash
sudo systemctl disable --now backup-producao.timer
sudo rm /etc/systemd/system/backup-producao.{service,timer}
sudo systemctl daemon-reload
```

Os backups já gravados em `/var/backups/envio-massa` **não** são apagados por
isto — remover é decisão separada e consciente.

## Retenção do arquivo importado (D3b) — 12 meses

Além de copiar, a rotina **expurga**: o arquivo original de uma importação é
apagado do volume 12 meses depois dela, prazo alinhado à Auditoria (D5 do
hub-frota, migration 0041) — um número só para lembrar e justificar perante a
LGPD. O motivo não é disco (produção tem 1,35 MB de arquivos), é que o ZIP
contém CNPJ/UUID/nome e guardar dado pessoal sem prazo definido é o problema.

Os **lançamentos** ficam no banco para sempre; o que expira é o arquivo.

### A regra que impede perda irreversível

O expurgo **se recusa** a apagar o arquivo de uma importação cujas linhas
rejeitadas ainda não estejam recuperáveis do banco (`linha_bruta` nula —
migration 0052). Não é uma promessa no README: é um `NOT EXISTS` na consulta.
Essas importações aparecem no log como *adiadas*.

Isso existe por um caso concreto: a importação de faturamento de produção
recusou 179 linhas cujo conteúdo só existia dentro do ZIP. Expurgá-lo antes de
extrair as linhas destruiria 179 lançamentos para sempre.

⚠️ **As 179 linhas ainda não foram extraídas.** Elas foram gravadas antes da
0052, então seguem com `linha_bruta` nula — e por isso aquele arquivo **nunca
será expurgado** até que alguém as recupere do ZIP. O prazo só vence em
2027-07-25, e a rotina avisa em todo backup. Importações novas já nascem com a
linha bruta gravada.

### Ordem e segurança

O expurgo roda **por último**, depois de os dois artefatos do dia estarem
gravados e verificados: o arquivo apagado acabou de entrar na cópia de hoje,
então ainda há 14 dias de janela para recuperá-lo se tiver sido engano. E se a
migration 0052 não estiver aplicada, o expurgo **avisa e se desliga** em vez de
virar um no-op silencioso.

Testado no caminho destrutivo (`infra/hub/testes/backup-producao-expurgo.sh`,
contra o hub-homolog, nunca produção): vencida e limpa é apagada e marcada;
vencida com pendência é preservada; dentro do prazo é preservada; e o controle
positivo confirma que preencher `linha_bruta` libera o expurgo na rodada
seguinte — sem ele o teste passaria até com um bug que não expurga nada.

### Recuperar uma linha rejeitada

`linha_bruta` **não é exposta pela API** — a 0052 tirou a coluna do alcance de
`authenticated`, porque o PostgREST de produção é alcançável em
`postgrest.todo-tips.com` e qualquer usuário logado do tenant poderia pedir
`select=linha_bruta`. A tela continua mostrando só o valor mascarado. A leitura
é feita como dono do banco:

```bash
docker exec "$CONT" sh -c 'psql -U "$POSTGRES_USER" -d chatmasterveloz -c \
  "SELECT numero_linha, motivo, linha_bruta FROM \"ImportacaoLinhaErro\" WHERE importacao_id = 1 ORDER BY numero_linha"'
```

## O que este backup NÃO cobre

- **Perda do host ou do disco.** O destino é o mesmo `/dev/sda1` de tudo o mais.
  Cobre o risco provável (volume apagado, migration ruim, `DROP` acidental,
  importação que corrompe dado) e não cobre incêndio. Envio para fora do host
  ficou como decisão pendente do operador — é o próximo passo natural, e o
  único que transforma isto em plano de desastre de verdade.
- **Alerta de falha**, como dito acima.
- **Os demais volumes de produção** (dados do pgadmin, etc.). O escopo aqui é o
  banco do cliente e os arquivos importados.

## Parâmetros

Ajustáveis por env var no `.service`, com estes padrões:

| var | padrão | nota |
|---|---|---|
| `BACKUP_DEST` | `/var/backups/envio-massa` | `chmod 700`, arquivos `600` — contêm dado de cliente |
| `BACKUP_RETENCAO_DIAS` | `14` | mesmo valor do backup do hub-homolog; **~380 MB** no total, medido |
| `EXPURGO_RETENCAO` | `12 months` | D3b — prazo do ARQUIVO original. Não confundir com `BACKUP_RETENCAO_DIAS`, que é a retenção destas cópias |
| `EXPURGO_ATIVO` | `1` | `0` desliga o expurgo mantendo o backup |
| `BACKUP_MIN_LIVRE_MB` | `3072` | abaixo disso o backup **aborta em vez de encher o disco** — este host já teve o Swarm derrubado por starvation |

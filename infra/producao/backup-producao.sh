#!/usr/bin/env bash
# =============================================================================
# backup-producao.sh — backup diário do que é de PRODUÇÃO neste host.
#
# Cobre duas coisas, e as duas estavam SEM CÓPIA NENHUMA até 2026-08-18:
#
#   1. o banco `chatmasterveloz` (342 MB), que guarda os dados de todos os
#      clientes — inclusive as tabelas do hub, que vivem dentro dele;
#   2. o volume `envio_massa_hub_uploads` (1,4 MB), com os arquivos originais
#      importados.
#
# ── Por que o volume entra, sendo tão pequeno ────────────────────────────────
#
# Porque ele NÃO é redundante com o banco. Medido em produção: a importação de
# faturamento aceitou 3.835 linhas e REJEITOU 179 (linhas 9 a 1169, todas por
# `id_da_pessoa_entregadora` com UUID inválido). Dessas 179 o banco guarda só
# `valor_mascarado = '**'` — decisão de LGPD da migration 0012 —, o que não
# permite nem saber de quem era. O conteúdo real dessas linhas existe
# exclusivamente dentro do ZIP. Backup só do banco perderia 179 lançamentos de
# faturamento para sempre, justamente os que alguém precisaria reprocessar
# depois de corrigir o UUID. (A importação de performance, essa sim, entrou
# íntegra: 2.720 aceitas, 0 rejeitadas.)
#
# ── O que este script NÃO resolve ────────────────────────────────────────────
#
# O destino é o MESMO DISCO do host. Isso cobre o risco provável — volume
# apagado, migration ruim, DROP acidental, importação que corrompe dados — e
# NÃO cobre perder o host ou o disco. Envio para fora é decisão pendente do
# operador (D3a-offsite), registrada em docs/plans/.
#
# Também não há alerta: uma falha marca o serviço como `failed` no systemd e
# fica no journal, mas ninguém é avisado ativamente. O README traz o comando de
# uma linha para conferir a saúde; alertar de verdade é decisão à parte.
#
# ── Invariantes que este script garante ──────────────────────────────────────
#
# - Nada é dado como bom sem VERIFICAÇÃO. O dump passa por `pg_restore --list`
#   e o tar por `tar -tzf` antes de perderem o sufixo `.parcial`. Arquivo
#   truncado por disco cheio não vira "backup do dia" — fica com o sufixo e o
#   script falha. Backup nunca verificado é esperança, não backup.
# - A retenção só roda DEPOIS de um backup bem-sucedido. Um dia ruim nunca
#   apaga o último dia bom.
# - O segredo do banco não passa pelo host: o `pg_dump` roda DENTRO do
#   container, lendo `$POSTGRES_USER` de lá.
# =============================================================================
set -euo pipefail

DEST="${BACKUP_DEST:-/var/backups/envio-massa}"
RETENCAO_DIAS="${BACKUP_RETENCAO_DIAS:-14}"
# O disco deste host vive perto do limite (90% em 2026-08-18). Sem esta guarda,
# um backup só descobriria que não cabe DEPOIS de encher a partição — e disco
# cheio aqui já derrubou o Swarm inteiro uma vez (incidente 2026-06-11).
MIN_LIVRE_MB="${BACKUP_MIN_LIVRE_MB:-3072}"

# Os três abaixo têm PRODUÇÃO como padrão e existem sobrescritíveis por um
# motivo só: o expurgo faz `rm -rf`, e caminho destrutivo que nunca foi
# exercitado é promessa, não garantia. `infra/hub/testes/backup-producao-expurgo.sh`
# aponta estes valores para o hub-homolog e prova o comportamento lá.
DB="${BACKUP_DB:-chatmasterveloz}"
VOLUME="${BACKUP_VOLUME:-envio_massa_hub_uploads}"
DB_CONT_FILTRO="${BACKUP_DB_CONT:-pgadmin_db.1}"
# D3b: retenção do ARQUIVO ORIGINAL importado. 12 meses, alinhado à Auditoria
# (D5 do hub-frota, migration 0041) — um prazo só para lembrar e justificar
# perante a LGPD. Não confundir com BACKUP_RETENCAO_DIAS, que é a retenção
# destas cópias.
EXPURGO_RETENCAO="${EXPURGO_RETENCAO:-12 months}"
EXPURGO_ATIVO="${EXPURGO_ATIVO:-1}"

stamp="$(date -u +%Y%m%d_%H%M%S)"
mkdir -p "$DEST"
chmod 700 "$DEST"

falhar() { echo "[backup-producao] ABORTADO: $*" >&2; exit 1; }

# --- guardas antes de escrever qualquer byte ---------------------------------
livre_mb="$(df -Pm "$DEST" | awk 'NR==2 {print $4}')"
[ "$livre_mb" -ge "$MIN_LIVRE_MB" ] \
  || falhar "só ${livre_mb} MB livres em ${DEST} (mínimo ${MIN_LIVRE_MB} MB)"

cont="$(docker ps -qf name="$DB_CONT_FILTRO")"
[ -n "$cont" ] || falhar "container do banco (${DB_CONT_FILTRO}) não encontrado"

# O override existe só para o teste do caminho destrutivo apontar para um
# diretório temporário; em produção a variável não é definida e o ponto de
# montagem vem do próprio Docker — derivado, e não fixo, para o script não
# quebrar em silêncio se o driver do volume mudar.
mount="${BACKUP_VOLUME_MOUNT_OVERRIDE:-$(docker volume inspect --format '{{.Mountpoint}}' "$VOLUME" 2>/dev/null || true)}"
[ -n "$mount" ] && [ -d "$mount" ] \
  || falhar "volume ${VOLUME} não encontrado (driver mudou?)"

echo "[backup-producao] início ${stamp} UTC — destino ${DEST}, ${livre_mb} MB livres"

# --- 1. banco ----------------------------------------------------------------
dump="${DEST}/${DB}_${stamp}.dump"
docker exec "$cont" sh -c "pg_dump -U \"\$POSTGRES_USER\" -Fc ${DB}" > "${dump}.parcial" \
  || falhar "pg_dump falhou"

# `pg_restore --list` lê o índice do arquivo: um dump truncado passa pelo
# pg_dump (que já escreveu o que deu) e MORRE aqui, que é o ponto.
# Verificado no container, que tem o binário; o host não necessariamente tem.
#
# SEM `-` no fim: `pg_restore --list -` interpreta o traço como NOME DE ARQUIVO
# ("could not open input file") em vez de stdin — pego rodando o script pela
# primeira vez. Sem argumento, ele lê a entrada padrão, que é o que queremos.
docker exec -i "$cont" pg_restore --list < "${dump}.parcial" > /dev/null \
  || falhar "dump ilegível — arquivo mantido como ${dump}.parcial para inspeção"
mv "${dump}.parcial" "$dump"
chmod 600 "$dump"
echo "[backup-producao] banco OK: $(basename "$dump") ($(stat -c%s "$dump") bytes)"

# --- 2. volume de uploads ----------------------------------------------------
tarball="${DEST}/uploads_${stamp}.tar.gz"
tar -czf "${tarball}.parcial" -C "$mount" . \
  || falhar "tar do volume falhou"
tar -tzf "${tarball}.parcial" > /dev/null \
  || falhar "tar ilegível — arquivo mantido como ${tarball}.parcial para inspeção"
mv "${tarball}.parcial" "$tarball"
chmod 600 "$tarball"
echo "[backup-producao] uploads OK: $(basename "$tarball") ($(stat -c%s "$tarball") bytes)"

# --- 3. retenção — SÓ agora, com os dois artefatos do dia verificados ---------
# `-mtime +N` apaga idade >= N+1 dias, então reter N dias é `+$((N-1))`.
find "$DEST" -maxdepth 1 -name "${DB}_*.dump"     -mtime +"$((RETENCAO_DIAS - 1))" -delete
find "$DEST" -maxdepth 1 -name "uploads_*.tar.gz" -mtime +"$((RETENCAO_DIAS - 1))" -delete
# Restos de execuções que falharam na verificação: úteis por um dia, lixo depois.
find "$DEST" -maxdepth 1 -name "*.parcial" -mtime +1 -delete

# --- 4. expurgo do arquivo original importado (D3b) --------------------------
#
# Roda SÓ AQUI, depois de os dois artefatos do dia estarem gravados e
# verificados: o arquivo que está prestes a ser apagado do volume acabou de
# entrar na cópia de hoje, então ainda há BACKUP_RETENCAO_DIAS de janela para
# recuperá-lo se o expurgo tiver sido um erro.
#
# A regra que impede perda irreversível não é uma promessa em prosa, é o
# `NOT EXISTS` da consulta: uma importação cujas linhas rejeitadas ainda não
# tenham `linha_bruta` preenchida (D3c, migration 0052) NÃO é expurgada, e
# aparece como "adiada" no log. O caso concreto que motivou isso: 179 linhas
# de faturamento recusadas cujo conteúdo só existe dentro do ZIP.
if [ "$EXPURGO_ATIVO" = 1 ]; then
  # Sem a 0052 as colunas não existem, a consulta abaixo erra e o `|| true`
  # engoliria o erro: o expurgo viraria um no-op silencioso e ninguém saberia
  # que a retenção não está rodando. Preferimos dizer em voz alta.
  tem_colunas="$(docker exec "$cont" sh -c "psql -U \"\$POSTGRES_USER\" -d ${DB} -tAc \"
    SELECT count(*) FROM information_schema.columns
    WHERE (table_name='ImportacaoArquivo'   AND column_name='arquivo_expurgado_em')
       OR (table_name='ImportacaoLinhaErro' AND column_name='linha_bruta')\"" 2>/dev/null | tr -d '[:space:]')"
  if [ "${tem_colunas:-0}" != "2" ]; then
    echo "[backup-producao] expurgo PULADO: migration 0052 não aplicada neste banco (colunas encontradas: ${tem_colunas:-0}/2)" >&2
    EXPURGO_ATIVO=0
  fi
fi

if [ "$EXPURGO_ATIVO" = 1 ]; then
  pendentes="$(docker exec "$cont" sh -c "psql -U \"\$POSTGRES_USER\" -d ${DB} -tAc \"
    SELECT a.id FROM \\\"ImportacaoArquivo\\\" a
    WHERE a.arquivo_expurgado_em IS NULL
      AND a.criado_em < now() - interval '${EXPURGO_RETENCAO}'
      AND NOT EXISTS (SELECT 1 FROM \\\"ImportacaoLinhaErro\\\" e
                      WHERE e.importacao_id = a.id AND e.linha_bruta IS NULL)\"" 2>/dev/null || true)"

  adiadas="$(docker exec "$cont" sh -c "psql -U \"\$POSTGRES_USER\" -d ${DB} -tAc \"
    SELECT count(*) FROM \\\"ImportacaoArquivo\\\" a
    WHERE a.arquivo_expurgado_em IS NULL
      AND a.criado_em < now() - interval '${EXPURGO_RETENCAO}'
      AND EXISTS (SELECT 1 FROM \\\"ImportacaoLinhaErro\\\" e
                  WHERE e.importacao_id = a.id AND e.linha_bruta IS NULL)\"" 2>/dev/null | tr -d '[:space:]')"

  n_expurgadas=0
  for id in $pendentes; do
    # Guarda contra `rm -rf` com id vazio ou não-numérico: o alvo é sempre
    # <mountpoint>/<inteiro>, nunca uma string vinda solta do banco.
    case "$id" in ''|*[!0-9]*) echo "[backup-producao] id de importação inesperado, pulando: '${id}'" >&2; continue ;; esac
    rm -rf -- "${mount:?}/${id}"
    docker exec "$cont" sh -c "psql -U \"\$POSTGRES_USER\" -d ${DB} -c \"
      UPDATE \\\"ImportacaoArquivo\\\" SET arquivo_expurgado_em = now() WHERE id = ${id}\"" >/dev/null \
      || { echo "[backup-producao] ERRO ao marcar importação ${id} como expurgada" >&2; continue; }
    n_expurgadas=$((n_expurgadas + 1))
  done

  if [ "$n_expurgadas" -gt 0 ] || [ "${adiadas:-0}" != "0" ]; then
    echo "[backup-producao] expurgo (retenção ${EXPURGO_RETENCAO}): ${n_expurgadas} arquivo(s) apagado(s), ${adiadas:-0} adiada(s) por linha rejeitada ainda não recuperável (D3c)"
  fi
fi

echo "[backup-producao] concluído — $(find "$DEST" -maxdepth 1 -name '*.dump' | wc -l) dump(s) retido(s), $(df -Pm "$DEST" | awk 'NR==2 {print $4}') MB livres"

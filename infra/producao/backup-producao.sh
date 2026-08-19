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

DB=chatmasterveloz
VOLUME=envio_massa_hub_uploads

stamp="$(date -u +%Y%m%d_%H%M%S)"
mkdir -p "$DEST"
chmod 700 "$DEST"

falhar() { echo "[backup-producao] ABORTADO: $*" >&2; exit 1; }

# --- guardas antes de escrever qualquer byte ---------------------------------
livre_mb="$(df -Pm "$DEST" | awk 'NR==2 {print $4}')"
[ "$livre_mb" -ge "$MIN_LIVRE_MB" ] \
  || falhar "só ${livre_mb} MB livres em ${DEST} (mínimo ${MIN_LIVRE_MB} MB)"

cont="$(docker ps -qf name=pgadmin_db.1)"
[ -n "$cont" ] || falhar "container do banco (pgadmin_db.1) não encontrado"

mount="$(docker volume inspect --format '{{.Mountpoint}}' "$VOLUME" 2>/dev/null || true)"
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

echo "[backup-producao] concluído — $(find "$DEST" -maxdepth 1 -name '*.dump' | wc -l) dump(s) retido(s), $(df -Pm "$DEST" | awk 'NR==2 {print $4}') MB livres"

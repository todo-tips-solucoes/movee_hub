# =============================================================================
# lib.sh — funções e constantes compartilhadas dos scripts do hub.
# Sourceado por: preflight.sh, migrate.sh, testes/isolamento.sh,
# testes/carga-seeds-teste.sh. Fonte ÚNICA para (a) parsing de env-file e
# (b) listas de recursos de produção — evita deriva entre o gate (preflight)
# e os consumidores/testes (review S1, achados reuse/altitude).
# =============================================================================

# Lê KEY=VALUE de um env-file SEM source/eval (nada é executado) e normaliza
# como o docker compose faz: remove \r (CRLF) e aspas envolventes simples ou
# duplas. Sem isso, o hash de fingerprint seria calculado sobre `"valor"` em
# vez de `valor` e o gate de segredo igual ao de produção não dispararia.
# Uso: get_var NOME ARQUIVO
get_var() {
  local raw
  raw="$(awk -F= -v k="$1" '$0 !~ /^[[:space:]]*#/ && $1 == k { sub(/^[^=]*=/, ""); print; exit }' "$2" | tr -d '\r')"
  case "$raw" in
    \"*\") raw="${raw#\"}"; raw="${raw%\"}" ;;
    \'*\') raw="${raw#\'}"; raw="${raw%\'}" ;;
  esac
  printf '%s' "$raw"
}

# --- Recursos de PRODUÇÃO (blocklist compartilhada; defesa em profundidade —
# a allowlist hub_* do preflight é a primeira linha) -------------------------
PROD_DB_REGEX='postgrest\.todo-tips\.com|pgadmin_db|chatmasterveloz'
PROD_MOUNT_REGEX='pgadmin_pg_data|/var/lib/fastapi_homologacao'
PROD_DOMAIN_REGEX='moveelog\.com\.br'
PROD_NETWORKS="pgadmin app_homologacao_default fastapi_homologacao fastapi_homologacao_nexus network_main"

# Redes que o projeto hub-homolog DEVE ter (conjunto exato; teste §4.11 #3)
HUB_EXPECTED_NETWORKS="hub_homolog_net hub_homolog_edge"

# Prefixos permitidos para bind mounts de containers hub_* (§4.11 #10).
#
# A raiz vem do PRÓPRIO arquivo (`.../infra/hub/scripts/lib.sh` -> `.../infra/hub`)
# em vez de um caminho fixo. O caminho fixo era o do checkout principal, então
# rodar qualquer teste a partir de um git worktree — `.claude/worktrees/<x>/` —
# abortava no preflight com "bind mount fora da allowlist", num guard que na
# verdade estava vendo o `infra/hub` correto, só que de outra cópia do repo.
# A intenção do guard é "binds sob o infra/hub DESTE repositório"; é isso que
# ele passa a checar. Nada afrouxa: um bind para fora continua sendo abortado.
HUB_HUB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)"
HUB_ALLOWED_BIND_PREFIXES="$HUB_HUB_DIR /var/lib/hub_secrets"

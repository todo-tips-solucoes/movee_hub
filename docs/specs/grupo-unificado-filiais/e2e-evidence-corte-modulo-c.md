# Evidência E2E — Corte controlado do Módulo C (flag `login_unico_ativo` por grupo)

Data: 2026-06-10 · Ambiente: homologação (Docker Swarm) · API: `https://envmassapihomologacao.todo-tips.com`
Banco: `chatmasterveloz` (container `pgadmin_db`) · executado pelo agente sob autorização do operador.

## Deploy (service update --image, preserva env/labels)
- backend `registry.todo-tips.com/envio-massa-backend:corte-modulo-c@sha256:a322e25c…` (convergido 1/1).
- Demais serviços não tocados.

## DDL aplicada
- `007-corte-modulo-c-login-unico-flag.sql` → `Grupo.login_unico_ativo boolean NOT NULL DEFAULT false`.
- Verificado: coluna boolean, default false, NOT NULL; ambos os grupos nasceram `false`.

## Setup de teste (sem tocar dado real)
- Filial **efêmera** criada no grupo 2 (Movee, sem filiais reais): `filial.e2e.corte@movee.test`,
  senha `teste123` (bcrypt cost 10), `id_grupo=2`, não-pai. **Removida ao final.**
- Pai do grupo 2: `admin@movee.com.br` / `123456`.
- Grupo 1 (D&G, 5 filiais reais) **nunca foi tocado** — flag permaneceu `false` o tempo todo.

## Resultados (todos verdes — toggle a quente, mesma imagem entre as fases)

| # | Cenário | Flag grupo 2 | Esperado | Obtido |
|---|---------|--------------|----------|--------|
| A1 | Filial efêmera loga (senha correta) | OFF | 200 | 200 |
| A2 | Pai Movee loga | OFF | 200 | 200 |
| B1 | Filial senha correta → bloqueada | ON | 403 | 403 |
| B2 | Filial senha errada → 400 genérico (anti-enum HIGH-001 preservado) | ON | 400 | 400 |
| B3 | Pai Movee continua logando (não afetado) | ON | 200 | 200 |
| B4 | Refresh de refreshToken antigo de filial (emitido com flag OFF) → bloqueado (LOW-004) | ON | 403 | 403 |
| C1 | Filial volta a logar após desativar (rollback a quente, reversível) | OFF | 200 | 200 |

## Pontos validados
- **Flag OFF = filial loga normal** (corte inativo) — sem breaking change no deploy.
- **Flag ON = filial 403, pai 200, refresh de filial 403** — corte por grupo nos DOIS pontos (login + refresh, mesma helper `grupoLoginUnicoAtivo`).
- **Toggle a quente sem redeploy**: A→B→C alternaram só por `UPDATE "Grupo" SET login_unico_ativo`, mesma imagem.
- **Anti-enumeração preservada**: senha errada → 400 genérico (a flag é consultada só após senha válida).
- **Isolamento por grupo**: ativar o grupo 2 não afetou o grupo 1 (flag do grupo 1 = false intacta; 5 filiais D&G intactas).

## Estado final (limpo)
- Filial efêmera removida (0 restantes). Ambos os grupos `login_unico_ativo=false` (ninguém bloqueado).
- Coluna persiste (é a feature). Backend em homologação com a imagem `corte-modulo-c`.

## Pendências (gates do operador — fora do escopo deste E2E)
- **Produção**: rodar `corte-modulo-c-levantamento-prod.sql`, aplicar DDL 007, deploy backend, e ATIVAR por grupo (Movee livre; D&G só após senha do pai `admin@dg.com.br` confirmada às 5 filiais). Tudo sob autorização explícita.
- **Commit/push/merge** da branch `docs/corte-modulo-c`: pendente de autorização.

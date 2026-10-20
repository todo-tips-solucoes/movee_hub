# Runbook de deploy - corrigir-movimento (execucao do OPERADOR)

Escrita no ambiente vivo: 5 gates do `CLAUDE.md` (autorizacao, janela, rollback, `service update --image`, smoke).

## Ordem obrigatoria

1. **Migration 0116 ANTES do codigo.** Sem a funcao `hub_envio_massa_corrigir_valor`, o `PATCH /update-envio-massa/:id` com `valor` responde 500.
   - Aplicar o arquivo `infra/hub/migrations/0116_envio_massa_corrigir_valor.sql` e o registro em `"SchemaMigration"` na MESMA transacao.
   - psql de producao: `-U chatmasterveloz` (nao `postgres`); copiar o script para `~/` antes.
2. **`SIGUSR1` no `pgadmin_postgrest.1.<hash>`** (nao no PostgREST do hub) para ele enxergar a funcao nova. Provar: chamar a RPC e ver `nao_encontrado` para um id inexistente.
3. **Antes de decidir o indice (CHK022):** rodar `EXPLAIN (ANALYZE, BUFFERS)` da consulta de casamento (Cenario 12 do `quickstart.md`) no `chatmasterveloz`. No hub_homolog (20.000 linhas sinteticas) usou `idx_envio_massa_cnpj_periodo`: 0,040 ms contra `Seq Scan` 2,8 ms por `uuid`. Se em producao nao usar o indice, ativar a alternativa B `(id_empresa, dt_inicial, dt_final)` em migration propria, aditiva.
4. **Build a partir da `main` mergeada**, tag `<rotulo>-<sha7>`; `df -h /` >= 20 GB e swap antes; backend por `Dockerfile.hub` com `docker run --rm <tag> node --version` = v20.
5. `docker service update --with-registry-auth --image ...` backend e frontend_v2 (nunca `stack deploy`).
6. **Prova de bundle** pela string servida (ex.: "Informe o motivo da correção") e smoke HTTP.

## Rollback

- Imagem anterior de cada servico (anotar via `docker service ls` ANTES): `docker service update --with-registry-auth --image <anterior> <servico>`.
- Banco: `DROP FUNCTION IF EXISTS hub_envio_massa_corrigir_valor(int, jsonb, text, text, int);` (aditiva; nada mais muda no schema da 0116).

## Mudancas de comportamento em caminho vivo (declarar no PR)

- Celula monetaria nao numerica na planilha passa a recusar o lote (antes: linha nova inseria R$ 0,00).
- Cinco campos do `edit-dialog` ficam somente-leitura (o backend nunca os gravava).
- Reimportacao deixa de ser INSERT cego (casa por `uuid`, depois CNPJ+periodo).
- `PATCH` com `valor` exige `motivo` (cliente antigo que mandava o form inteiro recebe 400).
- ⚠️ **A `mensagem1` passa a ser reescrita quando o valor e corrigido** — numero ancorado
  na frase (movimento de planilha) ou re-render do molde (movimento gerado pelo hub).
  **E o texto que o motorista recebe**, por isso e a mudanca mais sensivel da entrega.
  Se a ancora nao e encontrada, ou se o molde foi editado depois de a mensagem ter sido
  gerada, o sistema **avisa e NAO declara sucesso** — nunca reescreve no escuro.
- `POST /upload` responde 400 exigindo `motivo` quando o lote alteraria movimentos
  existentes: um reenvio que antes passava (duplicando) agora e recusado ate que o
  operador informe o motivo.

# Quickstart / cenarios: retorno-transfeera-xlsx

1. **Happy path**: lote com 58 itens `ADV-000015..74` (valores da fixture) + fixture -> 200, `aplicadas=58`, `ignoradas=0`. **Controle negativo**: o mesmo teste falha contra o codigo anterior (nomear os testes que falham no relato).
2. **Idempotencia**: reenviar -> itens `situacao != incluido` -> `JA_APLICADO` x58, nada alterado.
3. **Repasse**: fixture com IDs `REP-…` em lote de repasse -> confirma; fixture `ADV-…` em lote de repasse -> `ID_INTEGRACAO_INVALIDO` x58.
4. **Recusas**: CSV (mime errado e conteudo CSV com mime XLSX) -> 400 `FORMATO_INVALIDO`; ZIP corrompido; texto renomeado `.xlsx`; cabecalho com coluna renomeada/extra/fora de ordem -> `CABECALHO_INVALIDO`; planilha so com cabecalho -> sem linhas aplicaveis e `RETORNO_INCOMPLETO` (409); 10.001 linhas -> `ARQUIVO_MUITO_GRANDE`; ZIP com declarado > 32 MiB -> `ARQUIVO_MUITO_GRANDE`.
5. **Status**: linha `XYZ` -> `STATUS_DESCONHECIDO:XYZ`, lote nao confirmado (faltante); status de 5.000 chars -> motivo saneado <= 40; `Devolvida` com `Motivo` -> falha com motivo literal.
6. **Valores**: `54,57`, `1.234,56`, numero nativo `1234.56` -> mesmos centavos esperados; `abc`/vazio -> `VALOR_DIVERGENTE`.
7. **Celula vazia no meio** (ex.: `Motivo` vazia, `Email` vazio) -> coluna continua no lugar (posicional).
8. **Roundtrip End-to-End (borda frontend->proxy->backend)**: teste do proxy com bytes nao-UTF-8 comparados byte a byte; teste de dialog com `File` `.xlsx` -> `importar` recebe `ArrayBuffer` de `byteLength == File.size`; teste de rota com a fixture real via HTTP no app Express de teste (nao fixture parseada em mock). Smoke em producao (arquivo real, lote real): do operador.
9. **SC-004**: 10.000 linhas sinteticas -> tempo medido (< 5 s; medido na execucao: ver relato da FASE 6).

---

# Runbook de deploy (entregue ao operador — o agente NAO executa nada disto)

Escopo: **backend + frontend_v2**, nenhum outro servico. **Sem migration, sem `SIGUSR1` no PostgREST, sem passo de banco.** O app motorista nao muda.

> **Nao importar retorno da Transfeera durante a janela de deploy.** Um frontend antigo envia `text/csv` e recebe 400 `FORMATO_INVALIDO` do backend novo; um frontend novo envia XLSX que o backend antigo recusa. Os dois servicos sao um par: mesma janela, backend primeiro.

## Antes (rito do ciclo git + 5 gates de producao)

1. PR mergeado na `main`; `git checkout main && git pull --ff-only`. Tag `<rotulo>-<sha7>` (`git rev-parse --short HEAD`).
2. `df -h /` (abortar com menos de ~20 GB livres) e swap ativa. O disco estava em ~19 GB quando esta frente foi entregue: **liberar espaco antes de buildar** (so `docker image prune -f` sem `-a`; nunca `--volumes`).
3. Anotar o rollback: `docker service ls --filter name=envio-massa-homologacao_ --format '{{.Name}}\t{{.Image}}'` (imagens atuais dos DOIS servicos) e `docker run --rm <imagem-do-backend> node --version` (deve ser v20; o build do backend e o `Dockerfile.hub`).
4. Build a partir da main ja mergeada, sempre com `--memory=2g`:
   - backend: `DOCKER_BUILDKIT=0 docker build --memory=2g -f Dockerfile.hub -t registry.todo-tips.com/envio-massa-backend:<tag> .` e conferir `docker run --rm <tag> node --version` antes de empurrar.
   - frontend_v2: conferir o `ENV BACKEND_URL` do Dockerfile antes de buildar.
   - `docker push` das duas imagens; anotar os digests.

## Aplicar (janela combinada, backend primeiro)

```sh
docker service update --with-registry-auth --image registry.todo-tips.com/envio-massa-backend:<tag> envio-massa-homologacao_backend_homologacao
docker service update --with-registry-auth --image registry.todo-tips.com/envio-massa-frontend-v2:<tag> envio-massa-homologacao_frontend_v2_homologacao
```

Nunca `docker stack deploy`. O frontend_v2 e stop-first com 1 replica (downtime curto).

## Rollback (imagens anotadas no passo 3)

```sh
docker service update --with-registry-auth --image <imagem-anterior-backend> envio-massa-homologacao_backend_homologacao
docker service update --with-registry-auth --image <imagem-anterior-frontend> envio-massa-homologacao_frontend_v2_homologacao
```

Sem migration, o rollback nao deixa estado de banco para desfazer.

## Provas pos-deploy (HTTP 200 prova que o servico subiu, nao que subiu o codigo certo)

- **Frontend, pela STRING servida**: buscar `Arquivo XLSX` no chunk do dialog servido pelo painel (sem expor cookie nem segredo) e confirmar que `Arquivo CSV` sumiu. Em busybox, `grep --include` mente: usar `grep -rl` sem `--include` e conferir o controle negativo (a string antiga tem de aparecer no lado antigo).
- **Backend, interrogando o processo vivo** (`docker service logs` agrega tarefas antigas): `docker exec <task-id-do-backend> sh -c 'grep -c XLSX_MIME lib/adiantamento-retorno-transfeera.js'` (o `exec` roda no WORKDIR da imagem) e `docker exec <task-id-do-backend> node --version`.
- **Smoke funcional** (arquivo real em lote real): **do operador** — importar o XLSX de retorno de um lote real e conferir as contagens; reenviar e ver tudo como `JA_APLICADO`.

## O que esperar / registrar

- Corpo acima de 10 MB: o `express.raw` responde **413 em HTML do Express** (paridade com a rota CSV anterior, aceito); o dialog ja barra acima de 10 MB no cliente e o proxy responde 413 JSON antes de bufferizar.
- `Devolvida` e o **unico** rotulo medido do ramo de devolucao (`FINALIZADO` e `Finalizada` = pago). Se a Transfeera mandar outro rotulo, a linha vira `STATUS_DESCONHECIDO:<valor>` (saneado a 40 caracteres), o lote **nao** e confirmado, e o operador envia uma amostra para o vocabulario crescer.
- **Pendencia declarada (nao inventada)**: o caminho de menu da Transfeera para baixar esse XLSX nao esta medido; a Central de Ajuda e o dialog **nao** afirmam menu nenhum. O operador, que baixou o arquivo, confirma o caminho para a ajuda ganhar a frase.
- O CSV deixou de ser aceito (rota, dialog, ajuda). Nao ha caminho de volta sem novo deploy.

## Pendencias do operador (registradas pelo converge, nao resolvidas pelo agente)

- **Asserção obsoleta no driver de integração**: `infra/hub/testes/hub-adiantamentos-integration.sh`, asserção `1.4.2`, espera `financeiro=9` permissões, e o comentário acima dela cita a migration 0097. A **migration 0115 (19/10)** devolveu `adiantamentos.pagamento_confirmar` ao papel `financeiro` por decisão do operador, então o valor correto hoje é **`financeiro=10`** (`admin_entidade` segue 9). Medido: 230 PASS / 1 FAIL contra o hub-homolog; a parte XLSX do driver passou. Alheio a esta entrega; edição de asserção de permissão de pagamento é decisão do operador (o harness bloqueou a tentativa, corretamente) — corrigir valor e comentário numa PR própria.
- Caminho de menu da Transfeera para baixar o XLSX (a ajuda não afirma nenhum).
- `Devolvida`: confirmar o rótulo no primeiro XLSX real com devolução (CHK040).
- Mensagem `VALOR_AMBIGUO`: se o financeiro a vir, o arquivo trouxe valor tipo `1.234` sem vírgula; reexportar com vírgula e duas casas.

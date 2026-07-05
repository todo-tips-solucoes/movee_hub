# Prompt A — Criação do ambiente isolado (Sessão S1)

> Colar num Claude Code fresco na raiz de `/var/lib/envioMassa_homologacao`.
> Pré-requisito: **G1 aprovado** — ✅ decidido em 2026-07-05 (ver DIARIO.md): **MESMO
> HOST (VPSTodo)** com exceção standing escopada a recursos `hub-*`; subdomínio
> `hub-homolog.todo-tips.com`; D1/D2 ratificadas; D4 confirmada. Pré-condição
> operacional: `docker builder prune -a -f` executado pelo operador (disco).

```text
Use /context-mode:context-mode durante toda a sessão para gestão de memória/token.

CONTEXTO. O ambiente "homologação" atual (host VPSTodo, serviços envio-massa-homologacao_*,
banco chatmasterveloz, domínios *.moveelog.com.br) É PRODUÇÃO com clientes reais (CLAUDE.md).
Você vai criar o AMBIENTE ISOLADO real (dev/test/homolog) do Hub de Gestão de Frota,
conforme docs/plans/hub-frota/01-plano-tecnico.md §4–§6 (ler §4.4–§4.11 integralmente
antes de começar). Decisão de infra do G1 (2026-07-05, DIARIO.md): MESMO HOST (VPSTodo),
Alternativa B do plano — aplicar TODAS as exigências da §4.2 (projeto/redes/volumes/
banco/credenciais/portas próprios + caps de CPU/RAM em todo serviço e build; lição do
incidente de starvation). Subdomínio de homolog: hub-homolog.todo-tips.com (roteamento
TLS é decisão de design desta sessão: 2ª instância Traefik do hub em portas altas OU
rota no Traefik existente — esta última altera produção e só o operador executa).

ESCOPO (exclusivo — infra, zero mudança funcional):
1. Infra-as-code em infra/hub/: compose.hub.{dev,test,homolog}.yml, .env.hub.*.example
   (sem segredos), mocks/ (fastapi-mock, n8n-mock), scripts/preflight.sh,
   scripts/gen-seeds.py (anonimização), scripts/backup.sh + restore.sh, runbook
   infra/hub/RUNBOOK.md.
2. Banco exclusivo (postgres:13, hub_homolog) + PostgREST próprio (v14.1, PGRST_JWT_SECRET
   novo) na mesma rede interna — nunca a URL pública de produção.
3. Credenciais todas novas (JWT_SECRET, JWT_REFRESH_SECRET, POSTGREST_API_KEY etc.);
   segredos reais só na VPS (chmod 600), jamais no git.
4. Preflight fail-safe (§4.8): aborta se APP_ENV != production e detectar
   postgrest.todo-tips.com, moveelog.com.br, volumes/binds de produção ou tokens de
   produção (comparação por hash). Demonstrar o abort com teste negativo.
5. Mocks + proteções do envio em massa (§4.7, itens 1–10): ENVIO_DRY_RUN default,
   allowlist vazia bloqueia tudo, limite por lote, registro de bloqueios.
6. Seeds anonimizados: gerar NO SANDBOX context-mode a partir dos CSVs em
   /var/lib/envioMassa_homologacao/docs/documentos_apoio/*.zip (processo irreversível:
   HMAC com salt descartado, nomes fake, valores ±20%); asserção automática de
   não-vazamento. O gerador deve ter modo opcional de SÍNTESE DE VOLUME (replicar os
   dias disponíveis com datas deslocadas e hashes novos) — a S10 o usará para montar o
   dataset de ~1 ano. Os CSVs brutos nunca entram no contexto nem no git.
7. Backup diário (pg_dump -Fc) + restore testado + rollback documentado.
8. Executar os 20 TESTES DE ISOLAMENTO da §4.11 e anexar evidência item a item.

ORDEM: 1→8 acima. Não pular o preflight antes do primeiro `up`.

PROIBIDO:
- Qualquer mudança funcional na aplicação (código de app, telas, endpoints, schema além
  do banco novo vazio + SchemaMigration). O Prompt A NÃO autoriza features.
- Qualquer escrita no ambiente vivo do cliente: nada de docker service update, DDL em
  chatmasterveloz, mudanças em stacks/env/labels dos serviços existentes. Cláusula
  pétrea com EXCEÇÃO ESCOPADA concedida no G1 (2026-07-05, registrada no DIARIO.md):
  você PODE criar/gerir no VPSTodo SOMENTE recursos prefixados hub-/hub_ (projetos
  compose hub-dev/test/homolog, redes/volumes/containers hub_*, banco novo do hub).
  TODO o resto do host (Swarm, stacks envio-massa-homologacao_*/fastapi*/pgadmin/n8n/
  fia/sdr/metanoia, banco chatmasterveloz, .env, Traefik de produção, registry) segue
  intocável para escrita — na dúvida se um recurso é do hub, PARE e pergunte ao operador.
- Copiar credenciais/volumes/dumps de produção. Dados derivados só via gen-seeds
  anonimizado. Não usar tag latest. Não commitar .env reais nem os ZIPs.

TESTES/EVIDÊNCIAS (critério de saída = G2):
- 20/20 da §4.11 com saída de comando por item (produção intocada: itens 1, 2 e 19
  verificados pelo operador — gerar os comandos e pedir a saída).
- Preflight abortando as 6 combinações perigosas (teste negativo).
- docker compose config válido por ambiente; up canônico documentado.
- Backup + restore com contagens iguais; seeds com asserção 0-vazamentos.

CRITÉRIOS DE ACEITE: §17.1 do plano técnico (7 itens).

INTERRUPÇÃO SEGURA: ao detectar QUALQUER risco de alcançar produção (URL, volume, rede,
credencial, DNS), pare imediatamente, não tente rota alternativa e devolva ao operador
com o achado. Em dúvida sobre um recurso ser de produção, trate-o como produção.

FECHAMENTO: atualize docs/plans/hub-frota/DIARIO.md, commit em branch feat/hub-ambiente-isolado,
push e PR draft com as evidências. Merge e G2 são do operador.
```

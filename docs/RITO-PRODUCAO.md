# Rito de produção

> Regra operacional ditada pelo operador em **2026-06-11**. Vale para qualquer pessoa ou
> agente que opere a infraestrutura deste projeto.

## Fato fundamental: "homologação" é produção

O ambiente historicamente chamado de **homologação** é o que os **clientes usam em
produção**. Não existe um ambiente de produção separado.

| | Identificação |
|---|---|
| **Host** | `VPSTodo` |
| **Orquestrador** | Docker Swarm local |
| **Serviços** | `envio-massa-homologacao_backend_homologacao` · `envio-massa-homologacao_frontend_v2_homologacao` |
| **Banco** | `chatmasterveloz` no container `pgadmin_db` |
| **Domínios** | `https://envmassv2.todo-tips.com` (painel) · `https://appmotorista.todo-tips.com` (app motorista) |
| **Registry** | `registry.todo-tips.com/envio-massa-backend` · `registry.todo-tips.com/envio-massa-frontend-v2` |

Consequência: **todo deploy nesse ambiente atinge clientes reais imediatamente**. O nome
"homologação" nos recursos é histórico — trate-o como produção.

## O que exige rito de produção

Qualquer **escrita no ambiente vivo**:

- `docker service update` (deploy de imagem)
- DDL ou qualquer escrita no banco do cliente (`pgadmin_db`)
- alteração de configuração/segredos/labels dos serviços
- qualquer comando que mude estado do host de produção

## O que NÃO exige (segue fluxo normal)

- escrever/alterar código
- abrir, revisar e mergear PR
- buildar e dar `push` de imagem no registry (a imagem só vira produção no `service update`)
- rodar testes/lint localmente, gerar artefatos e documentação

## Os 5 gates

Antes de qualquer mudança no ambiente vivo, nesta ordem:

1. **Autorização explícita** para *aquela* mudança específica. Não vale autorização genérica,
   antiga ou "implícita". Cada deploy/DDL é autorizado individualmente.
2. **Janela combinada** — confirmar com o operador *quando* aplicar.
3. **Plano de rollback à mão** *antes* de aplicar:
   - imagem anterior de cada serviço anotada (`docker service ls` antes da mudança);
   - rollback = `docker service update --with-registry-auth --image <imagem-anterior> <serviço>`;
   - DDL sempre **idempotente e aditiva** (sem `DROP`/`DELETE` destrutivo), e backup leve
     (`pg_dump -t '"Tabela"'`) antes de seed/alteração de dados.
4. **Aplicar** com `docker service update --image` — **nunca** `docker stack deploy` (preserva
   env/labels/segredos do serviço).
5. **Smoke test** após a mudança (HTTP, sem expor segredos) antes de declarar OK. Ex.: rota
   protegida sem auth → 401; gate de regra de negócio → resposta esperada; tela carrega.

**Em qualquer dúvida: parar e devolver ao operador.** Não procurar rota alternativa (SSH,
credenciais, rede) para contornar um gate.

## Papel do agente (Claude Code)

O agente **nunca** decide sozinho aplicar em produção. O agente:

- entrega artefatos: código, PRs, DDLs/SQL, scripts, runbooks;
- executa a escrita no ambiente vivo **somente** com os 5 gates acima satisfeitos —
  começando por autorização explícita e específica do operador;
- analisa a saída que o operador colar e diz se passou ou se precisa de rollback.

Ver também: [`docs/plans/prod-cutover-cadastro-motorista-base.md`](plans/prod-cutover-cadastro-motorista-base.md)
(exemplo de runbook que segue este rito) e [`docs/constitution.md`](constitution.md).

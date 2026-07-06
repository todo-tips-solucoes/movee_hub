# infra/hub — ambiente isolado do Hub de Frota

Infra-as-code criada na **S1** (plano técnico
[`docs/plans/hub-frota/01-plano-tecnico.md`](../../docs/plans/hub-frota/01-plano-tecnico.md)
§4–§6). Operação completa no [`RUNBOOK.md`](RUNBOOK.md).

```text
compose.hub.dev.yml / compose.hub.test.yml / compose.hub.homolog.yml
.env.hub.{dev,test,homolog}.example   # templates sem segredos (reais: /var/lib/hub_secrets)
mocks/            # fastapi-mock, n8n-mock, placeholder (Node stdlib, sem deps)
scripts/          # preflight, gen-secrets, migrate, backup, restore, gen-seeds
migrations/       # série única (0000 SchemaMigration, 0001 role PostgREST)
testes/           # preflight-negativo (6 combinações §4.8), carga-seeds (efêmero)
traefik/dynamic/  # rotas do Traefik do hub (provider file, sem docker.sock)
seeds/out/        # seeds anonimizados gerados (gitignored)
```

Regra de ouro (CLAUDE.md): o ambiente "homologação" legado É produção. Tudo
aqui usa exclusivamente recursos prefixados `hub-`/`hub_` (exceção G1) e o
`preflight.sh` aborta qualquer configuração que alcance produção.

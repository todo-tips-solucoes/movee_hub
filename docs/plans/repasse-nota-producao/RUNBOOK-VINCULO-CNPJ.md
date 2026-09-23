# Runbook — vincular os entregadores sem CNPJ usando a EnvioMassa

Migration `0093_vinculo_cnpj_por_envio_massa.sql`. Preparado em 2026-09-23.

> O ambiente "homologação" **é produção**. Aplicar a migration e, principalmente,
> **executar com `p_aplicar => true`** são escritas no ambiente vivo: exigem os 5 gates.

## O problema, medido

A empresa 6 tem **925 entregadores sem vínculo** com `ContaMotorista`. Sem CNPJ não há
nota, e a F4 só alcançava 330 de 824 motoristas da semana. Não é limitação de código — é
cadastro.

A ponte é o **nome**: a `EnvioMassa` guarda `nome` + `cnpj_prestador` de anos de planilha.
Casando por `hub_normaliza_nome` (a mesma normalização que o vínculo manual já usa):

| Situação | Motoristas |
|---|---|
| **Vinculáveis** (um CNPJ, sem homônimo) | **753** |
| Ambíguos (mesmo nome, CNPJs diferentes) | 92 |
| Sem casamento na EnvioMassa | 80 |

Dos 753: **655** precisam de conta nova, **97** têm conta livre para vincular, **1** esbarra
em conta já vinculada a outro entregador (a função recusa, não estoura).

## As três guardas — e por que elas existem

1. **Só casa com UM CNPJ.** Dois CNPJs para o mesmo nome são pessoas diferentes, e um
   palpite aqui vira **nota emitida no CNPJ errado**.
2. **Só casa nome único entre entregadores.** Hoje há 0 homônimos internos, mas a guarda
   fica: o próximo import pode trazer um.
3. **Não rouba conta de outro entregador.** `Entregador.motorista_id` é UNIQUE parcial.

O controle negativo do teste prova as duas primeiras: removendo a guarda de homônimo, os
dois homônimos do fixture passam a ser vinculados ao mesmo CNPJ.

## Execução

```bash
DB=$(docker ps -q -f name=pgadmin_db)   # UM id; vazio = parar
echo "$DB"
```

### Passo 1 — aplicar a migration (cria a função; não vincula nada)

```bash
cd /var/lib/envioMassa_homologacao
docker exec -i $DB sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d chatmasterveloz' \
  < infra/hub/migrations/0093_vinculo_cnpj_por_envio_massa.sql
docker kill -s SIGUSR1 $(docker ps -q -f name=pgadmin_postgrest)
```

### Passo 2 — SIMULAR (não escreve nada)

A função nasce em `p_aplicar => false`. Rode e **leia o relatório** antes de qualquer coisa.

```bash
docker exec -i $DB sh -c 'psql -U "$POSTGRES_USER" -d chatmasterveloz' <<'SQL'
BEGIN;
SELECT set_config('request.jwt.claims',
  '{"sub":"<ID DE UM USUARIO COM adiantamentos.configurar>","empresa_ativa":"6","escopo":[6]}', true);
SELECT * FROM hub_motorista_vincular_por_envio_massa(6, false);
ROLLBACK;
SQL
```

Esperado (medido em 2026-09-23): `CRIAR_CONTA_E_VINCULAR 655`, `VINCULAR_CONTA_EXISTENTE 97`,
`AMBIGUO 92`, `SEM_CASAMENTO 80`, `CONTA_JA_VINCULADA 1`, `VINCULOS_FEITOS 0`.

**Se os números divergirem muito do esperado, pare** — a base mudou desde a medição e vale
reconferir antes de aplicar.

### Passo 3 — retrato ANTES (guarde a saída)

```bash
docker exec -i $DB sh -c 'psql -U "$POSTGRES_USER" -d chatmasterveloz' <<'SQL'
BEGIN READ ONLY;
SELECT count(*) FILTER (WHERE motorista_id IS NOT NULL) AS vinculados,
       count(*) AS entregadores FROM "Entregador" WHERE id_empresa = 6;
SELECT count(*) AS contas FROM "ContaMotorista";
ROLLBACK;
SQL
```

### Passo 4 — APLICAR

⚠️ Escreve em produção: cria `ContaMotorista` e preenche `Entregador.motorista_id`.

```bash
docker exec -i $DB sh -c 'psql -U "$POSTGRES_USER" -d chatmasterveloz' <<'SQL'
SELECT set_config('request.jwt.claims',
  '{"sub":"<ID DE UM USUARIO COM adiantamentos.configurar>","empresa_ativa":"6","escopo":[6]}', true);
SELECT * FROM hub_motorista_vincular_por_envio_massa(6, true);
SQL
```

É **idempotente**: reexecutar não cria conta duplicada nem vincula de novo (tem teste).

### Passo 5 — conferir

Repita o Passo 3 e compare. `vinculados` deve subir ~752 e `contas` ~655.

E o efeito na F4, que é o motivo de tudo isto:

```bash
docker exec -i $DB sh -c 'psql -U "$POSTGRES_USER" -d chatmasterveloz' <<'SQL'
BEGIN READ ONLY;
SELECT set_config('request.jwt.claims', '{"sub":"1","empresa_ativa":"6","escopo":[6]}', true);
WITH cfg AS (SELECT * FROM hub_adiantamento_config_vigente(6)),
     sem AS (SELECT ((now() AT TIME ZONE c.timezone)::date
             - ((extract(dow FROM (now() AT TIME ZONE c.timezone)::date)::int - c.apuracao_dia_inicio + 7) % 7)) AS ini FROM cfg c),
     rep AS (SELECT r.entregador_id FROM sem, hub_adiantamento_repasse((SELECT ini FROM sem), NULL, false, 0, 10000) r)
SELECT count(*) AS motoristas_da_semana,
       count(*) FILTER (WHERE e.motorista_id IS NOT NULL) AS com_cnpj_no_hub
  FROM rep JOIN "Entregador" e ON e.id = rep.entregador_id;
ROLLBACK;
SQL
```

Antes disto: 824 na semana, 330 com CNPJ.

## Rollback

`infra/hub/testes/sql/0093-rollback.sql` dropa a função. **Os vínculos criados ficam** —
`Entregador.motorista_id` preenchido é dado de cadastro, e as contas criadas podem já ter
recebido conta bancária ou solicitação. Desfazer é decisão à parte, com lista na mão.

## O que NÃO é resolvido aqui

Os **92 ambíguos** e os **80 sem casamento** continuam sem CNPJ. Os ambíguos pedem revisão
humana — ou uma segunda chave, e todos têm `id_externo` da EntreGô, que pode servir.

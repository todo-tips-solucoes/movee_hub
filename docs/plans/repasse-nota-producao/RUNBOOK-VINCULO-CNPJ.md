# Runbook — vincular os entregadores sem CNPJ usando a EnvioMassa

Migration `0093_vinculo_cnpj_por_envio_massa.sql`. Preparado em 2026-09-23,
**EXECUTADO em produção em 2026-09-30** (resultado no fim desta seção).

> O ambiente "homologação" **é produção**. Aplicar a migration e, principalmente,
> **executar com `p_aplicar => true`** são escritas no ambiente vivo: exigem os 5 gates.

## O problema, medido

A empresa 6 tinha **925 entregadores sem vínculo** com `ContaMotorista` (23/09). Sem CNPJ não
há nota, e a F4 só alcançava 330 de 824 motoristas da semana. Não é limitação de código — é
cadastro.

### ⚠️ Remedir antes de agir — o número muda sozinho

Em **30/09**, ao remedir para executar, os 925 tinham virado **213**. Não foi erro de medição:
o **vínculo automático por similaridade** (hub-motorista-360, em produção desde 04/09) já havia
vinculado a maior parte, e segue vinculando todo dia com o import do robô EntreGô
(`motorista.vinculado_automaticamente`: 550 eventos até 30/09).

Consequência prática: o ganho desta execução foi **91 vínculos, não 753**. Remeça a simulação
sempre — agir pelos números do dia anterior é agir sobre uma base que não existe mais.

A ponte é o **nome**: a `EnvioMassa` guarda `nome` + `cnpj_prestador` de anos de planilha.
Casando por `hub_normaliza_nome` (a mesma normalização que o vínculo manual já usa):

| Situação | 23/09 | **30/09 (execução)** |
|---|---|---|
| **Vinculáveis** (um CNPJ, sem homônimo) | **753** | **91** |
| — criar conta e vincular | 655 | 31 |
| — vincular a conta que já existe | 97 | 60 |
| Ambíguos (mesmo nome, CNPJs diferentes) | 92 | 33 |
| Sem casamento na EnvioMassa | 80 | 88 |
| Conta já vinculada a outro (a função recusa) | 1 | 1 |

Em 30/09 os quatro grupos somavam exatamente os 213 sem vínculo — confira essa soma ao
remedir: se não fechar, a leitura está incompleta.

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

Antes disto: 824 na semana, 330 com CNPJ (23/09).

### Resultado da execução de 2026-09-30

Rodado com `~/aplicar-0093-vinculo-cnpj.sh` (preflight, medição, `pg_dump` de `Entregador` e
`ContaMotorista`, simulação, confirmação, aplicação e medição final).

| | Antes | Depois |
|---|---|---|
| Entregadores da empresa 6 sem vínculo | 213 | **122** |
| Motoristas da semana (28/09–) com CNPJ | 715 / 786 (91%) | **754 / 786 (96%)** |
| Sem CNPJ na semana | 71 | **32** |

`CONTAS_CRIADAS: 31` · `VINCULOS_FEITOS: 91`, idêntico ao que a simulação previu. Reexecutar
a simulação depois não traz mais nada a vincular (as duas ações somem do relatório) — a
idempotência se confirma em produção, não só no teste.

Dos 71 sem CNPJ da semana, 39 eram vinculáveis e foram resolvidos; os 32 restantes são 16
ambíguos + 16 sem casamento.

### ⚠️ Dois enganos que custaram tempo na execução

1. **`set_config('request.jwt.claims', …, true)` é LOCAL à transação.** O passo de aplicação
   sem `BEGIN`/`COMMIT` roda em autocommit: o claim morre com o primeiro statement e a função
   aborta com `PERMISSAO_NEGADA` no segundo. Falha fechada (nada escrito), mas parece defeito
   de permissão do usuário — e não é. Envolva a aplicação numa transação, que de quebra dá
   atomicidade.
2. **A função NÃO grava trilha em `Auditoria`.** O comentário da 0093 e a seção de rollback
   diziam que "a trilha em Auditoria diz quais foram" — não é verdade: o corpo da função não
   tem nenhum `INSERT` em `Auditoria`, e as 91 mudanças de 30/09 não aparecem lá. O que
   identifica o que mudou está abaixo, em Rollback.

## Rollback

`infra/hub/testes/sql/0093-rollback.sql` dropa a função. **Os vínculos criados ficam** —
`Entregador.motorista_id` preenchido é dado de cadastro, e as contas criadas podem já ter
recebido conta bancária ou solicitação. Desfazer é decisão à parte, com lista na mão.

**Como saber o que mudou** (a função não grava auditoria — ver o engano 2 acima):

1. **O `pg_dump` de antes** é a via confiável: `~/backup-vinculo-cnpj-<timestamp>.sql`, com
   `Entregador` e `ContaMotorista` inteiras. O script de execução sempre o tira antes.
2. `Entregador.atualizado_em` marca os vinculados na janela da execução.
3. `ContaMotorista.criado_em::date` dá as contas do dia — mas **não separa** as criadas pela
   0093 das criadas por outro caminho: em 30/09 foram 37 no dia, das quais 31 desta execução.
   Sem trilha, essa imprecisão é o preço; use o dump se precisar de exatidão.

## O que NÃO é resolvido aqui

Os **ambíguos** (33 em 30/09) e os **sem casamento** (88) continuam sem CNPJ.

### ⚠️ O `id_externo` da EntreGô NÃO resolve os ambíguos — investigado em 01/10

Este runbook sugeria o `id_externo` como segunda chave. **Não serve**, e a investigação está
aqui para ninguém gastar o tempo de novo:

- A `EnvioMassa` — a única fonte de CNPJ por nome — **não tem** `id_externo` nem CPF. Suas
  colunas de identificação são `nome`, `cnpj_prestador` e `number` (telefone).
- `EnvioMassa.entregador_uuid` existe e seria a ponte natural, mas está **100% vazia**
  (0 de 51.129 linhas da empresa 6). Coluna preparada e nunca populada.
- O que a EntreGô traz de aproveitável é `dados_entrego_json -> dadosPessoais.telefone`
  (e `cpf`, que a `EnvioMassa` não tem para cruzar). O telefone desempata **3 dos 33**: em 11
  casos o MESMO telefone aparece em CNPJs diferentes.

### O que a investigação achou de útil: a maioria não é homônimo

Cruzando os períodos (`dt_inicial`/`dt_final`) dos CNPJs candidatos de cada nome:

| Classificação | Ambíguos | Leitura |
|---|---|---|
| `TROCOU_DE_CNPJ_PERIODOS_SEQUENCIAIS` | **14** | mesma pessoa, trocou de MEI — períodos não se sobrepõem (e o telefone confere) |
| `HOMONIMO_PERIODOS_SOBREPOSTOS` | **8** | duas pessoas faturando ao mesmo tempo — são exatamente as 8 com telefones diferentes |
| `INDETERMINADO_SEM_DATA` | **11** | sem data para comparar |

Duas medições independentes (telefone e sobreposição temporal) apontam os **mesmos 8**
homônimos reais — é o grupo que nenhuma regra deve tocar.

### Decisão de 01/10: resolver na tela, não por migration

Automatizar renderia **13 dos 33** (os sequenciais com CNPJ mais recente sem empate de data) e
criaria uma heurística de recência decidindo em qual CNPJ a nota sai. Para 33 casos, o
caminho é o **vínculo manual que já existe** (`POST /motoristas/:id/vinculo`, diálogo na tela de
Motoristas), com um relatório que torna cada decisão rápida.

**Relatório** (gerado em 01/10, 79 linhas = 33 entregadores × CNPJs candidatos): por linha traz
nome, `id_externo`, CNPJ candidato, período, nº de linhas na EnvioMassa, telefone dos dois lados,
a marca `TELEFONE CONFERE` e, nos sequenciais, qual é o `MAIS RECENTE — candidato`. Tem PII:
fica em `~/ambiguos-vinculo-cnpj-<timestamp>.csv`, **fora do git**, e no chat só contagens.
Priorização: 16 dos 33 produziram na semana corrente — a coluna `produziu_nesta_semana` ordena.

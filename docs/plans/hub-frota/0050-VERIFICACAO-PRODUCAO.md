# Migration 0050 — o que conferir ANTES de aplicar em produção

A 0050 muda o `tempo disponível` de "% do tempo escalado, média ponderada por
linha" para "% do período, praças somadas". As tabelas do hub em produção vivem
DENTRO do `chatmasterveloz` — logo, aplicar esta migration lá é **rito integral
dos 5 gates**, não a exceção `hub-*`.

Tudo abaixo é para o OPERADOR executar; a sessão analisa a saída colada.

## 1. Pré-requisito que decide se a métrica funciona (rodar ANTES)

A conta nova lê `tempo_disponivel` (o absoluto online). Linha sem esse valor sai
das duas somas — vira `null` na tela, nunca `0`. O pipeline de importação sempre
gravou a coluna, mas linhas criadas por seed/carga manual podem não ter.

```sql
SELECT count(*)                                                   AS linhas,
       count(*) FILTER (WHERE tempo_disponivel IS NULL)            AS sem_online,
       count(*) FILTER (WHERE duracao IS NULL)                     AS sem_duracao,
       min(data_periodo), max(data_periodo)
FROM "PerformanceTurno";
```

- `sem_online = 0` → a métrica cobre 100% do histórico.
- `sem_online > 0` → aquelas linhas somem do indicador (e só delas). Colar a
  saída antes de decidir.

## 2. Custo da aplicação (a 0050 é DDL bloqueante)

`ADD COLUMN … GENERATED … STORED` **reescreve a tabela** sob ACCESS EXCLUSIVE, e
o `CREATE MATERIALIZED VIEW` a varre inteira. Dimensionar antes:

```sql
SELECT count(*) AS linhas, pg_size_pretty(pg_total_relation_size('"PerformanceTurno"')) AS tamanho
FROM "PerformanceTurno";
```

Aplicar **fora da janela de importação** (é o único caminho de escrita nesses
fatos). Rollback: a migration é aditiva na tabela (`DROP COLUMN
tempo_disponivel_periodo_pct` desfaz) e a MV/RPCs voltam reaplicando o corpo da
0031.

## 3. Prova de que a conta ficou certa (rodar DEPOIS)

O número da tela tem que bater com esta consulta — a mesma álgebra, escrita à
mão fora da MV:

```sql
WITH por_turno AS (
    SELECT entregador_id, data_periodo, periodo,
           LEAST(SUM(EXTRACT(EPOCH FROM tempo_disponivel)),
                 MAX(EXTRACT(EPOCH FROM duracao)))  AS online,
           MAX(EXTRACT(EPOCH FROM duracao))         AS periodo_seg
    FROM "PerformanceTurno"
    WHERE id_empresa = :empresa
      AND data_periodo BETWEEN :de AND :ate
      AND tempo_disponivel IS NOT NULL AND duracao IS NOT NULL
    GROUP BY 1,2,3
)
SELECT round((SUM(online) / NULLIF(SUM(periodo_seg),0) * 100)::numeric, 2) AS tempo_disponivel_medio
FROM por_turno;
```

E o contraste com a fórmula ANTIGA, para medir o tamanho da correção naquele
tenant (é o número que vai mudar na cara do cliente):

```sql
SELECT round((SUM(tempo_disponivel_pct * EXTRACT(EPOCH FROM duracao))
              / NULLIF(SUM(EXTRACT(EPOCH FROM duracao)),0))::numeric, 2) AS formula_antiga
FROM "PerformanceTurno"
WHERE id_empresa = :empresa AND data_periodo BETWEEN :de AND :ate
  AND tempo_disponivel_pct IS NOT NULL;
```

## 4. Quantos entregadores trocam de lado nas metas

A tela de metas (0048/0049) marca "abaixo da meta" com este indicador. No CSV
real medido, 7–8% dos entregadores cruzavam a linha de uma meta de 60%/70%.
Para saber quantos são neste tenant, antes de alguém cobrar alguém:

```sql
WITH por_entregador AS (
    SELECT entregador_id,
           SUM(LEAST(online, periodo_seg)) / NULLIF(SUM(periodo_seg),0) * 100 AS novo,
           SUM(pct_x_dur) / NULLIF(SUM(dur),0)                                AS antigo
    FROM (
        SELECT entregador_id, data_periodo, periodo,
               SUM(EXTRACT(EPOCH FROM tempo_disponivel))            AS online,
               MAX(EXTRACT(EPOCH FROM duracao))                     AS periodo_seg,
               SUM(tempo_disponivel_pct * EXTRACT(EPOCH FROM duracao)) AS pct_x_dur,
               SUM(EXTRACT(EPOCH FROM duracao))                     AS dur
        FROM "PerformanceTurno"
        WHERE id_empresa = :empresa AND data_periodo BETWEEN :de AND :ate
          AND tempo_disponivel IS NOT NULL AND duracao IS NOT NULL
        GROUP BY 1,2,3
    ) t
    GROUP BY entregador_id
)
SELECT count(*) FILTER (WHERE (novo >= :meta) <> (antigo >= :meta)) AS trocam_de_lado,
       count(*)                                                     AS total
FROM por_entregador;
```

## 5. O que a 0050 NÃO corrige

A origem emite **linhas gêmeas** (mesmos números, diferindo só por `sub_praca`,
uma delas vazia) — 3 em 2.720 no CSV medido. O dedupe por `hash_linha` não as
pega porque a sub-praça entra no hash. O tempo tem teto por turno e fica
correto; **corridas e taxas dessas linhas ainda contam em dobro**. Para achá-las:

```sql
SELECT entregador_id, data_periodo, periodo, count(*) AS linhas_iguais
FROM "PerformanceTurno"
WHERE id_empresa = :empresa
GROUP BY entregador_id, data_periodo, periodo, tempo_disponivel, corridas_ofertadas,
         corridas_aceitas, corridas_completadas, taxas_centavos
HAVING count(*) > 1;
```

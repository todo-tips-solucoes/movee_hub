# Entregadores sem CNPJ — por que, e o que resolve cada grupo

Medido em 2026-10-05 na empresa 6 (grupo Movee). O ponto de partida foi: **1563
entregadores, 170 sem CNPJ**. Só o CNPJ permite emitir nota e entrar no CSV da
Transfeera, então sem ele o repasse trava ou vira trabalho manual.

## O recorte que importa

Dos 170 sem CNPJ, **97 tiveram movimento nos últimos 30 dias**, somando
**R$ 115.240,16** de R$ 3.465.416,99 (3,3% do faturamento do período). Os outros
73 não movimentaram — podem estar inativos e não valem esforço agora.

O valor é concentrado: **os 30 maiores somam R$ 104.344 (90,5%)**, e os 10
maiores sozinhos somam R$ 77.509 (67%).

## Por que cada um não tem CNPJ

A migration 0093 casa `Entregador` contra `EnvioMassa` por nome normalizado. A
medição revelou uma **segunda fonte que ela nunca olhou**: a tabela `Motorista`,
o pré-cadastro que alimenta o login e a validação de nota do app do motorista.

| Grupo | Entregadores (com movimento) | Valor 30d | Quem resolve |
|---|---|---|---|
| CNPJ **único** na base `Motorista` | 20 (15) | R$ 9.091 | **código** — migration 0102 |
| **2 CNPJs** da mesma pessoa | 22 (17) | R$ 67.438 | **decisão humana** |
| Sem casamento em nenhuma fonte | 126 (63) | R$ 34.782 | **cadastro novo** |
| Homônimo dentro da própria base | 2 (2) | R$ 3.929 | não casar (risco) |

## Grupo 1 — a migration 0102 resolve

Casam por nome normalizado com exatamente 1 CNPJ na base `Motorista`, sem
homônimo interno. Mesmas guardas da 0093: simulação por padrão, idempotente,
recusa ambíguo e homônimo. Execução: ver o runbook ao lado.

## Grupo 2 — os 22 ambíguos: por que NÃO automatizar

Todos têm **exatamente 2 CNPJs**, de **raízes diferentes** (empresas distintas),
e em **21 dos 22 os dois CNPJs têm histórico de uso**. O padrão é de quem trocou
de CNPJ, não de homônimos — mas escolher o errado emite nota fiscal no CNPJ
errado, com consequência tributária. Nenhuma heurística testada desempatou:

- `Motorista.ativo`: os dois ativos em **todos** os 22;
- último uso na `EnvioMassa`: os dois com uso em 21 dos 22;
- em apenas **5** um CNPJ domina (≥5× o uso do outro, ou o outro sem uso).

Planilha de decisão gerada em `~/ambiguos-cnpj-decisao-<data>.csv` (fora do git —
tem dado pessoal): nome, valor 30d, os dois CNPJs, último uso e nº de movimentos
de cada. **R$ 67.438 esperam uma escolha humana**, e é o maior bloco.

## Grupo 3 — os 63 sem casamento

O CNPJ não existe em nenhuma fonte do sistema. Não há o que automatizar: alguém
precisa obter o documento com o entregador. Lista priorizada por valor em
`~/entregadores-sem-cnpj-<data>.csv`.

## Consultas usadas

Todas em `infra/hub/testes/sql/` e no histórico do PR. A que abre o diagnóstico:

```sql
SELECT count(*) FILTER (WHERE e.motorista_id IS NULL) AS sem_cnpj,
       sum(f.valor) FILTER (WHERE e.motorista_id IS NULL) AS valor_bloqueado
  FROM "FaturamentoLancamento" f JOIN "Entregador" e ON e.id = f.entregador_id
 WHERE f.data_referencia >= CURRENT_DATE - 30 AND e.id_empresa = 6;
```

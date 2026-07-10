# Cenários 1-10 — hub-importacoes (FASE 7, hub-homolog persistente)

Executado em: 2026-07-10T02:33:54.712Z
Total de asserts falhos: 0

## Contadores por importação testada

| Cenário | status final | total | válidas | inválidas |
|---|---|---|---|---|
| 1 — happy path faturamento | completed | 20 | 20 | 0 |
| 2b — dedupe de linha | completed | 10 | 10 | 0 |
| 3 — performance dialeto | completed_with_errors | 6 | 5 | 1 |
| 4 — erros + LGPD | completed_with_errors | 10 | 8 | 2 |

## Idempotência (Cenário 2)
- Reenvio do MESMO arquivo -> status 409, importacaoOriginalId=55 (esperado = id do Cenário 1: 55)
- Dedupe de linha: arquivo com 5 linhas repetidas + 5 novas -> contadores {"total":10,"validas":10,"invalidas":0} (validas=10 esperado, dedupe silencioso; 0 fatos NOVOS confirmados via contagem direta na base durante a execução)

## Falha estrutural (Cenário 5)
- 60% de linhas inválidas -> status=failed, erro_resumo="6/10 linhas inválidas (60% > limiar de 50%) — importação recusada, nenhuma linha persistida"

## Gate de export (Cenário 7)
- papel leitura (sem importacoes.exportar) -> GET /original: 403 PERMISSAO_NEGADA
- papel admin_entidade (com importacoes.exportar) -> GET /original: 200

## Isolamento multi-tenant / RLS (Cenário 8)
- empresa B lendo importação da empresa A -> 404 (esperado 404)
- listagem da empresa B não contém a importação da empresa A: true

## Concorrência com lock advisório (Cenário 9)
- 2 uploads quase simultâneos (mesma empresa+tipo=performance) -> status HTTP 201/201 (nenhum rejeitado)
- ambos atingiram estado terminal: completed / completed

## LGPD — anti-CSV-injection e mascaramento (Cenário 4)
- célula '=1+1' recebeu prefixo de escape no CSV exportado: true
- nenhum UUID bruto exposto no CSV de erros: true
- shape JSON dos erros nunca expõe campo bruto (só valorMascarado): true

## Reprocessar / Cancelar (Cenário 6)
- reprocessar failed -> 202 (body.status=pending)
- reprocessar completed -> 409 CONFLITO
- reprocessar sem permissão (papel leitura) -> 403
- cancelar completed -> 409 CONFLITO

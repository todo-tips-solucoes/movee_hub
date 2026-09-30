# Briefing — executar o vínculo de CNPJ dos entregadores (0093)

> ✅ **EXECUTADO em 2026-09-30.** 91 vínculos (31 contas criadas), entregadores sem vínculo
> 213 → 122, semana corrente 91% → 96% de cobertura de CNPJ. Números, os dois enganos da
> execução e como saber o que mudou: [`RUNBOOK-VINCULO-CNPJ.md`](RUNBOOK-VINCULO-CNPJ.md).
> O que sobrou (33 ambíguos, 88 sem casamento) segue em aberto — ver §3 item 6 e §4.

Prompt para sessão limpa, aberta **em paralelo** a outra frente (2026-09-29).
**Leia o `CLAUDE.md` antes de qualquer coisa**: o ambiente "homologação" É
produção, o agente **nunca** escreve no banco de produção (o operador executa),
o ciclo git é cláusula pétrea e a autorização é **por etapa**. Repositório
público — nenhum nome, CNPJ ou telefone real em código, teste, log ou documento.

---

## 1. O problema, medido

Motorista sem `Entregador.motorista_id` não tem CNPJ no hub. Sem CNPJ:

- o "Gerar notas" do repasse **recusa** o motorista (`SEM_CNPJ`) — não há nota;
- a coluna `CNPJ do prestador` do CSV do repasse sai **vazia**, e a conferência
  com a planilha do financeiro (pendente, ver §6) não casa por CNPJ.

| Medição | Fonte | Números |
|---|---|---|
| 2026-09-23 | runbook §"O problema" | 925 entregadores da empresa 6 sem vínculo; a F4 alcançava 330 de 824 da semana |
| 2026-09-28 | CSV do repasse da semana 21–27/09, exportado em produção | **1020 motoristas, 101 sem CNPJ** |

A diferença entre 925 e 101 é de universo (todos os entregadores × os que
produziram na semana). **Remedir antes de agir** — a base muda todo dia com o
import do robô EntreGô.

## 2. O que já existe — não refazer

- **Migration `0093_vinculo_cnpj_por_envio_massa.sql`** (PR #216, mergeada):
  função `hub_motorista_vincular_por_envio_massa(p_empresa, p_aplicar)`. Casa
  `Entregador.nome` com `EnvioMassa.nome` por `hub_normaliza_nome` e herda o
  `cnpj_prestador`. **Nasce em simulação** (`p_aplicar => false`).
- **Runbook:** [`RUNBOOK-VINCULO-CNPJ.md`](RUNBOOK-VINCULO-CNPJ.md) — passos,
  as três guardas (só um CNPJ por nome; nome único entre entregadores; não
  rouba conta já vinculada) e por que cada uma existe.
- **Teste:** `infra/hub/testes/hub-vinculo-cnpj.sh`, com controle negativo.
- **Rollback:** `infra/hub/testes/sql/0093-rollback.sql` — dropa a função; os
  vínculos criados **ficam** (são cadastro; desfazer é decisão à parte).

Números da simulação de 2026-09-23: 655 contas a criar, 97 contas livres a
vincular, 92 ambíguos, 80 sem casamento, 1 conta já vinculada a outro.

## 3. O que está em aberto (é o trabalho desta frente)

1. **A função está criada em produção?** A `SchemaMigration` de produção ficou
   parada em 0089 (migrations aplicadas arquivo a arquivo desde então); no
   deploy de 2026-09-27 os objetos de 0090–0096 foram conferidos presentes.
   **Confirmar com consulta read-only** (`pg_proc`), não por memória.
2. **A função ainda vale sobre o schema de hoje?** Depois dela entraram
   0094–0100, entre elas **0095 (senhas no hub)** e **0096 (e-mail no hub, com
   triggers em `ContaMotorista`)**. A 0093 insere `ContaMotorista (cnpj_prestador,
   nome, telefone)`. Provar rodando `hub-vinculo-cnpj.sh` na `main` atual — o
   driver sobe o schema inteiro até a última migration.
3. **Remedir a simulação em produção** (o operador roda; o agente entrega o SQL
   pronto em `~/`, nunca caminho do scratchpad). Comparar com os números de
   23/09; se divergirem muito, entender por quê antes de aplicar.
4. **Atualizar o runbook** com os números novos e o que mudou.
5. **Aplicar** (`p_aplicar => true`) — escrita em produção: 5 gates, backup
   (`pg_dump -t '"Entregador"' -t '"ContaMotorista"'`) antes, execução do
   **operador**.
6. Depois: remedir a semana (quantos dos motoristas da semana ficaram com CNPJ).

## 4. Armadilhas conhecidas

- ⚠️ **Dois sistemas de senha**: o login do app usa a tabela `Motorista`; o hub
  usa `ContaMotorista` (incidente de 2026-09-23). Conta criada pela 0093 dá CNPJ
  para nota e CSV — **não** dá acesso ao app. Não prometer isso ao operador.
- ⚠️ A função lê permissão e escopo do **JWT** (`request.jwt.claims`): por `psql`
  cru ela devolve `PERMISSAO_NEGADA`. O runbook já traz o `set_config`; conferir
  que o usuário escolhido ainda tem a permissão exigida depois da 0097.
- ⚠️ **Nota no CNPJ errado é o pior resultado possível.** As guardas existem por
  isso. Os 92 ambíguos **não** se resolvem afrouxando a guarda; se o operador
  quiser atacá-los, a segunda chave candidata é `Entregador.id_externo` (EntreGô)
  — decisão dele, frente à parte.
- ⚠️ `EnvioMassa` é suja (ex.: 9.030 linhas com `number` = "55"): a 0093 já
  filtra telefone por `^[0-9]{12,13}$`.
- Relatório de simulação tem nomes e CNPJs reais: fica **fora do git** (em `~/`),
  e no chat só contagens.

## 5. Restrições de convivência com a outra sessão

- Outra sessão pode estar ativa no mesmo repositório. `git add` **só por
  caminho explícito** e **nunca** reverter arquivo que não é seu. Se precisar
  tocar código além de `docs/plans/repasse-nota-producao/` e do driver, use um
  worktree (`.claude/worktrees/<nome>`).
- `df -h /` ≥ 20 GB antes de qualquer build (em 2026-09-29 estava em 22 GB).
  O driver cria imagem sem tag: apagar **só as que ele criou**, por ID.

## 6. Relação com a conferência da planilha

A conferência CSV × planilha da semana 21–27/09 espera o financeiro da Movee.
Se o vínculo for aplicado antes, **reexportar o CSV** — a coluna de CNPJ virá
mais cheia e a conferência casa mais linhas. O primeiro "Fechar apuração"
continua esperando essa conferência.

## 7. Entregáveis

1. Consultas read-only (existência da função + simulação) em `~/`, para o operador.
2. Resultado do `hub-vinculo-cnpj.sh` na `main` atual, com números.
3. Runbook atualizado (PR próprio, autorização por etapa).
4. Após a execução do operador: medição de antes/depois na semana corrente.

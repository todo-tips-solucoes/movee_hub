# Runbook — go-live do adiantamento (destravar o que está em produção)

> **Para o operador.** O agente não executa nada disto (rito de produção, `CLAUDE.md`).
> Tudo foi **medido no hub-homolog em 2026-09-21**, não suposto. Repositório público:
> nenhum dado pessoal real aqui — ids e e-mails você lê do diagnóstico, no seu terminal.

## O que este runbook corrige no briefing anterior

O `BRIEFING-DIVIDA-RESTANTE.md` §4 listava 5 passos. Medindo, três deles estavam
**errados ou já feitos** — seguir a lista como estava levaria a erro ou a trabalho à toa:

| Passo do briefing | O que é de fato |
|---|---|
| 1. "Ligar o módulo" | **Provavelmente já está ligado.** A migration 0070 faz `ModuloEntidade … ativo=true` para a empresa 6. Mas usa `ON CONFLICT DO NOTHING` — o padrão que no robô EntreGô fez nada ser aplicado — então **confirme com o diagnóstico** antes de agir. |
| 3. "Rodar `SELECT hub_entregador_documento_carregar_do_enriquecimento();`" | **Não funciona por `psql`.** Devolve `ERROR: PERMISSAO_NEGADA`: a função lê permissão e escopo das claims do JWT, e `psql` não tem JWT. Use o `sql/02-carga-documentos.sql`, que simula a sessão de um usuário que tem a permissão. |
| 4. "Definir os valores de configuração" | **Tudo pela tela**, nenhum SQL. Inclusive `repasse visível no app`, que é o que faz o repasse aparecer para o motorista. |

E o que de fato trava hoje, pelo código (`0067`, `0071`, `0083`):

- **Adiantamento** recusa enquanto `fonte_producao` for nula → o motorista vê "indisponível".
- **Repasse no app** fica escondido enquanto `repasse_visivel_app = false` **ou**
  `apuracao_dia_inicio` for nulo.

A migration deixou esses campos nulos **de propósito**: a regra `FR-025` exige que o
financeiro os preencha antes de o módulo operar.

---

## Onde rodar

```bash
cd /var/lib/envioMassa_homologacao/docs/plans/adiantamento-motorista/sql
DB=$(docker ps -q -f name=pgadmin_db)     # task do Swarm — o sufixo muda a cada restart
echo "$DB"                                 # tem que ser UM id; vazio = parar
```

⚠️ **Não use `docker exec pgadmin_db`** literal: o container real é
`pgadmin_db.1.<sufixo>`, e o nome curto dá `No such container`. (Os runbooks do robô em
`docs/plans/robo-entrego/` usam a forma curta — ela não funciona como está escrita.)

---

## Passo 0 — Diagnóstico (antes de tudo)

Somente leitura (transação `READ ONLY` + `ROLLBACK`). Rode agora, e de novo depois de
cada passo para ver o que mudou.

```bash
docker exec -i $DB sh -c 'psql -U "$POSTGRES_USER" -d chatmasterveloz -v id_empresa=6' \
  < 01-diagnostico.sql
```

O bloco **VEREDITO** no fim diz, item a item, o que está `OK` e o que `FALTA`. No
hub-homolog, para a empresa 6, ele deu:

```
 módulo ligado                   | OK
 usuário no papel financeiro     | FALTA — runbook passo 2
 adiantamento: fonte_producao    | FALTA — o motorista recebe indisponível (runbook passo 4)
 repasse no app: visível         | FALTA — runbook passo 4
 repasse no app: dia da apuração | FALTA — runbook passo 4 (produção usa 1 = segunda)
```

Produção pode divergir — o briefing registra `apuracao_dia_inicio = 1` "medido no
deploy", e aqui está nulo. **Acredite no diagnóstico de produção, não neste exemplo.**

---

## Passo 1 — Módulo (só se o diagnóstico disser FALTA)

Se o item 1 der `OK`, **pule**. Se der `FALTA`:

```bash
docker exec $DB sh -c 'psql -U "$POSTGRES_USER" -d chatmasterveloz -v ON_ERROR_STOP=1 -c "
INSERT INTO \"ModuloEntidade\" (modulo_id, empresa_id, ativo)
SELECT m.id, 6, true FROM \"Modulo\" m WHERE m.codigo = '"'"'adiantamentos'"'"'
ON CONFLICT (modulo_id, empresa_id) DO UPDATE SET ativo = true"'
```

Saída esperada: **`INSERT 0 1`**. Se sair `INSERT 0 0`, nada foi gravado — pare.

`DO UPDATE`, **não** `DO NOTHING`. Medido no hub-homolog com a linha existente em
`ativo=false`: `DO UPDATE` religou (`t`); `DO NOTHING` devolveu `INSERT 0 0`, deixou
**desligado** e **não deu erro nenhum** — a mesma falha silenciosa do incidente do robô.

Sem heredoc de propósito: heredoc colado pelo `!` do Claude Code colapsa em uma linha.

Rollback: o mesmo comando com `ativo = false` nos dois lugares.

---

## Passo 2 — Usuário do financeiro (pela tela)

Decisão já tomada: **vai existir uma pessoa do financeiro que não é admin.**

1. Hub → **Usuários** → criar o usuário.
2. Vincular à empresa 6 com o papel **`financeiro`**.

⚠️ **Um usuário = um papel por entidade** (`UsuarioEntidade` tem
`UNIQUE (usuario_id, empresa_id)`). Não dá para somar papéis. E **não troque o papel de um
admin para `financeiro`**: o `admin_entidade` já tem as mesmas 10 permissões
`adiantamentos.*`, então a troca não dá acesso novo — só tira o que ele já tinha.

Conferir: rode o diagnóstico; o item 2 vira `OK` e a seção 3 mostra o `usuario_id`
**— anote, o passo 3 pede.**

Rollback: desativar o vínculo pela mesma tela.

---

## Passo 3 — Carga do CPF dos entregadores

Depende do passo 2 (precisa de um usuário com `adiantamentos.contas_revisar`).

**Backup antes** (regra do rito para escrita de dados):

```bash
docker exec $DB sh -c 'pg_dump -U "$POSTGRES_USER" -d chatmasterveloz -t "\"EntregadorDocumento\""' \
  > /var/lib/backup-entregador-documento-pre-golive-$(date +%Y%m%d).sql
```

**Simular** (padrão — termina em `ROLLBACK`, não grava nada):

```bash
docker exec -i $DB sh -c 'psql -U "$POSTGRES_USER" -d chatmasterveloz -v usuario_id=<ID> -v id_empresa=6' \
  < 02-carga-documentos.sql
```

Conferir `gravados_agora` contra `a_carga_vai_gravar` do diagnóstico — têm que bater.
Se baterem, **aplicar**:

```bash
docker exec -i $DB sh -c 'psql -U "$POSTGRES_USER" -d chatmasterveloz -v usuario_id=<ID> -v id_empresa=6 -v aplicar=true' \
  < 02-carga-documentos.sql
```

⚠️ **Se `gravados_agora` for bem menor que o total de enriquecidos, não é defeito.** Desde
a 0085 um trigger (`entregador_documento_enriquecimento`) grava o documento sozinho a cada
enriquecimento, e o robô enriquece a cada 5 min. A função é só o **backfill** de quem foi
enriquecido antes da 0085 e não foi re-enriquecido desde então — trigger não é retroativo.

Idempotente: rodar de novo grava 0. Rollback: restaurar o `pg_dump` acima.

<details><summary>Como isto foi provado</summary>

No hub-homolog, dentro de `BEGIN … ROLLBACK`: dois entregadores sintéticos (CPF
pontuado válido e um inválido `123`), documento do trigger apagado para reproduzir o
estado pré-0085. Resultado: 1ª chamada **gravou 1** (só o válido, normalizado para 11
dígitos), 2ª chamada **gravou 0**, o inválido foi ignorado. Sem as claims, a mesma
chamada deu `PERMISSAO_NEGADA`; com usuário inexistente, deu a mensagem do script que
aponta o passo 2.

</details>

---

## Passo 4 — Configuração (pela tela)

Hub → **Adiantamentos → Configurações**. Precisa de `adiantamentos.configurar` (o
financeiro do passo 2 ou um admin).

| Campo | O que pôr | Por quê |
|---|---|---|
| **Fonte da produção** | **decisão do financeiro** — a tela mostra as 3 opções com o aviso medido de cada uma (PLANO §2.4) | sem ela o adiantamento fica indisponível |
| **Categorias da produção** | obrigatórias se a fonte for `financeiro_*`; a tela lista as reais dos últimos 90 dias | o banco recusa fonte financeira sem categoria |
| **Dia de início da apuração** | **segunda-feira** (`1`) | a gravação da apuração recusa janela que comece noutro dia (`PERIODO_DESALINHADO`) |
| **Repasse visível no app** | **ligado** | é o que faz o repasse aparecer para o motorista |

A configuração é **versionada**: salvar cria uma versão nova, a anterior fica no
histórico. Rollback = salvar outra versão com os valores anteriores (nada se apaga).

Conferir: diagnóstico com os 5 itens `OK`.

---

## Passo 5 — Transfeera e contas bancárias

**Nenhum dos dois paga ninguém** se feito como abaixo.

1. **Upload na Transfeera sem confirmar pagamento** — gerar o arquivo pelo hub, subir no
   portal, **parar antes de confirmar**. Prova o formato de ponta a ponta.
2. **Carga das contas**, `--simular` primeiro (é o padrão do script):

   ```bash
   cd /var/lib/envioMassa_homologacao/app_homologacao/backend
   node scripts/carga-contas-bancarias.js --arquivo <planilha.xlsx> --simular --saida /tmp/relatorio-contas.json --id-empresa 6
   ```

   Ler o relatório. Só então `--gravar` (exige `POSTGREST_URL` e `PGRST_JWT_SECRET` no
   ambiente). As contas entram como **`PENDENTE`** — nada é aprovado automaticamente; a
   revisão/aprovação é humana, na tela. Idempotente.

   A **planilha** tem nome, CPF/CNPJ e conta de gente real: **fica fora do git**
   (`.gitignore:13`) e fora de scratchpad. O **relatório** (`--saida`) não tem: grava só
   contadores e o `idExterno` (uuid) de cada linha recusada — pode ficar em `/tmp`.

---

## Passo 6 — Piloto com 1 motorista (recomendado antes de abrir para todos)

O PLANO (F12) prevê piloto com um motorista antes do go-live amplo: uma solicitação de
adiantamento de ponta a ponta, conferindo o valor calculado, o lote gerado e o que o
motorista vê no app. O botão **"fechar apuração"** já está liberado.

Fora do código, também do F12: ajustar o Typebot para a opção 2 apontar para o app.

---

## Checklist

- [ ] 0 — diagnóstico rodado, veredito lido
- [ ] 1 — módulo `OK` (ou ligado com `DO UPDATE`)
- [ ] 2 — usuário financeiro criado e vinculado; `usuario_id` anotado
- [ ] 3 — `pg_dump` feito; simulação conferida; aplicado
- [ ] 4 — fonte + categorias + apuração (segunda) + repasse visível, pela tela
- [ ] 5 — Transfeera testada **sem confirmar**; contas simuladas, depois gravadas
- [ ] 6 — piloto com 1 motorista
- [ ] diagnóstico final: 5 × `OK`

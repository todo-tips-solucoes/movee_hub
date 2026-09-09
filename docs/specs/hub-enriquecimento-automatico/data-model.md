# Data Model: Enriquecimento automático de entregadores novos

Feature `hub-enriquecimento-automatico`. Escopo: **uma** tabela existente
(`"Entregador"`) com **duas** colunas novas, **uma** tabela nova de
habilitação por empresa (`"EnriquecimentoAutomatico"`, exigida por FR-010/
FR-012/FR-013 — mitigações H2/M2/H1 do `block-003`), **um** índice parcial e
**um** gatilho novo (`BEFORE INSERT OR UPDATE … FOR EACH ROW`).

> **Mudança em relação à primeira versão deste artefato** (onda-004): o
> gatilho continua `BEFORE … FOR EACH ROW` (dec-017 intacta), mas passa a
> cobrir **dois eventos** — `INSERT` **e** `UPDATE` — e ganha duas condições
> novas (habilitação da empresa e teto). O evento de `UPDATE` é o que faz o
> excedente do teto "entrar na importação seguinte" (FR-010): naquela
> importação as linhas excedentes caem no ramo `ON CONFLICT DO UPDATE`.
>
> Uma hipótese foi **testada e refutada** antes de virar desenho: a de que um
> gatilho de linha não conseguiria aplicar o teto, por não enxergar as linhas
> irmãs do mesmo `INSERT`. Ele enxerga — cada `SELECT` dentro de uma função
> PL/pgSQL passa pelo SPI, que incrementa o *command counter* e torna
> visíveis os efeitos já produzidos pelo comando corrente. Medido em
> `postgres:13.23` (§Evidência empírica, abaixo). Por isso **não** há
> gatilho de statement, nem *transition table*, nem guarda de recursão neste
> desenho: eles seriam complexidade comprada com uma premissa falsa.

---

## Entity: `Entregador` (existente — migration `0010`)

Só as colunas relevantes a esta feature. As demais (`motorista_id`, `ativo`,
`nome_editado_manualmente`, …) ficam inalteradas.

| Field | Type | Constraints | Origem | Notas |
|-------|------|-------------|--------|-------|
| `id` | `serial` | PK | `0010:15` | — |
| `id_empresa` | `int` | NOT NULL, parte da UNIQUE | `0010:16` | Escopo multi-tenant; RLS em `0015` |
| `id_externo` | `uuid` | NOT NULL, parte da UNIQUE | `0010:17` | Identificador do entregador na EntreGô |
| `criado_em` | `timestamptz` | NOT NULL DEFAULT `now()` | `0010:21` | Prova de que `DEFAULT` dispara no ramo INSERT do upsert |
| `dados_entrego_json` | `jsonb` | NULL | `0057` | PII do enriquecimento; leitura sob RBAC `motoristas.dados_sensiveis` |
| `dados_entrego_enriquecidos_em` | `timestamptz` | NULL | `0057` | NULL = nunca enriquecido com sucesso |
| `dados_entrego_solicitado_em` | `timestamptz` | NULL | `0057` | **É a fila**: `NOT NULL` = pendente |
| **`dados_entrego_desfecho`** | **`text`** | **NOT NULL DEFAULT `'nunca-tentado'`, CHECK ∈ 4 valores** | **`0060` (nova)** | **Desfecho da última tentativa (FR-005/FR-006)** |
| **`dados_entrego_solicitado_manual`** | **`boolean`** | **NOT NULL DEFAULT `false`** | **`0060` (nova)** | **Origem do pedido pendente: `true` = clique do operador, `false` = enfileiramento automático. É o discriminador de prioridade de FR-011. Só tem significado enquanto `dados_entrego_solicitado_em IS NOT NULL`; é zerado no mesmo PATCH que limpa o pedido** |

### Constraint da coluna nova

```
CHECK (dados_entrego_desfecho IN
       ('nunca-tentado', 'pessoa-nao-encontrada', 'outra-falha', 'sucesso'))
```

Nome sugerido da constraint: `entregador_dados_entrego_desfecho_check`.

`UNIQUE (id_empresa, id_externo)` (`0010:23`) permanece a chave natural — é ela
que faz o `ON CONFLICT` do upsert resolver, e é ela que garante FR-003 (um
`id_externo` repetido no lote nunca vira duas linhas).

### Permissões

Nenhum GRANT novo **em `"Entregador"`**: `0010:31` concede `SELECT, INSERT,
UPDATE` em **nível de tabela** ao role `authenticated`, o que alcança colunas
novas automaticamente. O único GRANT novo da `0060` é `SELECT` na tabela
`"EnriquecimentoAutomatico"` (ver adiante) — deliberadamente **sem** escrita.
A RLS de `0015` (`entregador_select_por_escopo` e políticas irmãs) continua
sendo o único mecanismo de isolamento — a coluna nova vive na mesma linha, já
protegida.

---

## State Transitions — `dados_entrego_desfecho`

Os 4 valores são mutuamente exclusivos (FR-006) e sempre refletem **apenas a
tentativa mais recente** (FR-007).

```
                          ┌──────────────────────────────┐
                          │  (linha criada)              │
                          └──────────────┬───────────────┘
                                         │ DEFAULT
                                         ▼
                                 ┌───────────────┐
              ┌──────────────────│ nunca-tentado │◀─────────────────┐
              │                  └───────┬───────┘                  │
              │                          │                          │
     PATCH sucesso=true          PATCH sucesso=false        (nenhuma transição
              │                          │                   automática volta
              ▼                          ▼                   para cá — SC-004)
      ┌───────────────┐     ┌────────────────────────┐
      │    sucesso    │◀───▶│  pessoa-nao-encontrada │
      └───────┬───────┘     └───────────┬────────────┘
              │                         │
              │             ┌───────────▼────────────┐
              └────────────▶│      outra-falha       │
                            └────────────────────────┘
                       (todas as transições entre os 3
                        estados terminais são livres —
                        vence sempre a última tentativa)
```

**Regras**:

- `nunca-tentado` é o estado inicial de toda linha nova (DEFAULT da coluna).
- Nenhuma transição **automática** retorna a `nunca-tentado` (SC-004). O valor
  só reaparece via backfill/migration ou intervenção manual em banco.
- `sucesso` ⟶ `pessoa-nao-encontrada` é uma transição **válida** (uma tentativa
  posterior falhou). Ver o invariante abaixo.

### Invariante de consistência (dec-010) — enunciado com precisão

> `dados_entrego_desfecho = 'sucesso'` e `dados_entrego_enriquecidos_em` são
> gravados **no mesmo PATCH** (`routes/hub-robo-entrego.js:222-229`). Não
> existe janela em que um seja escrito e o outro não.

O que o invariante **não** afirma: ele **não** é a bicondicional
`desfecho = 'sucesso' ⟺ enriquecidos_em IS NOT NULL`. FR-008 proíbe que uma
falha descarte dados de um sucesso anterior, então este estado é legítimo e
esperado:

| `desfecho` | `enriquecidos_em` | `dados_entrego_json` | Significado |
|---|---|---|---|
| `pessoa-nao-encontrada` | preenchido | preenchido | Enriquecido no passado; a **última** tentativa não achou a pessoa. Dados antigos preservados (FR-008) |

**Não "simplificar" removendo nenhuma das duas colunas** — a spec proíbe
explicitamente em nota destacada, e a redundância é a garantia de consistência.

---

## Fluxo de escrita da coluna nova

| Quem escreve | Quando | Valor | Fonte |
|---|---|---|---|
| `DEFAULT` da coluna | todo INSERT em `"Entregador"` | `'nunca-tentado'` | `0060` |
| Backfill da migration | uma vez, na aplicação da `0060` | `'sucesso'` onde `enriquecidos_em IS NOT NULL` | `0060` |
| `PATCH /robo-entrego/motoristas/:id/entrego-enriquecimento` | fim de cada tentativa | `sucesso` \| `pessoa-nao-encontrada` \| `outra-falha` | `routes/hub-robo-entrego.js` |

E, para `dados_entrego_solicitado_manual`:

| Quem escreve | Quando | Valor |
|---|---|---|
| `DEFAULT` da coluna | todo INSERT (inclusive o do upsert de importação) | `false` |
| `POST /motoristas/:id/entrego-enriquecimento` | clique do operador | `true` |
| `PATCH /robo-entrego/…/entrego-enriquecimento` | fim de cada tentativa, nos dois ramos | `false` |
| Gatilho da `0060` | enfileiramento automático | não escreve — fica no `DEFAULT` |

Nenhum outro caminho escreve a coluna. Em particular, o upsert de importação
(payload montado em `lib/hub-import-processor.js:326-330`, enviado em `:341`) **não** a menciona no payload — e por isso
ela recebe o `DEFAULT` no ramo INSERT e fica intocada no ramo `DO UPDATE`.

---

## Entity: `EnriquecimentoAutomatico` (NOVA — migration `0060`)

Habilitação e teto do enfileiramento automático, **por empresa**. Existe para
atender três requisitos que o operador fixou em `block-003` e que não têm onde
morar hoje: FR-012 (só empresa habilitada), FR-010 (teto configurável, nunca
constante mágica) e FR-013 (ligar é ato explícito, separado do deploy).

| Field | Type | Constraints | Notas |
|-------|------|-------------|-------|
| `empresa_id` | `int` | **PK** | Referência **lógica** a `"Empresa".id` (tabela legada, fora do banco do hub) — sem FK física, mesma decisão já documentada em `"ModuloEntidade"`/`"UsuarioEntidade"` (`0003:34-35`) |
| `ativo` | `boolean` | NOT NULL DEFAULT `false` | Interruptor. **Nega por padrão**: empresa sem linha nunca enfileira |
| `teto` | `int` | NOT NULL DEFAULT `100`, CHECK `teto > 0` | FR-010. Máximo de pedidos de enriquecimento **pendentes** para a empresa |
| `desde` | `timestamptz` | NOT NULL DEFAULT `now()` | Recorte de elegibilidade: só entregador com `criado_em >= desde` é alcançado. É o que mantém a **exclusão de retroatividade** (FR-002) estrutural |
| `atualizado_em` | `timestamptz` | NOT NULL DEFAULT `now()` | Quando a habilitação mudou pela última vez |

```sql
CREATE TABLE IF NOT EXISTS "EnriquecimentoAutomatico" (
    empresa_id    int PRIMARY KEY,
    ativo         boolean NOT NULL DEFAULT false,
    teto          int NOT NULL DEFAULT 100 CHECK (teto > 0),
    desde         timestamptz NOT NULL DEFAULT now(),
    atualizado_em timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON "EnriquecimentoAutomatico" TO authenticated;

ALTER TABLE "EnriquecimentoAutomatico" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS enriquecimentoautomatico_select_por_escopo
    ON "EnriquecimentoAutomatico";
CREATE POLICY enriquecimentoautomatico_select_por_escopo
    ON "EnriquecimentoAutomatico"
    FOR SELECT
    USING (empresa_id = ANY (hub_jwt_escopo_ids()));
```

### Por que reusar `"ModuloEntidade"` foi descartado

`"ModuloEntidade"` já é o mecanismo de liga/desliga por empresa do hub, com
semântica nega-por-padrão idêntica (`routes/hub-admin.js:121-123`: "Módulo sem
linha em `ModuloEntidade` = `habilitado:false`") e API de administração pronta.
Reusá-lo cobriria FR-012 — mas (a) `Modulo` é o catálogo que alimenta a
navegação da plataforma (`codigo`, `nome`, `ordem`), e criar um módulo para uma
capacidade **backend-only** (dec-011) poluiria o menu com um item que não abre
tela nenhuma; e (b) não haveria onde guardar o `teto` de FR-010 nem o `desde`
de FR-002 sem acrescentar colunas específicas desta feature a uma tabela
genérica. Uma tabela de 5 colunas é menos acoplamento que isso.

### RLS de leitura sim; escrita pela API não

A tabela segue **exatamente o precedente de `"ModuloEntidade"`**, que é a
tabela análoga do hub (liga/desliga por empresa, nega-por-padrão): `GRANT
SELECT`, RLS ligada e uma única política, de `SELECT`, escopada por
`hub_jwt_escopo_ids()` — a mesma forma de `0006:84-89`. Nenhum grant e nenhuma
política de escrita.

Por que a RLS é necessária apesar de o conteúdo não ser PII: `GRANT SELECT`
sem RLS transforma a tabela num endpoint REST do PostgREST legível
**cross-tenant** por qualquer JWT válido, expondo quais empresas têm
enfileiramento automático ligado, com que teto e desde quando. É pouco, mas é
gratuito de evitar, e divergir do precedente da tabela irmã exigiria uma
justificativa que não existe. **O gatilho continua funcionando sob a
política**: ele roda `SECURITY INVOKER` com o JWT da importação, cujo escopo
contém a própria empresa que está sendo importada.

Consequências da ausência de escrita, todas desejadas:

- Nenhuma rota do hub pode ligar/desligar o enfileiramento — a habilitação é
  ato de banco, feito pelo operador no runbook, o que **é** a separação que
  FR-013 exige entre deploy e ativação.
- Nenhuma superfície de API nova de escrita para atacar.
- Limitação declarada: como não há rota, a mudança **não** gera linha em
  `"Auditoria"`. O rastro é a própria linha (`ativo` + `desde` +
  `atualizado_em`) mais o registro no runbook. FR-013 pede auditável, e é isso
  que existe sem inventar uma rota administrativa que ninguém pediu.

**Falha fecha (fail-closed)**: se a política negar a leitura, ou a linha não
existir, o `SELECT … INTO cfg` não encontra nada e a função retorna sem
carimbar. O modo de falha do gatilho é **não coletar PII** — nunca coletar
demais.

---

## Índice novo — fila de enriquecimento

```sql
CREATE INDEX IF NOT EXISTS idx_entregador_fila_enriquecimento
    ON "Entregador" (id_empresa, dados_entrego_solicitado_em)
 WHERE dados_entrego_solicitado_em IS NOT NULL;
```

A `0057` não criou índice algum. Agora há dois caminhos quentes sobre o mesmo
predicado: a contagem de pendentes por empresa, que o gatilho faz **uma vez
por linha tocada** pela importação (para o teto de FR-010), e a leitura da
fila pelo consumidor (a cada 5 min, `config-enriquecimento.json`). É o índice
que torna a primeira barata — sem ele seriam N varreduras sequenciais; com
ele, o lote de 500 medido custou 19,0 ms no total. O índice é **parcial** — indexa só as
linhas pendentes, que são poucas por construção (teto de 100), não as ~720
linhas da tabela.

---

## Trigger novo — `trg_entregador_enfileira_import`

| Propriedade | Valor |
|-------------|-------|
| Tabela | `"Entregador"` |
| Função | `hub_entregador_enfileira_import()` |
| Gatilho | **um**: `BEFORE INSERT OR UPDATE`, `FOR EACH ROW` |
| Condições | claim `origem_importacao` **e** linha ainda virgem **e** empresa habilitada **e** teto não estourado |
| Efeito | `NEW.dados_entrego_solicitado_em := now()` |
| Migration | `0060` |
| Segurança | **`SECURITY INVOKER`** (default, mas **declarado explicitamente**) + `SET search_path = pg_catalog, public` |

```sql
CREATE OR REPLACE FUNCTION hub_entregador_enfileira_import()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
    cfg       record;
    pendentes int;
BEGIN
    -- (1) Só o pipeline de importação enfileira. A claim é assinada pelo
    -- backend (lib/hub-postgrest-jwt.js) e emitida exclusivamente por
    -- lib/hub-import-processor.js:341-344 — cliente nenhum a forja. O POST
    -- manual de motorista não a emite, então não enfileira.
    IF NOT hub_jwt_origem_importacao() THEN
        RETURN NEW;
    END IF;

    -- (2) Linha ainda virgem: nunca enfileirada, nunca enriquecida, nenhuma
    -- tentativa registrada. É o que impede reimportação de mexer em quem já
    -- está na fila, em quem já foi enriquecido ou em quem já falhou (FR-002).
    IF NEW.dados_entrego_solicitado_em     IS NOT NULL
       OR NEW.dados_entrego_enriquecidos_em IS NOT NULL
       OR NEW.dados_entrego_desfecho        <> 'nunca-tentado' THEN
        RETURN NEW;
    END IF;

    -- (3) Empresa habilitada (FR-012). Sem linha, ou com ativo=false, nada
    -- acontece — nega por padrão, e nenhum erro é emitido.
    SELECT teto, desde INTO cfg
      FROM "EnriquecimentoAutomatico"
     WHERE empresa_id = NEW.id_empresa
       AND ativo;
    IF NOT FOUND THEN
        RETURN NEW;
    END IF;

    -- (4) Recorte de retroatividade (FR-002): entregador que já existia antes
    -- de a empresa ser habilitada nunca é alcançado, nem pelo ramo de UPDATE.
    IF NEW.criado_em < cfg.desde THEN
        RETURN NEW;
    END IF;

    -- (5) Teto por empresa (FR-010). A contagem enxerga as linhas irmãs já
    -- processadas neste mesmo comando (ver §Evidência empírica), então o
    -- corte é exato dentro de um lote — o excedente simplesmente não é
    -- carimbado, e volta a ser candidato na importação seguinte.
    SELECT count(*) INTO pendentes
      FROM "Entregador"
     WHERE id_empresa = NEW.id_empresa
       AND dados_entrego_solicitado_em IS NOT NULL;

    IF pendentes < cfg.teto THEN
        NEW.dados_entrego_solicitado_em := now();
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_entregador_enfileira_import
    BEFORE INSERT OR UPDATE ON "Entregador"
    FOR EACH ROW
    EXECUTE FUNCTION hub_entregador_enfileira_import();
```

### Como cada cláusula amarra um requisito

| Cláusula | Requisito | Por quê |
|---|---|---|
| (1) `hub_jwt_origem_importacao()` | FR-001 | Criação **manual** de motorista (`routes/hub-motoristas.js:705`) não emite a claim, então não enfileira — e o operador não leva `429 JA_PENDENTE` ao clicar "enriquecer" logo depois (`:842`) |
| (2) linha virgem | **FR-002** / FR-007 | Quem já está na fila, já foi enriquecido ou já teve tentativa não é tocado por reimportação alguma |
| (3) `EnriquecimentoAutomatico` + `ativo` | **FR-012** (M2) | Nega por padrão. Empresa sem linha nunca enfileira |
| (4) `NEW.criado_em < cfg.desde` | **FR-002** | Recorte de retroatividade — é o que permite o evento de `UPDATE` existir sem varrer o passivo histórico |
| (5) `pendentes < cfg.teto` | **FR-010** (H2) | Teto por empresa, lido do banco, nunca constante |
| evento `UPDATE` no mesmo gatilho | **FR-010**, 2ª metade | É o que faz o excedente "entrar na importação seguinte": lá aquelas linhas caem no ramo `ON CONFLICT DO UPDATE` |

### Por que `BEFORE`, e não `AFTER`

`BEFORE … FOR EACH ROW` altera `NEW` **antes** da gravação: uma escrita só,
nenhum `UPDATE` extra emitido pela função, e portanto **nenhuma recursão
possível** — o gatilho nunca dispara a si mesmo. Um gatilho `AFTER` teria de
emitir um `UPDATE` na própria tabela que observa, o que exigiria uma guarda de
`pg_trigger_depth()` para não se realimentar (gatilho de statement dispara
mesmo quando o comando afeta zero linhas). Complexidade que este desenho não
precisa pagar.

### O teto é de fila pendente, não um contador por importação

A leitura literal de FR-010 ("teto por importação/dia") admitia um contador
por execução de importação. O que a cláusula (5) implementa é mais forte e sem
estado: **no máximo `teto` pedidos pendentes por empresa a qualquer instante**.

- Numa importação única, os dois coincidem: no máximo `teto` entram.
- Entre importações, o de fila pendente é mais seguro: se a fila anterior
  ainda não drenou (digamos, 40 restantes), a importação seguinte só
  acrescenta 60 — em vez de 100 sobre 40.
- Não precisa de tabela de contadores, nem de "qual importação foi essa", nem
  de reset diário à meia-noite.

Consequência direta: reduzir o teto configurado de uma empresa com pedidos
já pendentes acima do novo valor não descarta nem re-classifica nada — o
excedente só aguarda o processamento existente drenar (`spec.md` FR-010,
Edge Cases).

**Pedidos manuais contam para o teto**, porque ocupam a mesma fila e o mesmo
robô. Consequência declarada: uma rajada manual reduz o espaço da rodada
automática seguinte — o que é desejado, já que o limite existe para proteger a
sessão EntreGô compartilhada, não para privilegiar uma origem na contabilidade.
A **ordem** de atendimento, essa sim, privilegia o manual (FR-011).

### Cadência real que sustenta o número 100

`config-enriquecimento.json` dispara o consumidor a cada 5 min
(`onCalendar: "*:0/5"`); cada rodada leva até `LOTE_ENRIQUECIMENTO_DEFAULT`
= 20 (`routes/hub-robo-entrego.js:44`) e espaça 60 s entre motoristas
(`THROTTLE_MS_ENTRE_MOTORISTAS`, `src/enriquecimento.js`, citado no `_ref` do
`config-enriquecimento.json`); execuções não se sobrepõem (`flock -n`,
`infra/robo-entrego/src/index.js:485`). Isso dá ~1 enriquecimento por minuto ⇒
100 pendentes drenam em ~100 min, dentro da janela entre importações
(11h/13h/14h — `infra/robo-entrego/config.json:2`,
`"horarios": ["11:00", "13:00", "14:00"]`). É a mesma aritmética que o
operador usou ao escolher 100.

### Convivência com o gatilho existente

`trg_entregador_protege_nome` (`0019`, função substituída em `0025`) também é
`BEFORE UPDATE … FOR EACH ROW`. Os dois passam a coexistir no mesmo evento.
São compostos, não conflitantes: o PostgreSQL dispara gatilhos `BEFORE` de
linha em ordem alfabética de nome (`trg_entregador_enfileira_import` antes de
`trg_entregador_protege_nome`), cada um recebe o `NEW` devolvido pelo anterior
e eles escrevem campos **disjuntos** (`dados_entrego_solicitado_em` vs `nome`).
A ordem entre eles é indiferente ao resultado.

### Hardening obrigatório (gate `owasp-security`, achado L1)

A função MUST ser `SECURITY INVOKER` com `search_path` fixo. Sem `search_path`
fixo, um objeto criado por um role com privilégio de `CREATE` no schema
`public` poderia sequestrar a resolução de nomes dentro da função. As funções
irmãs (`0019`/`0025`) também não fixam — corrigir aqui não as piora, e a
`0060` não deve nascer com o mesmo débito. `SECURITY DEFINER` está **proibido**:
o gatilho não precisa de privilégio elevado e o elevaria acima da RLS.

Verificação complementar: confirmar que o role `authenticated` **não** tem
`CREATE` no schema `public`.

---

## Evidência empírica do desenho (medida, não suposta)

Todo o comportamento acima foi executado em `postgres:13.23` (mesma major dos
composes do hub — `infra/hub/compose.hub.*.yml` usam `postgres:13`), num
container descartável, contra uma réplica mínima do esquema (`"Entregador"`,
`"EnriquecimentoAutomatico"`, stub de `hub_jwt_origem_importacao()`) e a
função **literal** acima. Resultados:

| Prova | Montagem | Resultado medido |
|---|---|---|
| Contagem enxerga linhas irmãs | `BEFORE INSERT` de linha num `INSERT … SELECT` de 5 linhas | `count` observado = 0, 1, 2, 3, 4 — **enxerga** (foi o que refutou o desenho de statement) |
| Teto corta dentro do lote | `teto=3`, lote de 7 novos | **3** enfileirados de 7 |
| Teto cheio não deixa entrar mais | reimportar o mesmo lote | continua **3** |
| Excedente entra na importação seguinte | drenar a fila, marcar os 3 como `outra-falha`, reimportar | **+3** enfileirados (os que sobraram) |
| Empresa não habilitada | importar 4 novos para `empresa_id=99`, sem linha de habilitação | **0** enfileirados |
| Retroatividade fica fora | linha com `criado_em = now()-30d`, habilitar com `desde=now()`, reimportar (ramo `DO UPDATE`) | **não** enfileirada |
| Criação manual não enfileira | `INSERT` sem a claim | **0** enfileirados |
| `PATCH` do robô não é afetado | `UPDATE` sem a claim, zerando a fila e gravando `pessoa-nao-encontrada` | desfecho gravado, fila limpa, **não** re-enfileira |
| Ordenação manual-primeiro | 5 automáticos + 1 manual **posterior**, `ORDER BY …_manual DESC, …_em ASC` | manual em **1º**, automáticos em FIFO atrás |
| Custo | lote de **500** novos com `teto=100`, com o índice parcial | `INSERT` inteiro em **19,0 ms**; exatamente **100** enfileirados |

O custo mede o ponto que motivaria um gatilho de statement: 500 linhas × (1
lookup por PK + 1 `count` sobre índice parcial) custaram 19 ms no total. Não
há problema de desempenho a resolver.

---

## Prioridade do pedido manual (FR-011)

O discriminador é a coluna nova `dados_entrego_solicitado_manual`, e a
mudança de comportamento cabe em **uma chave de ordenação**:

| Quem | Antes | Depois |
|---|---|---|
| `GET /robo-entrego/motoristas-para-enriquecer?modo=sob-demanda` (`routes/hub-robo-entrego.js:166`) | `order=dados_entrego_solicitado_em.asc` | `order=dados_entrego_solicitado_manual.desc,dados_entrego_solicitado_em.asc` |
| `POST /motoristas/:id/entrego-enriquecimento` (`routes/hub-motoristas.js:846-850`) | grava `dados_entrego_solicitado_em` | grava também `dados_entrego_solicitado_manual: true` |
| Gatilho da `0060` | — | deixa a coluna no `DEFAULT false` |
| `PATCH /robo-entrego/motoristas/:id/entrego-enriquecimento` (`routes/hub-robo-entrego.js:222-229`) | zera `dados_entrego_solicitado_em` | zera também `dados_entrego_solicitado_manual` (nos **dois** ramos, sucesso e falha) |

`desc` num booleano `NOT NULL` põe `true` primeiro sem ambiguidade de `NULLS
FIRST/LAST` — é exatamente por isso que a coluna é `NOT NULL DEFAULT false` e
não anulável. Dentro de cada grupo, o desempate continua sendo FIFO por
`dados_entrego_solicitado_em`.

Alternativas descartadas: fila em tabela separada (duplica o consumidor);
coluna `text` com `'manual'|'automatico'` (mesma informação, ordenação por
acaso alfabético — frágil); carimbar o pedido manual com um timestamp
sentinela no passado (ordena certo por efeito colateral e destrói o dado de
quando o operador clicou).

---

### Relationships

`Entregador` mantém `motorista_id → ContaMotorista` (`0021`) e é referenciada
pelos fatos de faturamento/performance via `entregador_id` — nada disso muda.

O único relacionamento novo é **lógico, não físico**:
`"EnriquecimentoAutomatico".empresa_id` ↔ `"Entregador".id_empresa`. Sem FK,
pelo mesmo motivo de `"ModuloEntidade"`/`"UsuarioEntidade"`: `"Empresa"` é
tabela do esquema legado, fora do banco do hub no ambiente isolado
(`0003:34-35`). A junção acontece dentro da função do gatilho.

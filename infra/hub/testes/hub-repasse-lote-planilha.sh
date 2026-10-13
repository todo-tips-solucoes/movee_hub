#!/usr/bin/env bash
# Prova da 0109 no hub-homolog (dados efêmeros ids 9109xxx, apagados no fim):
# hub_repasse_lote_previa via HTTP no PostgREST. Uso: infra/hub/testes/hub-repasse-lote-planilha.sh
set -uo pipefail
RAIZ="$(cd "$(dirname "$0")/../../.." && pwd)"; ENV=/var/lib/hub_secrets/.env.hub.homolog
SECRET="$(grep '^PGRST_JWT_SECRET=' $ENV | cut -d= -f2-)"
P() { docker exec -i hub_homolog_db psql -v ON_ERROR_STOP=1 -U hub_homolog -d hub_homolog "$@"; }
cleanup() { P -q <<'SQL'
SET session_replication_role = replica;
DELETE FROM "ApuracaoRepasseMovimento" WHERE entregador_id BETWEEN 9109001 AND 9109009;
DELETE FROM "ApuracaoRepasseItem" WHERE entregador_id BETWEEN 9109001 AND 9109009;
DELETE FROM "ApuracaoRepasse" WHERE id = 9109001;
DELETE FROM "ContaBancariaMotorista" WHERE entregador_id BETWEEN 9109001 AND 9109009;
DELETE FROM "Entregador" WHERE id BETWEEN 9109001 AND 9109009;
DELETE FROM "ContaMotorista" WHERE cnpj_prestador LIKE '9109%';
DELETE FROM "EnvioMassa" WHERE cnpj_prestador LIKE '9109%' OR id BETWEEN 9109000 AND 9109099;
SQL
}
[ -n "${KEEP:-}" ] || trap cleanup EXIT; cleanup
D1="'2026-08-03 12:00+00'"; D2="'2026-08-09 12:00+00'"
P -q <<SQL
INSERT INTO "ApuracaoRepasse"(id,id_empresa,periodo_inicio,periodo_fim,data_repasse,configuracao_id,fechado_por)
 VALUES (9109001,9001,'2026-08-03','2026-08-09','2026-08-12',66,328);
-- 1..6 = A hub-só, B planilha-só, B2 planilha 2 movs (1 aprovado), C ambos, D trilha com EnvioMassa apagada, E cross-tenant
-- 7 = F sem motorista_id (planilha com CNPJ que não vincula)
INSERT INTO "ContaMotorista"(cnpj_prestador,nome) SELECT '9109000000000'||g, 'T'||g FROM generate_series(1,6) g;
INSERT INTO "Entregador"(id,id_empresa,id_externo,nome,motorista_id)
 SELECT 9109000+g,9001,gen_random_uuid(),'Teste '||g,
        CASE WHEN g<=6 THEN (SELECT id FROM "ContaMotorista" WHERE cnpj_prestador='9109000000000'||g) END
 FROM generate_series(1,7) g;
INSERT INTO "ContaBancariaMotorista"(id_empresa,entregador_id,origem,status,titular_nome,titular_documento,titular_tipo,banco_codigo,banco_nome,agencia,conta,conta_digito,tipo_conta,entregador_confirmado_id)
 SELECT 9001,9109000+g,'HUB','APROVADA','T','12345678901234','PJ','001','B','0001','1','1','CORRENTE',9109000+g FROM generate_series(1,7) g;
INSERT INTO "ApuracaoRepasseItem"(apuracao_id,id_empresa,entregador_id,creditos,adiantamentos,debitos,remanescente,valor_pago,valor_transportado,saldo_anterior)
 SELECT 9109001,9001,9109000+g,100,0,0,100,100,0,0 FROM generate_series(1,7) g;
-- EnvioMassa: ok = aprovado
INSERT INTO "EnvioMassa"(id,id_empresa,cnpj_prestador,nota_ok,dt_inicial,dt_final) VALUES
 (9109001,9001,NULL,'http://x/a.xml',NULL,NULL),                          -- A (só trilha)
 (9109002,9001,'91090000000002','http://x/b.xml',$D1,$D2),                -- B
 (9109003,9001,'91090000000003','http://x/b2a.xml',$D1,$D2),              -- B2 aprovado
 (9109004,9001,'91090000000003',NULL,$D1,$D2),                            -- B2 pendente
 (9109005,9001,'91090000000004','http://x/c.xml',$D1,$D2),                -- C (trilha + planilha)
 (9109006,9001,'91090000000006','http://x/e.xml',$D1,$D2),                -- E aprovado no escopo
 (9109007,9010,'91090000000006',NULL,$D1,$D2),                            -- E OUTRO tenant, pendente (não pode contar)
 (9109008,9001,'91090000000007','http://x/f.xml',$D1,$D2);                -- F (entregador sem vínculo)
INSERT INTO "ApuracaoRepasseMovimento"(apuracao_id,entregador_id,id_empresa,envio_massa_id,valor,gorjeta) VALUES
 (9109001,9109001,9001,9109001,100,0),
 (9109001,9109004,9001,9109005,100,0),
 (9109001,9109005,9001,9109099,100,0);                                    -- D: EnvioMassa 9109099 não existe
SQL
JWT="$(PGRST_JWT_SECRET="$SECRET" node -e "const {generateHubPostgrestJWT}=require('$RAIZ/app_homologacao/backend/lib/hub-postgrest-jwt');process.stdout.write(generateHubPostgrestJWT({usuarioId:328,empresaAtiva:9001,escopo:[9001]}))")"
RES="$(docker run --rm --network hub_homolog_net curlimages/curl:8.11.1 -s -w '\nHTTP:%{http_code}' -X POST http://postgrest:3000/rpc/hub_repasse_lote_previa \
  -H "Authorization: Bearer $JWT" -H 'Content-Type: application/json' \
  -d '{"p_apuracoes":[9109001,9109001,9109001,9109001,9109001,9109001,9109001],"p_entregadores":[9109001,9109002,9109003,9109004,9109005,9109006,9109007]}')"
echo "$RES" | tail -1
echo "$RES" | head -n -1 | node -e '
const rows=JSON.parse(require("fs").readFileSync(0,"utf8"));
const esp={9109001:["A hub-só",null],9109002:["B planilha-só",null],9109003:["B2 2 movs, 1 aprovado","NOTA_PENDENTE"],
 9109004:["C nos dois caminhos (conta 1x)",null],9109005:["D EnvioMassa apagada","NOTA_PENDENTE"],
 9109006:["E CNPJ em 2 tenants (outro não conta)",null],9109007:["F sem motorista_id","NOTA_PENDENTE"]};
let fail=0;
for(const r of rows){const [n,m]=esp[r.entregador_id];const ok=(r.motivo_pendencia??null)===m;if(!ok)fail++;
 console.log((ok?"PASS":"FAIL"),n,"->",r.motivo_pendencia??"apta");}
if(rows.length!==7){fail++;console.log("FAIL linhas",rows.length)}
process.exit(fail?1:0)'
RC=$?; echo "resultado: $([ $RC = 0 ] && echo OK || echo FALHOU)"; exit $RC

# Ensaio de migrations S10 — tempos por migration (20260710T024140Z)

## RUN A — banco VAZIO (cenário do cutover; migrate.sh série completa)

| migration | ms |
|---|---|
| 0000_schema_migration.sql | 286 |
| 0001_postgrest_roles.sql | 299 |
| 0002_usuario.sql | 317 |
| 0003_papel_permissao_modulo.sql | 404 |
| 0004_auditoria.sql | 300 |
| 0005_sessao_refresh.sql | 329 |
| 0006_rls_policies.sql | 324 |
| 0007_seed_papeis_permissoes_modulos.sql | 334 |
| 0008_migracao_empresa_para_usuario.sql | 302 |
| 0009_rls_hardening_indices.sql | 304 |
| 0010_entregador.sql | 293 |
| 0011_importacao_arquivo.sql | 307 |
| 0012_importacao_linha_erro.sql | 325 |
| 0013_faturamento_lancamento.sql | 325 |
| 0014_performance_turno.sql | 301 |
| 0015_rls_importacoes.sql | 301 |
| 0016_seed_importacoes_exportar.sql | 316 |
| 0017_grant_delete_importacao_linha_erro.sql | 321 |
| 0018_dedupe_erro_recuperacao_orfa.sql | 314 |
| 0019_entregador_edicao_manual.sql | 324 |
| 0020_fatos_indices_subpraca.sql | 324 |
| 0021_conta_motorista.sql | 319 |
| 0022_empresa_grupo_movee.sql | 321 |
| 0023_motoristas_rpc_candidatos.sql | 344 |
| 0024_areas_por_entregador.sql | 308 |
| 0025_entregador_protege_nome_apenas_import.sql | 293 |
| 0026_seed_permissao_faturamento_listar.sql | 350 |
| 0027_hub_faturamento_rpc_resumo.sql | 297 |
| 0028_mv_faturamento_dia.sql | 358 |
| 0029_seed_permissao_performance_listar.sql | 315 |
| 0030_hub_performance_rpc_resumo.sql | 358 |
| 0031_mv_performance_dia.sql | 342 |
| 0032_seed_permissao_envio_massa_gerenciar.sql | 303 |
| 0033_schema_legado_envio_massa.sql | 360 |
| 0034_seed_legado_envio_massa_teste.sql | 341 |
| 0035_auditoria_visao_global.sql | 308 |
| 0036_moduloentidade_escrita_admin.sql | 333 |
| 0037_rpc_papel_permissao_set.sql | 317 |
| 0038_seed_modulos_admin_qa.sql | 304 |
| 0039_usuarioentidade_escrita_admin.sql | 286 |
| 0040_fix_normaliza_nome_search_path.sql | 486 |

## RUN B — fase 1 (0000→0019, banco vazio)

| migration | ms |
|---|---|
| 0000_schema_migration.sql | 373 |
| 0001_postgrest_roles.sql | 329 |
| 0002_usuario.sql | 379 |
| 0003_papel_permissao_modulo.sql | 365 |
| 0004_auditoria.sql | 339 |
| 0005_sessao_refresh.sql | 314 |
| 0006_rls_policies.sql | 322 |
| 0007_seed_papeis_permissoes_modulos.sql | 299 |
| 0008_migracao_empresa_para_usuario.sql | 310 |
| 0009_rls_hardening_indices.sql | 407 |
| 0010_entregador.sql | 295 |
| 0011_importacao_arquivo.sql | 308 |
| 0012_importacao_linha_erro.sql | 326 |
| 0013_faturamento_lancamento.sql | 353 |
| 0014_performance_turno.sql | 305 |
| 0015_rls_importacoes.sql | 345 |
| 0016_seed_importacoes_exportar.sql | 305 |
| 0017_grant_delete_importacao_linha_erro.sql | 314 |
| 0018_dedupe_erro_recuperacao_orfa.sql | 301 |
| 0019_entregador_edicao_manual.sql | 502 |

## RUN B — fase 2 (0020→0039 sobre ~1501236 fat + 1017280 perf)

| migration | ms |
|---|---|
| 0020_fatos_indices_subpraca.sql | 2849 |
| 0021_conta_motorista.sql | 360 |
| 0022_empresa_grupo_movee.sql | 382 |
| 0023_motoristas_rpc_candidatos.sql | 292 |
| 0024_areas_por_entregador.sql | 353 |
| 0025_entregador_protege_nome_apenas_import.sql | 305 |
| 0026_seed_permissao_faturamento_listar.sql | 317 |
| 0027_hub_faturamento_rpc_resumo.sql | 335 |
| 0028_mv_faturamento_dia.sql | 4483 |
| 0029_seed_permissao_performance_listar.sql | 303 |
| 0030_hub_performance_rpc_resumo.sql | 371 |
| 0031_mv_performance_dia.sql | 6270 |
| 0032_seed_permissao_envio_massa_gerenciar.sql | 302 |
| 0033_schema_legado_envio_massa.sql | 368 |
| 0034_seed_legado_envio_massa_teste.sql | 347 |
| 0035_auditoria_visao_global.sql | 335 |
| 0036_moduloentidade_escrita_admin.sql | 337 |
| 0037_rpc_papel_permissao_set.sql | 332 |
| 0038_seed_modulos_admin_qa.sql | 328 |
| 0039_usuarioentidade_escrita_admin.sql | 293 |
| 0040_fix_normaliza_nome_search_path.sql | 527 |

Locks bloqueados observados no sampler: 0 amostras
(run-b-locks-sampler.log; log_lock_waits em run-b-db-lock-waits.log).

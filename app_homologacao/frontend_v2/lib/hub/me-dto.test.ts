// hub-shell (S3) task 1.3.4 — teste de paridade do adaptador de borda.
//
// Objetivo (data-model.md §3, "Invariante de paridade"): os campos snake do
// `MeResponseDTO` devem casar 1:1 com o select real de
// `app_homologacao/backend/routes/hub-me.js`:
//   - GET /me (linha 137-143):
//       usuario: { id, email, nome }
//       entidades: [{ empresa_id, papel, ativo }]   (linha 94-98)
//       entidade_ativa: number | null
//       modulos: [{ codigo, nome, icone, ordem, ativo }] (select linha 123)
//       permissoes: string[]
// Este teste falha se `toHubMe` referenciar um campo inexistente no DTO real
// ou omitir um campo contratado (fora de `modulos[].ativo`, que é
// deliberadamente descartado por decisão D2 — testado à parte abaixo).
import { describe, expect, it } from 'vitest';
import { toHubMe, toTrocarEntidadeReq, type MeResponseDTO } from './me-dto';

function buildDto(overrides: Partial<MeResponseDTO> = {}): MeResponseDTO {
  return {
    usuario: { id: 1, email: 'pessoa@exemplo.com', nome: 'Pessoa Exemplo' },
    entidades: [
      { empresa_id: 10, nome: 'Movee Matriz', papel: 'admin', ativo: true },
      { empresa_id: 11, papel: 'operador', ativo: true },
    ],
    entidade_ativa: 10,
    modulos: [
      { codigo: 'motoristas', nome: 'Motoristas', icone: 'truck', ordem: 1, ativo: true },
      { codigo: 'auditoria', nome: 'Auditoria', icone: 'shield', ordem: 2, ativo: true },
    ],
    permissoes: ['motoristas.view', 'auditoria.consultar'],
    ...overrides,
  };
}

describe('toHubMe — paridade com o contrato real de hub-me.js', () => {
  it('mapeia usuario 1:1 (id, email, nome)', () => {
    const dto = buildDto();
    const me = toHubMe(dto);
    expect(me.usuario).toEqual({ id: 1, email: 'pessoa@exemplo.com', nome: 'Pessoa Exemplo' });
  });

  it('mapeia entidades[] snake->camel preservando papel e ativo — nome ausente degrada para null', () => {
    const dto = buildDto();
    const me = toHubMe(dto);
    expect(me.entidades).toEqual([
      { empresaId: 10, nome: 'Movee Matriz', papel: 'admin', ativo: true },
      { empresaId: 11, nome: null, papel: 'operador', ativo: true },
    ]);
  });

  it('mapeia entidade_ativa -> entidadeAtiva sem alterar o valor', () => {
    const dto = buildDto({ entidade_ativa: 11 });
    expect(toHubMe(dto).entidadeAtiva).toBe(11);
  });

  it('cobre a degradação entidadeAtiva:null (perda de vínculo — FR-015)', () => {
    const dto = buildDto({ entidade_ativa: null });
    expect(toHubMe(dto).entidadeAtiva).toBeNull();
  });

  it('mapeia modulos[] preservando codigo/nome/icone/ordem e DESCARTANDO ativo (D2)', () => {
    const dto = buildDto();
    const me = toHubMe(dto);
    expect(me.modulos).toEqual([
      { codigo: 'motoristas', nome: 'Motoristas', icone: 'truck', ordem: 1 },
      { codigo: 'auditoria', nome: 'Auditoria', icone: 'shield', ordem: 2 },
    ]);
    for (const modulo of me.modulos) {
      expect(modulo).not.toHaveProperty('ativo');
    }
  });

  it('propaga permissoes[] tal-e-qual (decorativo — autoridade real é o backend)', () => {
    const dto = buildDto();
    expect(toHubMe(dto).permissoes).toEqual(['motoristas.view', 'auditoria.consultar']);
  });

  it('não introduz nem descarta nenhum campo fora do contrato (paridade estrita)', () => {
    const dto = buildDto();
    const me = toHubMe(dto);
    expect(Object.keys(me).sort()).toEqual(
      ['usuario', 'entidades', 'entidadeAtiva', 'modulos', 'permissoes'].sort()
    );
    expect(Object.keys(me.usuario).sort()).toEqual(['id', 'email', 'nome'].sort());
    expect(Object.keys(me.entidades[0]).sort()).toEqual(['empresaId', 'nome', 'papel', 'ativo'].sort());
    expect(Object.keys(me.modulos[0]).sort()).toEqual(['codigo', 'nome', 'icone', 'ordem'].sort());
  });
});

describe('toTrocarEntidadeReq', () => {
  it('converte empresaId (camel) para { empresa_id } (snake) — body de POST /me/entidade', () => {
    expect(toTrocarEntidadeReq(42)).toEqual({ empresa_id: 42 });
  });
});

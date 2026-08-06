// hub-shell (S3) — adaptador de borda para o contrato de backend do hub
// (fundação S2: routes/hub-me.js). Fonte da verdade dos shapes:
// docs/specs/hub-shell/plan.md §2/§6, docs/specs/hub-shell/data-model.md §1-3.
//
// Regra dura: nenhum componente consome `MeResponseDTO`/`TrocarEntidadeReqDTO`/
// `TrocarEntidadeRespDTO` diretamente — sempre via `toHubMe`/`toTrocarEntidadeReq`.

// ────────────────────────────────────────────────────────────────────────────
// 1. DTOs da API (snake_case) — espelho literal do contrato verificado
//    (hub-me.js: GET /api/v1/me em `router.get('/', ...)`, linhas 71-148;
//    POST /api/v1/me/entidade em `router.post('/entidade', ...)`, linhas
//    154-212 — reconfirmado na task 1.2.1/1.2.2 desta onda).
// ────────────────────────────────────────────────────────────────────────────

export interface MeResponseDTO {
  usuario: { id: number; email: string; nome: string };
  entidades: Array<{ empresa_id: number; nome?: string | null; papel: string | null; ativo: boolean }>;
  entidade_ativa: number | null;
  modulos: Array<{ codigo: string; nome: string; icone: string; ordem: number; ativo: boolean }>;
  permissoes: string[];
}

export interface TrocarEntidadeReqDTO {
  empresa_id: number;
}

export interface TrocarEntidadeRespDTO {
  entidade_ativa: number;
}

// ────────────────────────────────────────────────────────────────────────────
// 2. Tipos de domínio do shell (camelCase) — o que os componentes veem
//    (data-model.md §2). `HubModulo` NÃO propaga `ativo` do DTO — decisão D2:
//    a presença no array já significa habilitado+visível (o backend só inclui
//    módulos com `ModuloEntidade.ativo=true`, ver hub-me.js linhas 131-134).
// ────────────────────────────────────────────────────────────────────────────

export interface HubUsuario {
  id: number;
  email: string;
  nome: string;
}

export interface HubVinculo {
  empresaId: number;
  /** Nome de exibição da entidade — null quando o backend não resolveu (fallback "Empresa #id"). */
  nome: string | null;
  papel: string | null;
  ativo: boolean;
}

export interface HubModulo {
  codigo: string;
  nome: string;
  icone: string;
  ordem: number;
}

export interface HubMe {
  usuario: HubUsuario;
  entidades: HubVinculo[];
  entidadeAtiva: number | null;
  modulos: HubModulo[];
  permissoes: string[];
}

// ────────────────────────────────────────────────────────────────────────────
// 3. Adaptador — fonte única da tradução snake_case <-> camelCase
// ────────────────────────────────────────────────────────────────────────────

export function toHubMe(dto: MeResponseDTO): HubMe {
  return {
    usuario: {
      id: dto.usuario.id,
      email: dto.usuario.email,
      nome: dto.usuario.nome,
    },
    entidades: dto.entidades.map((e) => ({
      empresaId: e.empresa_id,
      nome: e.nome ?? null,
      papel: e.papel,
      ativo: e.ativo,
    })),
    // Degradação de vínculo (FR-015): o backend já resolve `entidade_ativa`
    // para `null` quando o vínculo da claim deixou de ser ativo — o
    // adaptador só propaga o valor, sem lógica adicional.
    entidadeAtiva: dto.entidade_ativa,
    modulos: dto.modulos.map((m) => ({
      codigo: m.codigo,
      nome: m.nome,
      icone: m.icone,
      ordem: m.ordem,
      // `ativo` deliberadamente omitido — decisão D2.
    })),
    permissoes: dto.permissoes,
  };
}

export function toTrocarEntidadeReq(empresaId: number): TrocarEntidadeReqDTO {
  return { empresa_id: empresaId };
}

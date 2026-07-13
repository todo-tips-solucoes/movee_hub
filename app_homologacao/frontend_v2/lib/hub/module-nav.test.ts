// hub-shell (S3) task 2.2.5 — teste unitário do mapeamento módulo→rota e
// módulo→ícone (funções puras de lib/hub/module-nav.ts).
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MODULE_ICON,
  moduloParaRota,
  resolveModuleIcon,
} from './module-nav';
import { FileUp, Truck, Upload } from 'lucide-react';

describe('moduloParaRota', () => {
  it('deriva /hub/dashboard/<codigo> por convenção pura, sem lista fixa (dec-039/dec-041: prefixo /hub/ evita colisão com app/dashboard/motoristas legado)', () => {
    expect(moduloParaRota('motoristas')).toBe('/hub/dashboard/motoristas');
    expect(moduloParaRota('faturamento')).toBe('/hub/dashboard/faturamento');
  });

  it('módulo importacoes (S4, tasks.md 6.1.4): resolve para /hub/dashboard/importacoes — mesma rota real da página', () => {
    expect(moduloParaRota('importacoes')).toBe('/hub/dashboard/importacoes');
  });

  it('resolve qualquer codigo futuro do backend sem precisar de mudança neste arquivo', () => {
    // SC-001: nenhum item hardcoded — um módulo nunca antes visto ainda
    // resolve corretamente pela convenção.
    expect(moduloParaRota('modulo-novo-2027')).toBe('/hub/dashboard/modulo-novo-2027');
  });

  it('hub-motorista-canonico FASE 1 (FR-001/FR-002, Acceptance Scenario 3 US1): dashboard resolve para a raiz /hub/dashboard, sem regressão nos demais códigos', () => {
    expect(moduloParaRota('dashboard')).toBe('/hub/dashboard');
    // Regressão: demais códigos continuam na convenção /hub/dashboard/<codigo>.
    expect(moduloParaRota('motoristas')).toBe('/hub/dashboard/motoristas');
    expect(moduloParaRota('faturamento')).toBe('/hub/dashboard/faturamento');
    expect(moduloParaRota('performance')).toBe('/hub/dashboard/performance');
    expect(moduloParaRota('importacoes')).toBe('/hub/dashboard/importacoes');
    expect(moduloParaRota('admin')).toBe('/hub/dashboard/admin');
  });
});

describe('resolveModuleIcon', () => {
  it('resolve string conhecida (case-insensitive)', () => {
    expect(resolveModuleIcon('truck')).toBe(Truck);
    expect(resolveModuleIcon('Truck')).toBe(Truck);
    expect(resolveModuleIcon('MOTORISTAS')).toBe(Truck);
  });

  it('fail-safe: null sem codigo cai no ícone padrão', () => {
    expect(resolveModuleIcon(null)).toBe(DEFAULT_MODULE_ICON);
    expect(resolveModuleIcon(undefined)).toBe(DEFAULT_MODULE_ICON);
  });

  it('cascata (uiux-hub F1): icone null (caso real hoje — seed não povoa icone) resolve pelo codigo do módulo', () => {
    expect(resolveModuleIcon(null, 'motoristas')).toBe(Truck);
    expect(resolveModuleIcon(undefined, 'importacoes')).toBe(FileUp);
    expect(resolveModuleIcon('', 'MOTORISTAS')).toBe(Truck);
  });

  it('icone explícito conhecido tem precedência sobre o codigo', () => {
    expect(resolveModuleIcon('truck', 'importacoes')).toBe(Truck);
  });

  it('fail-safe: nem icone nem codigo reconhecidos cai no ícone padrão, não lança', () => {
    expect(resolveModuleIcon('valor-inexistente-no-mapa')).toBe(DEFAULT_MODULE_ICON);
    expect(resolveModuleIcon('')).toBe(DEFAULT_MODULE_ICON);
    expect(resolveModuleIcon(null, 'modulo-novo-2027')).toBe(DEFAULT_MODULE_ICON);
  });

  it('módulo importacoes: codigo resolve para FileUp (mais específico); icone literal upload segue em Upload', () => {
    expect(resolveModuleIcon('importacoes')).toBe(FileUp);
    expect(resolveModuleIcon('upload')).toBe(Upload);
  });
});

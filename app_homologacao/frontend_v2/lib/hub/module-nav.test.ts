// hub-shell (S3) task 2.2.5 — teste unitário do mapeamento módulo→rota e
// módulo→ícone (funções puras de lib/hub/module-nav.ts).
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MODULE_ICON,
  moduloParaRota,
  resolveModuleIcon,
} from './module-nav';
import { Truck } from 'lucide-react';

describe('moduloParaRota', () => {
  it('deriva /dashboard/<codigo> por convenção pura, sem lista fixa', () => {
    expect(moduloParaRota('motoristas')).toBe('/dashboard/motoristas');
    expect(moduloParaRota('faturamento')).toBe('/dashboard/faturamento');
  });

  it('resolve qualquer codigo futuro do backend sem precisar de mudança neste arquivo', () => {
    // SC-001: nenhum item hardcoded — um módulo nunca antes visto ainda
    // resolve corretamente pela convenção.
    expect(moduloParaRota('modulo-novo-2027')).toBe('/dashboard/modulo-novo-2027');
  });
});

describe('resolveModuleIcon', () => {
  it('resolve string conhecida (case-insensitive)', () => {
    expect(resolveModuleIcon('truck')).toBe(Truck);
    expect(resolveModuleIcon('Truck')).toBe(Truck);
    expect(resolveModuleIcon('MOTORISTAS')).toBe(Truck);
  });

  it('fail-safe: null (caso real hoje — seed não povoa icone) cai no ícone padrão', () => {
    expect(resolveModuleIcon(null)).toBe(DEFAULT_MODULE_ICON);
    expect(resolveModuleIcon(undefined)).toBe(DEFAULT_MODULE_ICON);
  });

  it('fail-safe: string não reconhecida cai no ícone padrão, não lança', () => {
    expect(resolveModuleIcon('valor-inexistente-no-mapa')).toBe(DEFAULT_MODULE_ICON);
    expect(resolveModuleIcon('')).toBe(DEFAULT_MODULE_ICON);
  });
});

// hub-shell (S3) task 2.2.5 — teste unitário do mapeamento módulo→rota e
// módulo→ícone (funções puras de lib/hub/module-nav.ts).
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MODULE_ICON,
  moduloParaRota,
  resolveModuleIcon,
} from './module-nav';
import { Truck, Upload } from 'lucide-react';

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

  it('módulo importacoes (S4, tasks.md 6.1.4): ícone Upload já mapeado, nenhuma mudança necessária neste arquivo', () => {
    expect(resolveModuleIcon('importacoes')).toBe(Upload);
    expect(resolveModuleIcon('upload')).toBe(Upload);
  });
});

// Casos que quebram se a matemática de período errar: virada de mês, virada
// de ano, e o fuso (UTC-3 tarde da noite, onde `toISOString()` adiantaria o dia).
import { describe, expect, it } from 'vitest';
import {
  formatarISOparaBR,
  intervaloDoPreset,
  paraISO,
  presetAtivo,
} from './periodo';

// 15/03/2026, 22h local — se alguém trocar a implementação por `toISOString()`,
// em UTC-3 este horário vira 16/03 e todos os testes abaixo caem.
const QUINZE_MARCO = new Date(2026, 2, 15, 22, 0, 0);

describe('paraISO', () => {
  it('usa o dia LOCAL, não o UTC (22h em UTC-3 continua sendo dia 15)', () => {
    expect(paraISO(QUINZE_MARCO)).toBe('2026-03-15');
  });

  it('preenche mês e dia com zero à esquerda', () => {
    expect(paraISO(new Date(2026, 0, 5))).toBe('2026-01-05');
  });
});

describe('intervaloDoPreset', () => {
  it('hoje: de e ate no mesmo dia', () => {
    expect(intervaloDoPreset('hoje', QUINZE_MARCO)).toEqual({ de: '2026-03-15', ate: '2026-03-15' });
  });

  it('7 dias INCLUI hoje (09..15, não 08..15)', () => {
    expect(intervaloDoPreset('7d', QUINZE_MARCO)).toEqual({ de: '2026-03-09', ate: '2026-03-15' });
  });

  it('30 dias atravessa a virada de mês', () => {
    expect(intervaloDoPreset('30d', QUINZE_MARCO)).toEqual({ de: '2026-02-14', ate: '2026-03-15' });
  });

  it('este mês começa no dia 1º', () => {
    expect(intervaloDoPreset('mes', QUINZE_MARCO)).toEqual({ de: '2026-03-01', ate: '2026-03-15' });
  });

  it('30 dias atravessa a virada de ANO', () => {
    expect(intervaloDoPreset('30d', new Date(2026, 0, 10))).toEqual({
      de: '2025-12-12',
      ate: '2026-01-10',
    });
  });

  it('este mês no dia 1º devolve um intervalo de um dia só', () => {
    expect(intervaloDoPreset('mes', new Date(2026, 2, 1))).toEqual({
      de: '2026-03-01',
      ate: '2026-03-01',
    });
  });
});

describe('presetAtivo', () => {
  it('reconhece o intervalo gerado pelo próprio preset (ida e volta)', () => {
    const i = intervaloDoPreset('7d', QUINZE_MARCO);
    expect(presetAtivo(i.de, i.ate, QUINZE_MARCO)).toBe('7d');
  });

  it('intervalo digitado à mão não acende nenhum chip', () => {
    expect(presetAtivo('2026-03-02', '2026-03-11', QUINZE_MARCO)).toBeNull();
  });

  it('intervalo pela metade não acende nenhum chip', () => {
    expect(presetAtivo('2026-03-15', '', QUINZE_MARCO)).toBeNull();
    expect(presetAtivo('', '', QUINZE_MARCO)).toBeNull();
  });

  // Achado da verificação viva da rodada 4 (o E2E rodou num dia 7): há datas em
  // que dois presets descrevem EXATAMENTE o mesmo intervalo, e sem desempate
  // quem clicava em "Este mês" via "7 dias" acender.
  describe('empate entre presets', () => {
    const DIA_7 = new Date(2026, 7, 7); // 7 de agosto: "7 dias" e "Este mês" == 01..07
    const DIA_1 = new Date(2026, 7, 1); // 1º: "Hoje" e "Este mês" == 01..01

    it('no dia 7, "7 dias" e "Este mês" são o mesmo intervalo', () => {
      expect(intervaloDoPreset('7d', DIA_7)).toEqual(intervaloDoPreset('mes', DIA_7));
    });

    it('sem preferência, vence a ordem da lista (comportamento antigo, preservado)', () => {
      const i = intervaloDoPreset('mes', DIA_7);
      expect(presetAtivo(i.de, i.ate, DIA_7)).toBe('7d');
    });

    it('com preferência, o chip clicado é o que acende', () => {
      const i = intervaloDoPreset('mes', DIA_7);
      expect(presetAtivo(i.de, i.ate, DIA_7, 'mes')).toBe('mes');
      expect(presetAtivo(i.de, i.ate, DIA_7, '7d')).toBe('7d');
    });

    it('mesmo empate entre "Hoje" e "Este mês" no dia 1º', () => {
      const i = intervaloDoPreset('mes', DIA_1);
      expect(presetAtivo(i.de, i.ate, DIA_1, 'mes')).toBe('mes');
      expect(presetAtivo(i.de, i.ate, DIA_1)).toBe('hoje');
    });

    it('preferência obsoleta é ignorada — não acende um chip que não descreve o intervalo', () => {
      // Intervalo de "30 dias", mas a preferência guardada diz "hoje".
      const i = intervaloDoPreset('30d', QUINZE_MARCO);
      expect(presetAtivo(i.de, i.ate, QUINZE_MARCO, 'hoje')).toBe('30d');
    });

    it('preferência não faz um intervalo personalizado acender chip nenhum', () => {
      expect(presetAtivo('2026-03-02', '2026-03-11', QUINZE_MARCO, 'mes')).toBeNull();
    });
  });
});

describe('formatarISOparaBR', () => {
  it('converte para o formato que o operador brasileiro lê', () => {
    expect(formatarISOparaBR('2026-03-09')).toBe('09/03/2026');
  });

  it('devolve null para vazio ou lixo — sem inventar data', () => {
    expect(formatarISOparaBR('')).toBeNull();
    expect(formatarISOparaBR('09/03/2026')).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import { generateGame } from '../src/core/generate';
import { DIR_LIST, isWalkable, step } from '../src/core/map';
import { resolveTurn } from '../src/core/resolve';
import { levelFor, stats } from '../src/core/stats';
import { CLASSES, EXP_TABLE, MAX_LEVEL, MONSTERS } from '../src/data/units';

describe('経験値とレベル', () => {
  it('必要経験値の表からレベルが決まる', () => {
    expect(levelFor(0)).toBe(1);
    expect(levelFor(EXP_TABLE[1] - 1)).toBe(1);
    expect(levelFor(EXP_TABLE[1])).toBe(2);
    expect(levelFor(999999)).toBe(MAX_LEVEL);
  });

  it('レベルに応じて最大 HP・MP・攻撃力が上がる', () => {
    const lv1 = stats({ defId: 'warrior' });
    const lv3 = stats({ defId: 'warrior', level: 3 });
    const g = CLASSES.warrior.growth!;
    expect(lv3.maxHp).toBe(lv1.maxHp + g.hp * 2);
    expect(lv3.atk).toBe(lv1.atk + g.atk * 2);
    expect(stats({ defId: 'mage', level: 2 }).maxMp).toBe(CLASSES.mage.maxMp + CLASSES.mage.growth!.mp);
  });

  it('敵を倒すと気絶者を含む全員に経験値が入り、しきい値でレベルと最大 HP が上がる', () => {
    const s = generateGame(15, 'easy', 1);
    const party = s.units.filter((u) => u.side === 'party');
    const [w, , , p] = party;
    for (const u of party) u.exp = EXP_TABLE[1] - 1;
    p.down = true;
    p.hp = 0;
    const e = s.units.find((u) => u.side === 'enemy')!;
    const nb = DIR_LIST.map((d) => step(w, d)).find((q) => isWalkable(s.map, q.x, q.y) && !s.units.some((u) => u.x === q.x && u.y === q.y))!;
    e.x = nb.x;
    e.y = nb.y;
    e.hp = 1;
    const hpBefore = w.hp;
    const r = resolveTurn(s, { p1: [{ type: 'attack', target: e.id }] });
    const gained = MONSTERS[e.defId].exp!;
    expect(r.events.find((x) => x.type === 'exp')).toMatchObject({ amount: gained });
    for (const u of r.state.units.filter((u) => u.side === 'party')) {
      expect(u.exp).toBe(EXP_TABLE[1] - 1 + gained);
      expect(u.level).toBe(2);
    }
    expect(r.events.filter((x) => x.type === 'levelup').length).toBe(4);
    const w2 = r.state.units.find((u) => u.id === w.id)!;
    expect(stats(w2).maxHp).toBe(CLASSES.warrior.maxHp + CLASSES.warrior.growth!.hp);
    // 立っている者は増えた分だけ HP も増える(この戦闘で受けたダメージは差し引く)
    const taken = r.events.filter((x) => x.type === 'damage' && x.id === w.id).reduce((a, x) => a + (x.type === 'damage' ? x.amount : 0), 0);
    expect(w2.hp).toBe(Math.min(stats(w2).maxHp, hpBefore - taken + CLASSES.warrior.growth!.hp));
    // 気絶者の HP は 0 のまま
    expect(r.state.units.find((u) => u.id === p.id)!.hp).toBe(0);
  });
});

// 地上の住人の噂。住人は、隣に来た味方に「あることないこと」を話す。
// 噂の中身は、各階を作ったときの状態(generateFloor はシードから決まる)を元にした本当の話か、それを曲げた嘘。
// 住人に化けた盗人(ai.disguise)は、いつも嘘をつく。
import { MONSTERS } from '../data/units';
import { FLOORS, generateFloor } from './generate';
import { Rng, hashSeed } from './rng';
import type { Dir, GameEvent, GameState, Rumor, Unit } from './types';
import { TICKS_PER_TURN } from './types';

/** 住人が本当のことを言う確率 */
export const RUMOR_TRUTH = 0.6;
/** 同じ住人がもう一度噂を話すまでのターン数 */
export const RUMOR_COOLDOWN = 6;

/** 噂に出てくるモンスター(住人・野盗・ボスは除く) */
const RUMOR_MONSTERS = Object.keys(MONSTERS).filter((id) => !['resident', 'bandit', 'dragon', 'wyrm'].includes(id));
const OPPOSITE: Record<Dir, Dir> = { N: 'S', S: 'N', E: 'W', W: 'E' };

/** ターンの終わり: 立っている味方の隣(斜めを含む)にいる住人が 1 人、噂を話す(1 ターンに 1 つまで) */
export function applyRumors(state: GameState, events: GameEvent[]): void {
  if ((state.floor ?? 1) !== 0) return;
  const party = state.units.filter((u) => u.side === 'party' && !u.down);
  const talker = state.units.find(
    (u) =>
      u.defId === 'resident' &&
      !u.down &&
      state.turn - (u.ai?.talked ?? -Infinity) >= RUMOR_COOLDOWN &&
      party.some((p) => Math.max(Math.abs(p.x - u.x), Math.abs(p.y - u.y)) === 1),
  );
  if (!talker) return;
  (talker.ai ??= { mode: 'idle' }).talked = state.turn;
  const rng = new Rng(hashSeed('rumor', state.seed, state.turn, talker.id));
  events.push({ tick: TICKS_PER_TURN, type: 'rumor', id: talker.id, rumor: makeRumor(state, talker, rng) });
}

/** 噂を 1 つ作る。truth は本当の話か(化けた盗人はいつも嘘) */
export function makeRumor(state: GameState, talker: Unit, rng: Rng): Rumor {
  const truth = !talker.ai?.disguise && rng.next() < RUMOR_TRUTH;
  const floor = rng.int(1, FLOORS);
  const kind = rng.int(0, 4);
  if (kind === 4) {
    // 住人に化けた盗人の話(本当かどうかは、地上に化けた盗人がいるか)
    const real = state.units.some((u) => u.ai?.disguise && !u.down);
    return { kind: 'thief', claim: truth ? real : !real, truth };
  }
  const f = generateFloor(state.seed, state.difficulty ?? 'normal', floor);
  if (kind === 0 && f.down) {
    const dx = f.down.x - f.up.x;
    const dy = f.down.y - f.up.y;
    const dir: Dir = Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? 'E' : 'W') : dy >= 0 ? 'S' : 'N';
    return { kind: 'stairs', floor, dir: truth ? dir : OPPOSITE[dir], truth };
  }
  if (kind === 1) {
    const here = new Set(f.enemies.map((u) => u.defId));
    const pool = RUMOR_MONSTERS.filter((id) => here.has(id) === truth);
    if (pool.length > 0) return { kind: 'monster', floor, monster: pool[rng.int(0, pool.length - 1)], truth };
  }
  if (kind === 2) {
    const n = f.map.tiles.join('').split('$').length - 1;
    const lie = Math.max(0, n + (rng.next() < 0.5 ? -1 : 1) * rng.int(1, 2));
    return { kind: 'chests', floor, n: truth ? n : lie === n ? n + 1 : lie, truth };
  }
  // 竜の話(地下 5 階の奥で眠っている、が本当)
  return { kind: 'dragon', asleep: truth, truth };
}

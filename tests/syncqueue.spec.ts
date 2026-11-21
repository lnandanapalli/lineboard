import { expect, test } from '@playwright/test';

/**
 * The save queue on its own (no browser): a fake store whose saves can be held open, and an
 * in-memory localStorage shared by "tabs", like one browser profile.
 */

class MemStorage {
  private m = new Map<string, string>();
  get length() {
    return this.m.size;
  }
  key(i: number) {
    return [...this.m.keys()][i] ?? null;
  }
  getItem(k: string) {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, String(v));
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
}

type Stroke = { id: string; note_id: string; tool: 'pen'; color: string; width: number; points: number[] };
const stroke = (id: string, note: string): Stroke => ({ id, note_id: note, tool: 'pen', color: '#000', width: 2, points: [0, 0, 0.5] });

/**
 * A store whose upserts wait until released, recording what was sent. A release that comes before
 * the save has started (the queue first waits for its lock) is kept for it, not lost.
 */
function fakeStore() {
  const sent: string[][] = [];
  const waiting: (() => void)[] = [];
  let early = 0;
  return {
    sent,
    release: () => {
      const next = waiting.shift();
      if (next) next();
      else early++;
    },
    store: {
      upsertStrokes: (s: Stroke[]) =>
        new Promise<void>((res) => {
          const done = () => {
            sent.push(s.map((x) => x.id));
            res();
          };
          if (early) {
            early--;
            done();
          } else waiting.push(done);
        }),
      deleteStrokes: async () => {},
    },
  };
}

const settle = () => new Promise((r) => setTimeout(r, 20));

/**
 * Each test's own queue name: the queue takes a Web Lock by that name, and locks are shared by the
 * whole process, so a test that leaves a save unfinished on purpose must not hold up the next one.
 */
let KEY = '';

test.beforeEach(() => {
  KEY = 'lb-queue-' + crypto.randomUUID();
  const g = globalThis as Record<string, unknown>;
  g.localStorage = new MemStorage();
  g.window = { addEventListener() {} };
});

test('deleting a note while a save is in flight never drops another note’s waiting change', async () => {
  const { SyncQueue } = await import('../src/sync');
  const f = fakeStore();
  const q = new SyncQueue(f.store as never, KEY);
  q.upsert([stroke('a1', 'A')]); // starts sending at once and waits
  await settle();
  q.upsert([stroke('b1', 'B')]);
  q.dropNote('A'); // the note being sent is deleted meanwhile
  f.release(); // the save of A finishes
  await settle();
  f.release(); // B must still be sent
  await settle();
  expect(f.sent).toEqual([['a1'], ['b1']]);
  expect(q.pending).toBe(0);
});

test('two tabs queuing at once both keep their changes for the next load', async () => {
  const { SyncQueue } = await import('../src/sync');
  const f1 = fakeStore();
  const f2 = fakeStore();
  const tab1 = new SyncQueue(f1.store as never, KEY);
  const tab2 = new SyncQueue(f2.store as never, KEY);
  tab1.upsert([stroke('one', 'A')]);
  tab2.upsert([stroke('two', 'A')]);
  await settle();
  tab1.stop();
  tab2.stop();
  // A reload (a new queue on the same storage) still has both.
  const f3 = fakeStore();
  const reloaded = new SyncQueue(f3.store as never, KEY);
  expect(reloaded.pending).toBe(2);
  expect(reloaded.overlay('A', []).map((s) => s.id).sort()).toEqual(['one', 'two']);
  reloaded.stop();
});

test('the old single-value queue is carried over on load', async () => {
  const { SyncQueue } = await import('../src/sync');
  localStorage.setItem(KEY, JSON.stringify([{ kind: 'upsert', strokes: [stroke('old', 'A')] }]));
  const f = fakeStore();
  const q = new SyncQueue(f.store as never, KEY);
  expect(q.pending).toBe(1);
  expect(localStorage.getItem(KEY)).toBeNull();
  f.release();
  await settle();
  expect(f.sent).toEqual([['old']]);
  expect(q.pending).toBe(0);
});

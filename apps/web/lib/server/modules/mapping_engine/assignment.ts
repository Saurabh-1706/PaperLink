/**
 * Stage 6 — global one-to-one assignment (ADR-003). Port of
 * backend/app/modules/mapping_engine/assignment.py.
 *
 * Greedy per-answer matching lets one strong local match steal an answer another
 * question needed. The score matrix is solved once, for the whole sheet.
 *
 * The Python source solved this via `scipy.optimize.linear_sum_assignment`
 * (Hungarian algorithm), with a greedy fallback only for the case scipy itself
 * failed to import — never the default. There is no scipy equivalent as a JS
 * dependency here, so this hand-rolls the O(n^2 * m) Kuhn-Munkres algorithm
 * (the classic potentials formulation) directly — always the real solver, never
 * the greedy shortcut.
 */

const INF = Infinity;

/** Minimum-cost perfect matching of every row to a distinct column, for a cost
 * matrix with rows.length <= cols.length. Returns, per row, its matched column. */
function hungarianMinCost(cost: number[][]): number[] {
  const n = cost.length;
  const m = cost[0].length;
  const u = new Array(n + 1).fill(0);
  const v = new Array(m + 1).fill(0);
  const p = new Array(m + 1).fill(0); // p[j] = 1-based row matched to column j (0 = unmatched)
  const way = new Array(m + 1).fill(0);

  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array(m + 1).fill(INF);
    const used = new Array(m + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0];
      let delta = INF;
      let j1 = -1;
      for (let j = 1; j <= m; j++) {
        if (used[j]) continue;
        const cur = cost[i0 - 1][j - 1] - u[i0] - v[j];
        if (cur < minv[j]) {
          minv[j] = cur;
          way[j] = j0;
        }
        if (minv[j] < delta) {
          delta = minv[j];
          j1 = j;
        }
      }
      for (let j = 0; j <= m; j++) {
        if (used[j]) {
          u[p[j]] += delta;
          v[j] -= delta;
        } else {
          minv[j] -= delta;
        }
      }
      j0 = j1;
    } while (p[j0] !== 0);

    do {
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    } while (j0 !== 0);
  }

  const result = new Array(n).fill(-1);
  for (let j = 1; j <= m; j++) {
    if (p[j] > 0) result[p[j] - 1] = j - 1;
  }
  return result;
}

/** Return (row, column) pairs maximising total score, dropping pairs below the floor. */
export function solve(matrix: number[][], rejectBelow: number): Array<[number, number]> {
  if (matrix.length === 0 || matrix[0].length === 0) return [];

  const rows = matrix.length;
  const cols = matrix[0].length;
  let pairs: Array<[number, number]>;

  // The algorithm requires rows <= cols; transpose (swap the row/column roles) when
  // there are more questions than answers, then swap the result back.
  if (rows <= cols) {
    const cost = matrix.map((row) => row.map((value) => -value));
    const assignment = hungarianMinCost(cost);
    pairs = assignment
      .map((col, row): [number, number] => [row, col])
      .filter(([, col]) => col >= 0);
  } else {
    const costT: number[][] = [];
    for (let c = 0; c < cols; c++) {
      const row: number[] = [];
      for (let r = 0; r < rows; r++) row.push(-matrix[r][c]);
      costT.push(row);
    }
    const assignment = hungarianMinCost(costT);
    pairs = assignment
      .map((row, col): [number, number] => [row, col])
      .filter(([row]) => row >= 0);
  }

  return pairs.filter(([r, c]) => matrix[r][c] >= rejectBelow);
}

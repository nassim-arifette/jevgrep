import { DatabaseSync } from 'node:sqlite';
import type { PoolItem } from './score-pool.ts';

/**
 * A read-only view of a CodeGraph index (`.codegraph/codegraph.db`) and bounded
 * relationship expansion over JevGrep fragments, for experiment E7.
 *
 * An edge only proposes a candidate: every proposed fragment comes from the current
 * authorized snapshot and still needs a Jev judgment. A missing edge proves nothing.
 */
export type GraphNode = {
  readonly id: string; readonly kind: string; readonly name: string; readonly qualifiedName: string;
  readonly path: string; readonly startLine: number; readonly endLine: number;
};
export type CodeGraph = {
  readonly nodes: ReadonlyMap<string, GraphNode>;
  readonly byFile: ReadonlyMap<string, readonly GraphNode[]>;
  readonly adjacent: ReadonlyMap<string, readonly { readonly id: string; readonly kind: string }[]>;
  readonly stats: { readonly nodes: number; readonly edges: number; readonly unresolved: number };
};

/** Relationships followed, strongest first; `contains` is structure, not a relation. */
export const relationKinds = ['calls', 'instantiates', 'extends', 'references', 'imports'] as const;
const symbolKinds = new Set(['function', 'method', 'class', 'variable']);

export function loadCodeGraph(path: string): CodeGraph {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const nodes = new Map<string, GraphNode>();
    for (const row of db.prepare('SELECT id, kind, name, qualified_name, file_path, start_line, end_line FROM nodes').all()) {
      const node = { id: String(row['id']), kind: String(row['kind']), name: String(row['name']), qualifiedName: String(row['qualified_name']),
        path: String(row['file_path']), startLine: Number(row['start_line']), endLine: Number(row['end_line']) };
      nodes.set(node.id, node);
    }
    const byFile = new Map<string, GraphNode[]>();
    for (const node of nodes.values()) if (symbolKinds.has(node.kind)) (byFile.get(node.path) ?? byFile.set(node.path, []).get(node.path)!).push(node);
    const adjacent = new Map<string, { id: string; kind: string }[]>();
    const add = (from: string, to: string, kind: string): void => {
      (adjacent.get(from) ?? adjacent.set(from, []).get(from)!).push({ id: to, kind });
    };
    let edges = 0;
    const placeholders = relationKinds.map(() => '?').join(', ');
    for (const row of db.prepare(`SELECT source, target, kind FROM edges WHERE kind IN (${placeholders})`).all(...relationKinds)) {
      const source = String(row['source']); const target = String(row['target']); const kind = String(row['kind']);
      // Unresolved module stubs (`import` nodes) point nowhere in the snapshot.
      if (!symbolKinds.has(nodes.get(target)?.kind ?? '') && nodes.get(target)?.kind !== 'file') continue;
      add(source, target, kind); add(target, source, kind); edges += 1;
    }
    for (const list of adjacent.values()) {
      list.sort((a, b) => relationKinds.indexOf(a.kind as never) - relationKinds.indexOf(b.kind as never)
        || compareNodes(nodes.get(a.id), nodes.get(b.id)));
    }
    const unresolved = Number(db.prepare('SELECT count(*) AS n FROM unresolved_refs').get()?.['n'] ?? 0);
    return { nodes, byFile, adjacent, stats: { nodes: nodes.size, edges, unresolved } };
  } finally {
    db.close();
  }
}

function compareNodes(a: GraphNode | undefined, b: GraphNode | undefined): number {
  if (a === undefined || b === undefined) return a === b ? 0 : a === undefined ? 1 : -1;
  return a.path < b.path ? -1 : a.path > b.path ? 1 : a.startLine - b.startLine;
}

const overlaps = (item: PoolItem, start: number, end: number): boolean => item.startLine <= end && item.endLine >= start;

/** Symbols a fragment stands for: those defined inside it, else the innermost one enclosing it. */
export function symbolsOf(graph: CodeGraph, item: PoolItem): GraphNode[] {
  const inFile = graph.byFile.get(item.path) ?? [];
  const defined = inFile.filter((node) => node.startLine >= item.startLine && node.startLine <= item.endLine);
  if (defined.length > 0) return defined;
  const enclosing = inFile.filter((node) => node.startLine <= item.startLine && node.endLine >= item.endLine)
    .sort((a, b) => (a.endLine - a.startLine) - (b.endLine - b.startLine));
  return enclosing.slice(0, 1);
}

/** Current fragments for a proposed symbol: its body for callables, its head for classes and variables. */
export function fragmentsOf(node: GraphNode, items: readonly PoolItem[]): PoolItem[] {
  if (!symbolKinds.has(node.kind)) return [];
  const callable = node.kind === 'function' || node.kind === 'method';
  return items.filter((item) => item.path === node.path && (callable ? overlaps(item, node.startLine, node.endLine)
    : item.startLine <= node.startLine && item.endLine >= node.startLine));
}

export type Origin = 'seed' | 'hop1' | 'hop2' | 'lexical' | 'graph-tool' | 'adjacent';
export type Candidate = { readonly item: PoolItem; readonly origin: Origin };

export type ExpansionOptions = {
  /** Total fragments Jev may evaluate; identical across arms. */
  readonly budget: number;
  /** Lexical seeds taken before relationship expansion. */
  readonly seeds: number;
  readonly hops: 0 | 1 | 2;
  /** Neighbors followed per symbol and hop. */
  readonly fanout: number;
};

/**
 * Seeds from a fixed lexical ranking, then up to `hops` relationship hops, interleaved
 * across seeds so one hub cannot take the whole allowance. Visited symbols and
 * fragments are deduplicated, which also terminates cycles. Unused allowance falls
 * back to the same lexical ranking, so every arm evaluates the same number of fragments.
 */
export function expandCandidates(ranked: readonly PoolItem[], graph: CodeGraph | null, options: ExpansionOptions): Candidate[] {
  const chosen: Candidate[] = [];
  const taken = new Set<PoolItem>();
  const take = (item: PoolItem, origin: Origin): boolean => {
    if (chosen.length >= options.budget || taken.has(item)) return false;
    taken.add(item); chosen.push({ item, origin });
    return true;
  };
  const seeds = ranked.slice(0, options.hops === 0 ? options.budget : Math.min(options.seeds, options.budget));
  for (const item of seeds) take(item, 'seed');
  if (graph !== null && options.hops > 0) {
    const visited = new Set<string>();
    const unvisited = (node: GraphNode): boolean => {
      if (visited.has(node.id)) return false;
      visited.add(node.id);
      return true;
    };
    let frontier: GraphNode[][] = seeds.map((item) => symbolsOf(graph, item).filter(unvisited));
    for (let hop = 1; hop <= options.hops && chosen.length < options.budget; hop += 1) {
      const next: GraphNode[][] = [];
      const lanes = frontier.map((nodes) => nodes.flatMap((node) => (graph.adjacent.get(node.id) ?? []).slice(0, options.fanout)
        .map((edge) => graph.nodes.get(edge.id)).filter((neighbor): neighbor is GraphNode => neighbor !== undefined)));
      for (let index = 0; lanes.some((lane) => index < lane.length) && chosen.length < options.budget; index += 1) {
        lanes.forEach((lane, seed) => {
          const neighbor = lane[index];
          if (neighbor === undefined || !unvisited(neighbor)) return;
          (next[seed] ??= []).push(neighbor);
          for (const item of fragmentsOf(neighbor, ranked)) take(item, hop === 1 ? 'hop1' : 'hop2');
        });
      }
      frontier = next.map((nodes) => nodes ?? []);
    }
  }
  for (const item of ranked) if (!take(item, 'lexical') && chosen.length >= options.budget) break;
  return chosen;
}

/**
 * Locality control for E7: the same seeds and allowance, but neighbors are the fragments
 * next to each seed in its own file (±1, then ±2), with no relationship data at all.
 */
export function adjacentCandidates(ranked: readonly PoolItem[], options: Omit<ExpansionOptions, 'hops' | 'fanout'>): Candidate[] {
  const chosen: Candidate[] = [];
  const taken = new Set<PoolItem>();
  const take = (item: PoolItem | undefined, origin: Origin): void => {
    if (item !== undefined && chosen.length < options.budget && !taken.has(item)) { taken.add(item); chosen.push({ item, origin }); }
  };
  const seeds = ranked.slice(0, Math.min(options.seeds, options.budget));
  for (const item of seeds) take(item, 'seed');
  const byFile = new Map<string, PoolItem[]>();
  for (const item of ranked) (byFile.get(item.path) ?? byFile.set(item.path, []).get(item.path)!).push(item);
  for (const list of byFile.values()) list.sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);
  for (const distance of [1, 2]) {
    for (const seed of seeds) {
      const list = byFile.get(seed.path)!;
      const at = list.indexOf(seed);
      take(list[at - distance], 'adjacent');
      take(list[at + distance], 'adjacent');
    }
  }
  for (const item of ranked) take(item, 'lexical');
  return chosen;
}

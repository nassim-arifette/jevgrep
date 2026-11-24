/**
 * Language-neutral recursive chunk planning (language search spec 3.1, LS-1 and LS-3).
 *
 * A cAST-style policy over a minimal tree interface: a node that fits the active limits
 * stays whole and is packed with neighbouring siblings; an oversized node is split along
 * its own children, recursively and without a fixed depth, before line windows are used
 * as the last resort inside the smallest oversized node. A small header is carried into
 * the oversized node it opens, tiny remnants merge into a neighbour, and every range cut
 * from a declaration records that declaration's lines. The plan is made of line ranges
 * only; the caller slices fragments from the verified snapshot, so returned source is
 * never transformed.
 *
 * Parsers are adapted to `SyntaxTree`: the TypeScript compiler tree for JS/TS
 * (`javascript-chunker.ts`) and Tree-sitter trees for Go and Rust (`tree-sitter-chunker.ts`).
 * An adapter decides what a node's children are and where a node starts, so leading
 * trivia (comments, attributes, decorators) is part of the node it precedes.
 *
 * A file with syntax errors keeps structural ranges for the top-level items whose lines
 * hold no error; those that do are split into plain line windows (LS-8). If the damaged
 * items cover most of the file, the whole file falls back instead.
 */
import type { WindowLimits } from './line-windows.ts';
import type { SourceSnapshot } from './snapshot.ts';

/** A structural symbol a node introduces (`function:handle`), with the lines it spans. */
export type PlanSymbol = {
  readonly kind: string;
  readonly name: string;
  readonly signature: string | null;
  readonly startLine: number;
  readonly endLine: number;
};

/** The tree a parser exposes to the planner; lines are 1-based and inclusive. */
export interface SyntaxTree<N> {
  readonly root: N;
  /** Ordered structural children, without the trivia that `startLine` already attaches. */
  children(node: N): readonly N[];
  /** First line of a node, including the leading trivia attached to it. */
  startLine(node: N): number;
  endLine(node: N): number;
  /** The symbol a node introduces, if any. */
  symbolOf(node: N): PlanSymbol | null;
}

/**
 * Label policy. `local` labels a range with the outermost symbol that starts in it;
 * `enclosing` and `compact` render the enclosing chain (JS/TS benchmark arms, E1).
 */
export type LabelPolicy = 'enclosing' | 'compact' | 'local';

export type PlanOptions = {
  readonly policy: LabelPolicy;
  /** Symbol kinds that are declarations: a range cut from one records its lines. */
  readonly declarationKinds: ReadonlySet<string>;
  /** Lines holding a syntax error; a top-level item containing one becomes line windows. */
  readonly damagedLines: readonly number[];
  /**
   * Inside a split node, a range's own symbol comes from its first unit only, so a
   * continuation is never labelled with a nested symbol it happens to contain (D7).
   */
  readonly firstUnitLabels?: boolean;
  /**
   * A tiny remnant merges only within the declaration it was cut from, so the tail of a
   * split declaration never absorbs the next declaration and its label.
   */
  readonly mergeWithinDeclarations?: boolean;
};

export type PlannedRange = {
  readonly startLine: number;
  readonly endLine: number;
  readonly label: string | null;
  /** No usable syntax inside: the caller splits the range into line windows. */
  readonly windows: boolean;
  /** Label every window of a split range, not only the first. */
  readonly labelEveryWindow: boolean;
  /** The innermost declaration the range was cut from, when that declaration was split. */
  readonly declaration: { readonly startLine: number; readonly endLine: number } | null;
};

export type SyntaxPlan =
  | { readonly ok: true; readonly ranges: readonly PlannedRange[]; readonly recovered: boolean }
  | { readonly ok: false; readonly reason: 'parse_failure' };

type Chunk = {
  startLine: number;
  endLine: number;
  ancestry: readonly PlanSymbol[];
  own: PlanSymbol | null;
  /** Enclosing declarations being split, outermost first. */
  declarations: readonly PlanSymbol[];
  windows: boolean;
  /** A top-level statement containing a parse error. */
  damaged?: true;
  /** `own` is fixed to the first unit's symbol (`firstUnitLabels` inside a split node). */
  firstUnitOwn?: true;
};

type Unit<N> = { startLine: number; endLine: number; nodes: N[] };

/** Ranges at or below this many reference tokens are merged into a neighbour when possible. */
const TINY_TOKENS = 64;
/** A small header (`function f() {`, `if (x) {`) is carried into the oversized node it opens. */
const HEADER_TOKENS = 160;
const MAX_DEPTH = 400;
const MAX_LABEL_CHARACTERS = 400;
/** Above this share of damaged lines, structural recovery is not trusted. */
const MAX_RECOVERED_SHARE = 0.5;

export function bounded(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

/** Planner over one parsed file. */
class Planner<N> {
  readonly #snapshot: SourceSnapshot;
  readonly #tree: SyntaxTree<N>;
  readonly #limits: WindowLimits;
  readonly #declarationKinds: ReadonlySet<string>;
  readonly #firstUnitLabels: boolean;
  readonly #mergeWithinDeclarations: boolean;

  constructor(snapshot: SourceSnapshot, tree: SyntaxTree<N>, limits: WindowLimits, options: PlanOptions) {
    this.#snapshot = snapshot;
    this.#tree = tree;
    this.#limits = limits;
    this.#declarationKinds = options.declarationKinds;
    this.#firstUnitLabels = options.firstUnitLabels === true;
    this.#mergeWithinDeclarations = options.mergeWithinDeclarations === true;
  }

  oversized(startLine: number, endLine: number): boolean {
    return this.#snapshot.rangeTokens(startLine, endLine) > this.#limits.maxTokens
      || this.#snapshot.rangeBytes(startLine, endLine) > this.#limits.maxBytes
      || endLine - startLine + 1 > this.#limits.maxLines;
  }

  fitsTarget(startLine: number, endLine: number): boolean {
    return this.#snapshot.rangeTokens(startLine, endLine) <= this.#limits.targetTokens
      && this.#snapshot.rangeBytes(startLine, endLine) <= this.#limits.maxBytes
      && endLine - startLine + 1 <= this.#limits.maxLines;
  }

  fitsHard(startLine: number, endLine: number): boolean {
    return !this.oversized(startLine, endLine);
  }

  tokens(startLine: number, endLine: number): number {
    return this.#snapshot.rangeTokens(startLine, endLine);
  }

  /** Partition `[startLine, endLine]` at the start lines of `node`'s children. */
  units(node: N, startLine: number, endLine: number): Unit<N>[] {
    const units: Unit<N>[] = [{ startLine, endLine, nodes: [] }];
    for (const child of this.#tree.children(node)) {
      const start = this.#tree.startLine(child);
      const last = units[units.length - 1]!;
      if (start > last.startLine && start <= endLine) {
        last.endLine = start - 1;
        units.push({ startLine: start, endLine, nodes: [child] });
      } else {
        last.nodes.push(child);
      }
    }
    return units;
  }

  /** The child that spans the most lines; the one an oversized unit descends into. */
  widest(nodes: readonly N[]): N | null {
    let best: N | null = null;
    let span = -1;
    for (const node of nodes) {
      const current = this.#tree.endLine(node) - this.#tree.startLine(node);
      if (current > span) {
        best = node;
        span = current;
      }
    }
    return best;
  }

  /** The symbol a unit starts with: the first node's own symbol or one of its leading wrappers'. */
  ownSymbol(unit: Unit<N>): PlanSymbol | null {
    let node: N | null = unit.nodes[0] ?? null;
    const start = node === null ? 0 : this.#tree.startLine(node);
    for (let depth = 0; node !== null && depth < 6; depth += 1) {
      const symbol = this.#tree.symbolOf(node);
      if (symbol !== null) return symbol;
      node = this.widest(this.#tree.children(node).filter((child) => this.#tree.startLine(child) === start));
    }
    return null;
  }

  /** Split `node`, whose lines are `[startLine, endLine]`, into chunks under the limits. */
  plan(node: N, startLine: number, endLine: number, ancestry: readonly PlanSymbol[], declarations: readonly PlanSymbol[],
    depth: number, damaged?: (startLine: number, endLine: number) => boolean): Chunk[] {
    const symbol = node === this.#tree.root ? null : this.#tree.symbolOf(node);
    const context = symbol === null ? ancestry : [...ancestry, symbol];
    const declared = symbol !== null && this.#declarationKinds.has(symbol.kind) ? [...declarations, symbol] : declarations;
    const leaf = (): Chunk[] => [{ startLine, endLine, ancestry: context, own: null, declarations: declared, windows: true }];
    if (depth > MAX_DEPTH) return leaf();

    const units = this.units(node, startLine, endLine);
    if (damaged !== undefined && units.length === 1 && damaged(startLine, endLine)) {
      return [{ startLine, endLine, ancestry: [], own: null, declarations: [], windows: true, damaged: true }];
    }
    if (units.length === 1) {
      // Every child starts on the first line: descend through the wrapper that holds the rest.
      const inner = this.widest(units[0]!.nodes);
      return inner === null ? leaf() : this.plan(inner, startLine, endLine, context, declared, depth + 1);
    }

    const firstUnitOwn = this.#firstUnitLabels && depth > 0;
    const chunks: Chunk[] = [];
    let pending: Chunk | null = null;
    const flush = (): void => {
      if (pending !== null) chunks.push(pending);
      pending = null;
    };
    for (const unit of units) {
      if (damaged?.(unit.startLine, unit.endLine) === true) {
        flush();
        chunks.push({
          startLine: unit.startLine, endLine: unit.endLine, ancestry: [], own: null, declarations: [], windows: true, damaged: true,
        });
        continue;
      }
      if (this.oversized(unit.startLine, unit.endLine)) {
        let start = unit.startLine;
        const header: Chunk | null = pending;
        if (header !== null && header.own === null && this.tokens(header.startLine, header.endLine) <= HEADER_TOKENS) {
          start = header.startLine;
          pending = null;
        } else {
          flush();
        }
        const inner = this.widest(unit.nodes);
        chunks.push(...(inner === null
          ? [{ startLine: start, endLine: unit.endLine, ancestry: context, own: null, declarations: declared, windows: true }]
          : this.plan(inner, start, unit.endLine, context, declared, depth + 1)));
        continue;
      }
      const current: Chunk | null = pending;
      if (current !== null && this.fitsTarget(current.startLine, unit.endLine)) {
        current.endLine = unit.endLine;
        if (current.firstUnitOwn !== true) current.own ??= this.ownSymbol(unit);
        continue;
      }
      flush();
      pending = {
        startLine: unit.startLine, endLine: unit.endLine, ancestry: context, own: this.ownSymbol(unit), declarations: declared,
        windows: false, ...(firstUnitOwn ? { firstUnitOwn: true as const } : {}),
      };
    }
    flush();
    return chunks;
  }

  /** Fold tiny structural remnants (`return dom; }`, a lone header) into a contiguous neighbour. */
  mergeTiny(chunks: Chunk[]): Chunk[] {
    const result: Chunk[] = [];
    for (const chunk of chunks) {
      const previous = result[result.length - 1];
      if (previous !== undefined && !previous.windows && !chunk.windows && previous.endLine + 1 === chunk.startLine
        && (this.tokens(chunk.startLine, chunk.endLine) <= TINY_TOKENS || this.tokens(previous.startLine, previous.endLine) <= TINY_TOKENS)
        && this.fitsHard(previous.startLine, chunk.endLine)) {
        const declarations = mergedDeclarations(previous.declarations, chunk.declarations);
        const declaration = declarations.at(-1);
        if (this.#mergeWithinDeclarations && declaration !== undefined
          && (previous.startLine < declaration.startLine || chunk.endLine > declaration.endLine)) {
          result.push(chunk);
          continue;
        }
        result[result.length - 1] = {
          startLine: previous.startLine, endLine: chunk.endLine, ancestry: commonAncestry(previous.ancestry, chunk.ancestry),
          own: previous.firstUnitOwn === true ? previous.own : previous.own ?? chunk.own,
          declarations, windows: false,
          ...(previous.firstUnitOwn === true ? { firstUnitOwn: true as const } : {}),
        };
        continue;
      }
      result.push(chunk);
    }
    return result;
  }
}

function commonAncestry(left: readonly PlanSymbol[], right: readonly PlanSymbol[]): readonly PlanSymbol[] {
  let length = 0;
  while (length < left.length && length < right.length && left[length] === right[length]) length += 1;
  return left.slice(0, length);
}

/**
 * The declarations a merged range was cut from: those both parts were cut from, or the
 * outermost one a part was cut from when they share none.
 */
function mergedDeclarations(left: readonly PlanSymbol[], right: readonly PlanSymbol[]): readonly PlanSymbol[] {
  const common = commonAncestry(left, right);
  if (common.length > 0) return common;
  const outermost = left[0] ?? right[0];
  return outermost === undefined ? [] : [outermost];
}

function render(symbol: PlanSymbol, withSignature: boolean): string {
  return `${symbol.kind}:${symbol.name}${withSignature && symbol.signature !== null ? symbol.signature : ''}`;
}

/** Enclosing symbols, outermost first, then the first symbol the range declares. */
function enclosingLabel(chunk: Chunk): string | null {
  const parts: string[] = [];
  const symbols = chunk.own !== null && !chunk.ancestry.includes(chunk.own) ? [...chunk.ancestry, chunk.own] : [...chunk.ancestry];
  for (const symbol of symbols) {
    const partial = symbol.startLine < chunk.startLine || symbol.endLine > chunk.endLine;
    parts.push(`${render(symbol, true)}${partial ? ` [lines ${String(symbol.startLine)}-${String(symbol.endLine)}]` : ''}`);
  }
  if (parts.length === 0) return null;
  let label = parts.join(' > ');
  // Keep the outermost and innermost symbols; elide the middle of a deep chain.
  while (label.length > MAX_LABEL_CHARACTERS && parts.length > 3) {
    if (parts[1] === '…') parts.splice(2, 1);
    else parts.splice(1, 1, '…');
    label = parts.join(' > ');
  }
  return bounded(label, MAX_LABEL_CHARACTERS);
}

/** Enclosing symbol names only: no signatures and no line spans. */
function compactLabel(chunk: Chunk): string | null {
  const symbols = chunk.own !== null && !chunk.ancestry.includes(chunk.own) ? [...chunk.ancestry, chunk.own] : [...chunk.ancestry];
  if (symbols.length === 0) return null;
  const parts = symbols.map((symbol) => render(symbol, false));
  let label = parts.join(' > ');
  while (label.length > MAX_LABEL_CHARACTERS && parts.length > 3) {
    if (parts[1] === '…') parts.splice(2, 1);
    else parts.splice(1, 1, '…');
    label = parts.join(' > ');
  }
  return bounded(label, MAX_LABEL_CHARACTERS);
}

/** The previous convention: the outermost symbol that starts inside the range, without context. */
function localLabel(chunk: Chunk): string | null {
  const starting = [...chunk.ancestry, ...(chunk.own === null ? [] : [chunk.own])]
    .find((symbol) => symbol.startLine >= chunk.startLine && symbol.startLine <= chunk.endLine);
  return starting === undefined ? null : bounded(render(starting, false), 160);
}

/**
 * Plan the fragments of one parsed snapshot. Pure and deterministic; nothing from the
 * repository is resolved, compiled or executed.
 */
export function planSyntaxRanges<N>(snapshot: SourceSnapshot, tree: SyntaxTree<N>, limits: WindowLimits, options: PlanOptions): SyntaxPlan {
  const planner = new Planner(snapshot, tree, limits, options);
  const damagedLines = options.damagedLines;
  const damaged = damagedLines.length === 0 ? undefined
    : (startLine: number, endLine: number): boolean => damagedLines.some((line) => line >= startLine && line <= endLine);

  const chunks = planner.mergeTiny(planner.plan(tree.root, 1, snapshot.lineCount, [], [], 0, damaged));
  if (damaged !== undefined) {
    const lines = chunks.filter((chunk) => chunk.damaged === true)
      .reduce((sum, chunk) => sum + chunk.endLine - chunk.startLine + 1, 0);
    if (lines > snapshot.lineCount * MAX_RECOVERED_SHARE) return { ok: false, reason: 'parse_failure' };
  }
  const labelOf = options.policy === 'enclosing' ? enclosingLabel : options.policy === 'compact' ? compactLabel : localLabel;
  return {
    ok: true,
    recovered: damaged !== undefined,
    ranges: chunks.map((chunk) => {
      const declaration = chunk.declarations.at(-1);
      return {
        startLine: chunk.startLine, endLine: chunk.endLine, windows: chunk.windows,
        label: labelOf(chunk), labelEveryWindow: options.policy !== 'local',
        declaration: declaration === undefined ? null : { startLine: declaration.startLine, endLine: declaration.endLine },
      };
    }),
  };
}

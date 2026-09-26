import { availableParallelism } from 'node:os';
import { ensureMirror, exportSnapshot, mapLimit, validateTask, type RealTask } from './real-tasks.ts';

/** Export and verify every pinned snapshot, in parallel. */
export async function loadSnapshots(tasks: readonly RealTask[], mirrorRoot: string) {
  const mirrors = new Map(await Promise.all([...new Set(tasks.map((task) => task.repository))]
    .map(async (name) => [name, await ensureMirror(mirrorRoot, name)] as const)));
  const snapshots = await mapLimit(tasks, availableParallelism(), async (task) => {
    const files = await exportSnapshot(mirrors.get(task.repository)!, task.repository, task.baseCommit);
    validateTask(task, files);
    return [task.id, files] as const;
  });
  return new Map(snapshots);
}


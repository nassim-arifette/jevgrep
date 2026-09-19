# Source authorization: Node 24 and Windows guarantees

Research date: **2026-09-19**. Scope: [specification §5.1](../specification.md#51-configuration-trust) and the pre-hardening [authorization draft](../../src/source/authorization.ts), SHA-256 `730013e697ac49763abac350e242966a727f760fbf07d6c6287eec4e917a276b`. This note proposes implementation and tests; it does not certify the resulting implementation or close JG-008.

The feasible MVP is a checked, bounded reader for an operator-controlled tree. **Pure Node path checks do not establish an OS sandbox, and `isSymbolicLink()` cannot establish rejection of every Windows reparse-point type.** A Windows attribute check is needed for that explicit requirement.

## Facts that determine the implementation

| Concern | Verified guarantee and limit |
| --- | --- |
| Link checks | `lstat` examines the named entry itself; `stat` follows links. Check every component before descending, not only the final file. A metadata call on `parent/file` still requires resolving `parent`. [Node 24.15 fs](https://nodejs.org/download/release/v24.15.0/docs/api/fs.html#fslstatpath-options-callback) |
| Windows reparse types | Node's bundled libuv recognizes ordinary symlinks and drive-target junctions, but its `fs__readlink_handle` rejects unsupported tags and volume-GUID mount-point targets. `fs__stat_impl` then retries certain unsupported reparse points with `do_lstat=0`. Therefore some reparse points can appear as regular files/directories. [Pinned libuv implementation](https://github.com/nodejs/node/blob/848430679556aed0bd073f2bc263331ad84fa119/deps/uv/src/win/fs.c) |
| Canonical paths | `realpath` is a useful location check, not a unique identity: hard links and bind mounts can provide aliases. Its documented behavior does not promise case normalization. String equality between a parent and its `realpath` is not a universal reparse detector. [Node realpath](https://nodejs.org/download/release/v24.15.0/docs/api/fs.html#fsrealpathpath-options-callback) |
| Windows case | Windows supports case-sensitive directories. Global lowercasing can merge distinct entries or confuse a case-distinct sibling with the root. [Microsoft case sensitivity](https://learn.microsoft.com/en-us/windows/wsl/case-sensitivity). `path.win32.relative()` also lowercases internally; it is not a filesystem-aware correction. [Pinned Node path source](https://github.com/nodejs/node/blob/848430679556aed0bd073f2bc263331ad84fa119/lib/path.js) |
| Descriptor identity | `fstat(fd, { bigint: true })` describes the opened object. Compare its `dev` and `ino` to the checked object; a regular-file type alone proves no ancestry. Node defines these as device and filesystem-specific inode identifiers. [Node Stats](https://nodejs.org/download/release/v24.15.0/docs/api/fs.html#class-fsstats) |
| Open flags | Constants vary by platform. Local Node **24.15.0 / win32 / libuv 1.51.0** exposes neither `O_NOFOLLOW` nor `O_DIRECTORY`. Where present, use numeric flags deliberately. Linux `O_NOFOLLOW` rejects a final symlink but still follows intermediate ones. [Node constants](https://nodejs.org/download/release/v24.15.0/docs/api/fs.html#file-open-constants), [Linux manual](https://man7.org/linux/man-pages/man2/open.2.html) |
| Reads | `read`/`readSync` can return fewer bytes than requested; callers must track actual progress. A byte ceiling bounds transferred data, not elapsed syscall time or snapshot atomicity. [Node read](https://nodejs.org/download/release/v24.15.0/docs/api/fs.html#fsreadfd-buffer-offset-length-position-callback) |

Local `lstat(..., { bigint: true })` returned a root inode larger than `Number.MAX_SAFE_INTEGER`. BigInt identity is necessary here, not merely theoretical. Reproduce the capability observation without changing files:

```powershell
node --input-type=module -e "import {constants,lstatSync} from 'node:fs'; const s=lstatSync(process.cwd(),{bigint:true}); console.log({node:process.version,platform:process.platform,uv:process.versions.uv,noFollow:constants.O_NOFOLLOW??null,directory:constants.O_DIRECTORY??null,inoExceedsSafeInteger:s.ino>BigInt(Number.MAX_SAFE_INTEGER)});"
```

Windows libuv maps volume/file identifiers into `dev`/`ino`; those are useful replacement checks, not globally permanent identities. Microsoft documents file-ID reuse and requires 128-bit IDs for reliable ReFS identity; a 64-bit ID is not guaranteed unique there. Do not extend a local NTFS validation result to every filesystem. [Libuv identity fields](https://github.com/nodejs/node/blob/848430679556aed0bd073f2bc263331ad84fa119/deps/uv/src/win/fs.c), [Windows file-ID limitations](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/ns-fileapi-by_handle_file_information).

## Gaps in the inspected draft

- `AuthorizedRoot` stores only a canonical string. Replacing the root with a different real directory at that same path is not detected. `resolveEntry('.')` also skips root type/link revalidation.
- `readFileBytes` does not rerun the component walk and does not compare the pre-open entry with `fstat`. Its comment claiming descriptor containment is stronger than its implementation: opening a substituted regular target can pass `isFile()`.
- `realpath(parent) !== parent` can flag benign spelling differences while missing reparse types that do not change the returned pathname. It cannot replace explicit component checks.
- `foldCase` and `identityKey` assume all Windows directories have the same case semantics.
- The read allocation trusts the observed size and stops there. A growing file can therefore produce a prefix reported as a complete file; `maxBytes` itself is not validated at this boundary.

These are observations about the identified draft, not claims that fixes written after this report retain them.

## Feasible control sequence

1. **Pin the authorization anchor.** Canonicalize the trusted root once; require a non-link directory and record its BigInt identity. Do not replace this anchor with a fresh `realpath` after a mismatch. Before each operation, recheck root type, identity and canonical location; a changed root invalidates the search. If the policy rejects linked ancestors in the configured root path too, inspect those before canonicalization so it cannot hide them. Otherwise explicitly document one-time resolution of trusted root aliases; all search descendants still reject links.

2. **Make relative, rooted traversal authoritative.** Validate lexical syntax before any filesystem lookup; then construct paths from the pinned root, inspecting every intermediate entry and final entry. Never authorize an absolute caller path merely because `contains()` or `path.relative()` looks acceptable. Directory entries discovered by inventory must take the same route before descent/read. Verify canonical containment and the root/component identities again around the open.

3. **Preserve names and resolve aliases using the filesystem.** Prefer the actual spelling returned by directory enumeration. Accept a differently cased request only when filesystem lookup proves it identifies the same entry; compare BigInt identities to resolve that alias. Keep distinct `A.ts` and `a.ts` in a case-sensitive directory, and preserve distinct hard-link paths rather than using the inode alone as a result/cache key. A case-folded string may be a lookup hint, never authorization evidence. Reject ambiguity instead of silently merging entries.

4. **Open once, then bind the descriptor to the check.** Capture expected `lstat` identity/type, open read-only, immediately `fstat` with BigInts, require a regular file and matching identity, and revalidate the rooted path before the first content read. On supported POSIX hosts, add `O_NOFOLLOW`; `O_NONBLOCK` can additionally prevent a substituted FIFO from blocking open before its type is rejected. Keep all reads on that descriptor and close it in `finally`. Identity mismatch discards the attempt; do not fall back to unchecked `readFile(path)`. These extra checks narrow race windows, not eliminate them. [Open flag behavior](https://man7.org/linux/man-pages/man2/open.2.html).

5. **Bound actual bytes and detect change.** Validate `maxBytes` and safe allocation/arithmetic first. Read in bounded chunks, honoring short reads, until EOF or at most `maxBytes + 1` bytes; the extra byte establishes overflow and must never be returned as accepted content. Do not allocate from unchecked `stats.size` or return a successful prefix when the file grows. Compare descriptor identity, size, `mtimeNs` and `ctimeNs` before/after reading; reject observed changes or a byte count inconsistent with the final size. Revalidate the path/root before returning a snapshot and before remote use; transmit only the stored snapshot bytes. Hashing/freshness policy belongs with JG-011/JG-021.

## Meeting the Windows reparse requirement

Windows exposes the generic **`FILE_ATTRIBUTE_REPARSE_POINT` (`0x400`)** separately from particular link tags. `GetFileAttributesW` retrieves attributes of the named entry, including the link itself; .NET exposes the corresponding `FileAttributes.ReparsePoint` through `File.GetAttributes`. [Windows attributes](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getfileattributesw), [reparse tags](https://learn.microsoft.com/en-us/windows/win32/fileio/reparse-point-tags), [.NET attributes](https://learn.microsoft.com/en-us/dotnet/api/system.io.fileattributes), [.NET getter](https://learn.microsoft.com/en-us/dotnet/api/system.io.file.getattributes).

A small Windows adapter can inspect this bit for the root and **each** path component before any ordinary `lstat`, descent or open, rejecting every set bit regardless of tag. A bounded PowerShell/.NET helper is feasible for the MVP; use a trusted executable and fixed program with literal paths supplied as data, no interpolated shell commands. Treat unavailable helpers, timeouts and unreadable attributes as refusal. Batch requests or retain a helper to avoid spawning a process per component. Do not cache an attribute check across later opens as if it were an immutable permission grant. This helper approach is proposed, not implemented or benchmarked by this research.

For a native adapter, `CreateFileW` supports `FILE_FLAG_OPEN_REPARSE_POINT`, with `FILE_FLAG_BACKUP_SEMANTICS` for directories; inspect the resulting handle using `GetFileInformationByHandleEx(FileAttributeTagInfo)` and, where required, `FileIdInfo`. This gives access to attributes/identity unavailable through the ordinary Node Stats surface. Opening a full pathname still does not freeze its intermediate directories. [CreateFileW](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew), [handle metadata](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-getfileinformationbyhandleex).

Without an attribute-capable adapter, the honest supported claim is rejection of tested symlinks/junctions, **not all reparse points**. That narrower behavior does not fulfill the current specification; keep that requirement open instead of documenting it as guaranteed.

## Residual limits and required evidence

Separate path checks and `open` are vulnerable to concurrent substitution, including change-and-restore sequences. BigInt equality, postchecks and canonical paths reduce observed failures but do not form one atomic operation. Hard links can expose the same bytes under an authorized name; same-length concurrent writes can yield an inconsistent read despite unchanged identity. A digest identifies the bytes observed, not a guaranteed point-in-time filesystem snapshot. POSIX specifies descriptor-relative `openat` for stronger directory anchoring; that control is not part of Node's documented `fs.open` interface. [POSIX open/openat rationale](https://pubs.opengroup.org/onlinepubs/9699919799.orig/functions/open.html).

Tests should cover final/intermediate symlinks and junctions both inside and outside the root; `repo` versus `repo-other`; root replacement by directory/link; a case-sensitive Windows directory with distinct case-only names; alias deduplication in a case-insensitive directory; descriptor substitution; growth/shrinkage and short reads; attribute-helper failure; and at least one non-symlink Windows reparse fixture. Capability-dependent skips must be visible, with the Windows coverage actually run before claiming that platform's guarantee. Add deterministic interposition tests around validation/open/read; they prove selected windows are handled, not that every TOCTOU schedule is impossible.

Only source/documentation inspection and read-only capability observation were performed for this report. No adversarial fixture, native helper, POSIX run or Windows case-sensitive/reparse integration was executed here.

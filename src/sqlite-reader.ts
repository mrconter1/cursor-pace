import * as fs from "fs";

/** Read a SQLite variable-length integer (big-endian, 7 bits per byte). */
function readVarint(buf: Buffer, offset: number): [number, number] {
  let value = 0;
  for (let i = 0; i < 9; i++) {
    const b = buf[offset + i];
    if (i < 8) {
      value = value * 128 + (b & 0x7f);
      if (!(b & 0x80)) return [value, i + 1];
    } else {
      value = value * 256 + b;
      return [value, 9];
    }
  }
  return [value, 9];
}

function readPage(fd: number, pageSize: number, pageNum: number): Buffer {
  const buf = Buffer.alloc(pageSize);
  fs.readSync(fd, buf, 0, pageSize, (pageNum - 1) * pageSize);
  return buf;
}

/**
 * Parse a SQLite record payload into column values.
 * TEXT columns become strings, integer/real columns become numbers, NULL/BLOB become null.
 */
function parseRecord(payload: Buffer): (string | number | null)[] {
  let pos = 0;
  const [headerSize, hs] = readVarint(payload, 0);
  pos = hs;

  const serialTypes: number[] = [];
  while (pos < headerSize && pos < payload.length) {
    const [st, stLen] = readVarint(payload, pos);
    serialTypes.push(st);
    pos += stLen;
  }

  pos = headerSize;
  const values: (string | number | null)[] = [];

  for (const st of serialTypes) {
    if (pos > payload.length) break;
    if (st === 0) {
      values.push(null);
    } else if (st >= 1 && st <= 4) {
      values.push(payload.readIntBE(pos, st));
      pos += st;
    } else if (st === 5) {
      values.push(payload.readIntBE(pos, 6));
      pos += 6;
    } else if (st === 6) {
      const hi = payload.readInt32BE(pos);
      const lo = payload.readUInt32BE(pos + 4);
      values.push(hi * 0x100000000 + lo);
      pos += 8;
    } else if (st === 7) {
      values.push(payload.readDoubleBE(pos));
      pos += 8;
    } else if (st === 8) {
      values.push(0);
    } else if (st === 9) {
      values.push(1);
    } else if (st >= 12 && st % 2 === 0) {
      const len = (st - 12) / 2;
      values.push(null); // BLOB — skip content
      pos += len;
    } else if (st >= 13 && st % 2 === 1) {
      const len = (st - 13) / 2;
      values.push(payload.slice(pos, pos + len).toString("utf8"));
      pos += len;
    }
  }

  return values;
}

/**
 * Recursively scan all leaf cells of a table B-tree rooted at `pageNum`.
 * Calls `cb` with each cell's inline payload; return false from cb to stop early.
 * Only individual pages are read from disk — the file is never loaded into memory.
 */
function scanTableBTree(
  fd: number,
  pageSize: number,
  pageNum: number,
  maxInline: number,
  cb: (payload: Buffer) => boolean
): boolean {
  const page = readPage(fd, pageSize, pageNum);
  // Page 1 has a 100-byte file header before the B-tree page header.
  const base = pageNum === 1 ? 100 : 0;
  const pageType = page[base];

  // 5 = interior table page, 13 = leaf table page
  if (pageType !== 5 && pageType !== 13) return true;

  const numCells = page.readUInt16BE(base + 3);
  const cellArrayStart = base + (pageType === 5 ? 12 : 8);

  if (pageType === 5) {
    // Interior page: recurse into left children then rightmost child
    const rightmost = page.readUInt32BE(base + 8);
    for (let i = 0; i < numCells; i++) {
      const cellOff = page.readUInt16BE(cellArrayStart + i * 2);
      const leftChild = page.readUInt32BE(cellOff);
      if (!scanTableBTree(fd, pageSize, leftChild, maxInline, cb)) return false;
    }
    return scanTableBTree(fd, pageSize, rightmost, maxInline, cb);
  }

  // Leaf page: parse each cell and invoke the callback
  for (let i = 0; i < numCells; i++) {
    const cellOff = page.readUInt16BE(cellArrayStart + i * 2);
    let pos = cellOff;
    const [payloadSize, ps1] = readVarint(page, pos);
    pos += ps1;
    const [, ps2] = readVarint(page, pos); // rowid — not needed
    pos += ps2;

    // Cells whose payload fits within maxInline bytes are stored entirely inline.
    // Larger cells spill to overflow pages; we skip those since auth tokens are small.
    const inlineLen = Math.min(payloadSize, maxInline);
    const payload = page.slice(pos, pos + inlineLen);
    if (!cb(payload)) return false;
  }

  return true;
}

/**
 * Read a single value from a SQLite database without loading the file into memory.
 *
 * Searches `table` for a row where the first TEXT column equals `key` and
 * returns the second TEXT column value, or null if not found.
 *
 * Designed for VS Code's state.vscdb (ItemTable: key TEXT, value TEXT).
 */
export function readSqliteValue(dbPath: string, table: string, key: string): string | null {
  const fd = fs.openSync(dbPath, "r");
  try {
    const header = Buffer.alloc(100);
    fs.readSync(fd, header, 0, 100, 0);

    const pageSizeRaw = header.readUInt16BE(16);
    const pageSize = pageSizeRaw === 1 ? 65536 : pageSizeRaw;
    const reservedBytes = header[20];
    const maxInline = (pageSize - reservedBytes) - 35;

    // Page 1 is always sqlite_schema: type TEXT, name TEXT, tbl_name TEXT, rootpage INT, sql TEXT
    let rootPageNum: number | null = null;
    scanTableBTree(fd, pageSize, 1, maxInline, (payload) => {
      try {
        const cols = parseRecord(payload);
        if (cols[0] === "table" && cols[1] === table) {
          rootPageNum = cols[3] as number;
          return false;
        }
      } catch { /* skip malformed cells */ }
      return true;
    });

    if (rootPageNum === null) return null;

    let found: string | null = null;
    scanTableBTree(fd, pageSize, rootPageNum, maxInline, (payload) => {
      try {
        const cols = parseRecord(payload);
        if (cols[0] === key && typeof cols[1] === "string") {
          found = cols[1];
          return false;
        }
      } catch { /* skip malformed cells */ }
      return true;
    });

    return found;
  } finally {
    fs.closeSync(fd);
  }
}

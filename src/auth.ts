import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import initSqlJs from "sql.js";

function getCursorDbPath(): string {
  const platform = process.platform;
  if (platform === "win32") {
    return path.join(process.env["APPDATA"] ?? os.homedir(), "Cursor", "User", "globalStorage", "state.vscdb");
  } else if (platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb");
  } else {
    return path.join(os.homedir(), ".config", "Cursor", "User", "globalStorage", "state.vscdb");
  }
}

function decodeJwtSub(jwt: string): string | null {
  try {
    const payload = jwt.split(".")[1];
    const padded = payload + "=".repeat((4 - payload.length % 4) % 4);
    const decoded = Buffer.from(padded, "base64url").toString("utf8");
    const claims = JSON.parse(decoded);
    return claims.sub ?? null;
  } catch {
    return null;
  }
}

function buildSessionToken(jwt: string): string | null {
  const sub = decodeJwtSub(jwt);
  if (!sub) return null;
  const userId = sub.split("|").at(-1)!;
  return `${userId}%3A%3A${jwt}`;
}

export async function getSessionToken(extensionPath: string): Promise<string> {
  const dbPath = getCursorDbPath();
  if (!fs.existsSync(dbPath)) {
    throw new Error(`Cursor database not found at: ${dbPath}`);
  }

  const wasmPath = path.join(extensionPath, "node_modules", "sql.js", "dist", "sql-wasm.wasm");
  const SQL = await initSqlJs({
    locateFile: () => wasmPath,
  });

  const dbBuffer = fs.readFileSync(dbPath);
  const db = new SQL.Database(dbBuffer);

  try {
    const result = db.exec("SELECT value FROM ItemTable WHERE key = 'cursorAuth/accessToken' LIMIT 1");
    if (!result.length || !result[0].values.length) {
      throw new Error("cursorAuth/accessToken not found in Cursor database.");
    }
    const jwt = result[0].values[0][0] as string;
    const token = buildSessionToken(jwt);
    if (!token) throw new Error("Failed to build session token from JWT.");
    return token;
  } finally {
    db.close();
  }
}

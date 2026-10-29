import mongoose from "mongoose";

/**
 * Serverless-safe Mongoose connection.
 * Vercel reuses the Node process between invocations, so we cache the
 * connection promise on `globalThis` to avoid opening a new pool per request.
 *
 * Local-dev fallback: when no MONGODB_URI is set, automatically spin up an
 * in-memory MongoDB (via mongodb-memory-server) so `npm run dev` works
 * out of the box. The in-memory server is wiped on process exit — perfect for
 * local iteration but never to be relied on in production.
 */
const MONGODB_URI = process.env.MONGODB_URI;

type Cache = { conn: typeof mongoose | null; promise: Promise<typeof mongoose> | null; usedAt: number };
declare global {
  // eslint-disable-next-line no-var
  var _mongooseCache: Cache | undefined;
  // eslint-disable-next-line no-var
  var _applifillMemoryServer: import("mongodb-memory-server-core").MongoMemoryServer | undefined;
}

const cached: Cache = global._mongooseCache ?? { conn: null, promise: null, usedAt: 0 };
global._mongooseCache = cached;

/**
 * How long a connection may sit unused before it is checked again.
 *
 * A serverless instance is frozen between requests. When it thaws — typically
 * the next time someone refreshes the dashboard — the cached connection can
 * still report itself as open while its sockets are long gone, and the first
 * query on it fails. That failure was the "Application error: a server-side
 * exception has occurred" seen on reload; the refresh after it worked because
 * by then the driver had noticed and reconnected.
 */
const IDLE_CHECK_MS = 30_000;
const PING_TIMEOUT_MS = 2_500;

async function resolveUri(): Promise<string> {
  if (MONGODB_URI) return MONGODB_URI;

  // Lazy-load so the dependency is only paid for in dev. In a serverless
  // function with MONGODB_URI set, this code never executes.
  const { MongoMemoryServer } = await import("mongodb-memory-server-core");
  if (!global._applifillMemoryServer) {
    global._applifillMemoryServer = await MongoMemoryServer.create({
      instance: { storageEngine: "wiredTiger" },
    });
    // eslint-disable-next-line no-console
    console.info(
      `[applifill] No MONGODB_URI set — started an in-memory MongoDB at ${await global._applifillMemoryServer.getUri()}`
    );
  }
  return global._applifillMemoryServer.getUri();
}

/** Drops the cached connection so the next `connectDB()` opens a fresh one. */
export async function resetDB() {
  cached.conn = null;
  cached.promise = null;
  cached.usedAt = 0;
  try {
    await mongoose.disconnect();
  } catch {
    // Already gone — which is why we are here.
  }
}

/** A failure that a fresh connection is likely to fix, as opposed to a bad query. */
export function isTransientDbError(err: unknown): boolean {
  const e = err as { name?: string; message?: string; code?: unknown } | null;
  const name = String(e?.name ?? "");
  const message = String(e?.message ?? "");
  return (
    /MongoNetworkError|MongoNetworkTimeoutError|MongoServerSelectionError|MongooseServerSelectionError|MongoNotConnectedError|MongoTopologyClosedError|MongoPoolClearedError/.test(name) ||
    /before initial connection is complete|Client must be connected|connection .* closed|topology was destroyed|ECONNRESET|EPIPE|ETIMEDOUT|socket hang up|pool was cleared|timed out/i.test(message)
  );
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("ping timed out")), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); }
    );
  });
}

async function open(): Promise<typeof mongoose> {
  if (!cached.promise) {
    const uri = await resolveUri();
    cached.promise = mongoose.connect(uri, {
      bufferCommands: false,
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 10_000,
    });
  }
  try {
    cached.conn = await cached.promise;
  } catch (err) {
    cached.promise = null;
    cached.conn = null;
    throw err;
  }
  cached.usedAt = Date.now();
  return cached.conn;
}

export async function connectDB() {
  // 0 disconnected, 1 connected, 2 connecting, 3 disconnecting.
  const state = mongoose.connection.readyState;

  if (cached.conn && state === 1) {
    if (Date.now() - cached.usedAt > IDLE_CHECK_MS) {
      // Idle long enough to have been frozen: make sure it still answers.
      try {
        await withTimeout(mongoose.connection.db!.command({ ping: 1 }), PING_TIMEOUT_MS);
      } catch {
        await resetDB();
        return open();
      }
    }
    cached.usedAt = Date.now();
    return cached.conn;
  }

  // A connection the driver already knows is gone is never reused.
  if (cached.conn && (state === 0 || state === 3)) {
    await resetDB();
  }
  return open();
}

/**
 * Runs a database call, and once more on a fresh connection if the first
 * attempt failed for a reason a reconnect can fix.
 */
export async function withDbRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    await connectDB();
    return await fn();
  } catch (err) {
    if (!isTransientDbError(err)) throw err;
    await resetDB();
    await connectDB();
    return fn();
  }
}

export default connectDB;

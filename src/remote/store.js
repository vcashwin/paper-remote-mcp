// Remote mode's state in one SQLite file (node:sqlite, built into Node 22.5+).
// Tokens and keys are stored only as SHA-256 digests; Paper sessions only sealed.
//
//   accounts      a Paper user (their Paper id is the key): email, the sealed session (null: unlinked)
//   clients       OAuth clients registered with POST /register (90 days)
//   grants        one per client authorization: the account, PKCE challenge, code / refresh digests
//   access_tokens digest → grant, with expiry
//   keys          personal keys (`pmcp_key_…`): digest → account
//   link_codes    pending "link from this computer" codes, claimed by an account
//
// ponytail: one file, one process. Postgres when there is more than one instance.

const SCHEMA = `
pragma journal_mode = wal;
pragma foreign_keys = on;
create table if not exists accounts (
  id text primary key, email text not null, session text, linked_at integer not null, checked_at integer
);
create table if not exists clients (client_id text primary key, data text not null, expires_at integer not null);
create table if not exists grants (
  id text primary key, account_id text not null references accounts(id) on delete cascade,
  client_id text not null, client_name text, scope text not null, resource text, redirect_uri text not null,
  code_challenge text not null, code_digest text, code_expires_at integer,
  refresh_digest text, previous_refresh_digest text, created_at integer not null
);
create table if not exists access_tokens (
  digest text primary key, grant_id text not null references grants(id) on delete cascade, expires_at integer not null
);
create table if not exists keys (
  id text primary key, account_id text not null references accounts(id) on delete cascade,
  digest text not null, label text not null, created_at integer not null, used_at integer
);
create table if not exists link_codes (
  code text primary key, poll_digest text not null, expires_at integer not null, account_id text
);
`;

/**
 * @param {string} path a file, or ':memory:' (tests)
 */
export async function openStore(path) {
  /** @type {typeof import('node:sqlite')} */
  let sqlite;
  try {
    sqlite = await import('node:sqlite');
  } catch {
    throw new Error(`Remote mode needs Node 22.5 or newer (node:sqlite); this is ${process.version}.`);
  }
  const db = new sqlite.DatabaseSync(path);
  db.exec(SCHEMA);

  /** @typedef {import('node:sqlite').SQLInputValue} Param */
  return {
    /** @param {string} sql @param {...Param} params @returns {any} */
    get: (sql, ...params) => db.prepare(sql).get(...params),
    /** @param {string} sql @param {...Param} params @returns {any[]} */
    all: (sql, ...params) => db.prepare(sql).all(...params),
    /** @param {string} sql @param {...Param} params */
    run: (sql, ...params) => db.prepare(sql).run(...params),
    close: () => db.close(),
  };
}
/** @typedef {Awaited<ReturnType<typeof openStore>>} Store */

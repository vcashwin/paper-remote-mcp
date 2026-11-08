// Paper accounts: a Paper user (keyed by their Paper id) and their session, sealed.
// `session` null means unlinked: Paper stopped accepting it, and the person must link again.

const PURPOSE = 'paper-session';

/**
 * @param {import('./store.js').Store} store
 * @param {import('./seal.js').Secrets} secrets
 */
export function createAccounts(store, secrets) {
  return {
    /**
     * Link (or re-link) a Paper user with a fresh session.
     * @param {import('./paper.js').PaperUser} user @param {import('./paper.js').StorageState} storageState
     */
    link(user, storageState) {
      const sealed = secrets.seal(PURPOSE, JSON.stringify(storageState)), now = Date.now();
      store.run(
        `insert into accounts (id, email, session, linked_at, checked_at) values (?, ?, ?, ?, ?)
         on conflict (id) do update set email = excluded.email, session = excluded.session, linked_at = excluded.linked_at, checked_at = excluded.checked_at`,
        user.id, user.email, sealed, now, now
      );
      return user.id;
    },

    /** @param {string} id @returns {{ id: string, email: string, linked: boolean, linkedAt: number } | undefined} */
    get(id) {
      const row = store.get('select id, email, session is not null as linked, linked_at from accounts where id = ?', id);
      return row && { id: row.id, email: row.email, linked: !!row.linked, linkedAt: row.linked_at };
    },

    /** The sessions the editor pool reads and renews. @type {import('./paper.js').Sessions} */
    sessions: {
      load(id) {
        const row = store.get('select session from accounts where id = ?', id);
        const text = row?.session ? secrets.unseal(PURPOSE, row.session) : null;
        return text ? JSON.parse(text) : null;
      },
      save(id, storageState) {
        store.run('update accounts set session = ?, checked_at = ? where id = ? and session is not null', secrets.seal(PURPOSE, JSON.stringify(storageState)), Date.now(), id);
      },
      unlink(id) {
        store.run('update accounts set session = null where id = ?', id);
      },
    },

    /** Disconnect: the account, its session, grants and keys, all gone. @param {string} id */
    remove(id) {
      store.run('delete from accounts where id = ?', id);
    },
  };
}
/** @typedef {ReturnType<typeof createAccounts>} Accounts */

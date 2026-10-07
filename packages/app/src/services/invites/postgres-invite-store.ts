import { Pool } from 'pg';
import type { SqlClient } from '@/services/auth/stores/postgres-store';
import { InviteStorePostgres, type InviteStore } from '@/services/invites/invite-store';

/**
 * Construit le store des amis a partir d'une chaine de connexion. Module a
 * part, comme createPostgresAuthStore : `pg` n'entre que dans les bundles qui
 * l'importent (instance invitee, CLI), jamais dans le bundle lambda.
 */
export function createPostgresInviteStore(connectionString: string): {
  store: InviteStore;
  fermer: () => Promise<void>;
} {
  const pool = new Pool({ connectionString });
  return { store: new InviteStorePostgres(pool as SqlClient), fermer: () => pool.end() };
}

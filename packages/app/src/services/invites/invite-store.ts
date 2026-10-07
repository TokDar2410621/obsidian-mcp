import crypto from 'crypto';
import type { SqlClient } from '@/services/auth/stores/postgres-store';
import { logger } from '@/utils/logger';

/**
 * Les amis de Darius qui parlent a Dan (l'instance invitee), leur quota du
 * jour et la trace de ce qu'ils consultent.
 *
 * Le secret d'un ami n'est JAMAIS stocke : seulement son empreinte sha256. Il
 * est montre une seule fois, a la creation (CLI `invites create`). Un secret
 * de 32 octets aleatoires n'a pas besoin d'un hachage lent : on ne devine pas
 * 2^192 possibilites, on les enumere encore moins.
 */

export interface Invite {
  id: string;
  nom: string;
  creeLe: number;
  revoqueLe: number | null;
}

export type ResultatAudit = 'ok' | 'erreur' | 'quota' | 'refuse';

export interface EntreeAudit {
  horodatage: number;
  inviteId: string;
  nom: string;
  outil: string;
  /** Chemins ou noms demandes. Jamais les arguments complets, jamais le contenu rendu. */
  chemins: string[];
  resultat: ResultatAudit;
}

export interface FiltreAudit {
  nom?: string;
  depuis?: number;
  limite?: number;
}

export interface InviteStore {
  /** Cree un ami et rend son secret EN CLAIR, une seule fois. */
  creer(nom: string): Promise<{ invite: Invite; secret: string }>;
  lister(): Promise<Invite[]>;
  /** L'ami actif (non revoque) qui porte ce secret, ou null. */
  parSecret(secret: string): Promise<Invite | null>;
  /** L'ami actif (non revoque) de cet id, ou null. */
  parId(id: string): Promise<Invite | null>;
  /** Revoque l'ami actif de ce nom. Rend le nombre d'amis revoques (0 ou 1). */
  revoquer(nom: string): Promise<number>;
  /** Incremente le compteur du jour et rend sa nouvelle valeur. */
  incrementerQuota(inviteId: string, jour: string): Promise<number>;
  journaliser(entree: EntreeAudit): Promise<void>;
  lireAudit(filtre?: FiltreAudit): Promise<EntreeAudit[]>;
}

export function genererSecret(): string {
  return `dan_${crypto.randomBytes(32).toString('base64url')}`;
}

export function empreinte(secret: string): string {
  return crypto.createHash('sha256').update(secret, 'utf8').digest('hex');
}

function genererId(): string {
  return crypto.randomBytes(12).toString('hex');
}

function nomValide(nom: string): string {
  const n = (nom ?? '').trim();
  if (!/^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,39}$/u.test(n)) {
    throw new Error(
      `Nom d'ami invalide (${nom}) : 1 a 40 caracteres, lettres, chiffres, espace, point, tiret ou souligne.`,
    );
  }
  return n;
}

/** Le jour civil a Montreal (AAAA-MM-JJ) : le quota se remet a zero a minuit, heure de Darius. */
export function jourMontreal(date: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Montreal',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

// --- memoire (tests, developpement local) -----------------------------------

export class InviteStoreMemoire implements InviteStore {
  private readonly invites = new Map<string, Invite & { hash: string }>();
  private readonly quotas = new Map<string, number>();
  private readonly audit: EntreeAudit[] = [];

  async creer(nom: string): Promise<{ invite: Invite; secret: string }> {
    const n = nomValide(nom);
    const doublon = [...this.invites.values()].some(
      i => i.revoqueLe === null && i.nom.toLowerCase() === n.toLowerCase(),
    );
    if (doublon) throw new Error(`Un ami actif s'appelle deja ${n}.`);
    const secret = genererSecret();
    const invite: Invite = { id: genererId(), nom: n, creeLe: Date.now(), revoqueLe: null };
    this.invites.set(invite.id, { ...invite, hash: empreinte(secret) });
    return { invite, secret };
  }

  async lister(): Promise<Invite[]> {
    return [...this.invites.values()].map(({ hash: _h, ...i }) => i);
  }

  async parSecret(secret: string): Promise<Invite | null> {
    const h = empreinte(secret);
    for (const { hash, ...i } of this.invites.values()) {
      if (i.revoqueLe === null && hash === h) return i;
    }
    return null;
  }

  async parId(id: string): Promise<Invite | null> {
    const i = this.invites.get(id);
    if (!i || i.revoqueLe !== null) return null;
    const { hash: _h, ...invite } = i;
    return invite;
  }

  async revoquer(nom: string): Promise<number> {
    let n = 0;
    for (const i of this.invites.values()) {
      if (i.revoqueLe === null && i.nom.toLowerCase() === nom.trim().toLowerCase()) {
        i.revoqueLe = Date.now();
        n++;
      }
    }
    return n;
  }

  async incrementerQuota(inviteId: string, jour: string): Promise<number> {
    const cle = `${inviteId}|${jour}`;
    const v = (this.quotas.get(cle) ?? 0) + 1;
    this.quotas.set(cle, v);
    return v;
  }

  async journaliser(entree: EntreeAudit): Promise<void> {
    this.audit.push({ ...entree, chemins: [...entree.chemins] });
  }

  async lireAudit(filtre: FiltreAudit = {}): Promise<EntreeAudit[]> {
    return this.audit
      .filter(e => !filtre.nom || e.nom.toLowerCase() === filtre.nom.toLowerCase())
      .filter(e => !filtre.depuis || e.horodatage >= filtre.depuis)
      .slice(-(filtre.limite ?? 200))
      .reverse();
  }
}

// --- Postgres (production) ---------------------------------------------------

/**
 * Trois tables, creees au besoin : `invites`, `quota_invite`, `audit_invite`.
 * Elles vivent dans la base de l'instance INVITEE, jamais dans celle de
 * l'instance perso (stores separes, voir la spec §1.1).
 */
export class InviteStorePostgres implements InviteStore {
  private readonly pret: Promise<void>;

  constructor(private readonly sql: SqlClient) {
    this.pret = this.init();
  }

  private async init(): Promise<void> {
    await this.sql.query(
      `CREATE TABLE IF NOT EXISTS invites (
         id           TEXT   PRIMARY KEY,
         nom          TEXT   NOT NULL,
         secret_hash  TEXT   NOT NULL UNIQUE,
         cree_le      BIGINT NOT NULL,
         revoque_le   BIGINT
       )`,
    );
    await this.sql.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS invites_nom_actif ON invites (lower(nom)) WHERE revoque_le IS NULL`,
    );
    await this.sql.query(
      `CREATE TABLE IF NOT EXISTS quota_invite (
         invite_id  TEXT    NOT NULL,
         jour       TEXT    NOT NULL,
         compte     INTEGER NOT NULL,
         PRIMARY KEY (invite_id, jour)
       )`,
    );
    await this.sql.query(
      `CREATE TABLE IF NOT EXISTS audit_invite (
         id          BIGSERIAL PRIMARY KEY,
         horodatage  BIGINT NOT NULL,
         invite_id   TEXT   NOT NULL,
         nom         TEXT   NOT NULL,
         outil       TEXT   NOT NULL,
         chemins     JSONB  NOT NULL,
         resultat    TEXT   NOT NULL
       )`,
    );
    logger.info('Invite store Postgres pret');
  }

  private ligne(r: any): Invite {
    return {
      id: r.id,
      nom: r.nom,
      creeLe: Number(r.cree_le),
      revoqueLe: r.revoque_le === null || r.revoque_le === undefined ? null : Number(r.revoque_le),
    };
  }

  async creer(nom: string): Promise<{ invite: Invite; secret: string }> {
    await this.pret;
    const n = nomValide(nom);
    const actif = await this.sql.query(
      `SELECT id FROM invites WHERE lower(nom) = lower($1) AND revoque_le IS NULL`,
      [n],
    );
    if (actif.rows[0]) throw new Error(`Un ami actif s'appelle deja ${n}.`);
    const secret = genererSecret();
    const invite: Invite = { id: genererId(), nom: n, creeLe: Date.now(), revoqueLe: null };
    await this.sql.query(
      `INSERT INTO invites (id, nom, secret_hash, cree_le, revoque_le) VALUES ($1, $2, $3, $4, NULL)`,
      [invite.id, invite.nom, empreinte(secret), invite.creeLe],
    );
    return { invite, secret };
  }

  async lister(): Promise<Invite[]> {
    await this.pret;
    const r = await this.sql.query(`SELECT id, nom, cree_le, revoque_le FROM invites ORDER BY cree_le`);
    return r.rows.map(x => this.ligne(x));
  }

  async parSecret(secret: string): Promise<Invite | null> {
    await this.pret;
    const r = await this.sql.query(
      `SELECT id, nom, cree_le, revoque_le FROM invites WHERE secret_hash = $1 AND revoque_le IS NULL`,
      [empreinte(secret)],
    );
    return r.rows[0] ? this.ligne(r.rows[0]) : null;
  }

  async parId(id: string): Promise<Invite | null> {
    await this.pret;
    const r = await this.sql.query(
      `SELECT id, nom, cree_le, revoque_le FROM invites WHERE id = $1 AND revoque_le IS NULL`,
      [id],
    );
    return r.rows[0] ? this.ligne(r.rows[0]) : null;
  }

  async revoquer(nom: string): Promise<number> {
    await this.pret;
    const r = await this.sql.query(
      `UPDATE invites SET revoque_le = $2 WHERE lower(nom) = lower($1) AND revoque_le IS NULL RETURNING id`,
      [nom.trim(), Date.now()],
    );
    return r.rows.length;
  }

  async incrementerQuota(inviteId: string, jour: string): Promise<number> {
    await this.pret;
    const r = await this.sql.query(
      `INSERT INTO quota_invite (invite_id, jour, compte) VALUES ($1, $2, 1)
       ON CONFLICT (invite_id, jour) DO UPDATE SET compte = quota_invite.compte + 1
       RETURNING compte`,
      [inviteId, jour],
    );
    return Number(r.rows[0]?.compte ?? 0);
  }

  async journaliser(e: EntreeAudit): Promise<void> {
    await this.pret;
    await this.sql.query(
      `INSERT INTO audit_invite (horodatage, invite_id, nom, outil, chemins, resultat)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
      [e.horodatage, e.inviteId, e.nom, e.outil, JSON.stringify(e.chemins), e.resultat],
    );
  }

  async lireAudit(filtre: FiltreAudit = {}): Promise<EntreeAudit[]> {
    await this.pret;
    const r = await this.sql.query(
      `SELECT horodatage, invite_id, nom, outil, chemins, resultat FROM audit_invite
       WHERE ($1::text IS NULL OR lower(nom) = lower($1)) AND horodatage >= $2
       ORDER BY horodatage DESC LIMIT $3`,
      [filtre.nom ?? null, filtre.depuis ?? 0, filtre.limite ?? 200],
    );
    return r.rows.map(x => ({
      horodatage: Number(x.horodatage),
      inviteId: x.invite_id,
      nom: x.nom,
      outil: x.outil,
      chemins: typeof x.chemins === 'string' ? JSON.parse(x.chemins) : x.chemins,
      resultat: x.resultat,
    }));
  }
}

#!/usr/bin/env node
/**
 * Administration des amis de Dan (spec du 2026-10-07, §1.6).
 *
 *   node packages/app/dist/invites/index.js create <nom>
 *   node packages/app/dist/invites/index.js list
 *   node packages/app/dist/invites/index.js revoke <nom>
 *   node packages/app/dist/invites/index.js audit [nom] [jours]
 *
 * Lit DATABASE_URL : la base de l'instance INVITEE. Sur Railway, lancer dans
 * le conteneur de Dan (`railway ssh`), voir docs/dan-invite.md.
 *
 * Le code d'acces d'un ami s'affiche UNE seule fois, a la creation. Il n'est
 * stocke que sous forme d'empreinte : perdu, on revoque et on en recree un.
 */

import { loadEnv } from '@/env';
import { configureLogger } from '@/utils/logger';
import { createPostgresInviteStore } from '@/services/invites/postgres-invite-store';
import type { InviteStore } from '@/services/invites/invite-store';

const AIDE = `Usage :
  invites create <nom>          cree un ami et affiche son code d'acces (une seule fois)
  invites list                  liste les amis (actifs et revoques)
  invites revoke <nom>          revoque un ami : 401 immediat sur Dan
  invites audit [nom] [jours]   ce que les amis ont consulte (defaut : tous, 7 jours)`;

function date(ms: number | null): string {
  return ms === null ? '-' : new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
}

export async function executer(
  args: string[],
  store: InviteStore,
  ecrire: (ligne: string) => void = l => console.log(l),
): Promise<number> {
  const [commande, ...reste] = args;
  switch (commande) {
    case 'create': {
      const nom = reste.join(' ').trim();
      if (!nom) {
        ecrire(AIDE);
        return 2;
      }
      const { invite, secret } = await store.creer(nom);
      ecrire(`Ami cree : ${invite.nom} (id ${invite.id})`);
      ecrire('');
      ecrire(`Code d'acces (affiche UNE seule fois, transmets-le a part de l'URL) :`);
      ecrire(`  ${secret}`);
      return 0;
    }
    case 'list': {
      const amis = await store.lister();
      if (amis.length === 0) ecrire('Aucun ami.');
      for (const a of amis) {
        ecrire(
          `${a.revoqueLe === null ? 'actif  ' : 'revoque'}  ${a.nom.padEnd(20)}  cree ${date(a.creeLe)}  revoque ${date(a.revoqueLe)}`,
        );
      }
      return 0;
    }
    case 'revoke': {
      const nom = reste.join(' ').trim();
      if (!nom) {
        ecrire(AIDE);
        return 2;
      }
      const n = await store.revoquer(nom);
      ecrire(n > 0 ? `Revoque : ${nom}. Ses tokens sont refuses des la prochaine requete.` : `Aucun ami actif nomme ${nom}.`);
      return n > 0 ? 0 : 1;
    }
    case 'audit': {
      const jours = reste.length > 0 && /^\d+$/.test(reste[reste.length - 1]) ? Number(reste.pop()) : 7;
      const nom = reste.join(' ').trim() || undefined;
      const lignes = await store.lireAudit({
        nom,
        depuis: Date.now() - jours * 24 * 3600 * 1000,
        limite: 500,
      });
      if (lignes.length === 0) ecrire('Aucun appel sur la periode.');
      for (const l of lignes) {
        ecrire(`${date(l.horodatage)}  ${l.nom.padEnd(16)}  ${l.outil.padEnd(18)}  ${l.resultat.padEnd(7)}  ${l.chemins.join(', ')}`);
      }
      return 0;
    }
    default:
      ecrire(AIDE);
      return commande ? 2 : 0;
  }
}

async function main(): Promise<void> {
  loadEnv();
  configureLogger({ stream: process.stderr, minLevel: 'warn' });
  const url = process.env.DATABASE_URL?.trim();
  if (!url) {
    console.error('DATABASE_URL manquant (base de Dan).');
    process.exit(2);
  }
  const { store, fermer } = createPostgresInviteStore(url);
  try {
    process.exitCode = await executer(process.argv.slice(2), store);
  } catch (error) {
    console.error(String((error as Error).message ?? error));
    process.exitCode = 1;
  } finally {
    await fermer();
  }
}

// Lance seulement en execution directe (pas a l'import par les tests).
if (process.argv[1] && /invites(\.ts|[\\/]index\.js)$/.test(process.argv[1])) {
  void main();
}

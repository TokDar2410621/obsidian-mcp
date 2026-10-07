/**
 * Profil d'une instance du cerveau (spec du 2026-10-07, partie 3).
 *
 * Par defaut (profil de Darius), chaque cron tourne sauf si son flag vaut
 * `off`. Le profil `neutre` sert au cerveau d'un ami, deploye depuis le meme
 * code : la sonde Stripe, l'agenda, la relance, le brief du matin parlent de
 * la vie de Darius et n'ont rien a faire chez lui. En neutre, tout est coupe
 * et l'ami rallume ce qu'il veut, un flag `on` a la fois.
 */

/** Les interrupteurs des crons et passages de boot, tels que les lit chaque *-cron.ts. */
export const FLAGS_CRONS = [
  'SANTE',
  'POUSSOIR',
  'LIVRAISON',
  'LIVRAISON_PEREMPTION',
  'RETOURS',
  'STRIPE_SENSOR',
  'CALENDAR_SENSOR',
  'DAILY_REFLECTION',
  'OBJECTIVE_SWEEP',
  'CAPTURE_LINK',
  'MORNING_BRIEF',
  'RELANCE_SWEEP',
  'SYNAPSES_DIGEST',
  'MAINTENANCE_ENABLED',
  'GRAPH_REBUILD',
] as const;

export type FlagCron = (typeof FLAGS_CRONS)[number];

type Env = Record<string, string | undefined>;

export function profilNeutre(env: Env = process.env): boolean {
  return (env.CERVEAU_PROFIL ?? '').trim().toLowerCase() === 'neutre';
}

/**
 * Ce cron a-t-il le droit de demarrer dans ce profil ? En profil Darius, la
 * decision reste au cron lui-meme (son flag `off`). En neutre, il faut un
 * `on` explicite.
 */
export function cronPermis(flag: FlagCron, env: Env = process.env): boolean {
  if (!profilNeutre(env)) return true;
  return (env[flag] ?? '').trim().toLowerCase() === 'on';
}

/** Le rappel « motivé » lit les priorites et les peurs de Darius : jamais en neutre. */
export function rappelMotivePermis(env: Env = process.env): boolean {
  return !profilNeutre(env);
}

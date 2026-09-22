import type { VaultManager } from '@/services/vault-manager';
import { writeStateFile } from '@/services/vault-manager';

/**
 * L'etat de la livraison : ce qui est deja passe, quand, et par quelle voie.
 *
 * Pourquoi un module a part, et pourquoi une DATE. Le format de la premiere
 * version (`traitees: string[]`) ne porte pas de date : impossible de savoir
 * depuis quand un livrable attend, donc impossible de le peremer. Le format
 * devient `Record<chemin, { le, voie }>`, et ce module est le SEUL proprietaire
 * du fichier. Un second service qui inventerait son propre fichier d'etat
 * repartirait de zero et reannoncerait tout.
 *
 * Interdiction ecrite : ne jamais ecrire dans `08-auto/_relances-state.json`.
 * `RelanceSweepService.saveState:361` en fait un read-modify-write complet ; un
 * second ecrivain y perdrait des entrees.
 */

/** Ce que le passage fait d'une tache finie. */
export type Voie = 'annoncer' | 'fermer' | 'question';

/** `amorce` : inscrite au premier passage SANS action, pour ne pas partir en rafale. */
export type VoieEnregistree = Voie | 'amorce';

export interface EntreeEtat {
  /**
   * AAAA-MM-JJ. Une chaine VIDE veut dire « date inconnue » : l'appelant
   * retombe alors sur le `created:` du frontmatter de la tache. C'est le cas
   * des entrees relues depuis l'ancien format en tableau.
   */
  le: string;
  voie: VoieEnregistree;
}

/**
 * La marque de peremption d'un livrable, posee par le balayage quotidien et par
 * la route /encore. Deux dates, jamais plus :
 *
 *  - `demandeeLe` : le jour ou la question « encore utile ? » est partie. Elle
 *    VERROUILLE la question : tant qu'elle est la, elle ne se repose pas. C'est
 *    la regle du coffre `blocage-demander-pourquoi` appliquee a la sortie.
 *  - `utileLe` : le jour ou Darius a repondu « encore utile ». Le compteur
 *    repart de la, pas de la date du livrable, et `demandeeLe` disparait.
 */
export interface MarquePeremption {
  demandeeLe?: string;
  utileLe?: string;
}

export interface EtatLivraison {
  version: 1;
  traitees: Record<string, EntreeEtat>;
  /**
   * Les marques de peremption, par chemin de tache. Optionnel : un etat ecrit
   * par la version d'avant n'en a pas, et son absence ne vaut pas « rien a
   * peremer », elle vaut « jamais balaye ».
   */
  peremption?: Record<string, MarquePeremption>;
}

export const ETAT_LIVRAISON = '08-auto/_livraison-state.json';

/**
 * Fenetre glissante des chemins retenus. Une tache annoncee reste `a-valider`
 * tant que Darius n'a pas tape : au-dela de ce plafond, son chemin sort de la
 * fenetre et elle serait reannoncee depuis zero. Ne pas le reduire.
 */
export const MAX_TRAITEES = 500;

const VOIES = new Set<VoieEnregistree>(['annoncer', 'fermer', 'question', 'amorce']);

/** AAAA-MM-JJ du jour, en UTC comme le reste des etats du coffre. */
export function aujourdhui(maintenantMs: number = Date.now()): string {
  return new Date(maintenantMs).toISOString().slice(0, 10);
}

/**
 * Lecteur TOLERANT. Il accepte encore l'ancien format public
 * (`traitees: string[]`) et le convertit en entrees sans date : rien n'est
 * reannonce le jour ou le format change sous les pieds d'un serveur deja
 * deploye.
 */
export async function lireEtat(vault: VaultManager): Promise<EtatLivraison> {
  const vide: EtatLivraison = { version: 1, traitees: {} };
  let brut: unknown;
  try {
    brut = JSON.parse(await vault.readFile(ETAT_LIVRAISON));
  } catch {
    return vide;
  }
  const marques = lireMarques((brut as { peremption?: unknown })?.peremption);
  const avecMarques = (etat: EtatLivraison): EtatLivraison =>
    marques ? { ...etat, peremption: marques } : etat;
  const traitees = (brut as { traitees?: unknown })?.traitees;
  if (Array.isArray(traitees)) {
    const out: Record<string, EntreeEtat> = {};
    for (const t of traitees) {
      if (typeof t === 'string' && t) out[t] = { le: '', voie: 'fermer' };
    }
    return avecMarques({ version: 1, traitees: out });
  }
  if (traitees && typeof traitees === 'object') {
    const out: Record<string, EntreeEtat> = {};
    for (const [chemin, valeur] of Object.entries(traitees as Record<string, unknown>)) {
      if (!chemin) continue;
      const v = valeur as { le?: unknown; voie?: unknown };
      const voie = VOIES.has(v?.voie as VoieEnregistree) ? (v.voie as VoieEnregistree) : 'fermer';
      out[chemin] = { le: typeof v?.le === 'string' ? v.le : '', voie };
    }
    return avecMarques({ version: 1, traitees: out });
  }
  return avecMarques(vide);
}

/** Les marques relues du disque, ou null quand il n'y en a aucune de valide. */
function lireMarques(brut: unknown): Record<string, MarquePeremption> | null {
  if (!brut || typeof brut !== 'object' || Array.isArray(brut)) return null;
  const out: Record<string, MarquePeremption> = {};
  for (const [chemin, valeur] of Object.entries(brut as Record<string, unknown>)) {
    if (!chemin || !valeur || typeof valeur !== 'object') continue;
    const v = valeur as { demandeeLe?: unknown; utileLe?: unknown };
    const marque: MarquePeremption = {};
    if (typeof v.demandeeLe === 'string' && v.demandeeLe) marque.demandeeLe = v.demandeeLe;
    if (typeof v.utileLe === 'string' && v.utileLe) marque.utileLe = v.utileLe;
    if (marque.demandeeLe || marque.utileLe) out[chemin] = marque;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Ecriture LAZY (un commit groupe). Ce fichier n'interesse personne en direct :
 * lui donner un commit+push a chaque passage de cinq minutes rejouerait la
 * tempete documentee dans vault-manager.ts:106-109.
 *
 * La coupe garde les DERNIERES entrees : les cles sont des chemins non
 * numeriques, donc leur ordre d'insertion est garanti par le langage.
 */
export async function ecrireEtat(vault: VaultManager, etat: EtatLivraison): Promise<void> {
  // Relecture-modification-ecriture, et non pas ecriture directe de
  // l'instantane. Ce fichier a DEUX ecrivains : le passage de livraison toutes
  // les cinq minutes, et la peremption (balayage du soir plus la route
  // /encore). Un passage de livraison qui reecrirait `{version, traitees}` a
  // partir de l'etat lu en debut de tour effacerait les marques posees entre
  // temps, la question de peremption repartirait chaque jour, et le defaut
  // reparaitrait a l'identique.
  await majEtat(vault, frais => {
    frais.traitees = etat.traitees;
  });
}

/**
 * Le SEUL chemin d'ecriture de ce fichier : il RELIT l'etat juste avant
 * d'ecrire, applique la mutation, et serialise l'objet ENTIER. Les champs que
 * l'appelant ne connait pas (les marques de peremption pour la livraison, les
 * `traitees` pour la peremption) survivent sans qu'il ait a les porter.
 *
 * La fenetre de course n'est pas nulle pour autant : deux mutations qui se
 * chevauchent a la seconde pres peuvent encore se marcher dessus. Elle est
 * reduite a la duree de la mutation elle-meme, et les deux services vivent dans
 * le meme processus, donc dans la meme boucle d'evenements.
 */
export async function majEtat(
  vault: VaultManager,
  muter: (etat: EtatLivraison) => void,
): Promise<EtatLivraison> {
  const etat = await lireEtat(vault);
  muter(etat);
  const entrees = Object.entries(etat.traitees).slice(-MAX_TRAITEES);
  const marques = etat.peremption ?? {};
  await writeStateFile(
    vault,
    ETAT_LIVRAISON,
    JSON.stringify(
      {
        version: 1,
        traitees: Object.fromEntries(entrees),
        ...(Object.keys(marques).length ? { peremption: marques } : {}),
      },
      null,
      2,
    ),
  );
  return etat;
}

import { describe, expect, it } from 'vitest';
import { configureLogger } from '@/utils/logger';

configureLogger({ stream: process.stderr, minLevel: 'error' });

import { parseResultat, section } from '@/server/local/validation-route';
import {
  classer,
  livrablesAutoReferents,
  questionPosee,
  verdictCriteres,
} from '@/services/livraison/matiere-manquante';
import {
  CHEMIN_2026_07_12,
  CHEMIN_2026_08_31,
  CHEMIN_2026_09_03,
  FICHIER_2026_07_12,
  FICHIER_2026_08_31,
  FICHIER_2026_09_03,
} from '@tests/support/fixtures/taches-bloquees.js';

/**
 * « Impossible » n'est pas un livrable.
 *
 * Darius, mot pour mot : « quand je recois ca, impossible, lien verrouille,
 * aucun contenu capte, je dois faire quoi avec ? je dois valider pour ne plus
 * le voir ? ». Ces tests tournent sur les fiches REELLES du coffre, pas sur des
 * exemples propres : c'est la seule facon de savoir que la porte s'ouvre pour
 * les deux bonnes taches et reste fermee pour la troisieme.
 */

const bloc = (fichier: string): string => section(fichier, 'Résultat');

const aClasser = (fichier: string, chemin: string) => {
  const blocResultat = bloc(fichier);
  const { resume, livrables } = parseResultat(blocResultat);
  return { path: chemin, resume, livrables, resultatBrut: blocResultat };
};

describe('Matiere manquante : le verdict de l executeur', () => {
  it('lit le KO de la fiche du 31 aout, ligne verbatim du coffre', () => {
    expect(
      verdictCriteres(
        'criteres: demande satisfaite=KO acces video bloque ; zero em-dash=OK rien envoye aucune prod',
      ),
    ).toBe('ko');
  });

  it('lit le KO de la fiche du 12 juillet, autre separateur, ligne verbatim', () => {
    expect(
      verdictCriteres(
        'criteres: Demande satisfaite: KO acces MCP Gridar bloque | Notes citées mobilisées: OK incident + automatisation + regles | last_error verbatim capturé: KO rien inventé | Zéro em-dash: OK hook passé',
      ),
    ).toBe('ko');
  });

  it('accepte les six separateurs reellement mesures dans le coffre', () => {
    // Releve sur les 341 fiches : 124 occurrences, six ecritures differentes.
    for (const ligne of [
      'criteres: demande satisfaite OK verdict rendu',
      'criteres: demande satisfaite=OK verdict rendu',
      'criteres: demande satisfaite: OK verdict rendu',
      'criteres: Demande satisfaite : OK verdict rendu',
      'criteres: demande satisfaite = OK verdict rendu',
      'criteres: Demande satisfaite=OK verdict rendu',
    ]) {
      expect(verdictCriteres(ligne)).toBe('ok');
    }
  });

  it('rend « absent » quand le bloc ne porte aucune ligne criteres', () => {
    // Les 300 et quelques fiches anciennes n'en ont pas : elles ne doivent
    // jamais basculer en question par defaut.
    expect(verdictCriteres('resume: fait\nlivrables: 02-knowledge/x.md')).toBe('absent');
    expect(verdictCriteres('')).toBe('absent');
  });

  it('prend la DERNIERE ligne criteres du bloc, pas la premiere', () => {
    // Une reprise empile une nouvelle paire. `parseResultat` prend la premiere
    // pour resume et livrables ; le verdict, lui, exige la derniere.
    const deuxPasses = [
      'resume: premiere passe',
      'criteres: demande satisfaite=KO acces bloque',
      '',
      'resume: apres reprise',
      'criteres: demande satisfaite OK verdict rendu',
    ].join('\n');
    expect(verdictCriteres(deuxPasses)).toBe('ok');
  });
});

describe('Matiere manquante : la question, rendue verbatim', () => {
  it('rend caractere pour caractere la question du 31 aout', () => {
    const attendu =
      "quelle est la méthode ou le format montré dans la vidéo (ou un texte/capture d'écran de son contenu), et qu'entend-il par « chaque question planifiée » : un calendrier de contenu Q&A existant, les objections de vente reçues sur Gridar/Arivex, ou autre chose ? Avec l'un ou l'autre, la tâche redevient exécutable.";
    expect(questionPosee(bloc(FICHIER_2026_08_31))).toBe(attendu);
    // Et ce texte est bien celui du coffre, pas une copie qui aurait derive.
    expect(FICHIER_2026_08_31).toContain(attendu);
  });

  it('rend verbatim le blocage du 12 juillet', () => {
    const attendu =
      "pour capturer le message d'erreur exact, jouer la checklist depuis une session interactive (permission Gridar accordée à la volée) ou depuis Claude Cowork PC1. Aucun envoi extérieur, aucune touche à la prod, aucun `generate_article`.";
    expect(questionPosee(bloc(FICHIER_2026_07_12))).toBe(attendu);
    expect(FICHIER_2026_07_12).toContain(attendu);
  });

  it('rend null quand aucun paragraphe nomme n existe', () => {
    expect(questionPosee(bloc(FICHIER_2026_09_03))).toBeNull();
    expect(questionPosee('resume: rien de special')).toBeNull();
  });

  it('ne se laisse pas prendre par « question précise » au milieu d une ligne', () => {
    // La ligne `livrables:` du 31 aout porte « question précise pour Darius ».
    // Sans l'ancre de debut de ligne, le classifieur remonterait ca.
    const leurre =
      'livrables: 09-taches/x.md (journal + résultat + question précise pour Darius)';
    expect(questionPosee(leurre)).toBeNull();
  });
});

describe('Matiere manquante : l auto-reference, corroborant et jamais porte', () => {
  it('voit que la fiche du 31 aout n a produit qu elle-meme', () => {
    expect(livrablesAutoReferents(bloc(FICHIER_2026_08_31), CHEMIN_2026_08_31)).toBe(true);
  });

  it('voit que la fiche du 12 juillet a produit autre chose', () => {
    // Ses livrables portent la note d'incident, la fiche et « commit 66e11b3 ».
    expect(livrablesAutoReferents(bloc(FICHIER_2026_07_12), CHEMIN_2026_07_12)).toBe(false);
  });
});

describe('Matiere manquante : classer, sur les fiches reelles', () => {
  it('bloque la fiche du 31 aout, source telephone', () => {
    const m = classer(aClasser(FICHIER_2026_08_31, CHEMIN_2026_08_31));
    expect(m.bloque).toBe(true);
    expect(m.motif).toBe('critere-ko');
    expect(m.piece).toBe('une capture du contenu');
  });

  it('bloque la fiche du 12 juillet, source cerveau', () => {
    // Celle-la est le pire cas : sans la voie question posee AVANT le test de
    // source, elle se fermerait toute seule en `validee`.
    const m = classer(aClasser(FICHIER_2026_07_12, CHEMIN_2026_07_12));
    expect(m.bloque).toBe(true);
    expect(m.motif).toBe('critere-ko');
    expect(m.piece).toBe('une permission');
  });

  it('LAISSE PASSER la fiche du 3 septembre : livrables auto-referents mais criteres OK', () => {
    // Le faux positif mesure. La feuille de route donnait l'auto-reference
    // comme « signal structurel le plus fort » : elle se trompe, et livrer
    // la-dessus transformerait un travail fait en question posee.
    const entree = aClasser(FICHIER_2026_09_03, CHEMIN_2026_09_03);
    expect(livrablesAutoReferents(entree.resultatBrut, CHEMIN_2026_09_03)).toBe(true);
    expect(classer(entree).bloque).toBe(false);
    expect(classer(entree).motif).toBe('aucun');
  });

  it('ignore un KO qui ne vit que dans le bloc Contrôle', () => {
    // Fichier ENTIER : le grep naif trouve le KO, le classifieur ne doit pas.
    expect(/demande satisfaite\s*[:=]?\s*KO/i.test(FICHIER_2026_09_03)).toBe(true);
    expect(verdictCriteres(section(FICHIER_2026_09_03, 'Résultat'))).toBe('ok');
    expect(classer(aClasser(FICHIER_2026_09_03, CHEMIN_2026_09_03)).bloque).toBe(false);
  });

  it('ne redige JAMAIS la question : verbatim, ou exactement le resume', () => {
    const avecParagraphe = classer(aClasser(FICHIER_2026_08_31, CHEMIN_2026_08_31));
    expect(avecParagraphe.question).toBe(questionPosee(bloc(FICHIER_2026_08_31)));

    const sansParagraphe = {
      path: '09-taches/x.md',
      resume: "Impossible : la cle API manque.",
      livrables: [],
      resultatBrut: 'resume: Impossible : la cle API manque.\ncriteres: demande satisfaite=KO',
    };
    expect(classer(sansParagraphe).question).toBe("Impossible : la cle API manque.");
    expect(classer(sansParagraphe).bloque).toBe(true);
  });

  it('est pure : deux appels donnent le meme objet, et l entree n est pas mutee', () => {
    const entree = aClasser(FICHIER_2026_08_31, CHEMIN_2026_08_31);
    const avant = JSON.stringify(entree);
    expect(classer(entree)).toEqual(classer(entree));
    expect(JSON.stringify(entree)).toBe(avant);
  });

  it('ne bloque jamais une tache sans bloc Résultat', () => {
    const m = classer({ path: '09-taches/y.md', resume: '', livrables: [] });
    expect(m.bloque).toBe(false);
    expect(m.motif).toBe('aucun');
  });
});

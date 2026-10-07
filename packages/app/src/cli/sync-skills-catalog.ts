#!/usr/bin/env node
/**
 * Synchro du catalogue de skills du cerveau (spec du 2026-10-07, §2.2).
 *
 * Lit la liste curee (skills-curated.txt), copie chaque SKILL.md et ses
 * references markdown, et produit `09-skills/` :
 *   09-skills/_index.md                         le hub (collections, usage, plugins publics)
 *   09-skills/<collection>/LICENSE.md           la licence de la collection
 *   09-skills/<collection>/<skill>.md           le SKILL.md, frontmatter enrichi
 *   09-skills/<collection>/<skill>/<ref>.md     ses references
 *
 * Deux sorties :
 *   --out <dossier>    ecrit les fichiers sur le disque (apercu, tests, verif)
 *   --server <url>     les envoie a POST <url>/admin/skills-catalog, qui les
 *                      ecrit dans le coffre en UN commit (jeton : CERVEAU_JETON_LOCAL)
 *
 *   npx tsx packages/app/src/cli/sync-skills-catalog.ts --out ./apercu-skills
 *   CERVEAU_JETON_LOCAL=... npx tsx packages/app/src/cli/sync-skills-catalog.ts --server https://...
 */

import { promises as fs, existsSync, readdirSync, statSync } from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

export interface Collection {
  nom: string;
  source: string;
  licence: { type: 'fichier' | 'repo'; chemin: string } | { type: 'par-skill' };
  url?: string;
  skills: string[];
}

export interface FichierCatalogue {
  chemin: string;
  contenu: string;
}

export interface Rapport {
  fichiers: FichierCatalogue[];
  copies: Array<{ nom: string; references: number; nonCopies: number }>;
  ignores: Array<{ collection: string; skill: string; raison: string }>;
}

// --- liste curee ---------------------------------------------------------------

export function lireListeCuree(texte: string): Collection[] {
  const collections: Collection[] = [];
  let courante: Collection | null = null;
  for (const brute of texte.split(/\r?\n/)) {
    const ligne = brute.replace(/#.*$/, '').trim();
    if (!ligne) continue;
    const entete = ligne.match(/^\[([a-z0-9-]+)\]\s*(.*)$/);
    if (entete) {
      const attributs = Object.fromEntries(
        entete[2]
          .split(/\s+/)
          .filter(Boolean)
          .map(a => {
            const i = a.indexOf('=');
            return [a.slice(0, i), a.slice(i + 1)];
          }),
      );
      if (!attributs.source) throw new Error(`Collection ${entete[1]} : source manquante`);
      const l = attributs.licence ?? '';
      let licence: Collection['licence'];
      if (l === 'par-skill') licence = { type: 'par-skill' };
      else if (l.startsWith('fichier:')) licence = { type: 'fichier', chemin: l.slice(8) };
      else if (l.startsWith('repo:')) licence = { type: 'repo', chemin: l.slice(5) };
      else throw new Error(`Collection ${entete[1]} : licence invalide (${l})`);
      courante = { nom: entete[1], source: attributs.source, licence, url: attributs.url, skills: [] };
      collections.push(courante);
      continue;
    }
    if (!courante) throw new Error(`Skill hors collection : ${ligne}`);
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(ligne)) throw new Error(`Nom de skill invalide : ${ligne}`);
    courante.skills.push(ligne);
  }
  return collections;
}

/** `~` → dossier perso ; `*` final → la version la plus recente (tri numerique). */
export function resoudreSource(source: string, maison = os.homedir()): string {
  let s = source.replace(/^~(?=$|[\\/])/, maison);
  if (s.endsWith('/*') || s.endsWith('\\*')) {
    const parent = s.slice(0, -2);
    const versions = readdirSync(parent).filter(v => statSync(path.join(parent, v)).isDirectory());
    if (versions.length === 0) throw new Error(`Aucune version sous ${parent}`);
    versions.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    s = path.join(parent, versions[versions.length - 1]);
  }
  return s;
}

/** Le dossier d'un skill : un dossier nomme `nom` qui contient SKILL.md (profondeur 4 max). */
export function trouverSkill(racine: string, nom: string, profondeur = 4): string | null {
  const direct = path.join(racine, nom);
  if (existsSync(path.join(direct, 'SKILL.md'))) return direct;
  if (profondeur === 0) return null;
  let entrees: string[];
  try {
    entrees = readdirSync(racine);
  } catch {
    return null;
  }
  for (const e of entrees.sort()) {
    if (e === 'node_modules' || e.startsWith('.')) continue;
    const p = path.join(racine, e);
    try {
      if (!statSync(p).isDirectory()) continue;
    } catch {
      continue;
    }
    const trouve = trouverSkill(p, nom, profondeur - 1);
    if (trouve) return trouve;
  }
  return null;
}

// --- frontmatter ---------------------------------------------------------------

export function decouper(contenu: string): { frontmatter: string | null; corps: string } {
  const m = contenu.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { frontmatter: null, corps: contenu };
  return { frontmatter: m[1], corps: contenu.slice(m[0].length) };
}

/** La valeur d'une cle YAML de premier niveau, scalaires simples, cites ou plies. */
export function valeurYaml(frontmatter: string, cle: string): string | null {
  const lignes = frontmatter.split(/\r?\n/);
  const i = lignes.findIndex(l => l.startsWith(`${cle}:`));
  if (i < 0) return null;
  const reste = lignes[i].slice(cle.length + 1).trim();
  const suite = (): string[] => {
    const out: string[] = [];
    for (let j = i + 1; j < lignes.length && /^\s+\S/.test(lignes[j]); j++) out.push(lignes[j].trim());
    return out;
  };
  if (/^[>|][+-]?$/.test(reste)) return suite().join(' ').trim() || null;
  if (reste.startsWith('"')) {
    const texte = [reste, ...suite()].join(' ');
    const m = texte.match(/^"((?:[^"\\]|\\.)*)"/);
    if (m) {
      try {
        return JSON.parse(`"${m[1]}"`);
      } catch {
        return m[1];
      }
    }
    return texte.replace(/^"|"$/g, '');
  }
  if (reste.startsWith("'")) {
    const texte = [reste, ...suite()].join(' ');
    const m = texte.match(/^'((?:[^']|'')*)'/);
    return m ? m[1].replace(/''/g, "'") : texte;
  }
  const valeur = [reste, ...suite()].join(' ').trim();
  return valeur || null;
}

function aCle(frontmatter: string, cle: string): boolean {
  return frontmatter.split(/\r?\n/).some(l => l.startsWith(`${cle}:`));
}

/** Ajoute des cles au frontmatter SANS toucher aux lignes d'origine (pas de re-serialisation YAML). */
export function enrichir(contenu: string, ajouts: Array<[string, string]>): string {
  const { frontmatter, corps } = decouper(contenu);
  const base = frontmatter ?? '';
  const lignes = ajouts.filter(([cle]) => !aCle(base, cle)).map(([cle, v]) => `${cle}: ${v}`);
  const fm = [base, ...lignes].filter(s => s.length > 0).join('\n');
  return `---\n${fm}\n---\n${frontmatter === null ? '\n' : ''}${corps}`;
}

function listerFichiers(dossier: string): string[] {
  const out: string[] = [];
  const marcher = (d: string): void => {
    for (const e of readdirSync(d).sort()) {
      if (e === 'node_modules' || e.startsWith('.')) continue;
      const p = path.join(d, e);
      if (statSync(p).isDirectory()) marcher(p);
      else out.push(path.relative(dossier, p).split(path.sep).join('/'));
    }
  };
  marcher(dossier);
  return out;
}

/** Chemin vault sur (pas de `:` ni caracteres interdits sous Windows). */
function cheminSur(rel: string): boolean {
  return !/[<>:"|?*\u0000-\u001f]/.test(rel) && rel.split('/').every(s => s && !/[. ]$/.test(s));
}

// --- construction --------------------------------------------------------------

export interface OptionsConstruction {
  maison?: string;
  /** Dossier de la liste curee (pour les licences `repo:`). */
  dossierListe: string;
  date: string;
}

export async function construireCatalogue(
  collections: Collection[],
  options: OptionsConstruction,
): Promise<Rapport> {
  const fichiers: FichierCatalogue[] = [];
  const copies: Rapport['copies'] = [];
  const ignores: Rapport['ignores'] = [];
  const resumes: Array<{ c: Collection; skills: Array<{ nom: string; fichier: string; description: string }>; licence: string; version: string }> = [];

  for (const c of collections) {
    let racine: string;
    try {
      racine = resoudreSource(c.source, options.maison);
    } catch (error) {
      for (const s of c.skills) ignores.push({ collection: c.nom, skill: s, raison: `source introuvable (${String(error)})` });
      continue;
    }
    // Une version n'a de sens que pour un plugin resolu par `*`.
    const version = /[\\/]\*$/.test(c.source) ? path.basename(racine) : '-';

    let licenceCollection = '';
    if (c.licence.type === 'fichier') {
      licenceCollection = await fs.readFile(path.join(racine, c.licence.chemin), 'utf8').catch(() => '');
    } else if (c.licence.type === 'repo') {
      licenceCollection = await fs.readFile(path.join(options.dossierListe, c.licence.chemin), 'utf8').catch(() => '');
    }
    if (c.licence.type !== 'par-skill' && !licenceCollection.trim()) {
      for (const s of c.skills) ignores.push({ collection: c.nom, skill: s, raison: 'licence de collection introuvable' });
      continue;
    }

    const resume = { c, skills: [] as Array<{ nom: string; fichier: string; description: string }>, licence: '', version };
    if (licenceCollection.trim()) {
      resume.licence = licenceCollection.split(/\r?\n/).find(l => l.trim())?.trim() ?? 'voir LICENSE';
      fichiers.push({
        chemin: `09-skills/${c.nom}/LICENSE.md`,
        contenu:
          `---\ntype: document\ntags: [skill]\ncollection: ${c.nom}\n---\n\n# Licence de la collection ${c.nom}\n\n` +
          (c.url ? `Origine : ${c.url}\n\n` : '') +
          '```text\n' +
          licenceCollection.trim() +
          '\n```\n',
      });
    }

    for (const skill of c.skills) {
      const dossier = trouverSkill(racine, skill);
      if (!dossier) {
        ignores.push({ collection: c.nom, skill, raison: 'dossier introuvable' });
        continue;
      }
      const brut = await fs.readFile(path.join(dossier, 'SKILL.md'), 'utf8');
      const { frontmatter } = decouper(brut);
      const fm = frontmatter ?? '';

      let licenceSkill: string | null = null;
      const fichierLicence = readdirSync(dossier).find(f => /^licen[cs]e(\.(md|txt))?$/i.test(f));
      if (c.licence.type === 'par-skill') {
        if (fichierLicence) licenceSkill = await fs.readFile(path.join(dossier, fichierLicence), 'utf8');
        else if (/^mit$/i.test(valeurYaml(fm, 'license') ?? '')) licenceSkill = 'MIT (frontmatter du skill)';
        if (!licenceSkill) {
          ignores.push({ collection: c.nom, skill, raison: 'aucune licence claire' });
          continue;
        }
      }

      const nom = `${c.nom}-${skill}`;
      const description = (valeurYaml(fm, 'description') ?? '').replace(/\s+/g, ' ').trim();
      const tous = listerFichiers(dossier);
      const references = tous.filter(f => f !== 'SKILL.md' && f.toLowerCase().endsWith('.md') && cheminSur(f));
      const nonCopies = tous.filter(f => f !== 'SKILL.md' && !references.includes(f) && !/^licen[cs]e/i.test(path.basename(f))).length;

      fichiers.push({
        chemin: `09-skills/${c.nom}/${skill}.md`,
        contenu: enrichir(brut, [
          ['catalogue_nom', nom],
          ['collection', c.nom],
          ['catalogue_description', JSON.stringify(description)],
          ['type', 'document'],
          ['tags', '[skill]'],
          ['source', JSON.stringify(version === '-' ? c.nom : `${c.nom} ${version}`)],
          ['synced', options.date],
          ...(nonCopies > 0 ? ([['fichiers_non_copies', String(nonCopies)]] as Array<[string, string]>) : []),
        ]),
      });
      for (const ref of references) {
        const contenu = await fs.readFile(path.join(dossier, ref), 'utf8');
        fichiers.push({
          chemin: `09-skills/${c.nom}/${skill}/${ref}`,
          contenu: decouper(contenu).frontmatter === null
            ? enrichir(contenu, [['type', 'document'], ['tags', '[skill]'], ['skill', nom]])
            : contenu,
        });
      }
      if (licenceSkill && fichierLicence) {
        fichiers.push({
          chemin: `09-skills/${c.nom}/${skill}/LICENSE.md`,
          contenu: `---\ntype: document\ntags: [skill]\nskill: ${nom}\n---\n\n# Licence de ${nom}\n\n\`\`\`text\n${licenceSkill.trim()}\n\`\`\`\n`,
        });
      }
      copies.push({ nom, references: references.length, nonCopies });
      resume.skills.push({ nom, fichier: `09-skills/${c.nom}/${skill}`, description });
    }
    resumes.push(resume);
  }

  fichiers.push({ chemin: '09-skills/_index.md', contenu: rendreIndex(resumes, options.date, copies.length) });
  return { fichiers: sansEmDash(fichiers), copies, ignores };
}

function rendreIndex(
  resumes: Array<{ c: Collection; skills: Array<{ nom: string; fichier: string; description: string }>; licence: string; version: string }>,
  date: string,
  total: number,
): string {
  const lignes: string[] = [
    '---',
    'type: hub',
    'tags: [hub, skill]',
    `created: ${date}`,
    '---',
    '',
    '# Catalogue de skills',
    '',
    `${total} skills curés par Darius, synchronisés le ${date} par \`sync-skills-catalog\`. Ce dossier est généré : ne l'édite pas à la main, modifie \`skills-curated.txt\` puis relance la synchro.`,
    '',
    '## Comment s\'en servir',
    '',
    '- **find-skill** cherche par le sens le skill qui convient à une tâche (ex. « debug python »).',
    '- **read-skill** rend le skill complet à partir du nom exact rendu par find-skill.',
    '- Les références d\'un skill se lisent avec read-note, sous `09-skills/<collection>/<skill>/`.',
    '',
    '## Collections',
    '',
    '| Collection | Skills | Version | Licence | Origine |',
    '|---|---|---|---|---|',
  ];
  for (const r of resumes) {
    lignes.push(
      `| ${r.c.nom} | ${r.skills.length} | ${r.version} | ${r.c.licence.type === 'par-skill' ? 'par skill (MIT)' : r.licence} | ${r.c.url ?? '-'} |`,
    );
  }
  for (const r of resumes) {
    lignes.push('', `## ${r.c.nom}`, '');
    for (const s of r.skills) {
      const resume = s.description.length > 160 ? `${s.description.slice(0, 157)}...` : s.description;
      lignes.push(`- [[${s.fichier}|${s.nom}]] : ${resume.replace(/\|/g, '/')}`);
    }
  }
  lignes.push(
    '',
    '## Plugins publics (à installer soi-même)',
    '',
    'Ces collections ne sont pas copiées ici : elles s\'installent en une commande dans Claude Code.',
    '',
    '- Vercel : `/plugin install vercel@claude-plugins-official`',
    '- SEO (AgriciDaniel) : `/plugin marketplace add AgriciDaniel/claude-seo` puis `/plugin install claude-seo@agricidaniel-claude-seo`',
    '- Superpowers et Matt Pocock, en version complète : `/plugin install superpowers@claude-plugins-official`, `/plugin install mattpocock-skills@claude-plugins-official`',
    '',
  );
  return lignes.join('\n');
}

// --- sorties ---------------------------------------------------------------------

/**
 * Zero em-dash (regle du coffre) : meme remplacement que le serveur a
 * l'ecriture (git-vault-manager.ts, stripEmDash). Applique ici pour que
 * l'apercu --out montre exactement ce que le coffre contiendra.
 */
const EM_DASH = new RegExp(`[ \\t]*${String.fromCharCode(0x2014)}[ \\t]*`, 'g');

export function sansEmDash(fichiers: FichierCatalogue[]): FichierCatalogue[] {
  return fichiers.map(f =>
    f.chemin.endsWith('.md') ? { ...f, contenu: f.contenu.replace(EM_DASH, ' : ') } : f,
  );
}

export async function ecrireSurDisque(dossier: string, fichiers: FichierCatalogue[]): Promise<void> {
  for (const f of fichiers) {
    const complet = path.join(dossier, ...f.chemin.split('/'));
    await fs.mkdir(path.dirname(complet), { recursive: true });
    await fs.writeFile(complet, f.contenu, 'utf8');
  }
}

export async function envoyerAuServeur(
  url: string,
  jeton: string,
  fichiers: FichierCatalogue[],
): Promise<unknown> {
  const reponse = await fetch(`${url.replace(/\/$/, '')}/admin/skills-catalog`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jeton}` },
    body: JSON.stringify({ fichiers }),
  });
  const corps = await reponse.json().catch(() => ({}));
  if (!reponse.ok) throw new Error(`Serveur : HTTP ${reponse.status} ${JSON.stringify(corps)}`);
  return corps;
}

function jourMontreal(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Montreal',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const option = (n: string): string | undefined => {
    const i = args.indexOf(n);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const ici = path.dirname(fileURLToPath(import.meta.url));
  const liste = option('--liste') ?? path.join(ici, 'skills-curated.txt');
  const collections = lireListeCuree(await fs.readFile(liste, 'utf8'));
  const rapport = await construireCatalogue(collections, {
    dossierListe: path.dirname(liste),
    date: option('--date') ?? jourMontreal(),
  });

  const octets = rapport.fichiers.reduce((n, f) => n + Buffer.byteLength(f.contenu), 0);
  console.log(
    `Catalogue : ${rapport.copies.length} skills, ${rapport.fichiers.length} fichiers, ${(octets / 1024).toFixed(0)} Ko`,
  );
  for (const i of rapport.ignores) console.log(`  ignore : ${i.collection}/${i.skill} (${i.raison})`);

  const out = option('--out');
  const serveur = option('--server');
  if (out) {
    await ecrireSurDisque(out, rapport.fichiers);
    console.log(`Ecrit dans ${out}`);
  }
  if (serveur) {
    const jeton = process.env.CERVEAU_JETON_LOCAL?.trim();
    if (!jeton) throw new Error('CERVEAU_JETON_LOCAL manquant pour --server');
    console.log('Envoi au serveur :', await envoyerAuServeur(serveur, jeton, rapport.fichiers));
  }
  if (!out && !serveur) console.log('(apercu seulement : --out <dossier> ou --server <url> pour ecrire)');
}

if (process.argv[1] && /sync-skills-catalog\.(ts|js)$/.test(process.argv[1])) {
  main().catch(error => {
    console.error(String((error as Error).message ?? error));
    process.exit(1);
  });
}

import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import {
  RelanceSweepService,
  recordAnswer,
  consumeAnswer,
  markAnswered,
} from '@/services/relance/relance-sweep';
import type { VaultManager } from '@/services/vault-manager';
import type { NotifyPusher, Notification } from '@/services/notify/notifier';
import { configureLogger } from '@/utils/logger';

beforeAll(() => {
  configureLogger({ stream: process.stdout, minLevel: 'error' });
});

class FakeVault implements VaultManager {
  files = new Map<string, string>();
  async readFile(path: string): Promise<string> {
    const content = this.files.get(path);
    if (content === undefined) throw new Error(`ENOENT: ${path}`);
    return content;
  }
  async writeFile(path: string, content: string): Promise<void> {
    this.files.set(path, content);
  }
  async deleteFile(path: string): Promise<void> {
    this.files.delete(path);
  }
  async moveFile(src: string, dest: string): Promise<void> {
    const content = await this.readFile(src);
    this.files.delete(src);
    this.files.set(dest, content);
  }
  async createDirectory(): Promise<void> {}
  async listFiles(prefix?: string): Promise<string[]> {
    const all = [...this.files.keys()];
    return prefix ? all.filter(f => f.startsWith(prefix)) : all;
  }
  async fileExists(path: string): Promise<boolean> {
    return this.files.has(path);
  }
  getVaultPath(): string {
    return '/fake';
  }
}

class FakeNotify implements NotifyPusher {
  pushes: Notification[] = [];
  async push(n: Notification): Promise<void> {
    this.pushes.push(n);
  }
}

const OLD = '2000-01-01';

describe('relance sweep', () => {
  let vault: FakeVault;
  let notify: FakeNotify;

  beforeEach(() => {
    vault = new FakeVault();
    notify = new FakeNotify();
  });

  function service(): RelanceSweepService {
    return new RelanceSweepService({
      vault,
      notify,
      baseUrl: 'https://cerveau.example',
      token: 'tok',
    });
  }

  it("consumeAnswer(abandon) COCHE l'item de _darius.md (fin du re-harcelement)", async () => {
    vault.files.set(
      '09-taches/_darius.md',
      '# Liste\n\n- [ ] Envoyer le témoignage Any Claude : le brouillon est prêt (ajouté: 2000-01-01)\n- [ ] Autre action (ajouté: 2000-01-01)\n',
    );

    const action = await consumeAnswer(
      vault,
      'abandon',
      'Envoyer le témoignage Any Claude : le brouillon est prêt',
      '09-taches/_darius.md',
    );

    expect(action).toContain('abandonné');
    const content = vault.files.get('09-taches/_darius.md')!;
    expect(content).toContain('- [x] Envoyer le témoignage Any Claude');
    expect(content).toContain('(abandonné:');
    expect(content).toContain('- [ ] Autre action'); // pas touché
    // Et la relance ne le voit plus (elle ne lit que les [ ]).
    await service().runSweep();
    expect(notify.pushes.find(p => p.message.includes('Any Claude'))).toBeUndefined();
  });

  it("consumeAnswer(fait) valide une tâche a-valider : la déclaration EST la validation", async () => {
    vault.files.set(
      '09-taches/2026-07-07-demo.md',
      '---\ntype: tache\nstatut: a-valider\n---\n\n# Demo\n\n## Résultat\nfait\n',
    );

    const action = await consumeAnswer(vault, 'fait', 'Valider : Demo', '09-taches/2026-07-07-demo.md');

    expect(action).toContain('validee');
    expect(vault.files.get('09-taches/2026-07-07-demo.md')).toContain('statut: validee');
  });

  it('markAnswered(manque) : la relance se tait 7 jours sur cette cause', async () => {
    vault.files.set(
      '09-taches/_darius.md',
      '# Liste\n\n- [ ] Envoyer le mail marchand (ajouté: 2000-01-01)\n',
    );
    // Premier sweep : la question part.
    await service().runSweep();
    expect(notify.pushes).toHaveLength(1);
    const title = 'Envoyer le mail marchand';
    await markAnswered(vault, title, '09-taches/_darius.md');
    // On efface la trace « asked » pour isoler l'effet « answered ».
    const st = JSON.parse(vault.files.get('08-auto/_relances-state.json')!);
    st.asked = {};
    vault.files.set('08-auto/_relances-state.json', JSON.stringify(st));
    notify.pushes = [];

    await service().runSweep();

    expect(notify.pushes).toHaveLength(0); // répondu = silence, même sans « asked »
  });

  it("livrable a-valider : la relance SERT le résultat avec Valider/Rejeter, pas un pourquoi", async () => {
    vault.files.set(
      '09-taches/2026-07-07-demo-link.md',
      [
        '---',
        'type: tache',
        'statut: a-valider',
        'created: 2000-01-01',
        '---',
        '',
        '# Demo link AR-mesure',
        '',
        '## Résultat',
        '',
        '- Démo déployée : https://demo.example/pdp',
        '',
        '## Contrôle',
        '',
      ].join('\n'),
    );

    await service().runSweep();

    expect(notify.pushes).toHaveLength(1);
    const push = notify.pushes[0];
    expect(push.title).toContain('Livrable prêt');
    expect(push.message).toContain('https://demo.example/pdp');
    expect(push.actions?.map(a => a.label)).toEqual(['Valider', 'Rejeter', 'Revue']);
    expect(push.actions?.[0].url).toContain('/valide?k=tok&t=');
  });

  it("tâche échouée : notif « Tâche échouée » avec Relancer/Abandonner, jamais le silence", async () => {
    vault.files.set(
      '09-taches/2026-07-10-pilote-resto.md',
      [
        '---',
        'type: tache',
        'statut: echouee',
        'created: 2000-01-01',
        '---',
        '',
        '# Monter le paquet pilote resto',
        '',
        '## Journal',
        '',
        'Erreur worker : le controleur n a pas produit son bloc CONTROLE',
        '',
      ].join('\n'),
    );

    await service().runSweep();

    expect(notify.pushes).toHaveLength(1);
    const push = notify.pushes[0];
    expect(push.title).toContain('Tâche échouée');
    expect(push.message).toContain('Erreur worker');
    expect(push.actions?.map(a => a.label)).toEqual(['Relancer', 'Abandonner', 'Revue']);
    expect(push.actions?.[0].url).toContain('/approuve?k=tok&t=');

    // Même jour : pas de re-spam.
    notify.pushes = [];
    await service().runSweep();
    expect(notify.pushes).toHaveLength(0);
  });

  it('rappel récurrent dû : UNE notif, puis la date est repoussée d une période', async () => {
    const today = new Date().toISOString().slice(0, 10);
    vault.files.set(
      '09-taches/_rappels.md',
      `# Rappels\n\n- [ ] Appeler mes soeurs · chaque: 14j · prochain: ${today}\n`,
    );

    await service().runSweep();

    const rappelPush = notify.pushes.find(p => p.title.includes('Rappel'));
    expect(rappelPush).toBeDefined();
    expect(rappelPush!.message).toContain('Appeler mes soeurs');
    const attendu = new Date(Date.parse(`${today}T00:00:00Z`) + 14 * 86_400_000)
      .toISOString()
      .slice(0, 10);
    expect(vault.files.get('09-taches/_rappels.md')).toContain(`prochain: ${attendu}`);

    // Deuxième passe le même jour : la date a été repoussée, plus de notif rappel.
    notify.pushes = [];
    await service().runSweep();
    expect(notify.pushes.find(p => p.title.includes('Rappel'))).toBeUndefined();
  });

  it('rappel pas encore dû ou coché [x] : aucun bruit, ligne intacte', async () => {
    vault.files.set(
      '09-taches/_rappels.md',
      [
        '# Rappels',
        '',
        '- [ ] Payer le loyer · chaque: 30j · prochain: 2999-01-01',
        '- [x] Vieille habitude · chaque: 7j · prochain: 2000-01-01',
        '',
      ].join('\n'),
    );
    const avant = vault.files.get('09-taches/_rappels.md');

    await service().runSweep();

    expect(notify.pushes.find(p => p.title.includes('Rappel'))).toBeUndefined();
    expect(vault.files.get('09-taches/_rappels.md')).toBe(avant);
  });

  it('asks WHY for the oldest stalled item, with one-tap answer buttons', async () => {
    vault.files.set(
      '09-taches/_darius.md',
      `# t\n\n- [ ] Envoyer le témoignage (ajouté: ${OLD})\n- [x] Chose faite (ajouté: ${OLD})\n`,
    );
    const result = await service().runSweep();

    expect(result.stalled).toBe(1);
    expect(result.asked).toContain('témoignage');
    expect(notify.pushes).toHaveLength(1);
    const push = notify.pushes[0];
    expect(push.title).toContain('pourquoi');
    expect(push.actions).toHaveLength(3);
    expect(push.actions?.[0].url).toContain('/reponse?k=tok');
    // « Déjà fait » d'abord (la déclaration EST la validation), puis manque, puis abandon.
    expect(push.actions?.map(a => a.label)).toEqual(['Déjà fait', 'Il me manque un truc', 'Plus pertinent']);
    expect(push.actions?.[0].url).toContain('c=fait');
    expect(push.actions?.[2].url).toContain('c=abandon');
  });

  it('watches a-valider tasks but ignores fresh and non-pending ones', async () => {
    vault.files.set(
      '09-taches/2026-01-01-vieille.md',
      `---\ntype: tache\nstatut: a-valider\ncreated: ${OLD}\n---\n\n# Vieille tache\n`,
    );
    vault.files.set(
      '09-taches/2026-01-02-en-cours.md',
      `---\ntype: tache\nstatut: en-cours\ncreated: ${OLD}\n---\n\n# Pas concernee\n`,
    );
    const result = await service().runSweep();

    expect(result.watched).toBe(1);
    expect(result.asked).toContain('Valider : Vieille tache');
  });

  it('never re-asks the same item within the re-ask window', async () => {
    vault.files.set('09-taches/_darius.md', `# t\n\n- [ ] Chose en retard (ajouté: ${OLD})\n`);
    const svc = service();
    await svc.runSweep();
    notify.pushes = [];
    const second = await svc.runSweep();

    expect(second.asked).toBeNull();
    expect(notify.pushes).toHaveLength(0);
  });

  it('recordAnswer prepends the dated cause where agents will read it', async () => {
    await recordAnswer(vault, 'Envoyer le témoignage', '09-taches/_darius.md', 'pas envie ou peur');
    const content = vault.files.get('09-taches/_reponses.md') ?? '';
    expect(content).toContain('[pas envie ou peur] Envoyer le témoignage');
    expect(content).toContain('dissolvent la cause');
  });
});

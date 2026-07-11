import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import {
  MorningBriefService,
  parseTopPriority,
  parseLatestInsight,
  parseLatestQuestion,
} from '@/services/brief/morning-brief';
import type { ObjectiveNote } from '@/services/objectives/objective-sweep';
import type { VaultManager } from '@/services/vault-manager';
import type { NotifyPusher, NotifyMessage } from '@/services/notify/notifier';
import { configureLogger } from '@/utils/logger';

beforeAll(() => {
  configureLogger({ stream: process.stdout, minLevel: 'error' });
});

// --- fakes ---------------------------------------------------------------------

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
  async listFiles(): Promise<string[]> {
    return [...this.files.keys()];
  }
  async fileExists(path: string): Promise<boolean> {
    return this.files.has(path);
  }
  getVaultPath(): string {
    return '/fake';
  }
}

class FakeNotify implements NotifyPusher {
  pushes: NotifyMessage[] = [];
  async push(message: NotifyMessage): Promise<void> {
    this.pushes.push(message);
  }
}

function objective(over: Partial<ObjectiveNote> = {}): ObjectiveNote {
  return {
    file: '00-personnel/objectif-caq.md',
    title: 'Objectif : renouveler le CAQ',
    statut: 'ouvert',
    echeance: '2999-12-31',
    conditions: [
      { name: 'Formulaire signé', criteria: 'signé et daté', done: false },
      { name: 'Attestation', criteria: 'datée', done: true },
    ],
    ...over,
  };
}

const PRIORITIES = `---
type: compass
---

# Priorités

## Priorités (dans l'ordre)

1. **AR-mesure, pilote marchand.** LE goulot : l'email marchand [[note-289|#289]].
2. **Send Me Now.**
`;

// --- tests ---------------------------------------------------------------------

describe('parseTopPriority', () => {
  it('extracts the first numbered item, stripping wikilinks and bold', () => {
    const top = parseTopPriority(PRIORITIES);
    expect(top).toContain('AR-mesure, pilote marchand.');
    expect(top).toContain('#289');
    expect(top).not.toContain('[[');
    expect(top).not.toContain('**');
  });
});

describe('morning brief', () => {
  let vault: FakeVault;
  let notify: FakeNotify;
  let objectives: ObjectiveNote[];

  beforeEach(() => {
    vault = new FakeVault();
    notify = new FakeNotify();
    objectives = [objective()];
    vault.files.set('08-auto/_priorities.md', PRIORITIES);
    vault.files.set('08-auto/_objectifs-propositions.md', '# t\n\n## s\n- prop 1\n- prop 2\n');
  });

  function service(): MorningBriefService {
    return new MorningBriefService({
      objectives: { loadObjectives: async () => objectives },
      vault,
      notify,
      baseUrl: 'https://cerveau.example',
      token: 'tok',
    });
  }

  it('sends one push with deadline, priority and pending counts', async () => {
    const result = await service().runBrief();

    expect(result.sent).toBe(true);
    expect(notify.pushes).toHaveLength(1);
    const msg = notify.pushes[0].message;
    expect(notify.pushes[0].title).toBe('Brief du matin');
    expect(msg).toContain('Échéance : Objectif : renouveler le CAQ');
    expect(msg).toContain('1 condition(s) ouverte(s)');
    expect(msg).toContain('Priorité n°1 : AR-mesure');
    expect(msg).toContain('2 objectifs');
    // Record written for the vault.
    expect(vault.files.get('08-auto/_brief-matin.md')).toContain('Brief du matin');
  });

  it('dedups per day: second run same day sends nothing', async () => {
    const svc = service();
    await svc.runBrief();
    notify.pushes = [];
    const second = await svc.runBrief();

    expect(second.sent).toBe(false);
    expect(second.reason).toContain('already sent');
    expect(notify.pushes).toHaveLength(0);
  });

  it('only counts NEW bullets since the last brief', async () => {
    const svc = service();
    await svc.runBrief();
    // New day, one new proposal appended.
    vault.files.set(
      '08-auto/_brief-state.json',
      JSON.stringify({
        version: 1,
        lastSentDate: '2000-01-01',
        bulletCounts: JSON.parse(vault.files.get('08-auto/_brief-state.json') as string).bulletCounts,
      }),
    );
    vault.files.set('08-auto/_objectifs-propositions.md', '# t\n\n## s\n- prop 1\n- prop 2\n- prop 3\n');
    notify.pushes = [];
    const result = await svc.runBrief();

    expect(result.sent).toBe(true);
    expect(result.pending).toBe(1);
    expect(notify.pushes[0].message).toContain('1 objectifs');
  });

  it('quotes the newest insight headline as the first line of the brief', async () => {
    vault.files.set(
      '08-auto/_insights.md',
      '# t\n\n## 2026-07-06\n\n- **[croisement] Gridar peut nourrir la page services**\n  Preuve : [[a]] + [[b]].\n',
    );
    const result = await service().runBrief();

    expect(result.sent).toBe(true);
    const msg = notify.pushes[0].message;
    expect(msg.startsWith('Insight : croisement : Gridar peut nourrir la page services')).toBe(true);
    expect(msg).toContain('1 insights');
  });

  it('serves the night thinker question of the day when fresh, else stays silent on it', async () => {
    const today = new Date().toISOString().slice(0, 10);
    vault.files.set(
      '08-auto/_question.md',
      `# t\n\n## ${today}\n\nTu vises 10k mais aucun coup n'est daté cette semaine, lequel prends-tu ? || sinon le mois file\n`,
    );
    const result = await service().runBrief();
    expect(result.sent).toBe(true);
    const push = notify.pushes[0];
    expect(push.message).toContain('Question du jour : Tu vises 10k');
    expect(push.message).toContain('pk:');
    // One-tap "Répondre" (capture prefilled with "pk: ") then "Revue" (triage).
    expect(push.actions).toHaveLength(2);
    expect(push.actions?.[0].label).toBe('Répondre');
    expect(push.actions?.[0].url).toContain('/capture/app?k=tok');
    expect(push.actions?.[0].url).toContain('prefill=pk');
    expect(push.actions?.[1].label).toBe('Revue');
    expect(push.actions?.[1].url).toContain('/revue?k=tok');
  });

  it('adds only the Revue button when there is no fresh question', async () => {
    const result = await service().runBrief();
    expect(result.sent).toBe(true);
    // No "Répondre" without a question, but "Revue" is always one tap away.
    expect(notify.pushes[0].actions).toHaveLength(1);
    expect(notify.pushes[0].actions?.[0].label).toBe('Revue');
  });

  it('ignores a stale question from a previous day', async () => {
    vault.files.set(
      '08-auto/_question.md',
      `# t\n\n## 2000-01-01\n\nVieille question ?\n`,
    );
    const result = await service().runBrief();
    expect(result.sent).toBe(true);
    expect(notify.pushes[0].message).not.toContain('Question du jour');
  });

  it('parseLatestQuestion reads the newest question line', () => {
    const md = '# t\n\n## 2026-07-07\n\n> guide\n\nQuelle est la vraie question ? || parce que\n\n## 2026-07-01\n\nVieille ?\n';
    expect(parseLatestQuestion(md)).toContain('Quelle est la vraie question');
    expect(parseLatestQuestion(md)).not.toContain('Vieille');
  });

  it('parseLatestInsight reads only the newest section', () => {
    const md =
      '# t\n\n## 2026-07-06\n\n- **[alerte] Nouvelle alerte**\n\n## 2026-07-01\n\n- **[business] Vieille idee**\n';
    expect(parseLatestInsight(md)).toContain('Nouvelle alerte');
    expect(parseLatestInsight(md)).not.toContain('Vieille idee');
  });

  it('excludes settled conclusions from the daily-channel count', async () => {
    vault.files.set(
      '03-daily/2026-07-09.md',
      '# j\n\n### Propositions en attente (à valider)\n\n- [ ] deja faite hier\n- [ ] toute neuve\n',
    );
    const fakeRegistry = {
      settledMask: async (texts: string[]) => texts.map(t => t.includes('deja faite')),
    };
    const svc = new MorningBriefService({
      objectives: { loadObjectives: async () => objectives },
      vault,
      notify,
      baseUrl: 'https://cerveau.example',
      token: 'tok',
      conclusions: fakeRegistry as any,
    });
    const result = await svc.runBrief();
    expect(result.sent).toBe(true);
    expect(notify.pushes[0].message).toContain('1 du carnet du jour'); // pas 2
  });

  it('watchdog: alerts when the night thinker heartbeat is missing or stale', async () => {
    vault.files.set('08-auto/_insights.md', '# t\n\n## 2026-07-01\n\n- **[x] vieux**\n');
    // Heartbeat absent → alerte.
    const r1 = await service().runBrief();
    expect(r1.sent).toBe(true);
    expect(notify.pushes[0].message).toContain('Penseur de nuit');
    // Heartbeat frais → silence du chien de garde.
    vault.files.set(
      '08-auto/_veille-workers.json',
      JSON.stringify({ 'penseur-de-nuit': { last: new Date().toISOString() } }),
    );
    notify.pushes = [];
    const svc2 = service();
    const r2 = await svc2.runBrief(true);
    expect(r2.sent).toBe(true);
    expect(notify.pushes[0].message).not.toContain('Penseur de nuit');
  });

  it('watchdog: lit le nouveau fichier par worker', async () => {
    vault.files.set('08-auto/_insights.md', '# t\n\n## 2026-07-01\n\n- **[x] vieux**\n');
    vault.files.set(
      '08-auto/_veille-workers/penseur-de-nuit.json',
      JSON.stringify({ worker: 'penseur-de-nuit', last: new Date().toISOString(), ahead: 0 }),
    );
    await service().runBrief();
    expect(notify.pushes[0].message).not.toContain('Penseur de nuit');
  });

  it('watchdog: la telemetrie HTTP en direct fait taire une alerte du fichier vault', async () => {
    // Fichier vault muet (clone gele) MAIS le worker parle en HTTP : pas d'alerte de silence.
    vault.files.set('08-auto/_insights.md', '# t\n\n## 2026-07-01\n\n- **[x] vieux**\n');
    const svc = new MorningBriefService({
      objectives: { loadObjectives: async () => objectives },
      vault,
      notify,
      telemetry: () => ({ 'penseur-de-nuit': { last: new Date().toISOString(), ahead: 0 } }),
    });
    await svc.runBrief();
    expect(notify.pushes[0].message).not.toContain('aucun battement');
  });

  it('watchdog: vivant mais ahead > 0 declenche l alerte push (le verificateur de push)', async () => {
    const svc = new MorningBriefService({
      objectives: { loadObjectives: async () => objectives },
      vault,
      notify,
      telemetry: () => ({ 'chef-de-chantier': { last: new Date().toISOString(), ahead: 4 } }),
    });
    await svc.runBrief();
    const msg = notify.pushes[0].message;
    expect(msg).toContain('4 commit(s) non poussé(s)');
    expect(msg).toContain('Chef de chantier');
  });

  it('overdue deadline raises priority and is labelled', async () => {
    objectives = [objective({ echeance: '2000-01-01' })];
    await service().runBrief();

    expect(notify.pushes[0].priority).toBe(4);
    expect(notify.pushes[0].message).toContain('DÉPASSÉE');
  });

  it('stays silent when there is nothing to say', async () => {
    objectives = [];
    vault.files.delete('08-auto/_priorities.md');
    vault.files.delete('08-auto/_objectifs-propositions.md');
    const result = await service().runBrief();

    expect(result.sent).toBe(false);
    expect(result.reason).toContain('nothing');
    expect(notify.pushes).toHaveLength(0);
  });
});

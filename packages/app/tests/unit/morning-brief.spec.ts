import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import { MorningBriefService, parseTopPriority } from '@/services/brief/morning-brief';
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

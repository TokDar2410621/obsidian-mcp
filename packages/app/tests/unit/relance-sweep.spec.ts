import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import { RelanceSweepService, recordAnswer } from '@/services/relance/relance-sweep';
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
    expect(push.actions?.[0].url).toContain('c=manque');
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

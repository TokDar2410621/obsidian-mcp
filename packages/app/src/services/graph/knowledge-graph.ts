import type { Community, GraphExtraction, GraphNodeView } from '@/services/graph/types';

/** Canonical key for an entity name (case/space-insensitive). */
function key(name: string): string {
  return name.toLowerCase().replace(/\s+/g, ' ').trim();
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9]+/)
    .filter(t => t.length >= 3);
}

interface Node {
  name: string;
  mentions: Set<string>;
}
interface Edge {
  source: string;
  relation: string;
  target: string;
  notes: Set<string>;
}

export interface GraphEdgeView {
  source: string;
  relation: string;
  target: string;
  notes: string[];
}

export interface GraphDataNode {
  /** Entity display name (also the link source/target id). */
  id: string;
  degree: number;
  notes: number;
}

export interface GraphData {
  nodes: GraphDataNode[];
  links: GraphEdgeView[];
}

/**
 * In-memory knowledge graph: entities (nodes, with the notes that mention them)
 * and relations (edges). Pure data structure — no LLM, no IO.
 */
export class KnowledgeGraph {
  private nodes = new Map<string, Node>();
  private adjacency = new Map<string, Set<string>>();
  private edges = new Map<string, Edge>();

  addNote(file: string, extraction: GraphExtraction): void {
    for (const e of extraction.entities) this.touch(e, file);
    for (const r of extraction.relations) {
      this.touch(r.source, file);
      this.touch(r.target, file);
      const sk = key(r.source);
      const tk = key(r.target);
      if (sk === tk) continue;
      this.adjacency.get(sk)!.add(tk);
      this.adjacency.get(tk)!.add(sk);
      const ek = `${sk}|${r.relation.toLowerCase()}|${tk}`;
      let edge = this.edges.get(ek);
      if (!edge) {
        edge = { source: r.source, relation: r.relation, target: r.target, notes: new Set() };
        this.edges.set(ek, edge);
      }
      edge.notes.add(file);
    }
  }

  private touch(name: string, file: string): void {
    const k = key(name);
    let node = this.nodes.get(k);
    if (!node) {
      node = { name, mentions: new Set() };
      this.nodes.set(k, node);
      this.adjacency.set(k, new Set());
    }
    node.mentions.add(file);
  }

  get size(): { entities: number; relations: number } {
    return { entities: this.nodes.size, relations: this.edges.size };
  }

  nodeName(k: string): string {
    return this.nodes.get(k)?.name ?? k;
  }

  /** Entity keys whose name shares a token with the query, best first. */
  matchEntities(query: string, limit = 8): string[] {
    const qtokens = new Set(tokenize(query));
    if (qtokens.size === 0) return [];
    const scored: Array<{ k: string; s: number }> = [];
    for (const [k, node] of this.nodes) {
      const overlap = tokenize(node.name).filter(t => qtokens.has(t)).length;
      if (overlap > 0) scored.push({ k, s: overlap + node.mentions.size * 0.01 });
    }
    return scored
      .sort((a, b) => b.s - a.s)
      .slice(0, limit)
      .map(x => x.k);
  }

  /** BFS neighborhood around seed keys up to `depth` hops. */
  expand(seeds: string[], depth: number): Set<string> {
    const visited = new Set<string>(seeds.filter(s => this.nodes.has(s)));
    let frontier = [...visited];
    for (let d = 0; d < depth; d++) {
      const next: string[] = [];
      for (const k of frontier) {
        for (const nb of this.adjacency.get(k) ?? []) {
          if (!visited.has(nb)) {
            visited.add(nb);
            next.push(nb);
          }
        }
      }
      frontier = next;
    }
    return visited;
  }

  /** Edges with both endpoints inside the given entity-key set. */
  edgesWithin(keys: Set<string>): GraphEdgeView[] {
    const out: GraphEdgeView[] = [];
    for (const edge of this.edges.values()) {
      if (keys.has(key(edge.source)) && keys.has(key(edge.target))) {
        out.push({
          source: edge.source,
          relation: edge.relation,
          target: edge.target,
          notes: [...edge.notes],
        });
      }
    }
    return out;
  }

  notesFor(keys: Set<string>): string[] {
    const files = new Set<string>();
    for (const k of keys) for (const f of this.nodes.get(k)?.mentions ?? []) files.add(f);
    return [...files];
  }

  /** Connected components (communities) of the entity graph, largest first. */
  communities(minSize = 3): Community[] {
    const seen = new Set<string>();
    const comms: Community[] = [];
    let id = 0;
    for (const start of this.nodes.keys()) {
      if (seen.has(start)) continue;
      seen.add(start);
      const stack = [start];
      const members: string[] = [];
      while (stack.length) {
        const k = stack.pop()!;
        members.push(this.nodeName(k));
        for (const nb of this.adjacency.get(k) ?? []) {
          if (!seen.has(nb)) {
            seen.add(nb);
            stack.push(nb);
          }
        }
      }
      if (members.length >= minSize)
        comms.push({ id: id++, entities: members, size: members.length });
    }
    return comms.sort((a, b) => b.size - a.size);
  }

  /** Most-connected entities (graph "hubs"). */
  topEntities(limit = 12): GraphNodeView[] {
    return [...this.nodes.entries()]
      .map(([k, n]) => ({
        name: n.name,
        mentions: [...n.mentions],
        degree: this.adjacency.get(k)?.size ?? 0,
      }))
      .sort((a, b) => b.degree - a.degree)
      .slice(0, limit);
  }

  /** Nodes + links for a force-graph view: the `limit` most-connected entities and their edges. */
  graphData(limit = 150): GraphData {
    const top = [...this.nodes.entries()]
      .map(([k, n]) => ({ k, name: n.name, degree: this.adjacency.get(k)?.size ?? 0, notes: n.mentions.size }))
      .sort((a, b) => b.degree - a.degree)
      .slice(0, limit);
    const keys = new Set(top.map(t => t.k));
    // Canonicalize edge endpoints to the node display name so every link
    // source/target equals an existing node id (no dangling links for the viz).
    const links = this.edgesWithin(keys).map(e => ({
      ...e,
      source: this.nodeName(key(e.source)),
      target: this.nodeName(key(e.target)),
    }));
    return {
      nodes: top.map(t => ({ id: t.name, degree: t.degree, notes: t.notes })),
      links,
    };
  }
}

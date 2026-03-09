/**
 * Lightweight Knowledge Graph — stores entities and relations extracted
 * from Claude Code sessions. Persisted as JSON, queried in-memory.
 *
 * Entity types: project, file, concept, tool, library, pattern, error, person
 * Relation types: uses, depends_on, implements, fixes, related_to, part_of, etc.
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

// ─── Types ──────────────────────────────────────────────────────────

export type EntityType =
  | "project"
  | "file"
  | "concept"
  | "tool"
  | "library"
  | "pattern"
  | "error"
  | "person"
  | "service"
  | "other";

export type RelationType =
  | "uses"
  | "depends_on"
  | "implements"
  | "fixes"
  | "related_to"
  | "part_of"
  | "alternative_to"
  | "caused_by"
  | "learned_from"
  | "configured_with"
  | "deployed_to"
  | "other";

export interface Mention {
  sessionId: string;
  project: string;
  date: string;
}

export interface Entity {
  id: string;
  name: string;
  type: EntityType;
  description: string;
  properties: Record<string, string>;
  mentions: Mention[];
  createdAt: string;
  updatedAt: string;
}

export interface Relation {
  id: string;
  source: string; // entity id
  target: string; // entity id
  type: RelationType;
  description: string;
  properties: Record<string, string>;
  mentions: Mention[];
  createdAt: string;
}

interface KGStore {
  version: number;
  entities: Entity[];
  relations: Relation[];
  updatedAt: string;
}

// ─── Helpers ────────────────────────────────────────────────────────

function normalizeId(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

// ─── KnowledgeGraph class ───────────────────────────────────────────

export class KnowledgeGraph {
  private entities: Map<string, Entity> = new Map();
  private relations: Map<string, Relation> = new Map();
  private storePath: string;

  constructor(memoryRoot: string) {
    this.storePath = join(memoryRoot, "knowledge-graph.json");
  }

  // ─── Persistence ────────────────────────────────────────────────

  load(): boolean {
    if (!existsSync(this.storePath)) return false;
    try {
      const data = JSON.parse(readFileSync(this.storePath, "utf-8")) as KGStore;
      this.entities = new Map(data.entities.map((e) => [e.id, e]));
      this.relations = new Map(data.relations.map((r) => [r.id, r]));
      return true;
    } catch {
      return false;
    }
  }

  save(): void {
    const store: KGStore = {
      version: 1,
      entities: Array.from(this.entities.values()),
      relations: Array.from(this.relations.values()),
      updatedAt: new Date().toISOString(),
    };
    writeFileSync(this.storePath, JSON.stringify(store, null, 2), "utf-8");
  }

  // ─── Entity operations ──────────────────────────────────────────

  addEntity(
    name: string,
    type: EntityType,
    description: string,
    mention?: Mention,
    properties?: Record<string, string>
  ): Entity {
    const id = normalizeId(name);
    const existing = this.entities.get(id);
    const now = new Date().toISOString();

    if (existing) {
      // Merge: update description if provided, add mention, merge properties
      if (description && description !== existing.description) {
        existing.description = description;
      }
      if (mention) {
        const isDupe = existing.mentions.some(
          (m) => m.sessionId === mention.sessionId
        );
        if (!isDupe) existing.mentions.push(mention);
      }
      if (properties) {
        Object.assign(existing.properties, properties);
      }
      existing.updatedAt = now;
      return existing;
    }

    const entity: Entity = {
      id,
      name,
      type,
      description,
      properties: properties || {},
      mentions: mention ? [mention] : [],
      createdAt: now,
      updatedAt: now,
    };
    this.entities.set(id, entity);
    return entity;
  }

  getEntity(nameOrId: string): Entity | undefined {
    const id = normalizeId(nameOrId);
    return this.entities.get(id);
  }

  removeEntity(nameOrId: string): boolean {
    const id = normalizeId(nameOrId);
    if (!this.entities.has(id)) return false;
    this.entities.delete(id);
    // Remove related relations
    for (const [rid, rel] of this.relations) {
      if (rel.source === id || rel.target === id) {
        this.relations.delete(rid);
      }
    }
    return true;
  }

  // ─── Relation operations ────────────────────────────────────────

  addRelation(
    sourceName: string,
    targetName: string,
    type: RelationType,
    description: string,
    mention?: Mention,
    properties?: Record<string, string>
  ): Relation {
    const sourceId = normalizeId(sourceName);
    const targetId = normalizeId(targetName);
    const id = `${sourceId}--${type}--${targetId}`;
    const now = new Date().toISOString();

    const existing = this.relations.get(id);
    if (existing) {
      if (description && description !== existing.description) {
        existing.description = description;
      }
      if (mention) {
        const isDupe = existing.mentions.some(
          (m) => m.sessionId === mention.sessionId
        );
        if (!isDupe) existing.mentions.push(mention);
      }
      if (properties) {
        Object.assign(existing.properties, properties);
      }
      return existing;
    }

    const relation: Relation = {
      id,
      source: sourceId,
      target: targetId,
      type,
      description,
      properties: properties || {},
      mentions: mention ? [mention] : [],
      createdAt: now,
    };
    this.relations.set(id, relation);
    return relation;
  }

  removeRelation(sourceName: string, targetName: string, type: RelationType): boolean {
    const sourceId = normalizeId(sourceName);
    const targetId = normalizeId(targetName);
    const id = `${sourceId}--${type}--${targetId}`;
    return this.relations.delete(id);
  }

  // ─── Queries ────────────────────────────────────────────────────

  /**
   * Find entities by type, name pattern, or full-text in description.
   */
  searchEntities(options: {
    query?: string;
    type?: EntityType;
    project?: string;
    limit?: number;
  }): Entity[] {
    let results = Array.from(this.entities.values());

    if (options.type) {
      results = results.filter((e) => e.type === options.type);
    }

    if (options.project) {
      results = results.filter((e) =>
        e.mentions.some((m) => m.project === options.project)
      );
    }

    if (options.query) {
      const q = options.query.toLowerCase();
      results = results.filter(
        (e) =>
          e.name.toLowerCase().includes(q) ||
          e.description.toLowerCase().includes(q) ||
          e.id.includes(q)
      );
    }

    // Sort by mention count (most referenced first)
    results.sort((a, b) => b.mentions.length - a.mentions.length);

    return results.slice(0, options.limit || 50);
  }

  /**
   * Get all relations involving an entity (as source or target).
   */
  getRelationsFor(nameOrId: string): {
    outgoing: (Relation & { targetEntity?: Entity })[];
    incoming: (Relation & { sourceEntity?: Entity })[];
  } {
    const id = normalizeId(nameOrId);
    const outgoing: (Relation & { targetEntity?: Entity })[] = [];
    const incoming: (Relation & { sourceEntity?: Entity })[] = [];

    for (const rel of this.relations.values()) {
      if (rel.source === id) {
        outgoing.push({ ...rel, targetEntity: this.entities.get(rel.target) });
      }
      if (rel.target === id) {
        incoming.push({ ...rel, sourceEntity: this.entities.get(rel.source) });
      }
    }

    return { outgoing, incoming };
  }

  /**
   * Find shortest path between two entities (BFS, max depth 5).
   */
  findPath(fromName: string, toName: string, maxDepth = 5): Entity[] | null {
    const fromId = normalizeId(fromName);
    const toId = normalizeId(toName);

    if (!this.entities.has(fromId) || !this.entities.has(toId)) return null;
    if (fromId === toId) return [this.entities.get(fromId)!];

    // BFS
    const visited = new Set<string>();
    const queue: { id: string; path: string[] }[] = [{ id: fromId, path: [fromId] }];
    visited.add(fromId);

    // Build adjacency for speed
    const adj = new Map<string, Set<string>>();
    for (const rel of this.relations.values()) {
      if (!adj.has(rel.source)) adj.set(rel.source, new Set());
      if (!adj.has(rel.target)) adj.set(rel.target, new Set());
      adj.get(rel.source)!.add(rel.target);
      adj.get(rel.target)!.add(rel.source);
    }

    while (queue.length > 0) {
      const { id, path } = queue.shift()!;
      if (path.length > maxDepth) continue;

      const neighbors = adj.get(id);
      if (!neighbors) continue;

      for (const neighbor of neighbors) {
        if (visited.has(neighbor)) continue;
        visited.add(neighbor);

        const newPath = [...path, neighbor];
        if (neighbor === toId) {
          return newPath
            .map((nid) => this.entities.get(nid))
            .filter((e): e is Entity => e != null);
        }
        queue.push({ id: neighbor, path: newPath });
      }
    }

    return null;
  }

  /**
   * Get the most connected entities (hubs).
   */
  getHubs(limit = 20): { entity: Entity; connectionCount: number }[] {
    const counts = new Map<string, number>();

    for (const rel of this.relations.values()) {
      counts.set(rel.source, (counts.get(rel.source) || 0) + 1);
      counts.set(rel.target, (counts.get(rel.target) || 0) + 1);
    }

    return Array.from(counts.entries())
      .map(([id, count]) => ({ entity: this.entities.get(id)!, connectionCount: count }))
      .filter((h) => h.entity != null)
      .sort((a, b) => b.connectionCount - a.connectionCount)
      .slice(0, limit);
  }

  /**
   * Get graph stats.
   */
  stats(): {
    entityCount: number;
    relationCount: number;
    entityTypes: Record<string, number>;
    relationTypes: Record<string, number>;
    topProjects: { project: string; entityCount: number }[];
  } {
    const entityTypes: Record<string, number> = {};
    const relationTypes: Record<string, number> = {};
    const projectCounts = new Map<string, Set<string>>();

    for (const e of this.entities.values()) {
      entityTypes[e.type] = (entityTypes[e.type] || 0) + 1;
      for (const m of e.mentions) {
        if (!projectCounts.has(m.project)) projectCounts.set(m.project, new Set());
        projectCounts.get(m.project)!.add(e.id);
      }
    }

    for (const r of this.relations.values()) {
      relationTypes[r.type] = (relationTypes[r.type] || 0) + 1;
    }

    const topProjects = Array.from(projectCounts.entries())
      .map(([project, ids]) => ({ project, entityCount: ids.size }))
      .sort((a, b) => b.entityCount - a.entityCount)
      .slice(0, 10);

    return {
      entityCount: this.entities.size,
      relationCount: this.relations.size,
      entityTypes,
      relationTypes,
      topProjects,
    };
  }

  get entityCount(): number {
    return this.entities.size;
  }

  get relationCount(): number {
    return this.relations.size;
  }
}

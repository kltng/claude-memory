import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { KnowledgeGraph } from "../knowledge-graph.js";

function createTempRoot(): string {
  return mkdtempSync(join(tmpdir(), "claude-memory-kg-test-"));
}

describe("KnowledgeGraph", () => {
  let root: string;
  let kg: KnowledgeGraph;

  before(() => {
    root = createTempRoot();
  });

  beforeEach(() => {
    kg = new KnowledgeGraph(root);
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  // ─── Entity operations ────────────────────────────────────────

  describe("addEntity", () => {
    it("adds a new entity", () => {
      const e = kg.addEntity("React", "library", "UI library");
      assert.strictEqual(e.name, "React");
      assert.strictEqual(e.type, "library");
      assert.strictEqual(e.description, "UI library");
      assert.strictEqual(e.id, "react");
      assert.strictEqual(kg.entityCount, 1);
    });

    it("normalizes IDs from names", () => {
      const e = kg.addEntity("@huggingface/transformers", "library", "ML lib");
      assert.strictEqual(e.id, "huggingface-transformers");
    });

    it("merges duplicate entities by normalized name", () => {
      kg.addEntity("MiniSearch", "library", "Search engine");
      kg.addEntity("minisearch", "library", "Updated desc");
      assert.strictEqual(kg.entityCount, 1);
      const e = kg.getEntity("MiniSearch");
      assert.strictEqual(e!.description, "Updated desc");
    });

    it("accumulates mentions on merge", () => {
      const m1 = { sessionId: "s1", project: "p1", date: "2026-01-01" };
      const m2 = { sessionId: "s2", project: "p1", date: "2026-01-02" };
      kg.addEntity("TypeScript", "tool", "Language", m1);
      kg.addEntity("TypeScript", "tool", "Language", m2);
      const e = kg.getEntity("TypeScript");
      assert.strictEqual(e!.mentions.length, 2);
    });

    it("deduplicates mentions by sessionId", () => {
      const m1 = { sessionId: "s1", project: "p1", date: "2026-01-01" };
      kg.addEntity("Node", "tool", "Runtime", m1);
      kg.addEntity("Node", "tool", "Runtime", m1); // same mention
      const e = kg.getEntity("Node");
      assert.strictEqual(e!.mentions.length, 1);
    });

    it("merges properties", () => {
      kg.addEntity("API", "concept", "", undefined, { version: "v2" });
      kg.addEntity("API", "concept", "", undefined, { auth: "oauth" });
      const e = kg.getEntity("API");
      assert.strictEqual(e!.properties.version, "v2");
      assert.strictEqual(e!.properties.auth, "oauth");
    });
  });

  describe("getEntity", () => {
    it("returns undefined for missing entity", () => {
      assert.strictEqual(kg.getEntity("nonexistent"), undefined);
    });

    it("finds by display name", () => {
      kg.addEntity("Express.js", "library", "Web framework");
      const e = kg.getEntity("Express.js");
      assert.ok(e);
      assert.strictEqual(e.name, "Express.js");
    });
  });

  describe("removeEntity", () => {
    it("removes entity and its relations", () => {
      kg.addEntity("A", "concept", "");
      kg.addEntity("B", "concept", "");
      kg.addRelation("A", "B", "related_to", "test");
      assert.strictEqual(kg.relationCount, 1);
      kg.removeEntity("A");
      assert.strictEqual(kg.entityCount, 1);
      assert.strictEqual(kg.relationCount, 0);
    });

    it("returns false for missing entity", () => {
      assert.strictEqual(kg.removeEntity("nope"), false);
    });
  });

  // ─── Relation operations ──────────────────────────────────────

  describe("addRelation", () => {
    it("adds a relation", () => {
      kg.addEntity("React", "library", "");
      kg.addEntity("JSX", "concept", "");
      const r = kg.addRelation("React", "JSX", "uses", "JSX syntax");
      assert.strictEqual(r.source, "react");
      assert.strictEqual(r.target, "jsx");
      assert.strictEqual(r.type, "uses");
      assert.strictEqual(kg.relationCount, 1);
    });

    it("deduplicates same relation", () => {
      kg.addEntity("A", "concept", "");
      kg.addEntity("B", "concept", "");
      kg.addRelation("A", "B", "uses", "first");
      kg.addRelation("A", "B", "uses", "second");
      assert.strictEqual(kg.relationCount, 1);
    });

    it("allows different relation types between same entities", () => {
      kg.addEntity("X", "concept", "");
      kg.addEntity("Y", "concept", "");
      kg.addRelation("X", "Y", "uses", "");
      kg.addRelation("X", "Y", "depends_on", "");
      assert.strictEqual(kg.relationCount, 2);
    });
  });

  describe("removeRelation", () => {
    it("removes a specific relation", () => {
      kg.addEntity("A", "concept", "");
      kg.addEntity("B", "concept", "");
      kg.addRelation("A", "B", "uses", "");
      assert.strictEqual(kg.removeRelation("A", "B", "uses"), true);
      assert.strictEqual(kg.relationCount, 0);
    });

    it("returns false for missing relation", () => {
      assert.strictEqual(kg.removeRelation("X", "Y", "uses"), false);
    });
  });

  // ─── Queries ──────────────────────────────────────────────────

  describe("searchEntities", () => {
    it("searches by name substring", () => {
      kg.addEntity("Claude Code", "tool", "CLI tool");
      kg.addEntity("Claude API", "service", "API service");
      kg.addEntity("React", "library", "UI");
      const results = kg.searchEntities({ query: "claude" });
      assert.strictEqual(results.length, 2);
    });

    it("filters by type", () => {
      kg.addEntity("Python", "tool", "Language");
      kg.addEntity("Flask", "library", "Web fw");
      const results = kg.searchEntities({ type: "library" });
      assert.ok(results.every((e) => e.type === "library"));
    });

    it("filters by project", () => {
      const m1 = { sessionId: "s1", project: "proj-a", date: "2026-01-01" };
      const m2 = { sessionId: "s2", project: "proj-b", date: "2026-01-01" };
      kg.addEntity("Redis", "service", "", m1);
      kg.addEntity("Postgres", "service", "", m2);
      const results = kg.searchEntities({ project: "proj-a" });
      assert.strictEqual(results.length, 1);
      assert.strictEqual(results[0].name, "Redis");
    });

    it("respects limit", () => {
      for (let i = 0; i < 10; i++) {
        kg.addEntity(`Entity${i}`, "concept", "");
      }
      const results = kg.searchEntities({ limit: 3 });
      assert.strictEqual(results.length, 3);
    });

    it("sorts by mention count", () => {
      kg.addEntity("Popular", "concept", "", { sessionId: "s1", project: "p", date: "d" });
      kg.addEntity("Popular", "concept", "", { sessionId: "s2", project: "p", date: "d" });
      kg.addEntity("Popular", "concept", "", { sessionId: "s3", project: "p", date: "d" });
      kg.addEntity("Obscure", "concept", "", { sessionId: "s4", project: "p", date: "d" });
      const results = kg.searchEntities({ query: "" });
      // Popular should appear before Obscure (more mentions)
      const popIdx = results.findIndex((e) => e.name === "Popular");
      const obsIdx = results.findIndex((e) => e.name === "Obscure");
      if (popIdx !== -1 && obsIdx !== -1) {
        assert.ok(popIdx < obsIdx, "Popular should rank higher");
      }
    });
  });

  describe("getRelationsFor", () => {
    it("returns outgoing and incoming relations", () => {
      kg.addEntity("A", "concept", "");
      kg.addEntity("B", "concept", "");
      kg.addEntity("C", "concept", "");
      kg.addRelation("A", "B", "uses", "");
      kg.addRelation("C", "A", "depends_on", "");

      const rels = kg.getRelationsFor("A");
      assert.strictEqual(rels.outgoing.length, 1);
      assert.strictEqual(rels.incoming.length, 1);
      assert.strictEqual(rels.outgoing[0].target, "b");
      assert.strictEqual(rels.incoming[0].source, "c");
    });

    it("includes entity references", () => {
      kg.addEntity("Src", "concept", "Source");
      kg.addEntity("Tgt", "concept", "Target");
      kg.addRelation("Src", "Tgt", "uses", "");

      const rels = kg.getRelationsFor("Src");
      assert.ok(rels.outgoing[0].targetEntity);
      assert.strictEqual(rels.outgoing[0].targetEntity!.name, "Tgt");
    });
  });

  describe("findPath", () => {
    it("finds direct connection", () => {
      kg.addEntity("Start", "concept", "");
      kg.addEntity("End", "concept", "");
      kg.addRelation("Start", "End", "uses", "");

      const path = kg.findPath("Start", "End");
      assert.ok(path);
      assert.strictEqual(path.length, 2);
      assert.strictEqual(path[0].name, "Start");
      assert.strictEqual(path[1].name, "End");
    });

    it("finds multi-hop path", () => {
      kg.addEntity("A", "concept", "");
      kg.addEntity("B", "concept", "");
      kg.addEntity("C", "concept", "");
      kg.addRelation("A", "B", "uses", "");
      kg.addRelation("B", "C", "uses", "");

      const path = kg.findPath("A", "C");
      assert.ok(path);
      assert.strictEqual(path.length, 3);
    });

    it("returns null for disconnected entities", () => {
      kg.addEntity("Isolated1", "concept", "");
      kg.addEntity("Isolated2", "concept", "");
      const path = kg.findPath("Isolated1", "Isolated2");
      assert.strictEqual(path, null);
    });

    it("returns single entity for same start/end", () => {
      kg.addEntity("Self", "concept", "");
      const path = kg.findPath("Self", "Self");
      assert.ok(path);
      assert.strictEqual(path.length, 1);
    });

    it("returns null for missing entities", () => {
      assert.strictEqual(kg.findPath("missing1", "missing2"), null);
    });
  });

  describe("getHubs", () => {
    it("returns entities sorted by connection count", () => {
      kg.addEntity("Hub", "concept", "");
      kg.addEntity("Leaf1", "concept", "");
      kg.addEntity("Leaf2", "concept", "");
      kg.addEntity("Leaf3", "concept", "");
      kg.addRelation("Hub", "Leaf1", "uses", "");
      kg.addRelation("Hub", "Leaf2", "uses", "");
      kg.addRelation("Hub", "Leaf3", "uses", "");

      const hubs = kg.getHubs(5);
      assert.ok(hubs.length > 0);
      assert.strictEqual(hubs[0].entity.name, "Hub");
      assert.strictEqual(hubs[0].connectionCount, 3);
    });
  });

  describe("stats", () => {
    it("returns correct counts", () => {
      const freshKg = new KnowledgeGraph(root);
      freshKg.addEntity("A", "concept", "");
      freshKg.addEntity("B", "library", "");
      freshKg.addRelation("A", "B", "uses", "");

      const s = freshKg.stats();
      assert.strictEqual(s.entityCount, 2);
      assert.strictEqual(s.relationCount, 1);
      assert.strictEqual(s.entityTypes.concept, 1);
      assert.strictEqual(s.entityTypes.library, 1);
      assert.strictEqual(s.relationTypes.uses, 1);
    });
  });

  // ─── Persistence ──────────────────────────────────────────────

  describe("save and load", () => {
    it("round-trips entities and relations", () => {
      const kg1 = new KnowledgeGraph(root);
      kg1.addEntity("Saved", "tool", "A tool", { sessionId: "s1", project: "p1", date: "2026-01-01" });
      kg1.addEntity("Also Saved", "library", "A lib");
      kg1.addRelation("Saved", "Also Saved", "uses", "uses it");
      kg1.save();

      const kg2 = new KnowledgeGraph(root);
      assert.strictEqual(kg2.load(), true);
      assert.strictEqual(kg2.entityCount, 2);
      assert.strictEqual(kg2.relationCount, 1);

      const e = kg2.getEntity("Saved");
      assert.ok(e);
      assert.strictEqual(e.type, "tool");
      assert.strictEqual(e.mentions.length, 1);
    });

    it("load returns false when no file exists", () => {
      const emptyRoot = createTempRoot();
      try {
        const kg3 = new KnowledgeGraph(emptyRoot);
        assert.strictEqual(kg3.load(), false);
      } finally {
        rmSync(emptyRoot, { recursive: true, force: true });
      }
    });
  });
});

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ToolContext, ToolResultLike } from "@open-instinct/core";
import { LOAD_SKILL_TOOL, loadSkillList, loadSkillTool, loadSkillsPrompt, ownerSkillsDir, resolveSkillsDir } from "../src/skills.js";

const stranger = { principal: { kind: "stranger", id: "stranger:x", tier: "stranger", displayName: "x" }, conversationKey: "imessage:1", channel: "imessage", now: () => new Date() } as unknown as ToolContext;
const textOf = (r: ToolResultLike) => (typeof r === "string" ? r : r.content.map((c) => (c.type === "text" ? c.text : "")).join(""));

describe("skills", () => {
  let dir: string;
  beforeEach(() => (dir = mkdtempSync(join(tmpdir(), "instinct-skills-"))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("resolves explicit, then env, then the repo folder, skipping missing dirs", () => {
    const a = join(dir, "a");
    const b = join(dir, "b");
    mkdirSync(a);
    mkdirSync(b);
    expect(resolveSkillsDir({ explicit: a, env: { INSTINCT_SKILLS_DIR: b } })).toBe(a);
    expect(resolveSkillsDir({ explicit: join(dir, "missing"), env: { INSTINCT_SKILLS_DIR: b } })).toBe(b);
    expect(resolveSkillsDir({ env: {} })).toBeUndefined();
    // The repo's own skills folder, relative to a module three levels down.
    const fakeModule = `file://${join(dir, "packages", "server", "dist", "boot.js")}`;
    mkdirSync(join(dir, "skills"));
    expect(resolveSkillsDir({ env: {}, packageUrl: fakeModule })).toBe(join(dir, "skills"));
  });

  it("formats SKILL.md files for the prompt and tolerates an empty or missing folder", () => {
    expect(loadSkillsPrompt(undefined)).toBeUndefined();
    expect(loadSkillsPrompt(join(dir, "nope"))).toBeUndefined();
    expect(loadSkillsPrompt(dir)).toBeUndefined();
    mkdirSync(join(dir, "dining"));
    writeFileSync(join(dir, "dining", "SKILL.md"), "---\nname: dining\ndescription: Book tables and pick restaurants\n---\n\nSteps here.\n");
    const prompt = loadSkillsPrompt(dir);
    expect(prompt).toContain("dining");
    expect(prompt).toContain("Book tables");
  });

  it("points the index at load_skill, not at a file path the read tool cannot open", () => {
    mkdirSync(join(dir, "dining"));
    writeFileSync(join(dir, "dining", "SKILL.md"), "---\nname: dining\ndescription: Book tables\n---\n\nSteps here.\n");
    const prompt = loadSkillsPrompt(dir)!;
    expect(prompt).toContain(LOAD_SKILL_TOOL);
    expect(prompt).not.toContain(join(dir, "dining"));
    expect(prompt).not.toMatch(/read tool/);
  });

  it("load_skill returns a loaded skill by name for any conversing principal and takes no paths", async () => {
    mkdirSync(join(dir, "dining"));
    writeFileSync(join(dir, "dining", "SKILL.md"), "---\nname: dining\ndescription: Book tables\n---\n\nSteps here.\n");
    writeFileSync(join(dir, "secret.txt"), "not a skill");
    const tool = loadSkillTool(loadSkillList(dir)).spec;
    expect(tool.meta.capabilities).toEqual(["converse"]);
    expect(textOf(await tool.execute({ name: "Dining" }, stranger))).toContain("Steps here.");
    for (const name of ["../secret.txt", join(dir, "secret.txt"), "nope"]) {
      const r = await tool.execute({ name }, stranger);
      expect(typeof r === "object" && r.isError, name).toBe(true);
      expect(textOf(r)).toContain("Known skills: dining");
    }
  });

  it("leaves hidden skills out of the index but still loads them by name", async () => {
    mkdirSync(join(dir, "nightly"));
    writeFileSync(join(dir, "nightly", "SKILL.md"), "---\nname: nightly\ndescription: Nightly wrap-up\ndisable-model-invocation: true\n---\n\nWrap up the day.\n");
    const list = loadSkillList(dir);
    expect(loadSkillsPrompt(dir)).toBeUndefined();
    expect(textOf(await loadSkillTool(list).spec.execute({ name: "nightly" }, stranger))).toContain("Wrap up the day.");
  });

  it("keeps the first of two skills whose names differ only in case", () => {
    for (const [folder, name] of [["a", "Dining"], ["b", "dining"]]) {
      mkdirSync(join(dir, folder));
      writeFileSync(join(dir, folder, "SKILL.md"), `---\nname: ${name}\ndescription: Book tables ${folder}\n---\n\nFrom ${folder}.\n`);
    }
    const logs: string[] = [];
    const list = loadSkillList(dir, (m) => logs.push(m));
    expect(list).toHaveLength(1);
    expect(logs.some((l) => l.includes("duplicate name"))).toBe(true);
  });
});

describe("owner skills folder", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "skills-owner-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const skill = (root: string, name: string, description: string) => {
    mkdirSync(join(root, name), { recursive: true });
    writeFileSync(join(root, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\nFrom ${root}.\n`);
  };

  it("merges several folders, the later one winning on a name clash, and skips missing ones", () => {
    const image = join(dir, "image");
    const owner = join(dir, "owner");
    skill(image, "dining", "Built-in dining");
    skill(image, "travel", "Built-in travel");
    skill(owner, "dining", "Owner dining rules");
    skill(owner, "haiku", "Write a haiku when asked");
    const prompt = loadSkillsPrompt([image, join(dir, "missing"), owner])!;
    expect(prompt).toContain("Owner dining rules");
    expect(prompt).not.toContain("Built-in dining");
    expect(prompt).toContain("Built-in travel");
    expect(prompt).toContain("Write a haiku when asked");
    expect(loadSkillsPrompt([join(dir, "missing")])).toBeUndefined();
    expect(loadSkillList([image, owner]).map((s) => s.name)).toEqual(["dining", "travel", "haiku"]);
    expect(ownerSkillsDir("/data")).toBe(join("/data", "skills"));
  });

  it("load_skill with a getter serves a skill installed after the tool was registered", async () => {
    const owner = join(dir, "owner");
    const tool = loadSkillTool(() => loadSkillList([owner])).spec;
    expect(textOf(await tool.execute({ name: "haiku" }, stranger))).toContain("Known skills: none");
    skill(owner, "haiku", "Write a haiku when asked");
    expect(textOf(await tool.execute({ name: "haiku" }, stranger))).toContain(`From ${owner}.`);
  });
});

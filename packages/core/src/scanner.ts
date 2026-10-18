import fs from "node:fs";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { isRelativeTo, resolvePath, walk } from "./fsutil.js";

export const TECH_ORDER = [
  "Node.js",
  "Next.js",
  "React",
  "TypeScript",
  "Tailwind",
  "Vite",
  "Express",
  "Python",
  "FastAPI",
  "Flask",
  "Django",
  "Typer",
  "Click",
  ".NET",
  "C#",
  "Docker",
  "Rust",
  "Go",
  "Ruby",
];

export type TechnologyCategory = "language" | "framework" | "runtime" | "tooling";

const TECH_CATEGORIES: Record<string, TechnologyCategory> = {
  "Node.js": "runtime",
  "Next.js": "framework",
  React: "framework",
  TypeScript: "language",
  Tailwind: "framework",
  Vite: "tooling",
  Express: "framework",
  Python: "language",
  FastAPI: "framework",
  Flask: "framework",
  Django: "framework",
  Typer: "framework",
  Click: "framework",
  ".NET": "framework",
  "C#": "language",
  Docker: "tooling",
  Rust: "language",
  Go: "language",
  Ruby: "language",
};

/** Groups a detected technology tag so UIs can emphasise languages and frameworks. */
export function technologyCategory(technology: string): TechnologyCategory {
  return TECH_CATEGORIES[technology] ?? "tooling";
}

const TECH_RANK = new Map(TECH_ORDER.map((name, index) => [name, index]));
const PACKAGE_SECTIONS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

const configTags = (tag: string, ...names: string[]): [string, string][] =>
  names.map((name) => [name, tag]);

const PACKAGE_CONFIG_TAGS = new Map<string, string>([
  ...configTags("Next.js", "next.config.js", "next.config.mjs", "next.config.cjs", "next.config.ts"),
  ["tsconfig.json", "TypeScript"],
  ...configTags(
    "Tailwind",
    "tailwind.config.js",
    "tailwind.config.mjs",
    "tailwind.config.cjs",
    "tailwind.config.ts",
  ),
  ...configTags("Vite", "vite.config.js", "vite.config.mjs", "vite.config.cjs", "vite.config.ts"),
]);

const PYTHON_TAG_MAP: [string, string][] = [
  ["fastapi", "FastAPI"],
  ["flask", "Flask"],
  ["django", "Django"],
  ["typer", "Typer"],
  ["click", "Click"],
];

const NODE_TAG_MAP: [string, string][] = [
  ["next", "Next.js"],
  ["react", "React"],
  ["react-dom", "React"],
  ["typescript", "TypeScript"],
  ["tailwindcss", "Tailwind"],
  ["vite", "Vite"],
  ["express", "Express"],
];

const REQUIREMENTS_NAME = /^\s*([A-Za-z0-9_.-]+)/;

type Dict = Record<string, unknown>;

const isDict = (value: unknown): value is Dict =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function sortTechnologies(technologies: Iterable<string>): string[] {
  return [...new Set(technologies)].sort((a, b) => {
    const rankA = TECH_RANK.get(a) ?? TECH_ORDER.length;
    const rankB = TECH_RANK.get(b) ?? TECH_ORDER.length;
    if (rankA !== rankB) return rankA - rankB;
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

function collectPackageDependencies(data: Dict): Set<string> {
  const names = new Set<string>();
  for (const section of PACKAGE_SECTIONS) {
    const value = data[section];
    if (isDict(value)) for (const name of Object.keys(value)) names.add(name.toLowerCase());
  }
  return names;
}

function addNodeTagsFromPackage(filePath: string, technologies: Set<string>): void {
  technologies.add("Node.js");
  let payload: unknown;
  try {
    payload = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return;
  }
  if (!isDict(payload)) return;

  const dependencies = collectPackageDependencies(payload);
  for (const [dependency, tag] of NODE_TAG_MAP) {
    if (dependencies.has(dependency)) technologies.add(tag);
  }
}

function extractRequirementName(value: string): string | null {
  const stripped = value.trim();
  if (!stripped || stripped.startsWith("#") || stripped.startsWith("-")) return null;
  const match = REQUIREMENTS_NAME.exec(stripped);
  return match?.[1] ? match[1].toLowerCase() : null;
}

function addPythonTagsFromNames(names: Set<string>, technologies: Set<string>): void {
  if (names.size === 0) return;
  technologies.add("Python");
  for (const [dependency, tag] of PYTHON_TAG_MAP) {
    if (names.has(dependency)) technologies.add(tag);
  }
}

function addTagsFromRequirements(filePath: string, technologies: Set<string>): void {
  let lines: string[];
  try {
    lines = fs.readFileSync(filePath, "utf-8").split(/\r?\n/);
  } catch {
    return;
  }
  const names = new Set<string>();
  for (const line of lines) {
    const name = extractRequirementName(line);
    if (name) names.add(name);
  }
  addPythonTagsFromNames(names, technologies);
}

function parsePyprojectDependencyStrings(values: unknown): Set<string> {
  const names = new Set<string>();
  if (Array.isArray(values)) {
    for (const entry of values) {
      if (typeof entry !== "string") continue;
      const name = extractRequirementName(entry);
      if (name) names.add(name);
    }
  }
  return names;
}

function collectPoetryDependencies(values: unknown): Set<string> {
  if (!isDict(values)) return new Set();
  return new Set(
    Object.keys(values)
      .map((name) => name.toLowerCase())
      .filter((name) => name !== "python"),
  );
}

function addTagsFromPyproject(filePath: string, technologies: Set<string>): void {
  technologies.add("Python");
  let payload: Dict;
  try {
    payload = parseToml(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return;
  }

  const names = new Set<string>();
  const addAll = (values: Set<string>) => values.forEach((name) => names.add(name));

  const project = payload["project"];
  if (isDict(project)) {
    addAll(parsePyprojectDependencyStrings(project["dependencies"]));
    const optional = project["optional-dependencies"];
    if (isDict(optional)) {
      for (const value of Object.values(optional)) addAll(parsePyprojectDependencyStrings(value));
    }
  }

  const tool = payload["tool"];
  const poetry = isDict(tool) ? tool["poetry"] : undefined;
  if (isDict(poetry)) {
    addAll(collectPoetryDependencies(poetry["dependencies"]));
    const group = poetry["group"];
    if (isDict(group)) {
      for (const value of Object.values(group)) {
        if (isDict(value)) addAll(collectPoetryDependencies(value["dependencies"]));
      }
    }
  }

  addPythonTagsFromNames(names, technologies);
}

function depthFor(repoRoot: string, current: string): number {
  const relative = path.relative(repoRoot, current);
  return relative === "" ? 0 : relative.split(path.sep).length;
}

export function scanRepo(
  repoRootInput: string,
  ignoreDirs: ReadonlySet<string>,
  nestedRepoRoots: Iterable<string>,
  maxDepth = 3,
): string[] {
  const repoRoot = resolvePath(repoRootInput);
  const nestedRoots = [...nestedRepoRoots].map(resolvePath);
  const technologies = new Set<string>();
  const nestedByParent = new Map<string, Set<string>>();
  for (const child of nestedRoots) {
    const parent = path.dirname(child);
    const siblings = nestedByParent.get(parent) ?? new Set<string>();
    siblings.add(path.basename(child));
    nestedByParent.set(parent, siblings);
  }

  for (const entry of walk(repoRoot)) {
    const current = resolvePath(entry.dirpath);

    if (nestedRoots.some((child) => isRelativeTo(current, child))) {
      entry.dirnames.length = 0;
      continue;
    }

    const depth = depthFor(repoRoot, current);
    if (depth > maxDepth) {
      entry.dirnames.length = 0;
      continue;
    }

    const excludedChildren = nestedByParent.get(current);
    const kept = entry.dirnames.filter(
      (name) => !ignoreDirs.has(name) && !excludedChildren?.has(name),
    );
    entry.dirnames.splice(0, entry.dirnames.length, ...kept);
    if (depth === maxDepth) entry.dirnames.length = 0;

    for (const filename of entry.filenames) {
      const filePath = path.join(current, filename);

      if (filename === "package.json") {
        addNodeTagsFromPackage(filePath, technologies);
        continue;
      }

      const configTag = PACKAGE_CONFIG_TAGS.get(filename);
      if (configTag) {
        technologies.add(configTag);
        continue;
      }

      if (filename === "pyproject.toml") {
        addTagsFromPyproject(filePath, technologies);
        continue;
      }
      if (filename === "requirements.txt") {
        addTagsFromRequirements(filePath, technologies);
        continue;
      }
      if (filename.endsWith(".csproj") || filename.endsWith(".sln")) {
        technologies.add(".NET");
        technologies.add("C#");
        continue;
      }
      if (
        filename === "Dockerfile" ||
        filename === "docker-compose.yml" ||
        filename === "docker-compose.yaml"
      ) {
        technologies.add("Docker");
        continue;
      }
      if (filename === "Cargo.toml") {
        technologies.add("Rust");
        continue;
      }
      if (filename === "go.mod") {
        technologies.add("Go");
        continue;
      }
      if (filename === "Gemfile") technologies.add("Ruby");
    }
  }

  return sortTechnologies(technologies);
}

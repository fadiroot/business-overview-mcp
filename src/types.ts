// Shared domain types for Business Overview.

export interface SourceRef {
  file: string; // path relative to project root
  line: number; // 1-based
}

export interface Field {
  name: string;
  type: string;
  pk?: boolean;
  fk?: string; // target entity name
  nullable?: boolean;
  unique?: boolean;
}

export interface Entity {
  name: string;
  table?: string;
  orm: string;
  source: SourceRef;
  fields: Field[];
  feature: string;
}

export type RelationKind = "one-to-one" | "one-to-many" | "many-to-one" | "many-to-many";

export interface Relation {
  from: string;
  to: string;
  kind: RelationKind;
  field?: string;
  source: SourceRef;
}

export interface EnumDef {
  name: string;
  values: string[];
  source: SourceRef;
}

export interface DataModel {
  entities: Entity[];
  relations: Relation[];
  enums: EnumDef[];
  orms: string[];
  databases: string[];
}

export interface Endpoint {
  method: string; // GET POST ... | ANY | QUERY | MUTATION
  path: string;
  handler: string;
  framework: string;
  source: SourceRef;
  guards: string[]; // auth-ish middleware / guards / decorators applied
  roles: string[]; // normalized role names allowed
  permissions: string[]; // permission strings required
  isPublic: boolean; // no auth guard detected
  feature: string;
  resource: string;
  action: string; // list | view | create | update | delete | <custom>
}

export interface RoleDef {
  name: string; // normalized
  raw: string[];
  sources: SourceRef[];
  kind: "enum" | "constant" | "usage" | "config";
}

export interface PermissionDef {
  name: string;
  sources: SourceRef[];
}

export interface AccessCheck {
  kind: string; // e.g. "nest:@Roles", "express:middleware", "laravel:middleware", "frontend:jsx"
  roles: string[];
  permissions: string[];
  source: SourceRef;
  snippet: string;
  feature: string;
  layer: "backend" | "frontend" | "config";
}

export interface PathRule {
  pattern: string; // e.g. /admin/**
  roles: string[];
  permissions: string[];
  effect: "allow" | "authenticated" | "public" | "deny";
  source: SourceRef;
}

export interface GuardDef {
  name: string;
  kind: string;
  source: SourceRef;
}

export type AccessLevel = "full" | "partial" | "none" | "unknown";

export interface MatrixRow {
  feature: string;
  endpoints: number;
  access: Record<string, AccessLevel>; // by actor name
  publicEndpoints: number;
}

export interface AccessModel {
  roles: RoleDef[];
  permissions: PermissionDef[];
  guards: GuardDef[];
  pathRules: PathRule[];
  checks: AccessCheck[]; // backend
  frontendChecks: AccessCheck[];
  actors: string[]; // roles + "authenticated" + "anonymous"
  matrix: MatrixRow[];
}

export interface Feature {
  name: string;
  paths: string[];
  files: number;
  loc: number;
  endpoints: number;
  entities: string[];
}

export interface FileInfo {
  rel: string;
  abs: string;
  ext: string;
  lang: string;
  size: number;
  loc: number;
  feature: string;
  isFrontend: boolean;
  isTest: boolean;
}

export interface ProjectIndex {
  root: string;
  scannedAt: string;
  files: FileInfo[];
  languages: Record<string, number>; // lang -> loc
  frameworks: string[];
  manifests: string[];
  externalServices: string[];
  databases: string[];
  totalLoc: number;
  featureNames: string[];
  dependencies: string[]; // flattened dependency names from manifests
  name: string;
}

export interface UseCase {
  id: string;
  name: string;
  actors: string[];
  feature: string;
  action: string;
  resource: string;
  endpoints: string[]; // "METHOD /path"
  entities: string[];
  restrictions: string[];
  description: string;
  source: "heuristic" | "claude";
}

export type Severity = "high" | "medium" | "low" | "info";

export interface Finding {
  id: string;
  severity: Severity;
  category:
    | "unprotected-write"
    | "unused-role"
    | "unused-permission"
    | "orphan-entity"
    | "ui-only-restriction"
    | "inconsistent-restriction"
    | "duplicate-endpoint"
    | "complexity-hotspot"
    | "empty-feature"
    | "no-access-control";
  title: string;
  detail: string;
  evidence: SourceRef[];
  feature?: string;
}

export interface Analysis {
  index: ProjectIndex;
  model: DataModel;
  endpoints: Endpoint[];
  access: AccessModel;
  features: Feature[];
  useCases: UseCase[];
  findings: Finding[];
}

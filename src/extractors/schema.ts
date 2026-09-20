import type { DataModel, Entity, EnumDef, Field, ProjectIndex, Relation, RelationKind, SourceRef } from "../types.js";
import { readText, sourceFiles } from "../indexer.js";
import { bracketBody, lineOf, singular, splitTopLevel, stringLiterals, uniq, uniqBy } from "../util.js";

interface Ctx {
  entities: Entity[];
  relations: Relation[];
  enums: EnumDef[];
  orms: Set<string>;
}

const SCALARS = new Set(["String", "Int", "BigInt", "Float", "Decimal", "Boolean", "DateTime", "Json", "Bytes", "Unsupported", "string", "number", "boolean", "Date", "any", "unknown", "object", "Buffer", "bigint"]);

/** Authority of a definition source: a real ORM schema outranks migration SQL, which outranks a GraphQL type. */
function ormRank(orm: string): number {
  if (/GraphQL type/.test(orm)) return 0;
  if (/SQL|Knex|Laravel migration/.test(orm)) return 1;
  return 2;
}

function addEntity(ctx: Ctx, e: Entity) {
  const existing = ctx.entities.find((x) => x.name.toLowerCase() === e.name.toLowerCase());
  if (existing) {
    if (ormRank(e.orm) > ormRank(existing.orm)) {
      // The authoritative schema wins: keep its metadata and fields, retain columns only the weaker source knew.
      const extra = existing.fields.filter((f) => !e.fields.some((x) => x.name.toLowerCase() === f.name.toLowerCase()));
      existing.orm = e.orm;
      existing.source = e.source;
      existing.feature = e.feature;
      existing.table = e.table ?? existing.table;
      existing.fields = [...e.fields, ...extra];
    } else {
      for (const f of e.fields) if (!existing.fields.some((x) => x.name === f.name)) existing.fields.push(f);
    }
    return;
  }
  ctx.entities.push(e);
}

function rel(ctx: Ctx, from: string, to: string, kind: RelationKind, field: string | undefined, source: SourceRef) {
  if (!from || !to) return;
  ctx.relations.push({ from, to, kind, field, source });
}

function classBody(text: string, classIdx: number): { body: string; start: number } | null {
  const open = text.indexOf("{", classIdx);
  if (open === -1) return null;
  const b = bracketBody(text, open);
  return b ? { body: b.body, start: open + 1 } : null;
}

// ---------- Prisma ----------
function prisma(ctx: Ctx, text: string, file: string, feature: string) {
  const modelRe = /\bmodel\s+(\w+)\s*\{/g;
  let m: RegExpExecArray | null;
  const modelNames = new Set<string>();
  const tmp = /\bmodel\s+(\w+)\s*\{/g;
  while ((m = tmp.exec(text))) modelNames.add(m[1]);
  const enumNames = new Set<string>();
  const enumRe = /\benum\s+(\w+)\s*\{/g;
  while ((m = enumRe.exec(text))) {
    const b = bracketBody(text, m.index + m[0].length - 1);
    if (!b) continue;
    enumNames.add(m[1]);
    const values = b.body.split("\n").map((l) => l.trim().split(/\s+/)[0]).filter((v) => v && !v.startsWith("@") && !v.startsWith("//"));
    ctx.enums.push({ name: m[1], values, source: { file, line: lineOf(text, m.index) } });
  }
  while ((m = modelRe.exec(text))) {
    ctx.orms.add("Prisma");
    const name = m[1];
    const b = bracketBody(text, m.index + m[0].length - 1);
    if (!b) continue;
    const fields: Field[] = [];
    let table: string | undefined;
    for (const rawLine of b.body.split("\n")) {
      const line = rawLine.trim();
      if (!line || line.startsWith("//")) continue;
      const map = /^@@map\(\s*"([^"]+)"/.exec(line);
      if (map) { table = map[1]; continue; }
      if (line.startsWith("@@")) continue;
      const fm = /^(\w+)\s+(\w+)(\[\])?(\?)?\s*(.*)$/.exec(line);
      if (!fm) continue;
      const [, fname, ftype, isList, optional, attrs] = fm;
      const lineNo = lineOf(text, m.index) + b.body.slice(0, b.body.indexOf(rawLine)).split("\n").length - 1;
      if (modelNames.has(ftype)) {
        if (isList) {
          // one-to-many from this model to ftype, unless the other side is also a list (implicit m:n)
          const other = new RegExp(`\\bmodel\\s+${ftype}\\s*\\{([\\s\\S]*?)\\n\\}`).exec(text)?.[1] ?? "";
          const otherHasList = new RegExp(`^\\s*\\w+\\s+${name}\\[\\]`, "m").test(other);
          if (otherHasList) {
            if (name.localeCompare(ftype) <= 0) rel(ctx, name, ftype, "many-to-many", fname, { file, line: lineNo });
          } else rel(ctx, ftype, name, "many-to-one", fname, { file, line: lineNo });
        } else {
          const fk = /fields:\s*\[([^\]]+)\]/.exec(attrs);
          if (fk) {
            const isUnique = fk && new RegExp(`^\\s*${fk[1].trim()}\\s+\\w+.*@unique`, "m").test(b.body);
            rel(ctx, name, ftype, isUnique ? "one-to-one" : "many-to-one", fname, { file, line: lineNo });
            for (const col of fk[1].split(",").map((s) => s.trim())) {
              const f = fields.find((x) => x.name === col);
              if (f) f.fk = ftype;
              else fields.push({ name: col, type: "Int", fk: ftype });
            }
          }
        }
        continue;
      }
      const fdef: Field = {
        name: fname,
        type: ftype + (isList ? "[]" : ""),
        pk: /@id\b/.test(attrs) || undefined,
        nullable: optional ? true : undefined,
        unique: /@unique\b/.test(attrs) || undefined,
      };
      const existing = fields.find((x) => x.name === fname);
      if (existing) Object.assign(existing, fdef, { fk: existing.fk }); // scalar line after @relation placeholder
      else fields.push(fdef);
    }
    addEntity(ctx, { name, table, orm: "Prisma", source: { file, line: lineOf(text, m.index) }, fields, feature });
  }
}

// ---------- TypeORM / MikroORM decorators (TS) ----------
function typeorm(ctx: Ctx, text: string, file: string, feature: string) {
  const re = /@Entity\s*(\(([^)]*)\))?[\s\S]{0,300}?\bclass\s+(\w+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    ctx.orms.add("TypeORM");
    const name = m[3];
    const table = m[2] ? stringLiterals(m[2])[0] : undefined;
    const cb = classBody(text, m.index + m[0].length);
    if (!cb) continue;
    const body = cb.body;
    const fields: Field[] = [];
    const colRe = /@(PrimaryGeneratedColumn|PrimaryColumn|Column|CreateDateColumn|UpdateDateColumn|DeleteDateColumn|ObjectIdColumn|Property|PrimaryKey|Enum)\s*\(([\s\S]*?)\)\s*(?:@\w+(?:\([^)]*\))?\s*)*(?:readonly\s+|public\s+|private\s+)?(\w+)\s*[?!]?\s*:\s*([\w\[\]<>| .]+)/g;
    let c: RegExpExecArray | null;
    while ((c = colRe.exec(body))) {
      fields.push({ name: c[3], type: c[4].trim(), pk: /Primary/.test(c[1]) || undefined, nullable: /nullable:\s*true/.test(c[2]) || c[4].includes("null") || undefined, unique: /unique:\s*true/.test(c[2]) || undefined });
    }
    const relRe = /@(ManyToOne|OneToMany|ManyToMany|OneToOne)\s*\(\s*(?:\(\)\s*=>\s*|type\s*=>\s*)?(\w+)[\s\S]*?\)\s*(?:@\w+(?:\([^)]*\))?\s*)*(?:readonly\s+|public\s+|private\s+)?(\w+)\s*[?!]?\s*:/g;
    while ((c = relRe.exec(body))) {
      const kind: RelationKind = c[1] === "ManyToOne" ? "many-to-one" : c[1] === "OneToMany" ? "one-to-many" : c[1] === "ManyToMany" ? "many-to-many" : "one-to-one";
      const target = c[2];
      const line = lineOf(text, cb.start + c.index);
      if (kind === "one-to-many") rel(ctx, target, name, "many-to-one", c[3], { file, line });
      else if (kind === "many-to-many") { if (/JoinTable/.test(body.slice(c.index, c.index + 400)) || name.localeCompare(target) <= 0) rel(ctx, name, target, "many-to-many", c[3], { file, line }); }
      else rel(ctx, name, target, kind, c[3], { file, line });
      if (kind === "many-to-one" || kind === "one-to-one") fields.push({ name: c[3], type: target, fk: target });
    }
    addEntity(ctx, { name, table, orm: "TypeORM", source: { file, line: lineOf(text, m.index) }, fields, feature });
  }
}

// ---------- Mongoose ----------
function mongoose(ctx: Ctx, text: string, file: string, feature: string) {
  const re = /(?:const|let|var)\s+(\w+)\s*(?::[^=]+)?=\s*new\s+(?:mongoose\.)?Schema\s*(?:<[^>]*>)?\s*\(\s*\{/g;
  let m: RegExpExecArray | null;
  const modelNames: Record<string, string> = {};
  const mre = /(?:mongoose\.)?model\s*(?:<[^>]*>)?\s*\(\s*['"](\w+)['"]\s*,\s*(\w+)/g;
  while ((m = mre.exec(text))) modelNames[m[2]] = m[1];
  while ((m = re.exec(text))) {
    ctx.orms.add("Mongoose");
    const varName = m[1];
    const name = modelNames[varName] ?? varName.replace(/Schema$/i, "");
    const b = bracketBody(text, m.index + m[0].length - 1);
    if (!b) continue;
    const fields: Field[] = [];
    for (const part of splitTopLevel(b.body)) {
      const fm = /^(\w+)\s*:\s*([\s\S]+)$/.exec(part.trim());
      if (!fm) continue;
      const fname = fm[1];
      const val = fm[2];
      const refM = /ref\s*:\s*['"](\w+)['"]/.exec(val);
      const typeM = /type\s*:\s*\[?\s*([\w.]+)/.exec(val) ?? /^\[?\s*([\w.]+)/.exec(val);
      const type = (typeM?.[1] ?? "Mixed").replace(/^Schema\.Types\./, "").replace(/^mongoose\.Schema\.Types\./, "");
      const isArray = /^\[/.test(val.trim()) || /type\s*:\s*\[/.test(val);
      fields.push({ name: fname, type: isArray ? `${type}[]` : type, fk: refM?.[1], unique: /unique\s*:\s*true/.test(val) || undefined, nullable: /required\s*:\s*true/.test(val) ? undefined : true });
      if (refM) rel(ctx, name, refM[1], isArray ? "many-to-many" : "many-to-one", fname, { file, line: lineOf(text, m.index) });
    }
    addEntity(ctx, { name, orm: "Mongoose", source: { file, line: lineOf(text, m.index) }, fields, feature });
  }
  // NestJS @Schema() classes
  const nre = /@Schema\s*\([^)]*\)\s*(?:export\s+)?class\s+(\w+)/g;
  while ((m = nre.exec(text))) {
    ctx.orms.add("Mongoose");
    const cb = classBody(text, m.index + m[0].length);
    if (!cb) continue;
    const fields: Field[] = [];
    const pre = /@Prop\s*\(([\s\S]*?)\)\s*(\w+)\s*[?!]?\s*:\s*([\w\[\]<>| .]+)/g;
    let c: RegExpExecArray | null;
    while ((c = pre.exec(cb.body))) {
      const refM = /ref\s*:\s*['"]?(\w+)/.exec(c[1]);
      fields.push({ name: c[2], type: c[3].trim(), fk: refM?.[1] });
      if (refM) rel(ctx, m[1], refM[1], /\[\]/.test(c[3]) ? "many-to-many" : "many-to-one", c[2], { file, line: lineOf(text, cb.start + c.index) });
    }
    addEntity(ctx, { name: m[1], orm: "Mongoose", source: { file, line: lineOf(text, m.index) }, fields, feature });
  }
}

// ---------- Drizzle ----------
function drizzle(ctx: Ctx, text: string, file: string, feature: string) {
  const re = /(?:export\s+)?const\s+(\w+)\s*=\s*(pgTable|mysqlTable|sqliteTable|pgTableCreator\([^)]*\))\s*\(\s*['"](\w+)['"]\s*,\s*\{/g;
  let m: RegExpExecArray | null;
  const varToTable: Record<string, string> = {};
  const tmp = new RegExp(re.source, "g");
  while ((m = tmp.exec(text))) varToTable[m[1]] = m[3];
  while ((m = re.exec(text))) {
    ctx.orms.add("Drizzle");
    const name = m[3];
    const b = bracketBody(text, m.index + m[0].length - 1);
    if (!b) continue;
    const fields: Field[] = [];
    for (const part of splitTopLevel(b.body)) {
      const fm = /^(\w+)\s*:\s*(\w+)\s*\(([\s\S]*)$/.exec(part.trim());
      if (!fm) continue;
      const refM = /\.references\(\s*\(\)\s*=>\s*(\w+)\.(\w+)/.exec(part);
      const target = refM ? (varToTable[refM[1]] ?? refM[1]) : undefined;
      fields.push({ name: fm[1], type: fm[2], pk: /\.primaryKey\(\)/.test(part) || undefined, nullable: /\.notNull\(\)/.test(part) ? undefined : true, unique: /\.unique\(\)/.test(part) || undefined, fk: target });
      if (target) rel(ctx, name, target, /\.unique\(\)/.test(part) ? "one-to-one" : "many-to-one", fm[1], { file, line: lineOf(text, m.index) });
    }
    addEntity(ctx, { name, table: name, orm: "Drizzle", source: { file, line: lineOf(text, m.index) }, fields, feature });
  }
}

// ---------- Sequelize ----------
function sequelize(ctx: Ctx, text: string, file: string, feature: string) {
  let m: RegExpExecArray | null;
  const defRe = /\.define\s*(?:<[^>]*>)?\s*\(\s*['"](\w+)['"]\s*,\s*\{/g;
  while ((m = defRe.exec(text))) {
    ctx.orms.add("Sequelize");
    const b = bracketBody(text, m.index + m[0].length - 1);
    if (!b) continue;
    const fields: Field[] = [];
    for (const part of splitTopLevel(b.body)) {
      const fm = /^(\w+)\s*:\s*([\s\S]+)$/.exec(part.trim());
      if (!fm) continue;
      const t = /DataTypes\.(\w+)|Sequelize\.(\w+)/.exec(fm[2]);
      fields.push({ name: fm[1], type: t ? (t[1] ?? t[2]) : "unknown", pk: /primaryKey\s*:\s*true/.test(fm[2]) || undefined, nullable: /allowNull\s*:\s*false/.test(fm[2]) ? undefined : true });
    }
    addEntity(ctx, { name: m[1], orm: "Sequelize", source: { file, line: lineOf(text, m.index) }, fields, feature });
  }
  const initRe = /class\s+(\w+)\s+extends\s+Model\b[\s\S]*?\1\.init\s*\(\s*\{/g;
  while ((m = initRe.exec(text))) {
    ctx.orms.add("Sequelize");
    const b = bracketBody(text, m.index + m[0].length - 1);
    if (!b) continue;
    const fields: Field[] = [];
    for (const part of splitTopLevel(b.body)) {
      const fm = /^(\w+)\s*:\s*([\s\S]+)$/.exec(part.trim());
      if (!fm) continue;
      const t = /DataTypes\.(\w+)/.exec(fm[2]);
      fields.push({ name: fm[1], type: t?.[1] ?? "unknown", pk: /primaryKey\s*:\s*true/.test(fm[2]) || undefined });
    }
    addEntity(ctx, { name: m[1], orm: "Sequelize", source: { file, line: lineOf(text, m.index) }, fields, feature });
  }
  const assocRe = /\b(\w+)\.(belongsTo|hasMany|hasOne|belongsToMany)\s*\(\s*(\w+)/g;
  while ((m = assocRe.exec(text))) {
    if (!ctx.orms.has("Sequelize") && !/sequelize/i.test(text)) continue;
    const kind: RelationKind = m[2] === "belongsTo" ? "many-to-one" : m[2] === "hasMany" ? "one-to-many" : m[2] === "hasOne" ? "one-to-one" : "many-to-many";
    const line = lineOf(text, m.index);
    if (kind === "one-to-many") rel(ctx, m[3], m[1], "many-to-one", undefined, { file, line });
    else if (kind === "many-to-many") { if (m[1].localeCompare(m[3]) <= 0) rel(ctx, m[1], m[3], kind, undefined, { file, line }); }
    else rel(ctx, m[1], m[3], kind, undefined, { file, line });
  }
}

// ---------- SQLAlchemy / SQLModel ----------
function pythonClassBody(text: string, classIdx: number): { body: string; start: number } {
  const headerEnd = text.indexOf("\n", classIdx);
  const rest = text.slice(headerEnd + 1);
  const lines = rest.split("\n");
  const kept: string[] = [];
  for (const l of lines) {
    if (l.trim() === "" || /^\s/.test(l)) kept.push(l);
    else break;
  }
  return { body: kept.join("\n"), start: headerEnd + 1 };
}

function sqlalchemy(ctx: Ctx, text: string, file: string, feature: string) {
  if (!/sqlalchemy|sqlmodel|db\.Model|declarative_base|DeclarativeBase/.test(text)) return;
  const re = /^class\s+(\w+)\s*\(([^)]*)\)\s*:/gm;
  let m: RegExpExecArray | null;
  const tableToClass: Record<string, string> = {};
  const found: { name: string; body: string; start: number; idx: number }[] = [];
  while ((m = re.exec(text))) {
    const bases = m[2];
    if (!/Base\b|db\.Model|SQLModel|DeclarativeBase|Model\b/.test(bases)) continue;
    if (/BaseModel\b/.test(bases) && !/SQLModel/.test(bases)) continue;
    if (/^(Base|BaseModel|DeclarativeBase|TimestampMixin|Mixin|\w+Mixin|\w+Base)$/.test(m[1])) continue;
    const { body, start } = pythonClassBody(text, m.index);
    if (/SQLModel/.test(bases) && !/table\s*=\s*True/.test(bases)) continue;
    const tn = /__tablename__\s*=\s*['"](\w+)['"]/.exec(body)?.[1];
    if (tn) tableToClass[tn] = m[1];
    tableToClass[m[1].toLowerCase()] = m[1];
    found.push({ name: m[1], body, start, idx: m.index });
  }
  for (const f of found) {
    ctx.orms.add("SQLAlchemy");
    const fields: Field[] = [];
    const table = /__tablename__\s*=\s*['"](\w+)['"]/.exec(f.body)?.[1];
    const colRe = /^\s+(\w+)\s*(?::\s*(?:Mapped\[)?([^\]=\n]+)\]?)?\s*=\s*(Column|mapped_column|Field|db\.Column)\s*\(/gm;
    let c: RegExpExecArray | null;
    while ((c = colRe.exec(f.body))) {
      const openIdx = c.index + c[0].length - 1;
      const b = bracketBody(f.body, openIdx);
      const args = b?.body ?? "";
      const fk = /ForeignKey\s*\(\s*['"]([\w.]+)['"]/.exec(args) ?? /foreign_key\s*=\s*['"]([\w.]+)['"]/.exec(args);
      const target = fk ? (tableToClass[fk[1].split(".")[0]] ?? tableToClass[singular(fk[1].split(".")[0])] ?? fk[1].split(".")[0]) : undefined;
      const typeM = /^\s*([\w.]+)/.exec(args);
      const type = (c[2]?.trim() ?? typeM?.[1] ?? "unknown").replace(/^Optional\[/, "").replace(/\]$/, "");
      fields.push({ name: c[1], type, pk: /primary_key\s*=\s*True/.test(args) || undefined, nullable: /nullable\s*=\s*True/.test(args) || /Optional\[/.test(c[2] ?? "") || undefined, unique: /unique\s*=\s*True/.test(args) || undefined, fk: target });
      if (target) rel(ctx, f.name, target, /unique\s*=\s*True/.test(args) ? "one-to-one" : "many-to-one", c[1], { file, line: lineOf(text, f.start + c.index) });
    }
    const relRe = /^\s+(\w+)\s*(?::[^=\n]+)?=\s*(?:relationship|Relationship)\s*\(/gm;
    while ((c = relRe.exec(f.body))) {
      const b = bracketBody(f.body, c.index + c[0].length - 1);
      const args = b?.body ?? "";
      const tgt = /^\s*['"]?(\w+)['"]?/.exec(args)?.[1];
      const typeAnn = /:\s*Mapped\[\s*(?:list|List|set|Set)?\[?\s*['"]?(\w+)/.exec(c[0]);
      const target = (tgt && !/^(back_populates|backref|secondary|lazy|uselist|foreign_keys|cascade|primaryjoin)$/.test(tgt) ? tgt : typeAnn?.[1]) ?? "";
      if (!target) continue;
      if (/secondary\s*=|link_model\s*=/.test(args)) { if (f.name.localeCompare(target) <= 0) rel(ctx, f.name, target, "many-to-many", c[1], { file, line: lineOf(text, f.start + c.index) }); }
      else if (/uselist\s*=\s*False/.test(args)) rel(ctx, f.name, target, "one-to-one", c[1], { file, line: lineOf(text, f.start + c.index) });
      // one-to-many sides are implied by ForeignKey on the child; skip to avoid duplicates
    }
    addEntity(ctx, { name: f.name, table, orm: "SQLAlchemy", source: { file, line: lineOf(text, f.idx) }, fields, feature });
  }
}

// ---------- Django ----------
function django(ctx: Ctx, text: string, file: string, feature: string) {
  if (!/models\.Model|models\.(CharField|ForeignKey|IntegerField)/.test(text)) return;
  const re = /^class\s+(\w+)\s*\(([^)]*)\)\s*:/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (!/Model\b|AbstractUser|AbstractBaseUser|TimeStampedModel/.test(m[2]) || /ModelForm|ModelSerializer|ModelAdmin|ModelViewSet/.test(m[2])) continue;
    ctx.orms.add("Django ORM");
    const { body, start } = pythonClassBody(text, m.index);
    if (/abstract\s*=\s*True/.test(body)) continue;
    const fields: Field[] = [];
    const fre = /^\s+(\w+)\s*=\s*(?:models\.)?(\w+Field|ForeignKey|OneToOneField|ManyToManyField)\s*\(/gm;
    let c: RegExpExecArray | null;
    while ((c = fre.exec(body))) {
      const b = bracketBody(body, c.index + c[0].length - 1);
      const args = b?.body ?? "";
      let fk: string | undefined;
      if (/ForeignKey|OneToOneField|ManyToManyField/.test(c[2])) {
        const first = splitTopLevel(args)[0] ?? "";
        const toM = /to\s*=\s*['"]?([\w.]+)['"]?/.exec(args);
        const t = (toM?.[1] ?? first.replace(/['"]/g, "").replace(/^settings\.AUTH_USER_MODEL$/, "User")).split(".").pop()!;
        fk = t === "self" ? m[1] : t;
        const kind: RelationKind = c[2] === "ForeignKey" ? "many-to-one" : c[2] === "OneToOneField" ? "one-to-one" : "many-to-many";
        if (kind !== "many-to-many" || m[1].localeCompare(fk) <= 0) rel(ctx, m[1], fk, kind, c[1], { file, line: lineOf(text, start + c.index) });
      }
      fields.push({ name: c[1], type: c[2].replace(/Field$/, ""), fk, pk: /primary_key\s*=\s*True/.test(args) || undefined, nullable: /null\s*=\s*True/.test(args) || undefined, unique: /unique\s*=\s*True/.test(args) || undefined });
    }
    if (!fields.some((f) => f.pk)) fields.unshift({ name: "id", type: "AutoField", pk: true });
    const tbl = /db_table\s*=\s*['"](\w+)['"]/.exec(body)?.[1];
    addEntity(ctx, { name: m[1], table: tbl, orm: "Django ORM", source: { file, line: lineOf(text, m.index) }, fields, feature });
  }
}

// ---------- Laravel Eloquent ----------
function eloquent(ctx: Ctx, text: string, file: string, feature: string) {
  const re = /class\s+(\w+)\s+extends\s+(Model|Authenticatable|Pivot|MorphPivot)\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (!/Illuminate\\Database\\Eloquent|Illuminate\\Foundation\\Auth/.test(text)) continue;
    ctx.orms.add("Eloquent");
    const cb = classBody(text, m.index + m[0].length);
    if (!cb) continue;
    const fields: Field[] = [{ name: "id", type: "int", pk: true }];
    const fill = /\$fillable\s*=\s*\[([\s\S]*?)\]/.exec(cb.body);
    if (fill) for (const f of stringLiterals(fill[1])) fields.push({ name: f, type: "mixed" });
    const casts = /\$casts\s*=\s*\[([\s\S]*?)\]/.exec(cb.body);
    if (casts) for (const part of splitTopLevel(casts[1])) { const km = /['"](\w+)['"]\s*=>\s*['"]([\w:]+)['"]/.exec(part); if (km) { const f = fields.find((x) => x.name === km[1]); if (f) f.type = km[2]; else fields.push({ name: km[1], type: km[2] }); } }
    const tbl = /\$table\s*=\s*['"](\w+)['"]/.exec(cb.body)?.[1];
    const relRe = /function\s+(\w+)\s*\([^)]*\)[^{]*\{[\s\S]*?return\s+\$this->(belongsTo|hasMany|hasOne|belongsToMany|hasManyThrough|hasOneThrough|morphMany|morphOne|morphToMany|morphedByMany)\s*\(\s*(?:\\?[\w\\]*\\)?(\w+)::class/g;
    let c: RegExpExecArray | null;
    while ((c = relRe.exec(cb.body))) {
      const kind: RelationKind = /belongsTo$/.test(c[2]) ? "many-to-one" : /hasMany|morphMany|hasManyThrough/.test(c[2]) ? "one-to-many" : /hasOne|morphOne|hasOneThrough/.test(c[2]) ? "one-to-one" : "many-to-many";
      const line = lineOf(text, cb.start + c.index);
      if (kind === "one-to-many") rel(ctx, c[3], m[1], "many-to-one", c[1], { file, line });
      else if (kind === "many-to-many") { if (m[1].localeCompare(c[3]) <= 0) rel(ctx, m[1], c[3], kind, c[1], { file, line }); }
      else rel(ctx, m[1], c[3], kind, c[1], { file, line });
      if (kind === "many-to-one") { const col = `${c[1]}_id`; const f = fields.find((x) => x.name === col); if (f) f.fk = c[3]; else fields.push({ name: col, type: "int", fk: c[3] }); }
    }
    addEntity(ctx, { name: m[1], table: tbl, orm: "Eloquent", source: { file, line: lineOf(text, m.index) }, fields, feature });
  }
}

// ---------- JPA / Hibernate ----------
function jpa(ctx: Ctx, text: string, file: string, feature: string) {
  const re = /@Entity\b[\s\S]{0,400}?\b(?:public\s+)?(?:data\s+)?class\s+(\w+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    ctx.orms.add("JPA");
    const table = /@Table\s*\(\s*name\s*=\s*"(\w+)"/.exec(text.slice(m.index, m.index + m[0].length))?.[1];
    const cb = classBody(text, m.index + m[0].length);
    const body = cb?.body ?? text.slice(m.index + m[0].length, m.index + m[0].length + 4000);
    const fields: Field[] = [];
    const fre = /((?:@\w+(?:\([^)]*\))?\s*)*)(?:private|protected|public|val|var)\s+(?:final\s+)?([\w<>\[\], ?.]+?)\s+(\w+)\s*[;=:]/g;
    let c: RegExpExecArray | null;
    while ((c = fre.exec(body))) {
      const ann = c[1];
      const type = c[2].trim();
      const name = c[3];
      const relM = /@(ManyToOne|OneToMany|ManyToMany|OneToOne)/.exec(ann);
      if (relM) {
        const target = (/(?:List|Set|Collection)<(\w+)>/.exec(type)?.[1] ?? type.replace(/<.*>/, "")).trim();
        const kind: RelationKind = relM[1] === "ManyToOne" ? "many-to-one" : relM[1] === "OneToMany" ? "one-to-many" : relM[1] === "ManyToMany" ? "many-to-many" : "one-to-one";
        const line = lineOf(text, (cb?.start ?? m.index) + c.index);
        if (kind === "one-to-many") rel(ctx, target, m[1], "many-to-one", name, { file, line });
        else if (kind === "many-to-many") { if (/@JoinTable/.test(ann) || m[1].localeCompare(target) <= 0) rel(ctx, m[1], target, kind, name, { file, line }); }
        else rel(ctx, m[1], target, kind, name, { file, line });
        if (kind === "many-to-one" || kind === "one-to-one") fields.push({ name, type: target, fk: target });
        continue;
      }
      if (/@Transient/.test(ann) || /static/.test(c[0])) continue;
      fields.push({ name, type, pk: /@Id\b/.test(ann) || undefined, nullable: /nullable\s*=\s*false/.test(ann) ? undefined : /@Column/.test(ann) ? true : undefined, unique: /unique\s*=\s*true/.test(ann) || undefined });
    }
    addEntity(ctx, { name: m[1], table, orm: "JPA", source: { file, line: lineOf(text, m.index) }, fields, feature });
  }
}

// ---------- GORM (Go) ----------
function gorm(ctx: Ctx, text: string, file: string, feature: string) {
  if (!/gorm\.Model|gorm:"/.test(text)) return;
  const re = /type\s+(\w+)\s+struct\s*\{/g;
  let m: RegExpExecArray | null;
  const names = new Set<string>();
  const tmp = new RegExp(re.source, "g");
  while ((m = tmp.exec(text))) names.add(m[1]);
  while ((m = re.exec(text))) {
    const b = bracketBody(text, m.index + m[0].length - 1);
    if (!b) continue;
    if (!/gorm\.Model|gorm:"|json:"/.test(b.body)) continue;
    ctx.orms.add("GORM");
    const fields: Field[] = [];
    for (const line of b.body.split("\n")) {
      const fm = /^\s*(\w+)\s+(\[\])?(\*)?([\w.]+)\s*(`[^`]*`)?/.exec(line);
      if (!fm) continue;
      if (fm[1] === "gorm.Model" || fm[4] === "gorm.Model") { fields.push({ name: "ID", type: "uint", pk: true }); continue; }
      const t = fm[4];
      if (names.has(t) && t !== m[1]) {
        rel(ctx, fm[2] ? t : m[1], fm[2] ? m[1] : t, fm[2] ? "many-to-one" : "many-to-one", fm[1], { file, line: lineOf(text, m.index) });
        if (!fm[2]) fields.push({ name: fm[1], type: t, fk: t });
        continue;
      }
      fields.push({ name: fm[1], type: (fm[2] ?? "") + t, pk: /primaryKey|primary_key/.test(fm[5] ?? "") || undefined, unique: /unique/.test(fm[5] ?? "") || undefined });
    }
    addEntity(ctx, { name: m[1], orm: "GORM", source: { file, line: lineOf(text, m.index) }, fields, feature });
  }
}

// ---------- SQL DDL ----------
function sqlDdl(ctx: Ctx, text: string, file: string, feature: string) {
  const re = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"\[]?(?:\w+[`"\]]?\.[`"\[]?)?(\w+)[`"\]]?\s*\(/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    ctx.orms.add("SQL DDL");
    const b = bracketBody(text, m.index + m[0].length - 1);
    if (!b) continue;
    const name = m[1];
    const fields: Field[] = [];
    for (const part of splitTopLevel(b.body)) {
      const p = part.trim().replace(/\s+/g, " ");
      const fkC = /FOREIGN\s+KEY\s*\(\s*[`"\[]?(\w+)[`"\]]?\s*\)\s*REFERENCES\s+[`"\[]?(?:\w+[`"\]]?\.[`"\[]?)?(\w+)/i.exec(p);
      if (fkC) { const f = fields.find((x) => x.name === fkC[1]); if (f) f.fk = fkC[2]; else fields.push({ name: fkC[1], type: "int", fk: fkC[2] }); rel(ctx, name, fkC[2], "many-to-one", fkC[1], { file, line: lineOf(text, m.index) }); continue; }
      const pkC = /^(?:CONSTRAINT\s+\w+\s+)?PRIMARY\s+KEY\s*\(([^)]*)\)/i.exec(p);
      if (pkC) { for (const col of pkC[1].split(",").map((s) => s.trim().replace(/[`"\[\]]/g, ""))) { const f = fields.find((x) => x.name === col); if (f) f.pk = true; } continue; }
      if (/^(CONSTRAINT|UNIQUE|INDEX|KEY|CHECK|PRIMARY)\b/i.test(p)) continue;
      const col = /^[`"\[]?(\w+)[`"\]]?\s+([\w]+(?:\s*\([^)]*\))?(?:\s*\[\])?)/i.exec(p);
      if (!col) continue;
      const refI = /REFERENCES\s+[`"\[]?(?:\w+[`"\]]?\.[`"\[]?)?(\w+)/i.exec(p);
      fields.push({ name: col[1], type: col[2].toLowerCase(), pk: /PRIMARY\s+KEY/i.test(p) || undefined, nullable: /NOT\s+NULL/i.test(p) ? undefined : true, unique: /\bUNIQUE\b/i.test(p) || undefined, fk: refI?.[1] });
      if (refI) rel(ctx, name, refI[1], /\bUNIQUE\b/i.test(p) ? "one-to-one" : "many-to-one", col[1], { file, line: lineOf(text, m.index) });
    }
    addEntity(ctx, { name, table: name, orm: "SQL", source: { file, line: lineOf(text, m.index) }, fields, feature });
  }
  const alterRe = /ALTER\s+TABLE\s+(?:ONLY\s+)?[`"\[]?(?:\w+[`"\]]?\.[`"\[]?)?(\w+)[`"\]]?[\s\S]{0,200}?FOREIGN\s+KEY\s*\(\s*[`"\[]?(\w+)[`"\]]?\s*\)\s*REFERENCES\s+[`"\[]?(?:\w+[`"\]]?\.[`"\[]?)?(\w+)/gi;
  while ((m = alterRe.exec(text))) rel(ctx, m[1], m[3], "many-to-one", m[2], { file, line: lineOf(text, m.index) });
}

// ---------- Knex / Laravel migrations (table names + FKs only) ----------
function migrations(ctx: Ctx, text: string, file: string, feature: string) {
  let m: RegExpExecArray | null;
  const knexRe = /createTable\s*\(\s*['"](\w+)['"]\s*,\s*(?:\(?\s*\w+\s*\)?\s*=>|function\s*\(\s*\w+\s*\))\s*\{/g;
  while ((m = knexRe.exec(text))) {
    ctx.orms.add("Knex migrations");
    const b = bracketBody(text, m.index + m[0].length - 1);
    if (!b) continue;
    const fields: Field[] = [];
    const cre = /\.(increments|bigIncrements|uuid|string|integer|bigInteger|text|boolean|decimal|float|timestamp|date|datetime|json|jsonb|enum|enu)\s*\(\s*['"](\w+)['"]/g;
    let c: RegExpExecArray | null;
    while ((c = cre.exec(b.body))) fields.push({ name: c[2], type: c[1], pk: /increments|Increments/.test(c[1]) || undefined });
    const fre = /\.foreign\s*\(\s*['"](\w+)['"]\s*\)[\s\S]{0,80}?\.references\s*\(\s*['"](\w+)['"]\s*\)[\s\S]{0,40}?\.inTable\s*\(\s*['"](\w+)['"]/g;
    while ((c = fre.exec(b.body))) { rel(ctx, m[1], c[3], "many-to-one", c[1], { file, line: lineOf(text, m.index) }); const f = fields.find((x) => x.name === c![1]); if (f) f.fk = c[3]; }
    const fre2 = /\.(?:integer|uuid|bigInteger)\s*\(\s*['"](\w+)['"]\s*\)[^;\n]*?\.references\s*\(\s*['"]?(\w+)\.(\w+)['"]?\s*\)/g;
    while ((c = fre2.exec(b.body))) { rel(ctx, m[1], c[2], "many-to-one", c[1], { file, line: lineOf(text, m.index) }); const f = fields.find((x) => x.name === c![1]); if (f) f.fk = c[2]; }
    addEntity(ctx, { name: m[1], table: m[1], orm: "Knex", source: { file, line: lineOf(text, m.index) }, fields, feature });
  }
  const larRe = /Schema::create\s*\(\s*['"](\w+)['"]\s*,\s*function\s*\(\s*Blueprint\s+\$\w+\s*\)\s*\{/g;
  while ((m = larRe.exec(text))) {
    ctx.orms.add("Laravel migrations");
    const b = bracketBody(text, m.index + m[0].length - 1);
    if (!b) continue;
    const fields: Field[] = [];
    const cre = /\$\w+->(id|uuid|string|integer|bigInteger|unsignedBigInteger|text|boolean|decimal|float|timestamp|date|dateTime|json|enum|foreignId|foreignUuid|morphs|timestamps|softDeletes)\s*\(\s*(?:['"](\w+)['"])?/g;
    let c: RegExpExecArray | null;
    while ((c = cre.exec(b.body))) {
      if (c[1] === "timestamps") { fields.push({ name: "created_at", type: "timestamp" }, { name: "updated_at", type: "timestamp" }); continue; }
      if (c[1] === "softDeletes") { fields.push({ name: "deleted_at", type: "timestamp", nullable: true }); continue; }
      const name = c[2] ?? (c[1] === "id" ? "id" : c[1]);
      const rest = b.body.slice(c.index, c.index + 200);
      const constrained = /constrained\s*\(\s*(?:['"](\w+)['"])?/.exec(rest);
      const on = /->on\s*\(\s*['"](\w+)['"]/.exec(rest);
      let fk: string | undefined;
      if (/foreignId|foreignUuid/.test(c[1]) || constrained || on) {
        fk = constrained?.[1] ?? on?.[1] ?? (name.endsWith("_id") ? name.slice(0, -3) + "s" : undefined);
        if (fk) rel(ctx, m[1], fk, "many-to-one", name, { file, line: lineOf(text, m.index) });
      }
      fields.push({ name, type: c[1], pk: c[1] === "id" || undefined, fk });
    }
    addEntity(ctx, { name: m[1], table: m[1], orm: "Laravel migration", source: { file, line: lineOf(text, m.index) }, fields, feature });
  }
}

// ---------- GraphQL SDL types (data-ish) ----------
function graphqlSdl(ctx: Ctx, text: string, file: string, feature: string) {
  const re = /^\s*type\s+(\w+)(?:\s+implements\s+[\w&\s]+)?\s*(?:@\w+(?:\([^)]*\))?\s*)*\{([\s\S]*?)^\s*\}/gm;
  let m: RegExpExecArray | null;
  const typeNames = new Set<string>();
  const tmp = new RegExp(re.source, "gm");
  while ((m = tmp.exec(text))) typeNames.add(m[1]);
  while ((m = re.exec(text))) {
    if (/^(Query|Mutation|Subscription)$/.test(m[1])) continue;
    ctx.orms.add("GraphQL SDL");
    const fields: Field[] = [];
    for (const line of m[2].split("\n")) {
      const fm = /^\s*(\w+)\s*(?:\([^)]*\))?\s*:\s*(\[?)(\w+)!?\]?(!?)/.exec(line);
      if (!fm) continue;
      const t = fm[3];
      const isList = !!fm[2];
      fields.push({ name: fm[1], type: (isList ? `${t}[]` : t), pk: fm[1] === "id" || undefined, nullable: fm[4] ? undefined : true, fk: typeNames.has(t) && !/^(Query|Mutation)$/.test(t) ? t : undefined });
      if (typeNames.has(t) && !/^(Query|Mutation|Subscription)$/.test(t) && t !== m[1]) rel(ctx, isList ? t : m[1], isList ? m[1] : t, "many-to-one", fm[1], { file, line: lineOf(text, m.index) });
    }
    addEntity(ctx, { name: m[1], orm: "GraphQL type", source: { file, line: lineOf(text, m.index) }, fields, feature });
  }
}

export function extractDataModel(index: ProjectIndex): DataModel {
  const ctx: Ctx = { entities: [], relations: [], enums: [], orms: new Set() };
  for (const f of sourceFiles(index)) {
    const text = readText(f.abs);
    if (!text) continue;
    const args = [ctx, text, f.rel, f.feature] as const;
    switch (f.lang) {
      case "Prisma": prisma(...args); break;
      case "TypeScript":
      case "JavaScript":
        if (/@Entity\b/.test(text)) typeorm(...args);
        if (/new\s+(mongoose\.)?Schema|@Schema\(/.test(text)) mongoose(...args);
        if (/(pgTable|mysqlTable|sqliteTable)\s*\(/.test(text)) drizzle(...args);
        if (/sequelize|DataTypes\./i.test(text)) sequelize(...args);
        if (/createTable\s*\(/.test(text)) migrations(...args);
        break;
      case "Python": sqlalchemy(...args); django(...args); break;
      case "PHP": eloquent(...args); if (/Schema::create/.test(text)) migrations(...args); break;
      case "Java":
      case "Kotlin": if (/@Entity\b/.test(text)) jpa(...args); break;
      case "Go": gorm(...args); break;
      case "SQL": sqlDdl(...args); break;
      case "GraphQL": graphqlSdl(...args); break;
    }
  }
  // Prefer ORM entities over migration/DDL duplicates of the same table.
  const ormNames = new Set(ctx.entities.filter((e) => !/SQL|Knex|Laravel migration|GraphQL type/.test(e.orm)).flatMap((e) => [e.name.toLowerCase(), (e.table ?? "").toLowerCase(), singular(e.name).toLowerCase(), singular(e.table ?? "").toLowerCase()]));
  const entities = ctx.entities.filter((e) => !(/SQL|Knex|Laravel migration|GraphQL type/.test(e.orm) && (ormNames.has(e.name.toLowerCase()) || ormNames.has(singular(e.name).toLowerCase()))));
  const nameSet = new Map<string, string>();
  for (const e of entities) { nameSet.set(e.name.toLowerCase(), e.name); if (e.table) nameSet.set(e.table.toLowerCase(), e.name); nameSet.set(singular(e.name).toLowerCase(), e.name); nameSet.set(singular(e.table ?? "").toLowerCase(), e.name); }
  const canon = (n: string) => nameSet.get(n.toLowerCase()) ?? nameSet.get(singular(n).toLowerCase()) ?? n;
  const relations = uniqBy(
    ctx.relations.map((r) => ({ ...r, from: canon(r.from), to: canon(r.to) })).filter((r) => r.from !== r.to || r.kind !== "many-to-many"),
    (r) => `${r.from}|${r.to}|${r.kind}|${r.field ?? ""}`,
  );
  // drop mirrored duplicates (A m:n B and B m:n A)
  const seenPairs = new Set<string>();
  const finalRels: Relation[] = [];
  for (const r of relations) {
    const key = r.kind === "many-to-many" || r.kind === "one-to-one" ? [r.from, r.to].sort().join("|") + r.kind : `${r.from}|${r.to}|${r.kind}`;
    if (seenPairs.has(key)) continue;
    seenPairs.add(key);
    finalRels.push(r);
  }
  for (const e of entities) for (const f of e.fields) if (f.fk) f.fk = canon(f.fk);
  return { entities, relations: finalRels, enums: ctx.enums, orms: Array.from(ctx.orms).sort(), databases: index.databases };
}

export { SCALARS };

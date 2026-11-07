// A dendrite's surface: what it serves, read from its `index.ts`.
//
// Each exported async generator (or async function) is a method. Its first
// parameter is the call's params: an object, destructured or typed. A
// property's JSON type is its annotation's (string, number, boolean), else
// its default's (`{ days = 7 }` is a number), else a string — the film's
// `do_thing({ city })` names `city` and nothing else, so the runtime reads
// it as text. A method's description is its JSDoc, else its name.
//
// Hashes are of the shape (names, params, descriptions), never the body:
// an edit to a method's body is the same surface, and a service that mounted
// it keeps it across a restart of the dendrite (plexus-core's RemoteChild
// refuses a restarted child whose schema hash moved).

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import ts from "typescript";

export interface Param {
  name: string;
  schema: Record<string, unknown>;
  required: boolean;
}

export interface Method {
  name: string;
  description: string;
  params: Param[];
  /** `async function*`: many items; `async function`: one. */
  streaming: boolean;
}

function jsonType(node: ts.TypeNode | undefined): string | null {
  if (!node) return null;
  switch (node.kind) {
    case ts.SyntaxKind.StringKeyword: return "string";
    case ts.SyntaxKind.NumberKeyword: return "number";
    case ts.SyntaxKind.BooleanKeyword: return "boolean";
  }
  if (ts.isLiteralTypeNode(node)) {
    if (ts.isStringLiteral(node.literal)) return "string";
    if (ts.isNumericLiteral(node.literal)) return "number";
    if (node.literal.kind === ts.SyntaxKind.TrueKeyword || node.literal.kind === ts.SyntaxKind.FalseKeyword) return "boolean";
  }
  if (ts.isUnionTypeNode(node)) {
    const ts_ = new Set(node.types.map((t) => jsonType(t)).filter((x) => x));
    if (ts_.size === 1) return [...ts_][0]!;
  }
  return null;
}

function initType(e: ts.Expression | undefined): string | null {
  if (!e) return null;
  if (ts.isStringLiteralLike(e)) return "string";
  if (ts.isNumericLiteral(e) || (ts.isPrefixUnaryExpression(e) && ts.isNumericLiteral(e.operand))) return "number";
  if (e.kind === ts.SyntaxKind.TrueKeyword || e.kind === ts.SyntaxKind.FalseKeyword) return "boolean";
  return null;
}

function literalValue(e: ts.Expression | undefined): unknown {
  if (!e) return undefined;
  if (ts.isStringLiteralLike(e)) return e.text;
  if (ts.isNumericLiteral(e)) return Number(e.text);
  if (ts.isPrefixUnaryExpression(e) && ts.isNumericLiteral(e.operand)) return -Number(e.operand.text);
  if (e.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (e.kind === ts.SyntaxKind.FalseKeyword) return false;
  return undefined;
}

function doc(node: ts.Node): string | undefined {
  const tags = ts.getJSDocCommentsAndTags(node);
  for (const t of tags) {
    if (ts.isJSDoc(t) && t.comment) return typeof t.comment === "string" ? t.comment : t.comment.map((c) => c.text).join("");
  }
  return undefined;
}

/** The members a type literal or a local interface declares. */
function membersOf(src: ts.SourceFile, node: ts.TypeNode | undefined): Map<string, ts.PropertySignature> {
  const out = new Map<string, ts.PropertySignature>();
  let members: ts.NodeArray<ts.TypeElement> | undefined;
  if (node && ts.isTypeLiteralNode(node)) members = node.members;
  else if (node && ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)) {
    const name = node.typeName.text;
    src.forEachChild((s) => {
      if (ts.isInterfaceDeclaration(s) && s.name.text === name) members = s.members;
      if (ts.isTypeAliasDeclaration(s) && s.name.text === name && ts.isTypeLiteralNode(s.type)) members = s.type.members;
    });
  }
  for (const m of members ?? []) {
    if (ts.isPropertySignature(m) && m.name && (ts.isIdentifier(m.name) || ts.isStringLiteral(m.name))) out.set(m.name.text, m);
  }
  return out;
}

function paramsOf(src: ts.SourceFile, p: ts.ParameterDeclaration | undefined): Param[] {
  if (!p) return [];
  const typed = membersOf(src, p.type);
  const out: Param[] = [];
  const seen = new Set<string>();
  if (ts.isObjectBindingPattern(p.name)) {
    for (const el of p.name.elements) {
      const key = el.propertyName && ts.isIdentifier(el.propertyName) ? el.propertyName.text : ts.isIdentifier(el.name) ? el.name.text : null;
      if (!key || el.dotDotDotToken) continue;
      const sig = typed.get(key);
      const declared = jsonType(sig?.type) ?? initType(el.initializer);
      const schema: Record<string, unknown> = { type: declared ?? "string" };
      const d = sig ? doc(sig) : undefined;
      schema.description = d ?? (declared ? key : `${key} (untyped in index.ts: read as a string)`);
      const dv = literalValue(el.initializer);
      if (dv !== undefined) schema.default = dv;
      out.push({ name: key, schema, required: !el.initializer && !sig?.questionToken });
      seen.add(key);
    }
  }
  for (const [key, sig] of typed) {
    if (seen.has(key)) continue;
    const t = jsonType(sig.type) ?? "string";
    out.push({ name: key, schema: { type: t, description: doc(sig) ?? key }, required: !sig.questionToken });
  }
  return out;
}

/** The methods `index.ts` declares, by its source. */
export function readSurface(file: string): Map<string, Method> {
  const text = readFileSync(file, "utf8");
  const src = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out = new Map<string, Method>();
  const exported = (n: ts.Node) => ts.canHaveModifiers(n) && (ts.getModifiers(n) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
  src.forEachChild((s) => {
    if (ts.isFunctionDeclaration(s) && s.name && exported(s)) {
      const isAsync = (ts.getModifiers(s) ?? []).some((m) => m.kind === ts.SyntaxKind.AsyncKeyword);
      if (!isAsync) return;
      out.set(s.name.text, { name: s.name.text, description: doc(s) ?? `${s.name.text}`, params: paramsOf(src, s.parameters[0]), streaming: !!s.asteriskToken });
    }
    if (ts.isVariableStatement(s) && exported(s)) {
      for (const d of s.declarationList.declarations) {
        const f = d.initializer;
        if (ts.isIdentifier(d.name) && f && (ts.isFunctionExpression(f) || ts.isArrowFunction(f))) {
          out.set(d.name.text, { name: d.name.text, description: doc(s) ?? d.name.text, params: paramsOf(src, f.parameters[0]), streaming: ts.isFunctionExpression(f) && !!f.asteriskToken });
        }
      }
    }
  });
  return out;
}

const h16 = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

/** The child's schema (spec/07), as plexus-core's RemoteChild reads it at mount. */
export function schemaOf(ns: string, version: string, description: string, methods: Method[]): Record<string, unknown> {
  const ms = methods.map((m) => {
    const params = {
      type: "object",
      properties: Object.fromEntries(m.params.map((p) => [p.name, p.schema])),
      required: m.params.filter((p) => p.required).map((p) => p.name),
    };
    return {
      name: m.name,
      description: m.description,
      hash: h16(JSON.stringify([m.name, m.description, params, m.streaming])),
      params,
      returns: { description: `what ${m.name} yields: any JSON, one item per yield` },
      streaming: m.streaming,
      bidirectional: false,
    };
  });
  const hash = h16(JSON.stringify(ms));
  const grants = ms.map((m) => `${ns}.${m.name}`);
  return { namespace: ns, version, description, self_hash: hash, hash, methods: ms, roles: { viewer: grants, editor: grants } };
}

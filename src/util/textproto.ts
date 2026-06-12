/**
 * Tolerant parser for protobuf text format as used by Defold resource files
 * (.collection, .go, .gui, .atlas, .tilemap, .particlefx, .material, ...).
 *
 * Produces plain JSON objects. Repeated fields become arrays; embedded
 * component "data" strings can optionally be parsed recursively.
 */

import { ToolFailure } from "./errors.js";

export type TextProtoValue =
  | string
  | number
  | boolean
  | TextProtoNode
  | TextProtoValue[];

export interface TextProtoNode {
  [field: string]: TextProtoValue;
}

interface Token {
  kind: "ident" | "string" | "number" | "punct";
  value: string;
  line: number;
}

function isIdentStart(c: string): boolean {
  return /[A-Za-z_]/.test(c);
}
function isIdentChar(c: string): boolean {
  return /[A-Za-z0-9_.]/.test(c);
}
function isDigit(c: string): boolean {
  return c >= "0" && c <= "9";
}

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === "\n") {
      line++;
      i++;
      continue;
    }
    if (c === " " || c === "\t" || c === "\r" || c === "," || c === ";") {
      i++;
      continue;
    }
    if (c === "#") {
      while (i < n && text[i] !== "\n") i++;
      continue;
    }
    if (c === "{" || c === "}" || c === ":" || c === "[" || c === "]" || c === "<" || c === ">") {
      tokens.push({ kind: "punct", value: c, line });
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      const quote = c;
      i++;
      const bytes: number[] = [];
      while (i < n && text[i] !== quote) {
        const ch = text[i];
        if (ch === "\n") {
          throw new ToolFailure(`Unterminated string literal at line ${line}`);
        }
        if (ch === "\\") {
          i++;
          const esc = text[i];
          switch (esc) {
            case "n": bytes.push(10); i++; break;
            case "t": bytes.push(9); i++; break;
            case "r": bytes.push(13); i++; break;
            case "b": bytes.push(8); i++; break;
            case "f": bytes.push(12); i++; break;
            case "v": bytes.push(11); i++; break;
            case "a": bytes.push(7); i++; break;
            case "\\": bytes.push(92); i++; break;
            case "'": bytes.push(39); i++; break;
            case '"': bytes.push(34); i++; break;
            case "x": case "X": {
              i++;
              let hex = "";
              while (i < n && hex.length < 2 && /[0-9a-fA-F]/.test(text[i])) {
                hex += text[i++];
              }
              if (hex === "") throw new ToolFailure(`Invalid \\x escape at line ${line}`);
              bytes.push(parseInt(hex, 16));
              break;
            }
            default: {
              if (esc >= "0" && esc <= "7") {
                let oct = "";
                while (i < n && oct.length < 3 && text[i] >= "0" && text[i] <= "7") {
                  oct += text[i++];
                }
                bytes.push(parseInt(oct, 8) & 0xff);
              } else {
                // Unknown escape: keep the character as-is.
                for (const b of Buffer.from(esc ?? "", "utf8")) bytes.push(b);
                i++;
              }
            }
          }
        } else {
          for (const b of Buffer.from(ch, "utf8")) bytes.push(b);
          i++;
        }
      }
      if (i >= n) throw new ToolFailure(`Unterminated string literal at line ${line}`);
      i++; // closing quote
      tokens.push({ kind: "string", value: Buffer.from(bytes).toString("utf8"), line });
      continue;
    }
    if (isDigit(c) || c === "-" || c === "+" || c === ".") {
      let j = i;
      if (text[j] === "-" || text[j] === "+") j++;
      let body = "";
      while (j < n && /[0-9.eE+\-]/.test(text[j])) {
        // Stop a trailing +/- that is not part of an exponent.
        if ((text[j] === "+" || text[j] === "-") && !/[eE]/.test(text[j - 1])) break;
        body += text[j++];
      }
      const numText = text.slice(i, j);
      if (body.length === 0 || !/[0-9]/.test(numText)) {
        throw new ToolFailure(`Unexpected character '${c}' at line ${line}`);
      }
      tokens.push({ kind: "number", value: numText, line });
      i = j;
      continue;
    }
    if (isIdentStart(c)) {
      let j = i;
      while (j < n && isIdentChar(text[j])) j++;
      tokens.push({ kind: "ident", value: text.slice(i, j), line });
      i = j;
      continue;
    }
    throw new ToolFailure(`Unexpected character '${c}' at line ${line}`);
  }
  return tokens;
}

class Parser {
  private pos = 0;
  constructor(private tokens: Token[]) {}

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }
  private next(): Token {
    const t = this.tokens[this.pos++];
    if (!t) throw new ToolFailure("Unexpected end of file while parsing");
    return t;
  }
  private expect(kind: Token["kind"], value?: string): Token {
    const t = this.next();
    if (t.kind !== kind || (value !== undefined && t.value !== value)) {
      throw new ToolFailure(
        `Parse error at line ${t.line}: expected ${value ?? kind}, got '${t.value}'`
      );
    }
    return t;
  }

  parseMessage(stopAt?: string): TextProtoNode {
    const node: TextProtoNode = {};
    for (;;) {
      const t = this.peek();
      if (!t) {
        if (stopAt) throw new ToolFailure("Unexpected end of file: unclosed message block");
        return node;
      }
      if (stopAt && t.kind === "punct" && t.value === stopAt) {
        this.next();
        return node;
      }
      if (t.kind !== "ident") {
        throw new ToolFailure(
          `Parse error at line ${t.line}: expected field name, got '${t.value}'`
        );
      }
      const field = this.next().value;
      const after = this.peek();
      let value: TextProtoValue;
      if (after && after.kind === "punct" && (after.value === "{" || after.value === "<")) {
        this.next();
        value = this.parseMessage(after.value === "{" ? "}" : ">");
      } else {
        this.expect("punct", ":");
        value = this.parseValue();
      }
      assign(node, field, value);
    }
  }

  private parseValue(): TextProtoValue {
    const t = this.peek();
    if (!t) throw new ToolFailure("Unexpected end of file while reading a value");
    if (t.kind === "punct" && (t.value === "{" || t.value === "<")) {
      this.next();
      return this.parseMessage(t.value === "{" ? "}" : ">");
    }
    if (t.kind === "punct" && t.value === "[") {
      this.next();
      const items: TextProtoValue[] = [];
      for (;;) {
        const p = this.peek();
        if (!p) throw new ToolFailure("Unexpected end of file inside list value");
        if (p.kind === "punct" && p.value === "]") {
          this.next();
          return items;
        }
        items.push(this.parseValue());
      }
    }
    if (t.kind === "string") {
      // Adjacent string literals concatenate (protobuf text format rule).
      let s = this.next().value;
      while (this.peek()?.kind === "string") s += this.next().value;
      return s;
    }
    if (t.kind === "number") {
      this.next();
      const num = Number(t.value);
      if (!Number.isFinite(num)) return t.value;
      // Preserve very large integers (e.g. 64-bit hashes) as strings.
      if (Number.isInteger(num) && Math.abs(num) > Number.MAX_SAFE_INTEGER) return t.value;
      return num;
    }
    // ident: bool or enum value
    this.next();
    if (t.value === "true") return true;
    if (t.value === "false") return false;
    return t.value;
  }
}

function assign(node: TextProtoNode, field: string, value: TextProtoValue): void {
  const existing = node[field];
  if (existing === undefined) {
    node[field] = value;
  } else if (Array.isArray(existing)) {
    existing.push(value);
  } else {
    node[field] = [existing, value];
  }
}

/** Parse a Defold text-format resource into a JSON object. */
export function parseTextProto(text: string): TextProtoNode {
  return new Parser(tokenize(text)).parseMessage();
}

/** Fields that hold embedded text-proto payloads in Defold files. */
const EMBEDDED_DATA_FIELDS = new Set(["data"]);

/**
 * Walk a parsed node and recursively parse embedded "data" strings
 * (embedded_components / embedded_instances) up to `depth` levels.
 */
export function parseEmbeddedData(node: TextProtoNode, depth: number): TextProtoNode {
  if (depth <= 0) return node;
  for (const [key, value] of Object.entries(node)) {
    if (EMBEDDED_DATA_FIELDS.has(key) && typeof value === "string" && value.trim() !== "") {
      try {
        node[key] = parseEmbeddedData(parseTextProto(value), depth - 1);
      } catch {
        // Not text-proto content (e.g. embedded shader source); keep raw string.
      }
    } else if (Array.isArray(value)) {
      for (const item of value) {
        if (item && typeof item === "object" && !Array.isArray(item)) {
          parseEmbeddedData(item as TextProtoNode, depth);
        }
      }
      if (EMBEDDED_DATA_FIELDS.has(key)) {
        node[key] = value.map((item) => {
          if (typeof item === "string" && item.trim() !== "") {
            try {
              return parseEmbeddedData(parseTextProto(item), depth - 1);
            } catch {
              return item;
            }
          }
          return item;
        });
      }
    } else if (value && typeof value === "object") {
      parseEmbeddedData(value as TextProtoNode, depth);
    }
  }
  return node;
}

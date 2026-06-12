/**
 * Minimal proto2 binary encoder for the handful of messages accepted by the
 * Defold engine service (/post/<socket>/<message>). Only string and int32
 * fields are needed.
 */

function writeVarint(bytes: number[], value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new Error(`varint out of supported range: ${value}`);
  }
  let v = value >>> 0;
  for (;;) {
    if ((v & ~0x7f) === 0) {
      bytes.push(v);
      return;
    }
    bytes.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
}

function tag(fieldNumber: number, wireType: number): number {
  return (fieldNumber << 3) | wireType;
}

export function encodeStringField(bytes: number[], fieldNumber: number, value: string): void {
  const data = Buffer.from(value, "utf8");
  writeVarint(bytes, tag(fieldNumber, 2));
  writeVarint(bytes, data.length);
  for (const b of data) bytes.push(b);
}

export function encodeInt32Field(bytes: number[], fieldNumber: number, value: number): void {
  writeVarint(bytes, tag(fieldNumber, 0));
  writeVarint(bytes, value);
}

/** dmResourceDDF.Reload { repeated string resources = 1; } */
export function encodeReload(resources: string[]): Uint8Array {
  const bytes: number[] = [];
  for (const r of resources) encodeStringField(bytes, 1, r);
  return Uint8Array.from(bytes);
}

/** dmSystemDDF.Reboot { optional string arg1..arg6 = 1..6; } */
export function encodeReboot(args: string[]): Uint8Array {
  if (args.length > 6) {
    throw new Error("reboot supports at most 6 arguments (arg1..arg6)");
  }
  const bytes: number[] = [];
  args.forEach((a, i) => encodeStringField(bytes, i + 1, a));
  return Uint8Array.from(bytes);
}

/** dmSystemDDF.SetUpdateFrequency { required int32 frequency = 1; } */
export function encodeSetUpdateFrequency(frequency: number): Uint8Array {
  const bytes: number[] = [];
  encodeInt32Field(bytes, 1, frequency);
  return Uint8Array.from(bytes);
}

/** dmSystemDDF.SetVsync { required int32 swap_interval = 1; } */
export function encodeSetVsync(swapInterval: number): Uint8Array {
  const bytes: number[] = [];
  encodeInt32Field(bytes, 1, swapInterval);
  return Uint8Array.from(bytes);
}

/** dmSystemDDF.StartRecord { string file_name = 1; int32 frame_period = 2; int32 fps = 3; } */
export function encodeStartRecord(fileName: string, framePeriod: number, fps: number): Uint8Array {
  const bytes: number[] = [];
  encodeStringField(bytes, 1, fileName);
  encodeInt32Field(bytes, 2, framePeriod);
  encodeInt32Field(bytes, 3, fps);
  return Uint8Array.from(bytes);
}

/** dmSystemDDF.Exit { required int32 code = 1; } */
export function encodeExit(code: number): Uint8Array {
  const bytes: number[] = [];
  encodeInt32Field(bytes, 1, code);
  return Uint8Array.from(bytes);
}

/** Empty message (toggle_profile, stop_record, resume_rendering, ...). */
export function encodeEmpty(): Uint8Array {
  return new Uint8Array(0);
}

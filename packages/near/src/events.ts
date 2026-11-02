import { EventEnvelope, EventSchemas, isKnownEvent, type EventName } from "@builderos/shared";

const PREFIX = "EVENT_JSON:";

export type ParsedEvent = { event: EventName; version: string; standard: string; data: Record<string, unknown>[] };
export type ParseResult = { ok: true; value: ParsedEvent } | { ok: false; error: string; raw: string } | null;

/** Parse a single log line. Returns null for non-event logs. */
export function parseEventLog(log: string): ParseResult {
  if (!log.startsWith(PREFIX)) return null;
  const raw = log.slice(PREFIX.length);
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, error: "invalid json", raw };
  }
  const env = EventEnvelope.safeParse(json);
  if (!env.success) {
    // Other standards (nep141 etc.) are not ours; ignore silently.
    if ((json as any)?.standard && (json as any).standard !== "builderos") return null;
    return { ok: false, error: env.error.message, raw };
  }
  if (!env.data.version.startsWith("1.")) return { ok: false, error: `unsupported version ${env.data.version}`, raw };
  if (!isKnownEvent(env.data.event)) return { ok: false, error: `unknown event ${env.data.event}`, raw };
  const items = Array.isArray(env.data.data) ? env.data.data : [env.data.data];
  const schema = EventSchemas[env.data.event];
  const data: Record<string, unknown>[] = [];
  for (const item of items) {
    const r = schema.safeParse(item);
    if (!r.success) return { ok: false, error: `${env.data.event}: ${r.error.message}`, raw };
    data.push(r.data as Record<string, unknown>);
  }
  return { ok: true, value: { event: env.data.event, version: env.data.version, standard: env.data.standard, data } };
}

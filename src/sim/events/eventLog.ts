// Event log — the player's primary reading material between sessions.
// Per GDD §9.2 the log is a chronicle in a consistent, slightly wry
// narrative voice: short sentences that read as historical record rather
// than UI status updates. Every meaningful change in the colony's state
// (a blueprint planned, a tunnel completed, an ore vein sensed, the seven
// arriving on day one) gets a sentence in the log.
//
// Events are part of the deterministic save state so the catch-up worker
// produces the same chronicle the player would have witnessed live.

export type EventCategory =
  | "founding"      // first arrival, milestones tied to time
  | "discovery"     // ore/cavern/relic found
  | "construction"  // blueprint planned or completed
  | "social"        // relationships, births, deaths (later sessions)
  | "milestone"     // GDD §10.2 milestone trips
  | "crisis";       // attacks, cave-ins, etc. (later sessions)

export interface LogEvent {
  /** Tick at which the event fired. Used for sorting + display. */
  tick: number;
  category: EventCategory;
  text: string;
  /** Optional tile coordinates the event happened at — when present
   * the notification UI can offer a "jump to" camera pan. Omitted for
   * non-spatial events (research completing, milestones, etc.). */
  x?: number;
  y?: number;
}

export class EventLog {
  events: LogEvent[] = [];
  /** Cap to bound save size. Per GDD §12.4 the save stores the last 10k. */
  private readonly maxEvents = 10000;

  add(tick: number, category: EventCategory, text: string, pos?: { x: number; y: number }): void {
    const event: LogEvent = { tick, category, text };
    if (pos) {
      event.x = pos.x;
      event.y = pos.y;
    }
    this.events.push(event);
    if (this.events.length > this.maxEvents) {
      // Drop the oldest entries when the cap is exceeded.
      this.events.splice(0, this.events.length - this.maxEvents);
    }
  }

  /** Most-recent N events (newest last). */
  recent(n: number): LogEvent[] {
    return this.events.slice(Math.max(0, this.events.length - n));
  }

  filterByCategory(cat: EventCategory): LogEvent[] {
    return this.events.filter((e) => e.category === cat);
  }

  size(): number {
    return this.events.length;
  }
}

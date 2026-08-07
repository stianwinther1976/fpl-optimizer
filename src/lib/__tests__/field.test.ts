import { describe, expect, it } from "vitest";
import {
  ownershipShare,
  preferDifferential,
  splitByField,
  templateClass,
  lastTemplateCaptain,
  readCaptains,
} from "../field";
import type { Bootstrap, Element, Event } from "../types";

const el = (over: Partial<Element> & { id: number }): Element =>
  ({
    web_name: `P${over.id}`,
    team: 1,
    element_type: 3,
    now_cost: 60,
    status: "a",
    selected_by_percent: "10.0",
    ...over,
  }) as Element;

const ev = (over: Partial<Event> & { id: number }): Event =>
  ({
    name: `Gameweek ${over.id}`,
    deadline_time: "2026-08-14T17:30:00Z",
    finished: false,
    is_current: false,
    is_next: false,
    average_entry_score: 0,
    highest_score: null,
    ...over,
  }) as Event;

describe("ownershipShare", () => {
  it("reads a published percentage as a fraction", () => {
    expect(ownershipShare(el({ id: 1, selected_by_percent: "75.2" }))).toBeCloseTo(0.752, 9);
  });

  it("abstains rather than reporting nobody owns him", () => {
    // The same discipline as `ownershipPercentiles` in xp.ts: `parseFloat(..) || 0`
    // turns a parse failure into a confident claim of 0% ownership, which is the
    // most differential a player can possibly be. Every consumer here treats
    // null as "say nothing".
    for (const bad of ["", "n/a", undefined as unknown as string]) {
      expect(ownershipShare(el({ id: 1, selected_by_percent: bad }))).toBeNull();
    }
  });
});

describe("splitByField", () => {
  it("charges each player's points to the field in proportion to who owns him", () => {
    // 10 points at 75% owned: 7.5 of it arrives for three quarters of the field
    // at the same moment it arrives for you, and cannot move you past them.
    const split = splitByField([
      { element: el({ id: 1, selected_by_percent: "75.0" }), xp: 10 },
      { element: el({ id: 2, selected_by_percent: "5.0" }), xp: 10 },
    ]);
    expect(split.total).toBe(20);
    expect(split.shared).toBeCloseTo(8, 9);
    expect(split.differential).toBeCloseTo(12, 9);
  });

  it("leaves an unpublished player out of both halves and says so", () => {
    // Counting him as shared would invent an owner; counting him as
    // differential would invent an edge. He is reported as unknown instead.
    const split = splitByField([
      { element: el({ id: 1, selected_by_percent: "50.0" }), xp: 10 },
      { element: el({ id: 2, selected_by_percent: "oops" }), xp: 10 },
    ]);
    expect(split.unknown).toBe(1);
    expect(split.shared).toBeCloseTo(5, 9);
  });
});

describe("templateClass", () => {
  it("separates the handful the field is on from the long tail", () => {
    expect(templateClass(0.752)).toBe("template");
    expect(templateClass(0.22)).toBe("popular");
    expect(templateClass(0.08)).toBe("mid");
    expect(templateClass(0.01)).toBe("differential");
  });
});

describe("lastTemplateCaptain", () => {
  it("says nothing at all before a gameweek has finished", () => {
    // Pre-season this is every gameweek, and `most_captained` is null on all
    // 38. Reading an absent value as an id, or as "nobody", would be a claim
    // about a week that has not happened.
    const events = [ev({ id: 1 }), ev({ id: 2 })];
    expect(lastTemplateCaptain(events)).toBeNull();
  });

  it("reads the most recent finished gameweek, not the first", () => {
    const events = [
      ev({ id: 1, finished: true, most_captained: 11 }),
      ev({ id: 2, finished: true, most_captained: 22 }),
      ev({ id: 3 }),
    ];
    expect(lastTemplateCaptain(events)).toEqual({ gw: 2, element: 22 });
  });

  it("ignores a most_captained on a gameweek that has not finished", () => {
    const events = [ev({ id: 1, finished: false, most_captained: 11 })];
    expect(lastTemplateCaptain(events)).toBeNull();
  });
});

describe("readCaptains", () => {
  it("reports ownership beside the projection without changing the order", () => {
    const bootstrap = {
      events: [ev({ id: 1, finished: true, most_captained: 2 })],
    } as Bootstrap;
    const reads = readCaptains(
      [
        { element: el({ id: 1, selected_by_percent: "9.0" }), xp: 6 },
        { element: el({ id: 2, selected_by_percent: "75.0" }), xp: 5 },
      ],
      bootstrap
    );
    expect(reads.map((r) => r.element.id)).toEqual([1, 2]);
    expect(reads[0].klass).toBe("mid");
    expect(reads[1].klass).toBe("template");
    expect(reads[1].wasTemplateCaptain).toBe(true);
    expect(reads[0].wasTemplateCaptain).toBe(false);
  });
});

/*
 * The tolerance is in POINTS and belongs to the reader — see the note on
 * `preferDifferential`. These tests pin the two properties that make it safe to
 * expose at all: it is the identity when nobody asks, and it can never promote
 * a pick over one it actually trails by more than the stated amount.
 */
describe("preferDifferential", () => {
  const ranked = [
    { element: el({ id: 1, selected_by_percent: "75.0" }), xp: 6.0 },
    { element: el({ id: 2, selected_by_percent: "4.0" }), xp: 5.7 },
    { element: el({ id: 3, selected_by_percent: "1.0" }), xp: 3.0 },
  ];

  it("changes nothing at all at zero tolerance", () => {
    expect(preferDifferential(ranked, 0).map((r) => r.element.id)).toEqual([1, 2, 3]);
  });

  it("does not reorder an exact tie at zero tolerance either", () => {
    // The narrow case the early return actually protects, and the reason it is
    // not merely an optimisation: without it, `best - xp <= 0` admits every
    // player LEVEL with the leader into the band, and they would then be sorted
    // by ownership. Zero tolerance has to mean the differential question was
    // never asked — including of two picks the model cannot separate.
    const tied = [
      { element: el({ id: 1, selected_by_percent: "75.0" }), xp: 6.0 },
      { element: el({ id: 2, selected_by_percent: "2.0" }), xp: 6.0 },
    ];
    expect(preferDifferential(tied, 0).map((r) => r.element.id)).toEqual([1, 2]);
  });

  it("promotes the differential only inside the band the reader allowed", () => {
    // 0.3 apart, so at a tolerance of 0.5 the 4%-owned pick is a genuine
    // alternative and goes first.
    expect(preferDifferential(ranked, 0.5).map((r) => r.element.id)).toEqual([2, 1, 3]);
  });

  it("never promotes a pick that trails by more than the tolerance", () => {
    // Player 3 is the most differential in the list by a distance and must
    // still not outrank a pick three points better. A differential three points
    // worse is not a bolder version of the same decision, it is a worse pick.
    expect(preferDifferential(ranked, 0.5)[0].element.id).not.toBe(3);
    expect(preferDifferential(ranked, 0.5).map((r) => r.element.id)).toEqual([2, 1, 3]);
  });

  it("does not let unpublished ownership win a tie-break it cannot justify", () => {
    const withUnknown = [
      { element: el({ id: 1, selected_by_percent: "75.0" }), xp: 6.0 },
      { element: el({ id: 2, selected_by_percent: "junk" }), xp: 5.9 },
    ];
    expect(preferDifferential(withUnknown, 0.5).map((r) => r.element.id)).toEqual([1, 2]);
  });
});

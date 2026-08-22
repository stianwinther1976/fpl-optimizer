// Whether the reader got here by moving around inside the app.
//
// WHY THIS EXISTS. The header's back control has to do one of two different
// things, and nothing in the platform tells it which:
//
//  - Reached `/team/{id}` from the landing page, or from a rival's row in the
//    mini-league — there is a previous screen inside the app, and "back" means
//    that screen.
//  - Reached it cold: a shared link, a bookmark, the home-screen icon. There is
//    no previous screen, and `history.back()` leaves the app entirely — to
//    whatever the reader was doing before, or to a blank tab. A back button
//    that ejects you from the site is worse than no back button.
//
// `history.length` cannot tell those apart: it counts the whole tab's history,
// so a reader who visited three other sites before opening a shared link has a
// length of four and no in-app step to go back to.
//
// Module state can. It survives client-side navigation, because that is the
// same JavaScript context, and it resets on a full page load — which is exactly
// the distinction being drawn. `Dashboard` therefore falls back to the landing
// page whenever this is false, and the label follows the behaviour.
let steps = 0;

/** Record one client-side navigation. Called at every in-app route push. */
export function markNavigation(): void {
  steps++;
}

/** True when there is a screen inside this app to go back to. */
export function canGoBack(): boolean {
  return steps > 0;
}

/** For tests: forget the history, as a full page load would. */
export function resetNavigation(): void {
  steps = 0;
}

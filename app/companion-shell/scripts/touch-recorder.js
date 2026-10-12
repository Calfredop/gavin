// The touch recorder: what a finger on the Companion's terminal actually
// does, measured inside the page. It is one expression, evaluated in the
// bundle webview by `touch-recorder.sh` (a physical iPhone, over USB) or by
// any inspector that can run script in the page.
//
// Every swipe -- touchstart to the last finger up, plus SETTLE_MS of quiet
// for momentum -- becomes one row:
//
//   target           what the finger came down on (its first class)
//   ms, moves        how long it lasted, how many touchmoves arrived
//   swipePx          finger travel, last touch minus first; + is downward
//   rowChanges       mutations under `.xterm-rows`: the terminal redrew
//   changesAfterLift the part of them after the finger lifted: momentum
//   rowsBefore/After the first and last visible row's text
//   pageScrolled     whether the document itself moved (it must not)
//   p95, worst       frame intervals over the swipe, by requestAnimationFrame
//   over33           frames slower than 33 ms
//   scale            visualViewport.scale at the end (a pinch zoomed the page)
//
// It only listens -- capture, passive -- so it cannot change what it
// measures: a passive listener cannot preventDefault, and it runs before
// xterm's own gesture handling on the document. A touch's moves and its
// end go to the element it came down on, and one taken out of the page
// mid-touch (the Latest pill, pressed) no longer passes them up to the
// document, so the recorder listens on that element too.
//
// Read it with `window.__touchrec.report()`, empty it with `.clear()`.
(() => {
  if (window.__touchrec) return "touch recorder already on";

  /// Quiet after the last finger lifts before a swipe is closed. xterm's
  /// momentum decays in well under this.
  const SETTLE_MS = 900;

  const options = { capture: true, passive: true };
  const swipes = [];
  let s = null;
  let settle;

  const rowsNode = () => document.querySelector(".xterm-rows");
  const edges = () => {
    const rows = rowsNode();
    if (!rows) return "";
    const text = (row) => (row ? row.textContent.trim() : "");
    return `${text(rows.firstElementChild)} .. ${text(rows.lastElementChild)}`;
  };
  const pageTop = () => (document.scrollingElement ? document.scrollingElement.scrollTop : 0);

  const frame = (t) => {
    if (!s) return;
    s.frames.push(t - s.lastFrame);
    s.lastFrame = t;
    s.raf = requestAnimationFrame(frame);
  };

  const finish = () => {
    if (!s) return;
    const done = s;
    s = null;
    clearTimeout(settle);
    cancelAnimationFrame(done.raf);
    if (done.observer) done.observer.disconnect();
    for (const [type, listener] of touched) done.node.removeEventListener(type, listener, options);
    // The first interval runs from touchstart to a frame, not frame to frame.
    const d = done.frames.slice(1).sort((a, b) => a - b);
    swipes.push({
      target: done.target,
      ms: Math.round(performance.now() - done.t0),
      moves: done.moves,
      swipePx: Math.round(done.y1 - done.y0),
      rowChanges: done.changes,
      changesAfterLift: done.changesAfterLift,
      firstChangeMs: done.firstChange,
      rowsBefore: done.rowsBefore,
      rowsAfter: edges(),
      pageScrolled: pageTop() !== done.pageTop,
      frames: d.length,
      p95: d.length ? Math.round(d[Math.floor(d.length * 0.95)]) : 0,
      worst: d.length ? Math.round(d[d.length - 1]) : 0,
      over33: d.filter((x) => x > 33).length,
      scale: window.visualViewport ? window.visualViewport.scale : 1,
    });
  };

  const start = (e) => {
    // A new finger after a lift is a new swipe, even inside the settle.
    if (s && s.lifted !== null) finish();
    if (s) return;
    const touch = e.touches[0];
    const now = performance.now();
    s = {
      t0: now,
      lastFrame: now,
      frames: [],
      raf: 0,
      moves: 0,
      changes: 0,
      changesAfterLift: 0,
      firstChange: null,
      lifted: null,
      y0: touch ? touch.clientY : 0,
      y1: touch ? touch.clientY : 0,
      target: (e.target.className && String(e.target.className).split(" ")[0]) || e.target.tagName,
      rowsBefore: edges(),
      pageTop: pageTop(),
      observer: null,
      node: e.target,
    };
    for (const [type, listener] of touched) s.node.addEventListener(type, listener, options);
    s.raf = requestAnimationFrame(frame);
    const rows = rowsNode();
    if (rows) {
      const current = s;
      current.observer = new MutationObserver(() => {
        current.changes++;
        if (current.firstChange === null) current.firstChange = Math.round(performance.now() - current.t0);
        if (current.lifted !== null) current.changesAfterLift++;
      });
      current.observer.observe(rows, { subtree: true, childList: true, characterData: true });
    }
  };

  const move = (e) => {
    if (!s) return;
    s.moves++;
    const touch = e.touches[0];
    if (touch) s.y1 = touch.clientY;
  };

  const end = (e) => {
    if (!s || e.touches.length > 0) return;
    s.lifted = performance.now();
    clearTimeout(settle);
    settle = setTimeout(finish, SETTLE_MS);
  };

  // An event heard on the document and again on the touched element
  // counts once.
  const heard = new WeakSet();
  const once = (handler) => (e) => {
    if (heard.has(e)) return;
    heard.add(e);
    handler(e);
  };
  const touched = [
    ["touchmove", once(move)],
    ["touchend", once(end)],
    ["touchcancel", once(end)],
  ];
  document.addEventListener("touchstart", start, options);
  for (const [type, listener] of touched) document.addEventListener(type, listener, options);

  window.__touchrec = {
    report: () => JSON.stringify(swipes),
    clear: () => {
      swipes.length = 0;
      return "cleared";
    },
  };
  return "touch recorder on";
})()

(() => {
  // Registry to track cleanup per element (idempotent binding)
  const REGISTRY = new WeakMap();

  // Tunables (can be overridden per-element via data attrs)
  const DEFAULTS = {
    friction: 0.92, // 0..1  (lower = more friction)
    minVelocity: 0.02, // px/ms equivalent (converted below)
    maxVelocity: 3.5, // px/ms cap to avoid crazy fling
    touchAction: "pan-y", // allow vertical page scroll
  };

  // Utility: read number data-attrs safely, fallback to default
  const numAttr = (el, name, fallback) => {
    const v = el.getAttribute(name);
    const n = v == null ? NaN : Number(v);
    return Number.isFinite(n) ? n : fallback;
  };

  const initInRoot = (root = document) => {
    const areas = root.querySelectorAll("[data-hscroll]");
    areas.forEach((wrap) => {
      if (REGISTRY.has(wrap)) return; // already wired

      // Per-element config (optional data overrides)
      const friction = numAttr(
        wrap,
        "data-hscroll-friction",
        DEFAULTS.friction,
      );
      const minVelocity = numAttr(
        wrap,
        "data-hscroll-min-velocity",
        DEFAULTS.minVelocity,
      );
      const maxVelocity = numAttr(
        wrap,
        "data-hscroll-max-velocity",
        DEFAULTS.maxVelocity,
      );
      const touchAction =
        wrap.getAttribute("data-hscroll-touch-action") || DEFAULTS.touchAction;

      // State
      let isDragging = false;
      let startX = 0;
      let startScrollLeft = 0;
      let lastX = 0;

      // Velocity in px/ms (time-based)
      let velocity = 0;
      let lastT = 0;

      // RAF id for momentum loop
      let rafId = 0;

      // Helpers
      const setUserSelect = (value) => {
        document.documentElement.style.userSelect = value;
      };

      const stopMomentum = () => {
        if (rafId) {
          cancelAnimationFrame(rafId);
          rafId = 0;
        }
      };

      // Clamp scroll to bounds and report if we hit an edge
      const clampToBounds = () => {
        const min = 0;
        const max = wrap.scrollWidth - wrap.clientWidth;
        const before = wrap.scrollLeft;
        if (before <= min) {
          wrap.scrollLeft = min;
          return "min";
        }
        if (before >= max) {
          wrap.scrollLeft = max;
          return "max";
        }
        return null;
      };

      // Momentum loop (time-based decay, edge damping)
      const momentum = (t) => {
        if (!lastT) lastT = t;
        const dt = Math.max(1, t - lastT); // ms
        lastT = t;

        // Apply velocity -> scroll
        wrap.scrollLeft -= velocity * dt;

        // If we hit an edge, dampen harder
        const edge = clampToBounds();
        if (edge) {
          velocity *= 0.4; // strong damping at edges
        }

        // Apply friction as exponential decay w.r.t. time
        // Convert per-frame 'friction' into per-ms by raising to (dt/16.67)
        const decay = Math.pow(friction, dt / 16.67);
        velocity *= decay;

        if (Math.abs(velocity) < minVelocity) {
          velocity = 0;
          rafId = 0;
          lastT = 0;
          return;
        }
        rafId = requestAnimationFrame(momentum);
      };

      // Pointer Events unify mouse + touch
      const onPointerDown = (e) => {
        // Only left button or touch/pen
        if (e.pointerType === "mouse" && e.button !== 0) return;

        stopMomentum();
        isDragging = true;

        // Capture ensures we still get up/move even if pointer leaves the el
        wrap.setPointerCapture?.(e.pointerId);

        startX = e.clientX;
        lastX = e.clientX;
        startScrollLeft = wrap.scrollLeft;

        velocity = 0;
        lastT = 0;

        wrap.classList.add("cursor-grabbing");
        setUserSelect("none");
      };

      const onPointerMove = (e) => {
        if (!isDragging) return;

        // delta since drag start
        const dx = e.clientX - startX;

        // per-move delta for velocity
        const deltaFromLast = e.clientX - lastX;
        const now = performance.now();

        // Convert to px/ms (use elapsed since last move; fallback to ~16.67ms)
        const elapsed = Math.max(1, now - (lastT || now - 16.67));
        velocity = Math.max(
          -maxVelocity,
          Math.min(maxVelocity, deltaFromLast / elapsed),
        );

        lastX = e.clientX;
        lastT = now;

        wrap.scrollLeft = startScrollLeft - dx;
        // prevent text selection / native drag while dragging
        e.preventDefault?.();
      };

      const onPointerUp = (e) => {
        if (!isDragging) return;
        isDragging = false;
        wrap.releasePointerCapture?.(e.pointerId);
        wrap.classList.remove("cursor-grabbing");
        setUserSelect("");

        // Kick off momentum if we have enough speed
        if (Math.abs(velocity) > minVelocity && !rafId) {
          rafId = requestAnimationFrame(momentum);
        }
      };

      const onPointerCancel = () => {
        isDragging = false;
        wrap.classList.remove("cursor-grabbing");
        setUserSelect("");
        stopMomentum();
      };

      const onDragStart = (ev) => ev.preventDefault();

      // Wheel: treat trackpads with horizontal wheel as native (don’t hijack),
      // but if a strictly vertical wheel happens while overflow-x, let browser handle.
      // No custom wheel handler = better compatibility with inertial scroll/assistive tech.

      // Respect prefers-reduced-motion: if user prefers, disable momentum fling.
      const prefersReducedMotion = window.matchMedia?.(
        "(prefers-reduced-motion: reduce)",
      )?.matches;
      if (prefersReducedMotion) {
        // Override to kill fling; still allow drag
        velocity = 0;
        // friction value is irrelevant when velo=0, but keep code simple
      }

      // Configure pointer behavior (allow vertical scroll on page)
      wrap.style.touchAction = touchAction;

      // Bind listeners
      wrap.addEventListener("dragstart", onDragStart);
      wrap.addEventListener("pointerdown", onPointerDown);
      wrap.addEventListener("pointermove", onPointerMove);
      wrap.addEventListener("pointerup", onPointerUp);
      wrap.addEventListener("pointercancel", onPointerCancel);
      wrap.addEventListener("pointerleave", onPointerCancel);

      // Keep idempotent cleanup per element
      const cleanup = () => {
        stopMomentum();
        wrap.classList.remove("cursor-grabbing");
        if (wrap.style.touchAction === touchAction) wrap.style.touchAction = "";
        document.documentElement.style.userSelect = "";
        wrap.removeEventListener("dragstart", onDragStart);
        wrap.removeEventListener("pointerdown", onPointerDown);
        wrap.removeEventListener("pointermove", onPointerMove);
        wrap.removeEventListener("pointerup", onPointerUp);
        wrap.removeEventListener("pointercancel", onPointerCancel);
        wrap.removeEventListener("pointerleave", onPointerCancel);
        REGISTRY.delete(wrap);
      };

      REGISTRY.set(wrap, cleanup);
    });
  };

  const init = () => initInRoot(document);

  // Initial run
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  // Theme Editor lifecycle events (sections mount/unmount/reorder)
  document.addEventListener("shopify:section:load", (ev) =>
    initInRoot(ev.target),
  );
  document.addEventListener("shopify:section:reorder", (ev) =>
    initInRoot(ev.target),
  );
  document.addEventListener("shopify:block:select", (ev) =>
    initInRoot(ev.target),
  );
  document.addEventListener("shopify:block:deselect", (ev) =>
    initInRoot(ev.target),
  );
  document.addEventListener("shopify:section:unload", (ev) => {
    ev.target.querySelectorAll?.("[data-hscroll]")?.forEach((el) => {
      const dispose = REGISTRY.get(el);
      if (dispose) dispose();
    });
  });

  // Fallback: catch nodes added/removed outside of Shopify events (e.g., app embeds)
  const mo = new MutationObserver((mutations) => {
    for (const m of mutations) {
      m.addedNodes?.forEach((n) => {
        if (n.nodeType !== 1) return;
        if (n.matches?.("[data-hscroll]")) initInRoot(n);
        n.querySelectorAll?.("[data-hscroll]").forEach((el) => initInRoot(el));
      });
      m.removedNodes?.forEach((n) => {
        if (n.nodeType !== 1) return;
        const toClean = [];
        if (n.matches?.("[data-hscroll]")) toClean.push(n);
        n.querySelectorAll?.("[data-hscroll]").forEach((el) =>
          toClean.push(el),
        );
        toClean.forEach((el) => {
          const dispose = REGISTRY.get(el);
          if (dispose) dispose();
        });
      });
    }
  });
  mo.observe(document.documentElement, { childList: true, subtree: true });
})();
